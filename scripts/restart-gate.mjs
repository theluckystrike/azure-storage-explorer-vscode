// Start-up check in a normal VS Code launch (no test runner: test-mode launches never write globalState to disk).
// Launch 1 adds two connections through the real UI: "Connect to Azurite" and a connection string whose endpoints
// point to a trap server that counts every TCP connection. VS Code quits. Launch 2 starts the same profile: the trap
// must get 0 connections while VS Code starts and shows the saved connections, and only the user's expand reaches it.
//   node scripts/restart-gate.mjs --vsix dist/x.vsix --work ~/azure-storage-work/rg --azurite ~/azure-storage-work/azurite --port 9267
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launch, installVsix, sleep } from './vsc.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const work = path.resolve(arg('work'));
const port = Number(arg('port', '9267'));
const cs = require(path.join(root, 'src/azure/connstr.js'));
if (spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).stdout.toString().trim()) { console.error(`port ${port} is busy`); process.exit(2); }
if (spawnSync('lsof', ['-ti', 'tcp:10000', '-sTCP:LISTEN']).stdout.toString().trim()) { console.error('port 10000 is busy'); process.exit(2); }
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, 'folder'), { recursive: true });
const az = spawn(path.join(path.resolve(arg('azurite')), 'node_modules/.bin/azurite'), ['--silent', '--location', path.join(work, 'azurite-data')], { stdio: 'ignore' });
process.on('exit', () => az.kill('SIGKILL'));
for (let i = 0; i < 100; i++) { const ok = await new Promise((r) => { const s = net.connect(10000, '127.0.0.1'); s.on('connect', () => { s.end(); r(true); }); s.on('error', () => r(false)); }); if (ok) break; await sleep(200); }
const { Account } = require(path.join(root, 'src/azure/service.js'));
const p = cs.forAzurite();
await new Account({ id: 's', name: 's', ...p }, p.secret).container('restart-check').create();

let hits = 0;
const trap = net.createServer((s) => { hits++; s.destroy(); });
await new Promise((r) => trap.listen(0, '127.0.0.1', r));
const trapCs = `DefaultEndpointsProtocol=http;AccountName=trapacct;AccountKey=${cs.AZURITE_KEY};BlobEndpoint=http://127.0.0.1:${trap.address().port}/trapacct;`;

