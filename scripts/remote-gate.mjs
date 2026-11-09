// Remote check: the vsix installed in VS Code's server inside a Linux container (gitpod/openvscode-server, the same
// split as GitHub Codespaces: browser UI, extension host on the remote Linux side). Azurite runs on the Mac and is
// reached from the container as host "host.lima.internal" (colima), with the "Azurite on another host" entry.
// The UI is driven over CDP in a headless agent browser (~/bin/agent-chrome).
//
//   node scripts/remote-gate.mjs --cdp 9262 --url http://127.0.0.1:3000/?folder=/home/workspace --out <dir> --host host.lima.internal
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('cdp', '9262'));
const url = arg('url');
const out = path.resolve(arg('out'));
const host = arg('host', 'host.lima.internal');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });
const log = [];
const note = (s) => { log.push(`${new Date().toISOString().slice(11, 19)} ${s}`); console.log(s); };

const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
const key = async (k, code, mods = 0) => {
  const vk = { Enter: 13, Escape: 27, F1: 112, ArrowDown: 40 }[k] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, modifiers: mods, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(80);
};
const mouse = async (x, y, count = 1) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let k = 1; k <= count; k++) { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: k }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: k }); }
  await sleep(200);
};
const type = async (t) => { await send('Input.insertText', { text: t }); };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, 'base64')); note(`screenshot ${name}`); };
const waitFor = async (expr, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(300); } return false; };
const command = async (title) => {
  await ev(`(document.querySelector('.part.statusbar') || document.body).focus && 1`);
  await key('F1', 'F1');
  await waitFor(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) input')`, 5000);
  await type('>' === title[0] ? title.slice(1) : title);
  await sleep(700);
  await key('Enter', 'Enter');
  await sleep(800);
};
const pickQuick = async (text) => { await type(text); await sleep(600); await key('Enter', 'Enter'); await sleep(800); };
const clickText = async (text, sel = '.monaco-list-row') => {
  const r = await ev(`(() => { const r = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => ((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(${JSON.stringify(text)})); if (!r) return null; r.scrollIntoView && r.scrollIntoView({ block: 'nearest' }); const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2 }); })()`);
  if (!r) { note(`not found: ${text}`); return false; }
  const q = JSON.parse(r);
  await mouse(q.x, q.y);
  await sleep(700);
  return true;
};
const expand = async (text) => {
  const st = await ev(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find((e) => ((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(${JSON.stringify(text)})); return r ? String(r.getAttribute('aria-expanded')) : 'missing'; })()`);
  if (st === 'true') return true;
  if (st === 'missing') { const ok = await waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((e) => e.textContent.includes(${JSON.stringify(text)}))`, 20000); if (!ok) { note(`not found: ${text}`); return false; } }
  return clickText(text);
};
const rows = async () => ev(`[...document.querySelectorAll('.pane-body .monaco-list-row')].map((e) => e.getAttribute('aria-label') || e.textContent).join(' | ')`);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const results = { url, host, checks: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail: String(detail || '').slice(0, 400) }); note(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail ? '(' + String(detail).slice(0, 200) + ')' : ''}`); };

check('workbench loaded in the browser', await waitFor(`!!document.querySelector('.monaco-workbench .activitybar')`, 60000));
await sleep(4000);
// The workspace trust dialog (Codespaces open trusted): answer "Yes" (--trust no: Restricted Mode).
const TRUST = arg('trust', 'yes') === 'yes' ? 'Yes, I trust' : "No, I don't trust";
if (await waitFor(`[...document.querySelectorAll('.monaco-dialog-box .monaco-button')].some((b) => b.textContent.includes(${JSON.stringify(TRUST)}))`, 8000)) {
  await ev(`[...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find((b) => b.textContent.includes(${JSON.stringify(TRUST)})).click()`);
  note(`workspace trust: answered ${TRUST}`);
  await sleep(2500);
}
await key('Escape', 'Escape');
check('the Azure Storage icon is in the activity bar', await waitFor(`[...document.querySelectorAll('.activitybar .action-label')].some((e) => /Azure Storage/.test(e.getAttribute('aria-label') || ''))`, 15000));
const remoteExt = await ev(`document.title`);
note(`title: ${remoteExt}`);
await clickText('Azure Storage', '.activitybar .action-label');
await sleep(1500);
await command('Azure Storage: Add Connection');
await pickQuick('Azurite on another host');
await ev(`(() => { const i = document.querySelector('.quick-input-widget input'); if (i) { i.select(); } return true; })()`);
await type(host);
await key('Enter', 'Enter');
await sleep(2500);
const t0 = Date.now();
const listed = await waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((e) => e.textContent.includes(${JSON.stringify('Azurite (' + host + ')')}))`, 20000);
check('"Azurite on another host" saved and shown in the Storage Accounts view (remote extension host)', listed, await rows());
await expand(`Azurite (${host})`);
await sleep(1000);
await expand('Blob Containers');
const cont = await waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((e) => e.textContent.includes('remote-demo'))`, 30000);
check('containers listed from Azurite through the container network', cont, `${Date.now() - t0} ms: ${await rows()}`);
await expand('remote-demo');
await sleep(1500);
await expand('reports');
const blobOk = await waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((e) => e.textContent.includes('summary.json'))`, 20000);
check('folders and blobs listed with size and tier', blobOk, await rows());
await waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((e) => e.textContent.includes('summary.json'))`, 15000);
await clickText('summary.json');
const opened = await waitFor(`[...document.querySelectorAll('.tab')].some((e) => e.textContent.includes('summary.json')) && [...document.querySelectorAll('.view-line')].some((e) => /container\\s*test/.test(e.textContent.replace(/\\u00a0/g, ' ')))`, 20000);
check('a JSON blob opens in an editor tab (azblob: file system on the remote side)', opened, await ev(`[...document.querySelectorAll('.view-line')].map((e) => e.textContent).join(' ').slice(0, 200)`));
await shot('remote-blob.png');
await expand('Queues');
await sleep(1000);
await waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((e) => e.textContent.includes('remote-jobs'))`, 15000);
await clickText('remote-jobs');
const qOk = await waitFor(`[...document.querySelectorAll('.tab')].some((e) => e.textContent.includes('remote-jobs'))`, 20000);
await sleep(2500);
check('queue page opens (webview in the browser, data from the remote host)', qOk);
await shot('remote-queue.png');
await expand('Tables');
await sleep(1000);
await waitFor(`[...document.querySelectorAll('.monaco-list-row')].some((e) => e.textContent.includes('remotecustomers'))`, 15000);
await clickText('remotecustomers');
const tOk = await waitFor(`[...document.querySelectorAll('.tab')].some((e) => e.textContent.includes('remotecustomers'))`, 20000);
await sleep(3000);
check('table page opens', tOk);
await shot('remote-table.png');
results.log = log;
fs.writeFileSync(path.join(out, 'remote-results.json'), JSON.stringify(results, null, 1));
await send('Page.close');
ws.close();
process.exit(results.checks.every((c) => c.ok) ? 0 : 1);
