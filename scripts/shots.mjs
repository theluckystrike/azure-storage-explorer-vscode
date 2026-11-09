// README screenshots in a real VS Code (CDP on 127.0.0.1:<port>): starts its own Azurite (port 10000-10002 must be
// free), seeds a demo account, clicks "Connect to Azurite" in the welcome view, expands the tree, opens the properties
// page of a PDF, and captures dark and light shots, plus the table grid. Reports console errors too.
//   node scripts/shots.mjs --vsix dist/x.vsix --work ~/azure-storage-work/shots --azurite ~/azure-storage-work/azurite --port 9262 --out <dir>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { launch, installVsix, sleep } from './vsc.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const work = path.resolve(arg('work'));
const port = Number(arg('port', '9262'));
const outDir = path.resolve(arg('out', path.join(root, 'images')));
const cs = require(path.join(root, 'src/azure/connstr.js'));
const { Account } = require(path.join(root, 'src/azure/service.js'));

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, 'folder'), { recursive: true });
const az = spawn(path.join(path.resolve(arg('azurite')), 'node_modules/.bin/azurite'), ['--silent', '--location', path.join(work, 'azurite-data')], { stdio: 'ignore' });
process.on('exit', () => az.kill('SIGKILL'));
for (let i = 0; i < 100; i++) { const ok = await new Promise((r) => { const s = net.connect(10000, '127.0.0.1'); s.on('connect', () => { s.end(); r(true); }); s.on('error', () => r(false)); }); if (ok) break; await sleep(200); }