console.log('install', installVsix(work, path.resolve(arg('vsix'))).out.trim().split('\n').pop());
const results = { checks: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail: String(detail || '') }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`); };
const settings = { 'azureStorage.askForRating': false, 'window.dialogStyle': 'custom', 'azureStorage.requestTimeoutSeconds': 5 };
const rowExpr = (label) => `(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find(e => ((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(${JSON.stringify(label)})); if (!r) return null; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 40, y: b.y + b.height / 2, exp: r.getAttribute('aria-expanded') }); })()`;
const openView = async (vs) => {
  const act = await vs.waitFor(() => vs.wbEval(`(() => { const a = [...document.querySelectorAll('.activitybar .action-label')].find(e => /Azure Storage/.test(e.getAttribute('aria-label') || '')); if (!a) return null; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2, on: a.closest('.action-item').classList.contains('checked') }); })()`), 20000);
  if (!act) throw new Error('Azure Storage icon not found');
  const q = JSON.parse(act);
  if (!q.on) await vs.click(q.x, q.y);
  await sleep(1500);
};
const expand = async (vs, label) => {
  const r = await vs.waitFor(() => vs.wbEval(rowExpr(label)), 15000);
  if (!r) throw new Error('row not found: ' + label);
  const q = JSON.parse(r);
  if (q.exp !== 'true') await vs.click(q.x, q.y);
  await sleep(1500);
};

// ---- launch 1: add the connections through the UI ----
let vs = await launch(work, port, path.join(work, 'folder'), settings);
try {
  await sleep(5000);
  await openView(vs);
  await vs.command('Azure Storage: Connect to Azurite');
  await sleep(1500);
  await vs.command('Azure Storage: Add Connection');
  await vs.type('Connection string'); await sleep(500); await vs.key('Enter', 'Enter'); await sleep(800);
  await vs.type(trapCs); await vs.key('Enter', 'Enter'); await sleep(800);
  await vs.wbEval(`(() => { const i = document.querySelector('.quick-input-widget input'); if (i) { i.select(); } return 1; })()`);
  await vs.type('Trap account'); await vs.key('Enter', 'Enter'); await sleep(800);
  await vs.key('Enter', 'Enter'); await sleep(1500); // "Read and write"
  const rows = await vs.wbEval(`[...document.querySelectorAll('.monaco-list-row')].map(e => e.textContent).join(' | ')`);
  check('launch 1: both connections added through the UI (Connect to Azurite, Add Connection > Connection string)', /Azurite \(local\)/.test(rows) && /Trap account/.test(rows), rows);
  check('launch 1: adding a connection makes no request to it', hits === 0, `${hits} connections`);
} finally { await vs.close(); }
await sleep(2000);

// ---- launch 2: start-up ----
const before = hits;
vs = await launch(work, port, path.join(work, 'folder'), settings);
try {
  await sleep(6000);
  await openView(vs);
  await sleep(4000);
  const rows = await vs.wbEval(`[...document.querySelectorAll('.monaco-list-row')].map(e => e.textContent).join(' | ')`);
  check('launch 2: saved connections are listed after a restart', /Azurite \(local\)/.test(rows) && /Trap account/.test(rows), rows);
  check('launch 2: 0 connections to the trap while VS Code starts and shows the saved connections', hits - before === 0, `${hits - before} connections in about 10 s`);
  await expand(vs, 'Trap account');
  await expand(vs, 'Blob Containers');
  await sleep(6000);
  const after = hits - before;
  const msg = await vs.wbEval(`[...document.querySelectorAll('.monaco-list-row')].map(e => e.textContent).filter(t => /refused|answer|time|failed|connect/i.test(t)).join(' | ')`);
  check('launch 2: the trap is contacted only after the user expands it, and the tree shows a message', after > 0 && !!msg, `${after} connections; ${msg}`);
  await expand(vs, 'Azurite (local)');
  const azBlob = await vs.wbEval(`(() => { const rows = [...document.querySelectorAll('.monaco-list-row')]; const i = rows.findIndex(e => e.textContent.includes('Azurite (local)')); return i >= 0 && rows[i + 1] ? rows[i + 1].textContent : ''; })()`);
  if (/Blob Containers/.test(azBlob)) {
    const rs = await vs.wbEval(rowExpr('Azurite (local)'));
    void rs;
  }
  const bc = await vs.wbEval(`(() => { const rows = [...document.querySelectorAll('.monaco-list-row')]; const i = rows.findIndex(e => e.textContent.includes('Azurite (local)')); if (i < 0) return null; const r = rows[i + 1]; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 40, y: b.y + b.height / 2, exp: r.getAttribute('aria-expanded') }); })()`);
  if (bc) { const q = JSON.parse(bc); if (q.exp !== 'true') await vs.click(q.x, q.y); }
  const listed = await vs.waitFor(() => vs.wbEval(`[...document.querySelectorAll('.monaco-list-row')].some(e => e.textContent.includes('restart-check'))`), 15000);
  check('launch 2: Azurite containers list on expand after the restart', !!listed);
  await vs.shot(path.join(work, 'restart.png'));
} finally { await vs.close(); }
trap.close();
fs.writeFileSync(path.join(work, 'restart-results.json'), JSON.stringify(results, null, 1));
fs.rmSync(path.join(work, 'azurite-data'), { recursive: true, force: true });
const fail = results.checks.filter((c) => !c.ok).length;
console.log(`restart gate: ${results.checks.length - fail} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
