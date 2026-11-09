'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const cs = require('../src/azure/connstr');
const { safeLocalPath } = require('../src/azure/paths');
const qt = require('../src/azure/queuetable');
const { TransferQueue } = require('../src/transfers');
const { excluder } = require('../src/azure/sync');
const { describeError } = require('../src/ui');

const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';

test('connection string with an account key: endpoints from the suffix, key kept, case-insensitive names', () => {
  const p = cs.fromConnectionString(`DefaultEndpointsProtocol=https;AccountName=myacct;AccountKey=${KEY};EndpointSuffix=core.windows.net`);
  assert.equal(p.kind, 'key');
  assert.equal(p.account, 'myacct');
  assert.equal(p.secret.accountKey, KEY);
  assert.equal(p.endpoints.blob, 'https://myacct.blob.core.windows.net');
  assert.equal(p.endpoints.table, 'https://myacct.table.core.windows.net');
  const q = cs.fromConnectionString(`accountname=x1y;accountkey=${KEY};endpointsuffix=core.chinacloudapi.cn`);
  assert.equal(q.endpoints.queue, 'https://x1y.queue.core.chinacloudapi.cn');
});

test('connection string variants: explicit endpoints, SAS, development storage, errors', () => {
  const e = cs.fromConnectionString(`BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;AccountName=devstoreaccount1;AccountKey=${KEY}`);
  assert.deepEqual(e.services, ['blob']);
  assert.equal(e.endpoints.blob, 'http://127.0.0.1:10000/devstoreaccount1');
  const s = cs.fromConnectionString('BlobEndpoint=https://acct.blob.core.windows.net/;QueueEndpoint=https://acct.queue.core.windows.net/;SharedAccessSignature=sv=2022-11-02&ss=b&srt=sco&sp=rl&se=2099-01-01T00:00:00Z&sig=abc');
  assert.equal(s.kind, 'sas');
  assert.equal(s.account, 'acct');
  assert.deepEqual(s.services, ['blob'], 'ss=b drops the queue endpoint');
  const d = cs.fromConnectionString('UseDevelopmentStorage=true');
  assert.equal(d.kind, 'azurite');
  assert.equal(d.endpoints.blob, 'http://127.0.0.1:10000/devstoreaccount1');
  const dp = cs.fromConnectionString('UseDevelopmentStorage=true;DevelopmentStorageProxyUri=http://azurite');
  assert.equal(dp.endpoints.queue, 'http://azurite:10001/devstoreaccount1');
  assert.throws(() => cs.fromConnectionString(''), /empty/);
  assert.throws(() => cs.fromConnectionString('AccountName=a1b'), /neither an AccountKey nor a SharedAccessSignature/);
  assert.throws(() => cs.fromConnectionString('AccountName=a1b;AccountKey=not base64!!'), /not base64/);
  assert.throws(() => cs.fromConnectionString('garbage'), /no "="/);
});

test('SAS URLs: account SAS covers its services, container SAS keeps the container, one-blob SAS and expiry are caught', () => {
  const a = cs.fromSasUrl('https://acct.blob.core.windows.net/?sv=2022-11-02&ss=bqt&srt=sco&sp=rwdlacup&se=2099-01-01T00:00:00Z&sig=x%2By');
  assert.equal(a.kind, 'sas');
  assert.deepEqual(a.services, ['blob', 'queue', 'table']);
  assert.equal(a.endpoints.table, 'https://acct.table.core.windows.net');
  assert.equal(a.sasInfo.expired, false);
  const c = cs.fromSasUrl('https://acct.blob.core.windows.net/box?sv=2022-11-02&sr=c&sp=rl&se=2020-01-01T00:00:00Z&sig=abc');
  assert.equal(c.container, 'box');
  assert.deepEqual(c.services, ['blob']);
  assert.equal(c.sasInfo.expired, true);
  assert.equal(c.sasInfo.permissions, 'rl');
  const z = cs.fromSasUrl('http://127.0.0.1:10000/devstoreaccount1/box?sv=2022-11-02&sr=c&sp=rl&se=2099-01-01T00:00:00Z&sig=abc');
  assert.equal(z.account, 'devstoreaccount1');
  assert.equal(z.container, 'box');
  assert.equal(z.endpoints.blob, 'http://127.0.0.1:10000/devstoreaccount1');
  const za = cs.fromSasUrl('http://127.0.0.1:10000/devstoreaccount1?sv=2025-05-05&ss=bqt&srt=sco&sp=rl&se=2099-01-01T00:00:00Z&sig=abc');
  assert.deepEqual(za.services, ['blob', 'queue', 'table'], 'an Azurite account SAS reaches every service on its port');
  assert.equal(za.endpoints.table, 'http://127.0.0.1:10002/devstoreaccount1');
  assert.throws(() => cs.fromSasUrl('https://acct.blob.core.windows.net/box/file.txt?sv=1&sr=b&sig=abc'), /one blob/);
  assert.throws(() => cs.fromSasUrl('https://acct.blob.core.windows.net/box'), /no SAS token/);
  assert.throws(() => cs.fromSasUrl('not a url'), /not a URL/);
  assert.throws(() => cs.fromSasUrl('https://acct.file.core.windows.net/share?sv=1&sig=a'), /File shares/);
});

