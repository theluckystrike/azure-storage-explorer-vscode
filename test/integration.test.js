'use strict';
// Against a running Azurite (127.0.0.1:10000-10002, or AZX_AZURITE_HOST). Skipped when Azurite does not answer.
// Large files go to ~/azure-storage-work (never the temp folder) and are deleted at the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const cs = require('../src/azure/connstr');
const { Account } = require('../src/azure/service');
const blob = require('../src/azure/blob');
const qt = require('../src/azure/queuetable');
const { planUpload, planDownload, applyPlan, usageReport } = require('../src/azure/sync');

const HOST = process.env.AZX_AZURITE_HOST || '127.0.0.1';
const WORK = path.join(os.homedir(), 'azure-storage-work', 'it-' + process.pid);
const RUN = crypto.randomBytes(3).toString('hex');
const C = `it-${RUN}`;

function up() {
  return new Promise((resolve) => { const s = net.connect(10000, HOST); s.on('connect', () => { s.end(); resolve(true); }); s.on('error', () => resolve(false)); s.setTimeout(1000, () => { s.destroy(); resolve(false); }); });
}

let acct;
const skip = { skip: false };
test.before(async () => {
  if (!(await up())) { skip.skip = 'Azurite is not running'; return; }
  const p = cs.forAzurite(HOST);
  acct = new Account({ id: 'it', name: 'Azurite', ...p }, p.secret, { timeoutMs: 10000 });
  fs.mkdirSync(WORK, { recursive: true });
  await blob.createContainer(acct, C);
});

test.after(async () => {
  if (acct) {
    await blob.deleteContainer(acct, C).catch(() => {});
    await qt.deleteQueue(acct, `q-${RUN}`).catch(() => {});
    await qt.deleteTable(acct, `t${RUN}x`).catch(() => {});
  }
  fs.rmSync(WORK, { recursive: true, force: true });
});

const t = (name, fn) => test(name, async (ctx) => { if (skip.skip) return ctx.skip(skip.skip); return fn(ctx); });

t('paging: 2,500 blobs in one folder come in pages of 1,000 with a continuation token', async () => {
  const cc = acct.container(C);
  const names = Array.from({ length: 2500 }, (_, i) => `many/f${String(i).padStart(5, '0')}.txt`);
  for (let i = 0; i < names.length; i += 100) await Promise.all(names.slice(i, i + 100).map((n) => cc.getBlockBlobClient(n).upload('x', 1)));
  let marker;
  let total = 0;
  let pages = 0;
  do { const r = await blob.listLevel(acct, C, 'many/', { marker, pageSize: 1000 }); total += r.blobs.length; pages++; marker = r.next; assert.ok(r.blobs.length <= 1000); } while (marker);
  assert.equal(total, 2500);
  assert.equal(pages, 3);
  const top = await blob.listLevel(acct, C, '');
  assert.deepEqual(top.folders, ['many/']);
});

t('names with Unicode, spaces, "%2F", "+" and "#" round-trip; the hostile ".." name never leaves the folder', async () => {
  const names = ['ünï cødé/日本 語.txt', 'with space/a b.txt', 'pct/a%2Fb.txt', 'plus/a+b#c.txt'];
  for (const n of names) await acct.container(C).getBlockBlobClient(n).upload(n, Buffer.byteLength(n));
  // Hostile names: the service refuses some ("../x" is InvalidResourceName); the ones it accepts must stay inside.
  for (const n of ['../escape.txt', 'a/../../b.txt', '..\\..\\escape.txt', 'x/.. /y.txt', '%2E%2E/%2E%2E/z.txt']) {
    await acct.container(C).getBlockBlobClient(n).upload('h', 1).catch((e) => assert.equal(e.code, 'InvalidResourceName', n));
  }
  for (const n of names.slice(0, 4)) {
    const p = await blob.properties(acct, C, n);
    assert.equal(p.size, Buffer.byteLength(n), n);
    const dest = path.join(WORK, 'dl', crypto.createHash('md5').update(n).digest('hex'));
    await blob.downloadFile(acct, C, n, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), n);
  }
  const { safeLocalPath } = require('../src/azure/paths');
  const listed = [];
  await blob.listAll(acct, C, '', (items) => listed.push(...items.map((b) => b.name)));
  for (const n of listed) {
    const r = safeLocalPath(path.join(WORK, 'safe'), n);
    if (!r.error) assert.ok(r.path.startsWith(path.join(WORK, 'safe') + path.sep), n);
  }
});

