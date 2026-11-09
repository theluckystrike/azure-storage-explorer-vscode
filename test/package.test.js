'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pk = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const Module = require('module');

// A tiny vscode stand-in, enough to load the modules that need it.
const fakeVscode = { window: {}, commands: { executeCommand() {}, registerCommand: () => ({ dispose() {} }) }, workspace: { getConfiguration: () => ({ get: (k, d) => d }) }, Uri: { parse: (s) => ({ toString: () => s }) } };
const origLoad = Module._load;
Module._load = function load(req, ...a) { return req === 'vscode' ? fakeVscode : origLoad.call(this, req, ...a); };
const panels = require('../src/panels');
const { createPro, FREE_TRIES, FEATURES, PRO_ENABLED } = require('../src/pro');

test('every command registered in the code is listed in package.json and the other way round', () => {
  const src = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8');
  const registered = new Set([...src.matchAll(/reg\('(azureStorage\.[\w]+)'/g)].map((m) => m[1]));
  for (const c of ['supportDeveloper', 'moreViewers', 'unlockWithSponsors', 'getPro', 'enterLicenseKey', 'removeLicense', 'payWithPayPal']) registered.add('azureStorage.' + c);
  const listed = new Set(pk.contributes.commands.map((c) => c.command));
  for (const c of registered) assert.ok(listed.has(c), `${c} missing in package.json`);
  for (const c of listed) assert.ok(registered.has(c), `${c} listed but never registered`);
  for (const m of Object.values(pk.contributes.menus).flat()) assert.ok(listed.has(m.command) || m.command === 'azureStorage.transfers.focus', `menu ${m.command}`);
});

test('engines floor for Cursor and Windsurf; the exact search phrases stay whole and first in the name', () => {
  assert.strictEqual(pk.engines.vscode, '^1.90.0');
  assert.strictEqual(pk.devDependencies['@types/vscode'], '~1.90.0');
  const name = pk.displayName;
  assert.ok(name.startsWith('Azure Storage & Azure Blob Storage Explorer'), name);
  for (const phrase of ['Azure Storage', 'Azure Blob Storage', 'Blob Storage', 'Storage Explorer', 'Azurite']) assert.ok(name.includes(phrase), phrase);
  for (const k of ['azure storage', 'azure blob storage', 'blob storage', 'azurite', 'table storage', 'queue storage']) assert.ok(pk.keywords.includes(k), k);
  assert.ok(/not made by microsoft/i.test(pk.description), 'description says it is not by Microsoft');
  assert.deepStrictEqual(Object.keys(pk.dependencies).sort(), ['@azure/data-tables', '@azure/storage-blob', '@azure/storage-queue']);
  assert.ok(!pk.activationEvents.includes('*') && !pk.activationEvents.includes('onStartupFinished'), 'no start-up activation');
});

test('README first screen: not affiliated with Microsoft, no sign-in, screenshot, network statement', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const first = readme.split('\n## ')[0];
  assert.match(first, /Not made by or affiliated with Microsoft/);
  assert.match(first, /No Azure sign-in is needed/);
  assert.match(first, /connects only to the storage endpoints you add/);
  assert.match(first, /!\[[^\]]+\]\(images\/screenshot-dark\.png\)/);
  assert.match(readme, /## Why this one/);
  assert.match(readme, /tier_id=679995/, 'USD 299 custom format line');
  assert.match(readme, /tier_id=679878/, 'Zovo Pro USD 19 tier');
  assert.ok(!/tier_id=(?!679878|679995)\d+/.test(readme), 'no other sponsor tier');
});

test('walkthrough media and icons exist', () => {
  for (const s of pk.contributes.walkthroughs[0].steps) {
    const m = s.media.image || s.media.markdown;
    assert.ok(fs.existsSync(path.join(root, m)), m);
  }
  assert.ok(fs.existsSync(path.join(root, pk.icon)));
  assert.ok(fs.existsSync(path.join(root, 'media/activity.svg')));
});

test('network code only where it belongs: the SDK wrapper, the license rail; nothing else fetches', () => {
  const files = [];
  const walkDir = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walkDir(p); else if (f.name.endsWith('.js')) files.push(p); } };
  walkDir(path.join(root, 'src'));
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    const rel = path.relative(root, f);
    if (/\b(fetch\(|https?\.request|net\.connect|XMLHttpRequest|WebSocket)/.test(s)) assert.ok(['src/license/sponsors.js'].includes(rel), `${rel} has network code`);
    if (/require\('@azure\//.test(s)) assert.strictEqual(rel, 'src/azure/service.js', `${rel} loads an SDK`);
  }
});

