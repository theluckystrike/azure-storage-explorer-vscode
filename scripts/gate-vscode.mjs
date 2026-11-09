// Release gate in a real VS Code with the packaged vsix. Never touches Azure: it starts its own Azurite (npm package in
// --azurite) on 127.0.0.1, seeds real files, 10,000 blobs, a queue with 1,000 messages and a table with 50,000 entities,
// and a trap server that counts every connection (a saved connection points to it: it must get 0 at start-up).
//
//   node scripts/gate-vscode.mjs --vsix dist/x.vsix --work ~/azure-storage-work/gate --azurite ~/azure-storage-work/azurite [--code <VS Code binary>] [--keep]
//
// Launch A does every check (the runner kills and restarts Azurite through this script during an upload).
// Launch B is a fresh start of the same profile: activation time, 0 connections at start-up, then the tree again.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const vsix = path.resolve(arg('vsix'));
const work = path.resolve(arg('work'));
const azuriteDir = path.resolve(arg('azurite'));
const CODE = arg('code', '/Applications/Visual Studio Code.app/Contents/MacOS/Code');
const CLI = arg('cli', path.join(path.dirname(path.dirname(CODE)), 'Resources/app/bin/code'));
const keep = process.argv.includes('--keep');
const skipBig = process.argv.includes('--skip-big');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cs = require(path.join(root, 'src/azure/connstr.js'));
const { Account, SDK } = require(path.join(root, 'src/azure/service.js'));

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, 'files'), { recursive: true });

// ---- Azurite (own process, own data folder) ----
let az = null;
function startAzurite() {
  if (az) az.kill('SIGKILL');
  az = spawn(path.join(azuriteDir, 'node_modules/.bin/azurite'), ['--silent', '--location', path.join(work, 'azurite-data'), '--blobHost', '127.0.0.1', '--queueHost', '127.0.0.1', '--tableHost', '127.0.0.1'], { stdio: 'ignore', detached: false });
  return waitPort(10000);
}
function stopAzurite() { if (az) { az.kill('SIGKILL'); az = null; } }
process.on('exit', () => stopAzurite());
process.on('uncaughtException', (e) => { console.error(e); stopAzurite(); process.exit(3); });
process.on('unhandledRejection', (e) => { console.error(e); stopAzurite(); process.exit(3); });
async function waitPort(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.end(); r(true); }); s.on('error', () => r(false)); });
    if (ok) return true;
    await sleep(200);
  }
  throw new Error('Azurite did not start');
}
if (spawnSync('lsof', ['-ti', 'tcp:10000', '-sTCP:LISTEN']).stdout.toString().trim()) { console.error('port 10000 is busy: stop the other Azurite first'); process.exit(2); }
await startAzurite();

// ---- trap: counts connections; a saved connection's endpoints point here ----
let trapHits = 0;
const trap = net.createServer((s) => { trapHits++; s.destroy(); });
await new Promise((r) => trap.listen(0, '127.0.0.1', r));
const trapPort = trap.address().port;