t('streamed block upload and download of 96 MB: same bytes, progress, memory stays flat', async () => {
  const file = path.join(WORK, 'big.bin');
  const fd = fs.openSync(file, 'w');
  const chunk = crypto.randomBytes(1024 * 1024);
  for (let i = 0; i < 96; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  let lastProgress = 0;
  const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  await blob.uploadFile(acct, C, 'big/big.bin', file, { blockSizeMB: 8, concurrency: 4, singleShotMB: 32, onProgress: (n) => { lastProgress = n; } });
  assert.equal(lastProgress, 96 * 1024 * 1024);
  const out = path.join(WORK, 'big-down.bin');
  await blob.downloadFile(acct, C, 'big/big.bin', out, { onProgress: () => {} });
  clearInterval(iv);
  const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.equal(h(out), h(file));
  assert.ok(!fs.existsSync(out + '.part'));
  assert.ok(peak - rss0 < 200 * 1024 * 1024, `rss grew ${((peak - rss0) / 1048576).toFixed(0)} MB`);
});

t('cancel stops an upload and a download; a cancelled download leaves no file', async () => {
  const file = path.join(WORK, 'cancel.bin');
  fs.writeFileSync(file, crypto.randomBytes(40 * 1024 * 1024));
  const ac = new AbortController();
  const p = blob.uploadFile(acct, C, 'cancel/c.bin', file, { blockSizeMB: 1, concurrency: 1, singleShotMB: 1, signal: ac.signal, onProgress: (n) => { if (n > 2 * 1024 * 1024) ac.abort(); } });
  await assert.rejects(p, (e) => e.code === 'Aborted');
  await blob.uploadFile(acct, C, 'cancel/c.bin', file, { blockSizeMB: 8 });
  const ac2 = new AbortController();
  const dest = path.join(WORK, 'cancel-down.bin');
  const d = blob.downloadFile(acct, C, 'cancel/c.bin', dest, { signal: ac2.signal, onProgress: (n) => { if (n > 1024 * 1024) ac2.abort(); } });
  await assert.rejects(d, (e) => e.code === 'Aborted');
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.part'));
});

t('properties, content type and cache control, tier, SAS URL, rename by copy, delete', async () => {
  await acct.container(C).getBlockBlobClient('p/report.json').upload('{"a":1}', 7);
  await blob.setHeaders(acct, C, 'p/report.json', { contentType: 'application/json', cacheControl: 'max-age=60' });
  let p = await blob.properties(acct, C, 'p/report.json');
  assert.equal(p.contentType, 'application/json');
  assert.equal(p.cacheControl, 'max-age=60');
  await blob.setTier(acct, C, 'p/report.json', 'Cool');
  p = await blob.properties(acct, C, 'p/report.json');
  assert.equal(p.tier, 'Cool');
  const url = await blob.generateSas(acct, { container: C, name: 'p/report.json', permissions: 'r', expiresOn: new Date(Date.now() + 3600e3) });
  assert.match(url, /sp=r/);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"a":1}');
  const bad = await fetch(url.replace(/sig=[^&]+/, 'sig=AAAA'));
  assert.equal(bad.status, 403);
  await blob.renameBlob(acct, C, 'p/report.json', 'p/renamed.json');
  assert.equal(await blob.exists(acct, C, 'p/report.json'), false);
  p = await blob.properties(acct, C, 'p/renamed.json');
  assert.equal(p.contentType, 'application/json', 'copy keeps the headers');
  await blob.deleteBlob(acct, C, 'p/renamed.json');
  assert.equal(await blob.exists(acct, C, 'p/renamed.json'), false);
  const sd = await blob.softDeleteInfo(acct);
  assert.ok(sd && typeof sd.enabled === 'boolean');
});