test('account name and key, Entra, Azurite and redaction', () => {
  assert.equal(cs.fromAccountKey('abc123', KEY).endpoints.blob, 'https://abc123.blob.core.windows.net');
  assert.throws(() => cs.fromAccountKey('Bad_Name', KEY), /3 to 24/);
  assert.throws(() => cs.fromAccountKey('abc', 'x y z!'), /base64/);
  const en = cs.forEntra('prodstore', { tenant: 'contoso.onmicrosoft.com' });
  assert.equal(en.kind, 'entra');
  assert.deepEqual(en.secret, {});
  assert.equal(cs.forAzurite('azurite').endpoints.table, 'http://azurite:10002/devstoreaccount1');
  const r = cs.redact(`AccountName=a;AccountKey=${KEY};SharedAccessSignature=sv=1&sig=zzz`);
  assert.ok(!r.includes(KEY) && !r.includes('zzz'));
  assert.ok(cs.redact('https://a/?sv=1&sig=secret').endsWith('sig=•••'));
});

test('download paths never leave the folder: "..", absolute names and "%2F" stay inside', () => {
  const root = path.resolve('/tmp/azx-root');
  assert.ok(safeLocalPath(root, '../../.ssh/config').error);
  assert.ok(safeLocalPath(root, 'a/../../b').error);
  assert.ok(safeLocalPath(root, 'C:/x', '', 'win32').error);
  const enc = safeLocalPath(root, 'reports/a%2F..%2Fb.txt');
  assert.ok(enc.path.startsWith(root + path.sep), 'a literal %2F is a file name character, not a separator');
  assert.equal(path.basename(enc.path), 'a%2F..%2Fb.txt');
  assert.equal(safeLocalPath(root, '/abs/file.txt').path, path.join(root, 'abs', 'file.txt'));
  assert.equal(safeLocalPath(root, 'data/2026/ü ñ 日本.csv', 'data/').path, path.join(root, '2026', 'ü ñ 日本.csv'));
});

test('queue messages: Base64 shown decoded only when it is really Base64 text', () => {
  assert.equal(qt.decodeMaybeBase64(Buffer.from('{"orderId":42}').toString('base64')), '{"orderId":42}');
  assert.equal(qt.decodeMaybeBase64('hello world'), null);
  assert.equal(qt.decodeMaybeBase64('abcd'), null, 'decodes to binary');
  assert.equal(qt.decodeMaybeBase64(Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString('base64')), null);
});

test('table values: each type is checked and converted the way the SDK sends it', () => {
  assert.equal(qt.toSdkValue('n', 'Int32', '42'), 42);
  assert.throws(() => qt.toSdkValue('n', 'Int32', '3000000000'), /Int32/);
  assert.deepEqual(qt.toSdkValue('b', 'Int64', '9007199254740993'), { value: '9007199254740993', type: 'Int64' });
  assert.throws(() => qt.toSdkValue('b', 'Int64', '1e5'), /whole number/);
  assert.deepEqual(qt.toSdkValue('d', 'Double', '2.5'), { value: 2.5, type: 'Double' });
  assert.equal(qt.toSdkValue('f', 'Boolean', 'TRUE'), true);
  assert.throws(() => qt.toSdkValue('f', 'Boolean', 'yes'), /true or false/);
  assert.deepEqual(qt.toSdkValue('t', 'DateTime', '2026-11-09 12:00:00Z'), { value: '2026-11-09T12:00:00.000Z', type: 'DateTime' });
  assert.throws(() => qt.toSdkValue('g', 'Guid', 'nope'), /Guid/);
  assert.throws(() => qt.entityFrom('a/b', 'r', {}), /cannot contain/);
  assert.throws(() => qt.entityFrom('p', 'r', { RowKey: { type: 'String', value: 'x' } }), /system property/);
  const row = qt.rowOf({ partitionKey: 'p', rowKey: 'r', etag: 'W/"x"', timestamp: { value: '2026-01-01T00:00:00Z', type: 'DateTime' }, name: 'Ann', age: 7, score: 1.5, ok: false, big: { value: '12', type: 'Int64' } });
  assert.deepEqual(row.props, { name: { type: 'String', value: 'Ann' }, age: { type: 'Int32', value: '7' }, score: { type: 'Double', value: '1.5' }, ok: { type: 'Boolean', value: 'false' }, big: { type: 'Int64', value: '12' } });
});