// ---- seed ----
const p = cs.forAzurite();
const acct = new Account({ id: 'seed', name: 'seed', ...p }, p.secret, { timeoutMs: 60000 });
const S = SDK();
const P = path.join(root, '..');
const real = [
  ['docs/README.md', path.join(P, 'load-testing-vscode/README.md')],
  ['reports/2026/quarterly report Q3.pdf', path.join(P, 'pdf-viewer-vscode/test/fixtures/sample.pdf')],
  ['reports/earthquakes-october-2026.pdf', path.join(P, 'pdf-viewer-vscode/test/fixtures/earthquakes-october-2026.pdf')],
  ['tables/sample.xlsx', path.join(P, 'table-viewer-vscode/test/fixtures/sample.xlsx')],
  ['tables/semicolon.csv', path.join(P, 'table-viewer-vscode/test/fixtures/semicolon.csv')],
  ['tables/codec-snappy.parquet', path.join(P, 'parquet-viewer-vscode/test/fixtures/codec-snappy.parquet')],
  ['images/icon.png', path.join(root, 'icon.png')],
  ['data/config.json', path.join(P, 'load-testing-vscode/schemas/load-test.schema.json')],
  ['video/demo.mp4', path.join(P, fs.readdirSync(P).find((d) => /^video-preview/.test(d) && fs.existsSync(path.join(P, d, 'test/fixtures/demo-h264-aac.mp4'))) || 'none', 'test/fixtures/demo-h264-aac.mp4')],
  ['unicodé/日本語/メモ.txt', null, 'これはテストです。\nUnicode name with spaces and accents.\n'],
  ['notes/edit-me.json', null, '{\n  "note": "edit me"\n}\n'],
  ['hostile/zero-bytes.parquet', path.join(P, 'parquet-viewer-vscode/test/fixtures/hostile-zero-bytes.parquet')],
  ['hostile/a%2Fb.txt', null, 'a literal %2F in the name\n'],
  ['hostile\\..\\..\\escape.txt', null, 'tries to climb out of the download folder\n'],
];
const bigLog = path.join(work, 'files', 'big-50mb.log');
{
  const fd = fs.openSync(bigLog, 'w');
  let buf = '';
  for (let i = 0; i < 650000; i++) { buf += `2026-11-09T12:00:00.000Z INFO request id=${i} path=/api/orders status=200 ms=${i % 97}\n`; if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = ''; } }
  fs.writeSync(fd, buf);
  fs.closeSync(fd);
}
real.push(['logs/big-50mb.log', bigLog]);
const C = 'gate-files';
await acct.container(C).create();
const expected = {};
for (const [name, file, text] of real) {
  if (file && !fs.existsSync(file)) { console.log('missing fixture', file); continue; }
  const body = file ? fs.readFileSync(file) : Buffer.from(text);
  await acct.container(C).getBlockBlobClient(name).uploadData(body);
  const stored = name.replace(/\\/g, '/');
  const asText = body.toString('utf8').replace(/^\uFEFF/, '');
  expected[stored] = { sha: crypto.createHash('sha256').update(body).digest('hex'), textSha: crypto.createHash('sha256').update(Buffer.from(asText)).digest('hex'), size: body.length };
}
// 10,000 small blobs in one folder
const M = 'gate-many';
await acct.container(M).create();
const t0 = Date.now();
for (let i = 0; i < 10000; i += 200) await Promise.all(Array.from({ length: 200 }, (_, j) => acct.container(M).getBlockBlobClient(`many/item-${String(i + j).padStart(5, '0')}.json`).uploadData(Buffer.from(`{"i":${i + j}}`))));
console.log(`seeded ${Object.keys(expected).length} real files, 10,000 blobs in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
// queue with 1,000 messages
const qc = acct.queueClient('gate-orders');
await qc.create();
for (let i = 0; i < 1000; i += 50) await Promise.all(Array.from({ length: 50 }, (_, j) => qc.sendMessage(Buffer.from(JSON.stringify({ orderId: i + j, sku: `SKU-${(i + j) % 37}` })).toString('base64'))));
// table with 50,000 entities
const tc = acct.tableClient('gatecustomers');
await tc.createTable();
const t1 = Date.now();
const regions = ['north', 'south', 'east', 'west', 'central'];
for (let r = 0; r < regions.length; r++) {
  const ops = [];
  for (let i = 0; i < 10000; i++) ops.push(['create', { partitionKey: regions[r], rowKey: String(i).padStart(6, '0'), name: `Customer ${r * 10000 + i}`, orders: i % 50, spend: (i % 1000) / 10, vip: i % 97 === 0, since: new Date(Date.UTC(2020, 0, 1) + i * 86400000) }]);
  for (let i = 0; i < ops.length; i += 100 * 5) await Promise.all(Array.from({ length: 5 }, (_, k) => ops.slice(i + k * 100, i + (k + 1) * 100)).filter((x) => x.length).map((b) => tc.submitTransaction(b)));
}
console.log(`seeded queue 1,000 messages, table 50,000 entities in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
// SAS URLs: an account SAS and an expired container SAS
const key = new S.blob.StorageSharedKeyCredential(cs.AZURITE_ACCOUNT, cs.AZURITE_KEY);
const accountSas = S.blob.generateAccountSASQueryParameters({ expiresOn: new Date(Date.now() + 6 * 3600e3), permissions: S.blob.AccountSASPermissions.parse('rwdlacup'), resourceTypes: 'sco', services: 'bqt', version: '2025-05-05' }, key).toString();
const expiredSas = S.blob.generateBlobSASQueryParameters({ containerName: C, permissions: S.blob.ContainerSASPermissions.parse('rl'), startsOn: new Date(Date.now() - 7200e3), expiresOn: new Date(Date.now() - 3600e3), version: '2025-05-05' }, key).toString();
const containerSas = S.blob.generateBlobSASQueryParameters({ containerName: C, permissions: S.blob.ContainerSASPermissions.parse('rl'), expiresOn: new Date(Date.now() + 6 * 3600e3), version: '2025-05-05' }, key).toString();

// 2 GB file (real bytes, 1 MB random block repeated)
const big = path.join(work, 'files', 'video-2gb.bin');
if (!skipBig) {
  const block = crypto.randomBytes(1024 * 1024);
  const fd = fs.openSync(big, 'w');
  for (let i = 0; i < 2048; i++) fs.writeSync(fd, block);
  fs.closeSync(fd);
}
const syncDir = path.join(work, 'files', 'site');
fs.mkdirSync(path.join(syncDir, 'css'), { recursive: true });
fs.writeFileSync(path.join(syncDir, 'index.html'), '<!doctype html><title>site</title>');
fs.writeFileSync(path.join(syncDir, 'css', 'app.css'), 'body{margin:0}');

const manifest = {
  work, files: path.join(work, 'files'), container: C, many: M, expected, big: skipBig ? '' : big, bigSize: skipBig ? 0 : 2 * 1024 ** 3, syncDir,
  connString: `DefaultEndpointsProtocol=http;AccountName=${cs.AZURITE_ACCOUNT};AccountKey=${cs.AZURITE_KEY};BlobEndpoint=http://127.0.0.1:10000/${cs.AZURITE_ACCOUNT};QueueEndpoint=http://127.0.0.1:10001/${cs.AZURITE_ACCOUNT};TableEndpoint=http://127.0.0.1:10002/${cs.AZURITE_ACCOUNT};`,
  accountSasUrl: `http://127.0.0.1:10000/${cs.AZURITE_ACCOUNT}?${accountSas}`,
  containerSasUrl: `http://127.0.0.1:10000/${cs.AZURITE_ACCOUNT}/${C}?${containerSas}`,
  expiredSasUrl: `http://127.0.0.1:10000/${cs.AZURITE_ACCOUNT}/${C}?${expiredSas}`,
  wrongKeyConnString: `DefaultEndpointsProtocol=http;AccountName=${cs.AZURITE_ACCOUNT};AccountKey=${Buffer.alloc(64, 7).toString('base64')};BlobEndpoint=http://127.0.0.1:10000/${cs.AZURITE_ACCOUNT};`,
  trapConnString: `DefaultEndpointsProtocol=http;AccountName=trapacct;AccountKey=${cs.AZURITE_KEY};BlobEndpoint=http://127.0.0.1:${trapPort}/trapacct;QueueEndpoint=http://127.0.0.1:${trapPort}/trapacct;TableEndpoint=http://127.0.0.1:${trapPort}/trapacct;`,
  signal: path.join(work, 'signal'),
};
fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 1));