t('a container SAS connection lists and reads only its container; an expired SAS fails with a clear code', async () => {
  const url = await blob.generateSas(acct, { container: C, permissions: 'rl', expiresOn: new Date(Date.now() + 3600e3) });
  const parsed = cs.fromSasUrl(url);
  const sasAcct = new Account({ id: 's', name: 'sas', ...parsed }, parsed.secret);
  const r = await blob.listContainers(sasAcct);
  assert.deepEqual(r.items.map((x) => x.name), [C]);
  const lvl = await blob.listLevel(sasAcct, C, '');
  assert.ok(lvl.folders.includes('many/'));
  const old = await blob.generateSas(acct, { container: C, permissions: 'rl', expiresOn: new Date(Date.now() - 3600e3), startsOn: new Date(Date.now() - 7200e3) });
  const op = cs.fromSasUrl(old);
  assert.equal(op.sasInfo.expired, true);
  const oldAcct = new Account({ id: 'o', name: 'old', ...op }, op.secret, { maxTries: 1 });
  await assert.rejects(blob.listLevel(oldAcct, C, ''), (e) => e.statusCode === 403);
});

t('a wrong account key is refused with 403 AuthenticationFailed', async () => {
  const p = cs.forAzurite(HOST);
  const badKey = Buffer.alloc(64, 7).toString('base64');
  const a = new Account({ id: 'w', name: 'wrong', ...p }, { accountKey: badKey }, { maxTries: 1 });
  await assert.rejects(blob.listContainers(a), (e) => e.statusCode === 403);
});

t('read-only connection: every write is refused before any request', async () => {
  const p = cs.forAzurite(HOST);
  const ro = new Account({ id: 'r', name: 'prod', readOnly: true, ...p }, p.secret);
  await assert.rejects(blob.deleteBlob(ro, C, 'many/f00000.txt'), (e) => e.code === 'ReadOnly');
  await assert.rejects(blob.setTier(ro, C, 'many/f00000.txt', 'Cool'), (e) => e.code === 'ReadOnly');
  await assert.rejects(qt.send(ro, 'whatever', 'x'), (e) => e.code === 'ReadOnly');
  assert.equal(await blob.exists(acct, C, 'many/f00000.txt'), true);
});

t('queues: send text and Base64, peek 32 without changing anything, dequeue one, clear', async () => {
  const name = `q-${RUN}`;
  await qt.createQueue(acct, name);
  for (let i = 0; i < 40; i++) await qt.send(acct, name, JSON.stringify({ i }), { encoding: i % 2 ? 'base64' : 'text' });
  const peek = await qt.peek(acct, name, 32);
  assert.equal(peek.length, 32);
  assert.equal(peek[1].decoded, '{"i":1}');
  assert.equal(peek[0].decoded, null);
  assert.equal((await qt.peek(acct, name, 32)).length, 32, 'peek changes nothing');
  const m = await qt.dequeue(acct, name);
  assert.equal(m.text, '{"i":0}');
  const info = await qt.queueInfo(acct, name);
  assert.equal(info.approximateMessagesCount, 39);
  await assert.rejects(qt.send(acct, name, 'x'.repeat(70000)), /64 KB/);
  await qt.clear(acct, name);
  assert.equal((await qt.peek(acct, name)).length, 0);
});