const fakeWebview = { cspSource: 'vscode-resource:' };
const nasty = '<img src=x onerror=alert(1)>';

test('webviews: strict CSP, nonce scripts, no inline style attributes, values escaped', () => {
  const pages = [
    panels.detailsHtml(fakeWebview, { name: `a/${nasty}.txt`, container: 'c"x', connName: '<c>', props: { size: 10, lastModified: 'd', contentType: '<t>', tier: 'Hot', etag: 'e', metadata: { '<k>': '<v>' } }, canSas: true, sasUrl: 'https://x/?a=1&b=<2>', showLinks: true }),
    panels.queueHtml(fakeWebview, { name: nasty, connName: nasty, encoding: 'text', showLinks: true }),
    panels.tableHtml(fakeWebview, { name: nasty, connName: nasty, filter: `PartitionKey eq '${nasty}'`, showLinks: true }),
    panels.syncHtml(fakeWebview, { plan: { direction: 'up', container: 'c', prefix: 'p/', root: '/tmp/x', create: [{ key: `p/${nasty}`, size: 3 }], change: [], remove: [{ key: 'p/old', size: 1 }], same: 2, skipped: [{ key: '../../x', why: 'key has a ".." segment' }], bytes: 3, deleteExtra: true }, connName: 'c', showLinks: false }),
    panels.usageHtml(fakeWebview, { report: { container: 'c', prefix: '', count: 2, bytes: 3e9, monthly: 0.05, folders: [{ folder: nasty, count: 1, bytes: 2e9 }], tiers: [{ tier: 'Hot', count: 2, bytes: 3e9, monthly: 0.05, price: 0.0184 }], largest: [{ name: nasty, size: 5, tier: 'Hot' }], oldest: '', newest: '' }, connName: 'c', showLinks: true }),
  ];
  for (const html of pages) {
    assert.match(html, /default-src 'none'/);
    assert.ok(!html.includes('<img src=x'), 'escaped');
    assert.ok(!/ style="/.test(html), 'no inline style attribute');
    assert.ok(!/<script(?![^>]*nonce=)/.test(html), 'nonce scripts only');
  }
  assert.ok(pages[0].includes('&lt;k&gt;') && pages[0].includes('b=&lt;2&gt;'));
  assert.ok(pages[0].includes('id="zovo-support"'), 'support footer');
  assert.ok(!pages[3].includes('id="zovo-support"'), 'footer hidden when the setting is off');
  assert.match(pages[3], /Mirror mode/);
});

function fakeContext() {
  const state = new Map();
  return { subscriptions: [], globalState: { get: (k) => state.get(k), update: async (k, v) => { state.set(k, v); } } };
}

test('Pro: 2 tools, 3 free tries each, then one explanation; paid and off switch make it free', async () => {
  assert.strictEqual(PRO_ENABLED, true);
  assert.deepStrictEqual(Object.keys(FEATURES).sort(), ['sync', 'usage']);
  let asked = 0;
  const license = { ready: Promise.resolve(), isPro: () => false, refresh: async () => false, requirePro: async () => { asked++; return false; } };
  const pro = createPro({ vscode: fakeVscode, context: fakeContext(), license });
  for (let i = 1; i <= FREE_TRIES; i++) { const g = await pro.gate('usage'); assert.ok(g.ok); assert.match(g.note, new RegExp(`free try ${i} of ${FREE_TRIES}`)); }
  const g4 = await pro.gate('usage');
  assert.ok(!g4.ok);
  assert.strictEqual(asked, 1);
  assert.ok((await pro.gate('sync')).ok, 'tries count per tool');
  const paid = createPro({ vscode: fakeVscode, context: fakeContext(), license: Object.assign({}, license, { isPro: () => true }) });
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(await paid.gate('sync'), { ok: true, note: '' });
  const off = createPro({ vscode: fakeVscode, context: fakeContext(), license, enabled: false });
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(await off.gate('sync'), { ok: true, note: '' });
});

test('the license facade and the rating module are the factory copies, unchanged', () => {
  const F = path.join(process.env.HOME, 'plugin-market-intel-work/factory/sprint');
  if (!fs.existsSync(F)) return;
  for (const [a, b] of [['src/license/index.js', 'license/index.js'], ['src/license/license.js', 'license/license.js'], ['src/license/sponsors.js', 'license/sponsors.js'], ['src/rate.js', 'rating/rate.js']]) {
    assert.strictEqual(fs.readFileSync(path.join(root, a), 'utf8'), fs.readFileSync(path.join(F, b), 'utf8'), a);
  }
});