// ---- install the vsix into a private profile ----
const ud = path.join(work, 'ud'), ext = path.join(work, 'ext');
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false, 'security.workspace.trust.enabled': false, 'git.enabled': false, 'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true, 'window.dialogStyle': 'custom', 'azureStorage.requestTimeoutSeconds': 10, 'workbench.editorAssociations': { '*.pdf': 'default' },
}, null, 1));
const inst = spawnSync(CLI, ['--user-data-dir', ud, '--extensions-dir', ext, '--install-extension', vsix, '--force'], { encoding: 'utf8', timeout: 120000 });
console.log('install:', (inst.stdout + inst.stderr).trim().split('\n').pop());
const installed = fs.readdirSync(ext).find((d) => d.startsWith('zovo.zovo-azure-storage-explorer-'));
if (!installed) { console.error('not installed'); process.exit(2); }

const env = { ...process.env, ZOVO_AZX_GATE: '1', GATE_MANIFEST: path.join(work, 'manifest.json') };
const launch = (phase, out) => spawn(CODE, ['--user-data-dir', ud, '--extensions-dir', ext, '--disable-workspace-trust', '--skip-welcome', '--new-window',
  `--extensionDevelopmentPath=${path.join(ext, installed)}`, `--extensionTestsPath=${path.join(root, 'scripts/gate/runner.js')}`, manifest.files],
{ stdio: 'ignore', env: { ...env, GATE_PHASE: phase, GATE_OUT: out } });

let trapBase = 0;
const runPhase = async (phase, out, mins) => {
  trapBase = trapHits;
  fs.writeFileSync(`${manifest.signal}.trap`, '0');
  const pr = launch(phase, out);
  const timer = setTimeout(() => { console.error(`phase ${phase} timeout, killing VS Code`); spawnSync('pkill', ['-9', '-f', ud]); }, mins * 60 * 1000);
  // The runner asks this script to stop and start Azurite through files in manifest.signal.
  let busy = false;
  const poll = setInterval(async () => {
    fs.writeFileSync(`${manifest.signal}.trap`, String(trapHits - trapBase));
    if (busy) return;
    busy = true;
    for (const s of ['kill-azurite', 'start-azurite']) {
      const f = `${manifest.signal}.${s}`;
      if (fs.existsSync(f) && !fs.existsSync(f + '.done')) {
        if (s === 'kill-azurite') { stopAzurite(); await sleep(300); } else await startAzurite();
        fs.writeFileSync(f + '.done', String(Date.now()));
        console.log(`  ${phase}: ${s} at ${new Date().toISOString()}`);
      }
    }
    busy = false;
  }, 200);
  await new Promise((r) => pr.on('exit', r));
  clearTimeout(timer);
  clearInterval(poll);
  for (const f of fs.readdirSync(ud)) if (f === 'code.lock' || f.endsWith('.sock')) fs.rmSync(path.join(ud, f), { force: true });
  try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { console.error(`no results from phase ${phase}`); return { files: [], checks: [] }; }
};