t('tables: create, query with an OData filter and paging, merge one property, ETag conflict, delete', async () => {
  const name = `t${RUN}x`;
  await qt.createTable(acct, name);
  const tc = acct.tableClient(name);
  const batch = [];
  for (let i = 0; i < 1200; i++) batch.push({ partitionKey: i % 2 ? 'odd' : 'even', rowKey: String(i).padStart(5, '0'), n: i, label: `row ${i}` });
  for (let i = 0; i < batch.length; i += 100) {
    const byPk = {};
    for (const e of batch.slice(i, i + 100)) (byPk[e.partitionKey] = byPk[e.partitionKey] || []).push(['create', e]);
    for (const ops of Object.values(byPk)) await tc.submitTransaction(ops);
  }
  const page1 = await qt.query(acct, name, { filter: "PartitionKey eq 'odd' and n gt 100", top: 500 });
  assert.equal(page1.rows.length, 500);
  assert.ok(page1.next);
  const page2 = await qt.query(acct, name, { filter: "PartitionKey eq 'odd' and n gt 100", top: 500, marker: page1.next });
  assert.equal(page1.rows.length + page2.rows.length, 550);
  const r = page1.rows[0];
  assert.equal(r.props.n.type, 'Int32');
  await qt.updateEntity(acct, name, { partitionKey: r.partitionKey, rowKey: r.rowKey, etag: '*', props: { label: { type: 'String', value: 'edited' } } }, 'Merge');
  const after = (await qt.query(acct, name, { filter: `PartitionKey eq 'odd' and RowKey eq '${r.rowKey}'` })).rows[0];
  assert.equal(after.props.label.value, 'edited');
  assert.equal(after.props.n.value, r.props.n.value, 'merge keeps the other properties');
  await assert.rejects(qt.updateEntity(acct, name, { ...after, etag: r.etag }, 'Replace'), (e) => e.statusCode === 412);
  await qt.createEntity(acct, name, { partitionKey: 'new', rowKey: '1', props: { when: { type: 'DateTime', value: '2026-11-09T00:00:00Z' }, big: { type: 'Int64', value: '9007199254740993' } } });
  const n = (await qt.query(acct, name, { filter: "PartitionKey eq 'new'" })).rows[0];
  assert.equal(n.props.big.value, '9007199254740993');
  assert.equal(n.props.when.type, 'DateTime');
  await qt.deleteEntity(acct, name, 'new', '1');
  assert.equal((await qt.query(acct, name, { filter: "PartitionKey eq 'new'" })).rows.length, 0);
  await assert.rejects(qt.query(acct, name, { filter: 'this is not odata' }), (e) => e.statusCode === 400);
});

t('Pro tools: sync plan is a dry run (nothing changes until apply), then upload, download and mirror', async () => {
  const src = path.join(WORK, 'sync-src');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'A');
  fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'B');
  fs.mkdirSync(path.join(src, '.git'));
  fs.writeFileSync(path.join(src, '.git', 'HEAD'), 'x');
  let plan = await planUpload({ acct, container: C, prefix: 'site', root: src, excludes: ['.git/**'], deleteExtra: true });
  assert.equal(plan.create.length, 2);
  assert.equal(await blob.exists(acct, C, 'site/a.txt'), false, 'the plan changed nothing');
  let r = await applyPlan(plan, { acct, concurrency: 2 });
  assert.equal(r.failed.length, 0);
  plan = await planUpload({ acct, container: C, prefix: 'site', root: src, excludes: ['.git/**'], deleteExtra: true });
  assert.equal(plan.same, 2);
  assert.equal(plan.create.length + plan.change.length + plan.remove.length, 0);
  await acct.container(C).getBlockBlobClient('site/extra.txt').upload('E', 1);
  fs.writeFileSync(path.join(src, 'a.txt'), 'AA');
  plan = await planUpload({ acct, container: C, prefix: 'site/', root: src, excludes: ['.git/**'], deleteExtra: true });
  assert.deepEqual(plan.change.map((x) => x.key), ['site/a.txt']);
  assert.deepEqual(plan.remove.map((x) => x.key), ['site/extra.txt']);
  r = await applyPlan(plan, { acct });
  assert.equal(r.deleted, 1);
  const dst = path.join(WORK, 'sync-dst');
  const dp = await planDownload({ acct, container: C, prefix: 'site/', root: dst, excludes: [], deleteExtra: false });
  assert.equal(dp.create.length, 2);
  await applyPlan(dp, { acct });
  assert.equal(fs.readFileSync(path.join(dst, 'sub', 'b.txt'), 'utf8'), 'B');
  const rep = await usageReport({ acct, container: C, prefix: '' });
  assert.ok(rep.count > 2500 && rep.bytes > 96 * 1024 * 1024);
  assert.ok(rep.folders.find((f) => f.folder === 'big/'));
  assert.ok(rep.monthly > 0);
  assert.equal(rep.largest[0].name, 'big/big.bin');
});
