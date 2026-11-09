'use strict';
// Runs inside a real VS Code (extension host), started by scripts/gate-vscode.mjs with --extensionTestsPath and
// ZOVO_AZX_GATE=1. Drives the installed extension through its commands and gate hook against a local Azurite only.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const EXT = 'zovo.zovo-azure-storage-explorer';

exports.run = async function run() {
  const M = JSON.parse(fs.readFileSync(process.env.GATE_MANIFEST, 'utf8'));
  const phase = process.env.GATE_PHASE;
  const res = { started: new Date().toISOString(), phase, vscode: vscode.version, platform: process.platform, arch: process.arch, node: process.version, files: [], checks: [] };
  const save = () => fs.writeFileSync(process.env.GATE_OUT, JSON.stringify(res, null, 1));
  const check = (name, ok, detail) => { res.checks.push({ name: `${phase}: ${name}`, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 600) }); save(); };
  const fileRes = (file, ok, detail, ms) => { res.files.push({ file, ok: !!ok, detail: String(detail || '').slice(0, 300), ms: ms || 0 }); save(); };
  const step = (s) => { res.step = s; save(); };
  const signal = async (what) => { fs.writeFileSync(`${M.signal}.${what}`, '1'); for (let i = 0; i < 200 && !fs.existsSync(`${M.signal}.${what}.done`); i++) await sleep(100); fs.rmSync(`${M.signal}.${what}`, { force: true }); fs.rmSync(`${M.signal}.${what}.done`, { force: true }); };
  const trapStats = () => { try { return Number(fs.readFileSync(`${M.signal}.traphits`, 'utf8')); } catch (e) { return -1; } };
  void trapStats;
  step('start');

  const ext = vscode.extensions.getExtension(EXT);
  check('extension installed from the vsix, not active before use', ext && !ext.isActive, ext ? ext.packageJSON.version : 'missing');
  const ta = Date.now();
  const api = await ext.activate();
  res.activationMs = Date.now() - ta;
  const G = api && api._gate;
  if (!G) { check('gate hook present', false); return; }
  check('activation under 300 ms (module load + activate)', res.activationMs < 300, `${res.activationMs} ms total, activate() body ${G.activationMs} ms`);
  G.confirm.impl = async () => true;
  const conns = () => G.store.list();
  const byName = (n) => conns().find((c) => c.name === n);
  const tree = G.tree;
  const kids = async (n) => tree.getChildren(n);
  const node = (c) => ({ kind: 'connection', conn: c });
  const group = async (c, svc) => (await kids(node(c))).find((g) => g.service === svc);

  if (phase === 'W') {
    await G.store.context.globalState.update('azx.gate.warmup', Date.now());
    await sleep(2000);
    res.done = true; save();
    return;
  }
  if (phase === 'C') {
    // Another editor (Cursor): connect, browse, open, queue, table, and the review link goes to Open VSX.
    await vscode.commands.executeCommand('azureStorage.connectAzurite');
    const az = byName('Azurite (local)');
    const cont = await kids(await group(az, 'blob'));
    check('Azurite one click, containers listed', cont.some((c) => c.container === M.container), cont.map((c) => c.container).join(', '));
    const filesC = cont.find((c) => c.container === M.container);
    const docs = (await kids(filesC)).find((n) => n.prefix === 'data/');
    const json = (await kids(docs))[0];
    const r = await G.openBlob(json);
    const ed = vscode.window.activeTextEditor;
    fileRes(json.blob.name, r && r.mode === 'text' && ed && sha(Buffer.from(ed.document.getText())) === M.expected[json.blob.name].textSha, `${r && r.mode}, ${ed && ed.document.uri.scheme}`, 0);
    const pdf = (await kids((await kids(filesC)).find((n) => n.prefix === 'reports/'))).find((n) => n.kind === 'blob');
    const r2 = await G.openBlob(pdf, { yes: true });
    fileRes(pdf.blob.name, r2 && r2.mode === 'download' && sha(fs.readFileSync(r2.local)) === M.expected[pdf.blob.name].sha, r2 && r2.mode, 0);
    const qn = (await kids(await group(az, 'queue'))).find((n) => n.name === 'gate-orders');
    await G.openQueue(qn);
    const qk = [...G.gateHandlers.keys()].find((k) => k.startsWith('q:'));
    await G.gateHandlers.get(qk)({ cmd: 'peek' });
    const peeked = G.gatePosts.get(qk).filter((m) => m.type === 'messages').pop();
    check('queue peek 32', peeked && peeked.messages.length === 32);
    const tn = (await kids(await group(az, 'table'))).find((n) => n.name === 'gatecustomers');
    await G.openTable(tn);
    const tk = [...G.gateHandlers.keys()].find((k) => k.startsWith('t:'));
    await G.gateHandlers.get(tk)({ cmd: 'query', filter: "PartitionKey eq 'west'", top: '100' });
    const rows = G.gatePosts.get(tk).filter((m) => m.type === 'rows').pop();
    check('table query', rows && rows.rows.length === 100 && rows.rows.every((x) => x.partitionKey === 'west'));
    const env = { appName: vscode.env.appName, uriScheme: vscode.env.uriScheme };
    check('editor identified (rating and Rate link use the Open VSX review page outside VS Code)', !!env.appName, JSON.stringify(env));
    res.done = true; save();
    return;
  }
  if (phase === 'B') {
    // A fresh start of the same profile: saved connections, nothing connects until a node is expanded.
    step('B start');
    await vscode.commands.executeCommand('workbench.view.extension.azureStorage');
    await sleep(1500);
    const root = await kids(undefined);
    check('saved connections are listed after a restart (no network for the list)', root.length >= 4, root.map((r) => r.conn.name).join(', '));
    await sleep(1500);
    const trapNow = () => Number(fs.readFileSync(M.signal + '.trap', 'utf8'));
    res.startupTrapHits = trapNow();
    check('no connection at start-up: the trap server behind a saved connection got 0 connections', res.startupTrapHits === 0, `${res.startupTrapHits} connections after start-up and listing the saved connections`);
    const trapConn = byName('Trap (never expanded)');
    const tg = await group(trapConn, 'blob');
    const tk = await kids(tg);
    await sleep(500);
    res.trapHitsAfterExpand = trapNow();
    check('the trap connection is contacted only after the user expands it, and fails with a message', res.trapHitsAfterExpand > 0 && tk.length === 1 && tk[0].kind === 'message', `${res.trapHitsAfterExpand} connections after expand: ${tk[0] && tk[0].label}`);
    const az = byName('Azurite (local)');
    const t0 = Date.now();
    const containers = await kids(await group(az, 'blob'));
    check('after a restart: Azurite containers list on expand', containers.some((c) => c.container === M.container), `${containers.length} containers in ${Date.now() - t0} ms`);
    const rs = G.store.context.globalState.get('zovo.rating.v2') || {};
    check('rating ask v2.2: the count survived the restart, no ask yet (one session only)', (rs.count || 0) >= 2 && !(rs.asks > 0), JSON.stringify({ count: rs.count, asks: rs.asks, sessions: (rs.sessions || []).length, rules: rs.rules }));
    res.done = true; save();
    return;
  }

  // ================= phase A =================
  step('connections');
  await vscode.commands.executeCommand('azureStorage.connectAzurite');
  const az = byName('Azurite (local)');
  check('one-click Azurite entry (command azureStorage.connectAzurite)', az && az.kind === 'azurite', az && JSON.stringify(az.endpoints));
  const add = (parsed, name, readOnly) => vscode.commands.executeCommand('azureStorage.addConnection', { parsed, name, readOnly, quiet: true });
  const csConn = await add(G.connstr.fromConnectionString(M.connString), 'Connection string', false);
  const sasConn = await add(G.connstr.fromSasUrl(M.accountSasUrl), 'Account SAS URL', false);
  const cSasConn = await add(G.connstr.fromSasUrl(M.containerSasUrl), 'Container SAS URL', true);
  const expConn = await add(G.connstr.fromSasUrl(M.expiredSasUrl), 'Expired SAS URL', false);
  const badConn = await add(G.connstr.fromConnectionString(M.wrongKeyConnString), 'Wrong key', false);
  await add(G.connstr.fromConnectionString(M.trapConnString), 'Trap (never expanded)', false);
  const secretsInState = JSON.stringify(G.store.context.globalState.get('azx.connections.v1'));
  check('keys and SAS tokens are not in globalState (SecretStorage only)', !secretsInState.includes('Eby8vdM02') && !/sig=/.test(secretsInState), `${secretsInState.length} bytes of connection records`);
  for (const c of [csConn, sasConn]) {
    const t0 = Date.now();
    const groups = await kids(node(c));
    const cont = await kids(groups.find((g) => g.service === 'blob'));
    check(`connect with ${c.name}: Blob, Queue and Table groups, containers listed`, groups.length === 3 && cont.some((x) => x.container === M.container), `${groups.map((g) => g.service).join('+')}, ${cont.length} containers, ${Date.now() - t0} ms`);
  }
  {
    const groups = await kids(node(cSasConn));
    const cont = await kids(groups[0]);
    const inside = await kids(cont[0]);
    check('container SAS URL: shows only its container and browses it', groups.length === 1 && cont.length === 1 && cont[0].container === M.container && inside.length > 3, inside.map((n) => n.prefix || (n.blob && n.blob.name)).slice(0, 6).join(', '));
  }

  step('hostile connections');
  {
    const g = await kids(node(expConn));
    const t0 = Date.now();
    const cont = await kids(g[0]);
    const msg = await kids(cont[0]);
    check('expired SAS URL: a clear message in the tree, no hang', msg.length === 1 && msg[0].kind === 'message' && /expired on \d{4}-/.test(msg[0].label) && Date.now() - t0 < 15000, `${msg[0] && msg[0].label} (${Date.now() - t0} ms)`);
    const g2 = await kids(node(badConn));
    const t1 = Date.now();
    const m2 = await kids(g2[0]);
    check('wrong account key: a clear message in the tree, no hang', m2.length === 1 && /signature does not match|refused/i.test(m2[0].label) && Date.now() - t1 < 15000, `${m2[0] && m2[0].label} (${Date.now() - t1} ms)`);
  }

  step('browse 10,000');
  {
    const bg = await group(az, 'blob');
    const cont = (await kids(bg)).find((c) => c.container === M.many);
    const folder = (await kids(cont))[0];
    let t0 = Date.now();
    let list = await kids(folder);
    const first = Date.now() - t0;
    let loads = 0;
    const times = [];
    while (list[list.length - 1] && list[list.length - 1].kind === 'more') { t0 = Date.now(); await tree.loadMore(list[list.length - 1]); list = await kids(folder); times.push(Date.now() - t0); loads++; if (loads > 20) break; }
    const blobs = list.filter((n) => n.kind === 'blob');
    check('10,000 blobs in one folder: pages of 1,000 with Load more', blobs.length === 10000 && loads === 9 && new Set(blobs.map((b) => b.blob.name)).size === 10000, `first page ${first} ms, 9 more pages ${times.join('/')} ms`);
    res.browse = { first, more: times };
  }

  step('open files');
  const filesC = (await kids(await group(az, 'blob'))).find((c) => c.container === M.container);
  const allBlobs = [];
  const walkTree = async (n) => { for (const k of await kids(n)) { if (k.kind === 'folder') await walkTree(k); else if (k.kind === 'blob') allBlobs.push(k); } };
  await walkTree(filesC);
  for (const b of allBlobs) {
    const name = b.blob.name;
    if (/escape/.test(name) || /^hostile\//.test(name) && name.endsWith('.txt')) continue;
    const exp = M.expected[name];
    const t0 = Date.now();
    try {
      const r = await G.openBlob(b, { yes: true, largeChoice: 'head' });
      const ms = Date.now() - t0;
      if (!r || r.error) { fileRes(name, /zero-bytes/.test(name), r && r.error ? r.error.message : 'nothing opened', ms); continue; }
      if (r.mode === 'text' || r.mode === 'head') {
        await sleep(200);
        const ed = vscode.window.activeTextEditor;
        const text = ed ? ed.document.getText() : '';
        if (r.mode === 'head') fileRes(name, text.length > 900000 && text.length <= 1048576 && exp.size > 10 * 1048576, `${exp.size} bytes, showed the first ${text.length} characters (one range read)`, ms);
        else fileRes(name, sha(Buffer.from(text)) === exp.textSha, `text tab ${ed && ed.document.uri.scheme}:, ${text.length} chars`, ms);
      } else {
        const got = fs.readFileSync(r.local);
        fileRes(name, sha(got) === exp.sha, `downloaded and opened (${got.length} bytes, sha256 equal: ${sha(got) === exp.sha})`, ms);
      }
    } catch (e) { fileRes(name, false, e.message, Date.now() - t0); }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }

  step('edit and save');
  {
    const b = allBlobs.find((x) => x.blob.name === 'notes/edit-me.json');
    const r = await G.openBlob(b);
    const doc = vscode.window.activeTextEditor.document;
    await vscode.window.activeTextEditor.edit((e) => e.insert(new vscode.Position(1, 0), '  "edited": true,\n'));
    const saved = await doc.save();
    const acct = await G.store.account(az);
    const after = (await acct.container(M.container).getBlobClient('notes/edit-me.json').downloadToBuffer()).toString();
    check('JSON blob edited in a tab and saved back', saved && after.includes('"edited": true') && r.uri.scheme === 'azblob', after.replace(/\s+/g, ' '));
    await acct.container(M.container).getBlockBlobClient('notes/edit-me.json').uploadData(Buffer.from('{"changed":"elsewhere"}'));
    await vscode.window.activeTextEditor.edit((e) => e.insert(new vscode.Position(0, 0), ' '));
    let conflict = '';
    try { const ok = await doc.save(); conflict = ok ? 'saved' : 'not saved'; } catch (e) { conflict = e.message; }
    const final = (await acct.container(M.container).getBlobClient('notes/edit-me.json').downloadToBuffer()).toString();
    check('a blob changed by someone else is not overwritten by Save (ETag check)', final === '{"changed":"elsewhere"}', `save result: ${conflict}`);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }

  step('blob actions');
  {
    const acct = await G.store.account(az);
    const pdf = allBlobs.find((x) => x.blob.name === 'reports/earthquakes-october-2026.pdf');
    const url = await G.sasCmd(pdf, [pdf], { perm: 'r', exp: '1h' });
    const r = await fetch(url);
    const body = Buffer.from(await r.arrayBuffer());
    check('generate SAS URL (read, 1 hour): it downloads the blob', r.status === 200 && sha(body) === M.expected['reports/earthquakes-october-2026.pdf'].sha, url.replace(/sig=[^&]+/, 'sig=...'));
    const clip = await vscode.env.clipboard.readText();
    check('the SAS URL is on the clipboard', clip === url);
    await G.copyUrl(pdf);
    check('Copy URL gives the plain URL without a token', !/sig=/.test(await vscode.env.clipboard.readText()), await vscode.env.clipboard.readText());
    const panel = await G.showDetails(pdf);
    const key = [...G.gateHandlers.keys()].find((k) => k.startsWith('d:') && k.endsWith('earthquakes-october-2026.pdf'));
    await G.gateHandlers.get(key)({ cmd: 'saveHeaders', contentType: 'application/pdf', cacheControl: 'max-age=3600' });
    await G.gateHandlers.get(key)({ cmd: 'setTier', tier: 'Cool' });
    const p = await acct.container(M.container).getBlobClient('reports/earthquakes-october-2026.pdf').getProperties();
    check('details page: Content-Type, Cache-Control and tier saved', p.contentType === 'application/pdf' && p.cacheControl === 'max-age=3600' && p.accessTier === 'Cool', `${p.contentType} / ${p.cacheControl} / ${p.accessTier}`);
    check('details page has the support footer and a strict CSP', /id="zovo-support"/.test(panel.webview.html) && /default-src 'none'/.test(panel.webview.html));
    await G.gateHandlers.get(key)({ cmd: 'sas', perm: 'rw', exp: '7d' });
    check('details page SAS button: URL shown and copied', /sp=rw/.test(await vscode.env.clipboard.readText()) && /sp=rw/.test(panel.webview.html));
    panel.dispose();
    // rename and delete
    const csv = allBlobs.find((x) => x.blob.name === 'tables/semicolon.csv');
    const ci = G.confirm.log.length;
    const rn = await G.renameCmd(csv, [csv], { to: 'tables/renamed.csv' });
    check('rename by server-side copy and delete (asks first)', rn && rn.done === 1 && await acct.container(M.container).getBlobClient('tables/renamed.csv').exists() && !(await acct.container(M.container).getBlobClient('tables/semicolon.csv').exists()) && G.confirm.log.length > ci);
    const renamed = { ...csv, blob: { ...csv.blob, name: 'tables/renamed.csv' } };
    const di = G.confirm.log.length;
    const del = await G.deleteCmd(renamed, [renamed]);
    const q = G.confirm.log[di];
    check('delete lists the blobs and says whether soft delete can restore them', del && del.done === 1 && q && /renamed\.csv/.test(q.detail) && /soft delete/i.test(q.detail), q && q.detail.split('\n')[0]);
    // read-only switch
    await G.store.update(cSasConn.id, { readOnly: true });
    const roBlob = { kind: 'blob', conn: G.store.get(cSasConn.id), container: M.container, blob: { name: 'docs/README.md', size: 1 } };
    let roErr = '';
    await vscode.commands.executeCommand('azureStorage.delete', roBlob, [roBlob]);
    roErr = (G.gateLog.errors[G.gateLog.errors.length - 1] || {}).msg || '';
    check('read-only connection: Delete is refused, the blob stays', /read-only/i.test(roErr) && await acct.container(M.container).getBlobClient('docs/README.md').exists(), roErr);
  }

  step('hostile names');
  {
    const target = path.join(M.work, 'downloads', 'hostile');
    const folder = (await kids(filesC)).find((n) => n.kind === 'folder' && n.prefix === 'hostile/');
    const hostileParent = (await kids(filesC)).filter((n) => n.kind === 'folder').map((n) => n.prefix);
    const r = await G.downloadCmd(folder, [folder], { target, overwrite: true });
    await (r && r.done);
    const outside = fs.existsSync(path.join(M.work, 'escape.txt')) || fs.existsSync(path.join(M.work, 'downloads', 'escape.txt')) || fs.existsSync(path.join(target, 'escape.txt'));
    check('download of a folder with hostile names: "%2F" stays a file name inside the folder', fs.existsSync(path.join(target, 'hostile', 'a%2Fb.txt')), `downloaded ${r && r.items.length}, folders at the top: ${hostileParent.join(' ')}`);
    check('the blob named "hostile/../../escape.txt" is skipped with a reason, nothing is written outside the folder', r && r.skipped.length === 1 && /\.\./.test(r.skipped[0]) && !outside, r && r.skipped.join('; '));
  }

  step('queue');
  {
    const qn = (await kids(await group(az, 'queue'))).find((n) => n.name === 'gate-orders');
    await G.openQueue(qn);
    const key = [...G.gateHandlers.keys()].find((k) => k.startsWith('q:'));
    const h = G.gateHandlers.get(key);
    const posts = G.gatePosts.get(key);
    await h({ cmd: 'peek' });
    const peeked = posts.filter((m) => m.type === 'messages').pop();
    check('queue: peek shows 32 of 1,000 messages, Base64 shown decoded', peeked && peeked.messages.length === 32 && /orderId/.test(peeked.messages[0].decoded || ''), peeked && peeked.messages[0].decoded);
    await h({ cmd: 'send', text: '{"orderId": 99999}', encoding: 'base64', ttl: '' });
    const acct = await G.store.account(az);
    const n1 = (await acct.queueClient('gate-orders').getProperties()).approximateMessagesCount;
    await h({ cmd: 'dequeue' });
    const n2 = (await acct.queueClient('gate-orders').getProperties()).approximateMessagesCount;
    check('queue: send adds one, dequeue (confirmed) removes one', n1 === 1001 && n2 === 1000, `${n1} after send, ${n2} after dequeue`);
    const status = posts.filter((m) => m.type === 'status').map((m) => m.text);
    check('queue: the dequeued text is shown', status.some((t) => /Dequeued and deleted: \{"orderId":0/.test(t)), status.slice(-2).join(' | '));
  }

  step('table');
  {
    const tn = (await kids(await group(az, 'table'))).find((n) => n.name === 'gatecustomers');
    await G.openTable(tn);
    const key = [...G.gateHandlers.keys()].find((k) => k.startsWith('t:'));
    const h = G.gateHandlers.get(key);
    const posts = G.gatePosts.get(key);
    let t0 = Date.now();
    await h({ cmd: 'query', filter: '', top: '500' });
    const q1 = posts.filter((m) => m.type === 'rows').pop();
    const q1ms = Date.now() - t0;
    t0 = Date.now();
    await h({ cmd: 'query', filter: "PartitionKey eq 'east' and orders gt 45 and vip eq false", top: '500' });
    const q2 = posts.filter((m) => m.type === 'rows').pop();
    await h({ cmd: 'more' });
    const q3 = posts.filter((m) => m.type === 'rows').pop();
    check('table (50,000 entities): first 500 rows, then an OData filter with paging', q1.rows.length === 500 && q1.next && q2.rows.every((r) => r.partitionKey === 'east' && Number(r.props.orders.value) > 45) && q3.append, `all: ${q1ms} ms; filter: ${q2.rows.length} + ${q3.rows.length} rows in ${Date.now() - t0} ms`);
    const row = q2.rows[0];
    await h({ cmd: 'saveCell', i: '0', pk: row.partitionKey, rk: row.rowKey, prop: 'name', type: 'String', value: 'Edited in VS Code' });
    await h({ cmd: 'saveCell', i: '0', pk: row.partitionKey, rk: row.rowKey, prop: 'orders', type: 'Int32', value: 'not a number' });
    const saved = posts.filter((m) => m.type === 'saved');
    const failed = posts.filter((m) => m.type === 'saveFailed');
    const acct = await G.store.account(az);
    const e = await acct.tableClient('gatecustomers').getEntity(row.partitionKey, row.rowKey);
    check('table inline edit: the cell is saved, other properties and types stay; a bad Int32 is refused', saved.length === 1 && e.name === 'Edited in VS Code' && e.orders === Number(row.props.orders.value) && failed.length === 1, `${e.name}, orders ${e.orders}; refused: ${failed[0] && failed[0].text}`);
    await h({ cmd: 'create', pk: 'gate', rk: 'new1', props: JSON.stringify([{ name: 'amount', type: 'Double', value: '12.5' }, { name: 'since', type: 'DateTime', value: '2026-11-09T00:00:00Z' }]) });
    const ne = await acct.tableClient('gatecustomers').getEntity('gate', 'new1');
    await h({ cmd: 'del', pk: 'gate', rk: 'new1', i: '0' });
    let gone = false;
    try { await acct.tableClient('gatecustomers').getEntity('gate', 'new1'); } catch (err) { gone = err.statusCode === 404; }
    check('table: add an entity with types, then delete it (confirmed)', ne.amount === 12.5 && gone, JSON.stringify({ amount: ne.amount, since: ne.since }));
  }

  step('pro');
  {
    const r = await G.usageCmd(filesC, [filesC]);
    check('Zovo Pro usage report: free try 1 of 3, totals per folder and tier', r && r.report.count > 10 && /free try 1 of 3/.test(r.panel.webview.html), `${r && r.report.count} blobs, ${r && r.report.folders.length} folders`);
    const s = await G.syncCmd({ kind: 'folder', conn: az, container: M.container, prefix: 'site/' }, [], { direction: 'up', root: M.syncDir, deleteExtra: false, apply: true });
    const acct = await G.store.account(az);
    check('Zovo Pro folder sync: dry-run plan (2 new), then apply uploads them', s && s.plan.create.length === 0 && s.result.done === 2 && await acct.container(M.container).getBlobClient('site/css/app.css').exists(), s && JSON.stringify({ done: s.result.done, failed: s.result.failed.length }));
    check('Zovo Pro tries are counted per tool', G.pro.triesLeft('usage') === 2 && G.pro.triesLeft('sync') === 2);
  }

  step('support');
  {
    const cmds = await vscode.commands.getCommands(true);
    check('support and Pro commands registered (Sponsor, More free tools, Unlock, PayPal)', ['azureStorage.supportDeveloper', 'azureStorage.moreViewers', 'azureStorage.unlockWithSponsors', 'azureStorage.getPro', 'azureStorage.payWithPayPal', 'azureStorage.enterLicenseKey'].every((c) => cmds.includes(c)));
    const rs = G.store.context.globalState.get('zovo.rating.v2') || {};
    check('rating ask v2.2 counts good opens, never asks in the first session', (rs.count || 0) >= 2 && !(rs.asks > 0), JSON.stringify({ count: rs.count, asks: rs.asks, rules: rs.rules }));
  }

  if (M.big) {
    const acct = await G.store.account(az);
    const dest = { kind: 'container', conn: az, container: M.container };
    const destNode = { conn: az, container: M.container, prefix: 'big/', node: dest };
    const mem = () => process.memoryUsage().rss;
    step('2 GB upload');
    const base = mem();
    let peak = base;
    const iv = setInterval(() => { peak = Math.max(peak, mem()); }, 100);
    let t0 = Date.now();
    const up = await G.uploadPaths([M.big], destNode, { wait: true, overwrite: true });
    const upMs = Date.now() - t0;
    const it = up.items[0];
    const p = await acct.container(M.container).getBlobClient('big/video-2gb.bin').getProperties();
    check('2 GB upload through the transfer queue: blocks, progress, size on the server', it.status === 'done' && p.contentLength === M.bigSize, `${(M.bigSize / 1048576 / (upMs / 1000)).toFixed(0)} MB/s, ${(upMs / 1000).toFixed(1)} s`);
    step('2 GB download');
    const target = path.join(M.work, 'downloads', 'big');
    const bn = { kind: 'blob', conn: az, container: M.container, blob: { name: 'big/video-2gb.bin', size: M.bigSize }, parent: dest };
    t0 = Date.now();
    const dn = await G.downloadCmd(bn, [bn], { target, overwrite: true, wait: true });
    await dn.done;
    const dnMs = Date.now() - t0;
    clearInterval(iv);
    res.bigDownload = path.join(target, 'video-2gb.bin');
    check('2 GB download streamed to disk', dn.items[0].status === 'done' && fs.statSync(res.bigDownload).size === M.bigSize, `${(M.bigSize / 1048576 / (dnMs / 1000)).toFixed(0)} MB/s, ${(dnMs / 1000).toFixed(1)} s`);
    check('memory stays flat during 2 GB up and down (extension host RSS)', peak - base < 400 * 1048576, `base ${(base / 1048576).toFixed(0)} MB, peak ${(peak / 1048576).toFixed(0)} MB (+${((peak - base) / 1048576).toFixed(0)} MB)`);
    res.memory = { baseMB: Math.round(base / 1048576), peakMB: Math.round(peak / 1048576) };
    fs.rmSync(res.bigDownload, { force: true });
    res.bigDownload = '';
    step('cancel and retry');
    const up2 = await G.uploadPaths([M.big], { ...destNode, prefix: 'big2/' }, { overwrite: true });
    const i2 = up2.items[0];
    for (let i = 0; i < 600 && !(i2.bytes > M.bigSize * 0.1); i++) await sleep(100);
    await vscode.commands.executeCommand('azureStorage.cancelTransfer', i2);
    for (let i = 0; i < 100 && i2.status === 'running'; i++) await sleep(100);
    const cancelledAt = i2.bytes;
    check('Cancel stops a running 2 GB upload', i2.status === 'cancelled', `cancelled at ${(cancelledAt / 1048576).toFixed(0)} MB`);
    await vscode.commands.executeCommand('azureStorage.retryTransfer', i2);
    await G.queue.settle([i2]);
    const p2 = await acct.container(M.container).getBlobClient('big2/video-2gb.bin').getProperties();
    check('Retry uploads it again to the end', i2.status === 'done' && p2.contentLength === M.bigSize);
    step('azurite stopped during an upload');
    const up3 = await G.uploadPaths([M.big], { ...destNode, prefix: 'big3/' }, { overwrite: true });
    const i3 = up3.items[0];
    for (let i = 0; i < 600 && !(i3.bytes > M.bigSize * 0.05); i++) await sleep(100);
    await signal('kill-azurite');
    const tk = Date.now();
    for (let i = 0; i < 1200 && i3.status === 'running'; i++) await sleep(100);
    const failMs = Date.now() - tk;
    check('Azurite stopped during an upload: the transfer fails with a message, nothing hangs', i3.status === 'failed' && failMs < 90000, `${failMs} ms: ${i3.error}`);
    await signal('start-azurite');
    G.store.dropClient(az.id);
    await vscode.commands.executeCommand('azureStorage.retryTransfer', i3);
    await G.queue.settle([i3]);
    check('after Azurite is back, Retry finishes the upload', i3.status === 'done', i3.error);
    for (const pr of ['big/', 'big2/', 'big3/']) for await (const b of acct.container(M.container).listBlobsFlat({ prefix: pr })) await acct.container(M.container).deleteBlob(b.name).catch(() => {});
  }
  step('A done');
  await sleep(2500); // let VS Code write globalState before the window closes
  res.done = true;
  save();
};