if (process.argv.includes('--cursor')) {
  // Short check in another VS Code-based editor (Cursor): one launch, phase C.
  const resC = await runPhase('C', path.join(work, 'results-C.json'), 10);
  let pass = 0, fail = 0;
  console.log(`${CODE.split('/').slice(-4, -3)} ${resC.vscode} ${resC.platform}-${resC.arch} node ${resC.node}`);
  for (const f of resC.files) { f.ok ? pass++ : fail++; console.log(`${f.ok ? 'PASS' : 'FAIL'} file  ${f.file}  ${f.detail}`); }
  for (const c of resC.checks) { c.ok ? pass++ : fail++; console.log(`${c.ok ? 'PASS' : 'FAIL'} check ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`); }
  console.log(`gate: ${pass} pass, ${fail} fail`);
  fs.writeFileSync(path.join(work, 'results-final.json'), JSON.stringify(resC, null, 1));
  stopAzurite(); trap.close();
  fs.rmSync(path.join(work, 'azurite-data'), { recursive: true, force: true });
  fs.rmSync(path.join(work, 'files'), { recursive: true, force: true });
  if (!keep) { fs.rmSync(ud, { recursive: true, force: true }); fs.rmSync(ext, { recursive: true, force: true }); }
  process.exit(fail ? 1 : 0);
}
// warm-up launch: the first start of a fresh profile is slow to persist state (NBUILD5 lesson)
await runPhase('W', path.join(work, 'results-W.json'), 3);
for (let i = 0; i < 30 && spawnSync('pgrep', ['-f', ud]).status === 0; i++) await sleep(1000);
await sleep(1500);
const tA = Date.now();
const resA = await runPhase('A', path.join(work, 'results-A.json'), 40);
console.log(`phase A ${Math.round((Date.now() - tA) / 1000)} s, step ${resA.step}`);
// The restart check (saved connections, 0 connections at start-up) runs in normal launches: scripts/restart-gate.mjs.
// Launches with --extensionTestsPath never write globalState to disk, so a second test-mode launch cannot see them.
const res = { ...resA, stepA: resA.step };
const check = (name, ok, detail) => res.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
// downloaded 2 GB file equals the source
if (!skipBig && resA.bigDownload) {
  const h = (f) => new Promise((r) => { const x = crypto.createHash('sha256'); fs.createReadStream(f).on('data', (d) => x.update(d)).on('end', () => r(x.digest('hex'))); });
  const [a1, b1] = await Promise.all([h(big), h(resA.bigDownload)]);
  check('2 GB: the downloaded file has the same sha256 as the uploaded one', a1 === b1, a1.slice(0, 16));
}
let pass = 0, fail = 0;
console.log(`VS Code ${res.vscode} ${res.platform}-${res.arch}`);
for (const f of res.files) { f.ok ? pass++ : fail++; console.log(`${f.ok ? 'PASS' : 'FAIL'} file  ${f.file.padEnd(42)} ${String(f.ms).padStart(6)} ms  ${f.detail}`); }
for (const c of res.checks) { c.ok ? pass++ : fail++; console.log(`${c.ok ? 'PASS' : 'FAIL'} check ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`); }
console.log(`gate: ${pass} pass, ${fail} fail, ${res.files.length} files`);
fs.writeFileSync(path.join(work, 'results-final.json'), JSON.stringify(res, null, 1));

// ---- teardown: Azurite data, big files, profile ----
stopAzurite();
trap.close();
fs.rmSync(path.join(work, 'azurite-data'), { recursive: true, force: true });
fs.rmSync(path.join(work, 'files'), { recursive: true, force: true });
fs.rmSync(path.join(work, 'downloads'), { recursive: true, force: true });
if (!keep) { fs.rmSync(ud, { recursive: true, force: true }); fs.rmSync(ext, { recursive: true, force: true }); }
process.exit(fail ? 1 : 0);