const p = cs.forAzurite();
const acct = new Account({ id: 'shots', name: 'shots', ...p }, p.secret);
const P = path.join(root, '..');
for (const c of ['acme-reports', 'acme-web-assets', 'ml-datasets', 'backups']) await acct.container(c).create();
const files = [
  ['2026/10/earthquakes-october-2026.pdf', path.join(P, 'pdf-viewer-vscode/test/fixtures/earthquakes-october-2026.pdf'), 'application/pdf'],
  ['2026/10/summary.csv', path.join(P, 'table-viewer-vscode/test/fixtures/semicolon.csv'), 'text/csv'],
  ['2026/10/orders.xlsx', path.join(P, 'table-viewer-vscode/test/fixtures/sample.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['2026/10/events.parquet', path.join(P, 'parquet-viewer-vscode/test/fixtures/codec-snappy.parquet'), 'application/vnd.apache.parquet'],
  ['2026/10/config.json', path.join(P, 'load-testing-vscode/schemas/load-test.schema.json'), 'application/json'],
  ['2026/09/sample.pdf', path.join(P, 'pdf-viewer-vscode/test/fixtures/sample.pdf'), 'application/pdf'],
  ['logo.png', path.join(root, 'icon.png'), 'image/png'],
  ['README.md', path.join(P, 'load-testing-vscode/README.md'), 'text/markdown'],
];
for (const [k, f, ct] of files) await acct.container('acme-reports').getBlockBlobClient(k).uploadData(fs.readFileSync(f), { blobHTTPHeaders: { blobContentType: ct }, metadata: { team: 'research' } });
await acct.container('acme-reports').getBlobClient('2026/09/sample.pdf').setAccessTier('Cool');
for (const k of ['archive/2025/q4.csv', 'archive/2025/q3.csv']) await acct.container('acme-reports').getBlockBlobClient(k).uploadData(Buffer.from('a;b\n1;2\n'));
await acct.queueClient('orders-incoming').create();
for (let i = 0; i < 12; i++) await acct.queueClient('orders-incoming').sendMessage(Buffer.from(JSON.stringify({ orderId: 4100 + i, sku: `SKU-${i * 7}`, qty: (i % 4) + 1 })).toString('base64'));
const tc = acct.tableClient('customers');
await tc.createTable();
const names = ['Ana Lima', 'Ben Okafor', 'Chen Wei', 'Dara Novak', 'Eli Haddad', 'Fatma Yilmaz', 'Goran Petrov', 'Hana Sato', 'Ivan Horvat', 'Jae Park', 'Kofi Mensah', 'Lena Fischer'];
for (let i = 0; i < names.length; i++) await tc.createEntity({ partitionKey: i % 2 ? 'eu' : 'us', rowKey: String(1000 + i), name: names[i], orders: (i * 7) % 23, spend: Math.round(((i * 37) % 900) * 1.37 * 100) / 100, vip: i % 5 === 0, since: new Date(Date.UTC(2022, i, 3)) });
await acct.container('ml-datasets').getBlockBlobClient('train/part-0001.parquet').uploadData(fs.readFileSync(path.join(P, 'parquet-viewer-vscode/test/fixtures/codec-snappy.parquet')));

const vsix = path.resolve(arg('vsix'));
console.log('install', installVsix(work, vsix).out.trim().split('\n').pop());
const results = { console: [], shots: [] };
for (const theme of (arg('themes', 'Default Dark Modern,Default Light Modern')).split(',')) {
  console.log('launch', theme);
  const vs = await launch(work, port, path.join(work, 'folder'), { 'workbench.colorTheme': theme, 'azureStorage.askForRating': false, 'workbench.activityBar.location': 'default', 'window.dialogStyle': 'custom' });
  try {
    await sleep(6000);
    const act = await vs.waitFor(() => vs.wbEval(`(() => { const a = [...document.querySelectorAll('.activitybar .action-item a, .activitybar .action-label')].find(e => /Azure Storage/.test(e.getAttribute('aria-label') || '')); if (!a) return null; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`), 15000);
    if (act) { const q = JSON.parse(act); await vs.click(q.x, q.y); } else { await vs.command('View: Show Azure Storage'); }
    await sleep(2000);
    const row = (label) => vs.wbEval(`(() => { const r = (() => { const rs = [...document.querySelectorAll('.monaco-list-row')]; const L = ${JSON.stringify(label)}; return rs.find(e => { const n = e.querySelector('.label-name'); return n && n.textContent.trim() === L; }) || rs.find(e => ((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(L)); })(); if (!r) return null; const b = r.getBoundingClientRect(); return JSON.stringify({ x: b.x + 40, y: b.y + b.height / 2 }); })()`);
    const expandRow = async (label) => {
      await vs.waitFor(() => row(label), 15000);
      const st = await vs.wbEval(`(() => { const r = (() => { const rs = [...document.querySelectorAll('.monaco-list-row')]; const L = ${JSON.stringify(label)}; return rs.find(e => { const n = e.querySelector('.label-name'); return n && n.textContent.trim() === L; }) || rs.find(e => ((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(L)); })(); return r ? String(r.getAttribute('aria-expanded')) : 'missing'; })()`);
      if (st === 'true') return;
      await clickRow(label);
      for (let i = 0; i < 20; i++) { const s2 = await vs.wbEval(`(() => { const r = (() => { const rs = [...document.querySelectorAll('.monaco-list-row')]; const L = ${JSON.stringify(label)}; return rs.find(e => { const n = e.querySelector('.label-name'); return n && n.textContent.trim() === L; }) || rs.find(e => ((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')).includes(L)); })(); return r ? String(r.getAttribute('aria-expanded')) : 'missing'; })()`); if (s2 === 'true') break; await sleep(300); }
      await sleep(800);
    };
    const clickRow = async (label, opts) => { console.log('click', label); const q = JSON.parse(await vs.waitFor(() => row(label), 15000) || 'null'); if (!q) throw new Error('row not found: ' + label); await vs.click(q.x, q.y, opts); await sleep(900); };
    if (!(await vs.waitFor(() => row('Azurite (local)'), 2000))) {
      // the welcome view button
      const btn = await vs.waitFor(() => vs.wbEval(`(() => { const a = [...document.querySelectorAll('.welcome-view-content a, .welcome-view-content .monaco-button')].find(e => /Connect to Azurite/.test(e.textContent)); if (!a) return null; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`), 10000);
      if (!btn) throw new Error('Connect to Azurite button not found');
      const q = JSON.parse(btn);
      await vs.click(q.x, q.y);
      await sleep(2000);
    }
    await expandRow('Azurite (local)');
    await expandRow('Blob Containers');
    await expandRow('acme-reports');
    await expandRow('2026');
    await expandRow('10');
    const q = JSON.parse(await row('earthquakes-october-2026.pdf'));
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: q.x + 60, y: q.y }, vs.wb);
    await sleep(400);
    const icon = await vs.waitFor(() => vs.wbEval(`(() => { const r = [...document.querySelectorAll('.monaco-list-row')].find(e => ((e.textContent || '') + (e.getAttribute('aria-label') || '')).includes('earthquakes-october-2026.pdf')); const a = r && [...r.querySelectorAll('.action-label')].find(x => /Properties/.test(x.getAttribute('aria-label') || x.title || '')); if (!a) return null; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`), 5000);
    if (!icon) throw new Error('properties icon not found');
    const ic = JSON.parse(icon);
    await vs.click(ic.x, ic.y);
    await sleep(3000);
    const wv = await vs.webview();
    if (wv) {
      await vs.wvClick(wv, `document.querySelector('[data-cmd=sas]')`);
      await sleep(2000);
    }
    await vs.command('Notifications: Clear All Notifications');
    await sleep(800);
    const name = theme.includes('Dark') ? 'screenshot-dark.png' : 'screenshot-light.png';
    await vs.shot(path.join(outDir, name));
    results.shots.push(name);
    const wv2 = await vs.webview();
    if (wv2) results[name] = JSON.parse(await vs.wvEval(wv2, `JSON.stringify({ title: document.querySelector('h1') && document.querySelector('h1').textContent, footer: !!document.getElementById('zovo-support'), sas: !!document.getElementById('sasurl'), bg: getComputedStyle(document.body).backgroundColor })`));
    if (theme.includes('Dark')) {
      await vs.command('View: Close All Editors');
      await sleep(800);
      await clickRow('acme-reports'); // collapse, so Queues and Tables are on screen
      await expandRow('Queues');
      await expandRow('Tables');
      await clickRow('customers');
      await sleep(3500);
      await vs.shot(path.join(outDir, 'screenshot-table.png'));
      results.shots.push('screenshot-table.png');
      await vs.command('View: Close All Editors');
      await clickRow('orders-incoming');
      await sleep(3500);
      await vs.shot(path.join(outDir, 'screenshot-queue.png'));
      results.shots.push('screenshot-queue.png');
    }
  } catch (e) {
    results.error = (results.error || '') + e.message + '; ';
    console.log('ERROR', theme, e.message);
    await vs.shot(path.join(outDir, 'shot-error.png')).catch((e2) => console.log('error shot failed', e2.message));
  } finally {
    results.console.push(...vs.console.filter((c) => !/Extension Host|telemetry|marketplace|gallery|update/i.test(c.text)));
    await vs.close();
  }
}
az.kill('SIGKILL');
fs.writeFileSync(path.join(outDir, 'shots-result.json'), JSON.stringify(results, null, 1));
fs.rmSync(path.join(work, 'azurite-data'), { recursive: true, force: true });
console.log(JSON.stringify(results, null, 1).slice(0, 3000));