test('transfer queue: concurrency, progress, cancel of running and queued, retry after failure', async () => {
  let changes = 0;
  const q = new TransferQueue({ concurrency: 2, onChange: () => { changes++; } });
  let running = 0;
  let peak = 0;
  let failOnce = true;
  const job = (ms, opts = {}) => ({
    kind: 'upload', label: 'f', total: 100,
    run: (j, { signal, progress }) => new Promise((resolve, reject) => {
      running++; peak = Math.max(peak, running);
      progress(50, 100);
      const t = setTimeout(() => { running--; if (opts.fail && failOnce) { failOnce = false; reject(new Error('network down')); } else resolve('ok'); }, ms);
      signal.addEventListener('abort', () => { clearTimeout(t); running--; const e = new Error('Cancelled'); e.name = 'AbortError'; reject(e); });
    }),
  });
  const a = q.add(job(40));
  const b = q.add(job(200));
  const c = q.add(job(40, { fail: true }));
  const d = q.add(job(40));
  assert.equal(q.summary().active, 4);
  q.cancel(d.id);
  assert.equal(d.status, 'cancelled', 'a queued item cancels at once');
  setTimeout(() => q.cancel(b.id), 20);
  await q.settle([a, b, c, d]);
  assert.equal(peak, 2);
  assert.equal(a.status, 'done');
  assert.equal(a.bytes, 100);
  assert.equal(b.status, 'cancelled');
  assert.equal(c.status, 'failed');
  assert.equal(c.error, 'network down');
  assert.ok(q.retry(c.id));
  await q.settle([c]);
  assert.equal(c.status, 'done');
  assert.ok(q.retry(d.id));
  await q.idle();
  assert.equal(d.status, 'done');
  q.clearFinished();
  assert.equal(q.items.length, 0);
  assert.ok(changes > 5);
});

test('sync excludes and plain error messages', () => {
  const ex = excluder(['.git/**', 'node_modules/**', '*.tmp']);
  assert.ok(ex('.git/config') && ex('a/b.tmp') && ex('node_modules/x/y.js'));
  assert.ok(!ex('src/app.js'));
  const conn = { name: 'prod', kind: 'sas', sasExpires: '2020-01-01T00:00:00.000Z' };
  assert.match(describeError({ code: 'AuthenticationFailed', message: 'Server failed to authenticate the request.' }, conn).message, /expired on 2020-01-01 00:00 UTC/);
  assert.match(describeError({ code: 'AuthenticationFailed', message: 'Signature did not match. String to sign used was ...' }, { name: 'k', kind: 'key' }).message, /signature does not match/);
  assert.match(describeError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:10000' }, { name: 'Azurite', kind: 'azurite' }).message, /Azurite does not answer/);
  assert.match(describeError({ code: 'BlobArchived', message: 'x' }).message, /Archive tier/);
  assert.match(describeError({ code: 'InvalidHeaderValue', message: 'The API version 2026-04-06 is not supported' }, { name: 'a' }).message, /skipApiVersionCheck/);
  assert.match(describeError({ code: 'ReadOnly', message: '"prod" is read-only.' }).message, /read-only/);
  assert.match(describeError({ code: 'AuthorizationFailure', statusCode: 403, message: 'x' }, conn).message, /expired on 2020-01-01 00:00 UTC/);
  const azNamed = { name: 'Azurite (azurite)', kind: 'azurite', endpoints: { blob: 'http://azurite:10000/devstoreaccount1' } };
  assert.match(describeError({ name: 'RestError', message: '', statusCode: 400 }, azNamed).message, /--disableProductStyleUrl/);
  assert.match(describeError({ name: 'RestError', message: '', statusCode: 500, code: 'X' }, { name: 'n', kind: 'key', endpoints: {} }).message, /answered 500 \(X\) without a message/);
  assert.match(describeError({ code: 'AuthorizationFailure', message: 'This request is not authorized' }, { name: 'k', kind: 'key' }).message, /key is wrong, or the account's firewall/);
});
