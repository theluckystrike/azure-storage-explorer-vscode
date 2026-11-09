'use strict';
// Azure Storage Explorer by Zovo: Blob containers, Queues and Tables in Azure Storage accounts and Azurite, from a
// connection string, an account key, a SAS URL or Entra ID. Network: only the storage endpoints the user adds (and
// Microsoft sign-in when the user picks Entra ID, and GitHub when the user clicks Unlock Zovo Pro). No telemetry.
// Nothing connects at start-up: a connection is used the first time the user expands it.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const connstr = require('./azure/connstr');
const blob = require('./azure/blob');
const qt = require('./azure/queuetable');
const { ConnectionStore } = require('./connections');
const { StorageTree, createDnd, lastSeg } = require('./tree');
const { BlobFileSystem, toUri } = require('./fsprovider');
const { TransferQueue, TransfersView } = require('./transfers');
const { safeLocalPath, localToKey, parentPrefix } = require('./azure/paths');
const { walk, excluder, planUpload, planDownload, applyPlan, usageReport } = require('./azure/sync');
const { fmtBytes, fmtCount, keyList, describeError, confirm } = require('./ui');
const panels = require('./panels');
const { createRatingPrompt } = require('./rate');
const { registerSupport, showLinks } = require('./support');
const { createPro } = require('./pro');
const { contentTypeFor, isTextKey, viewerFor } = require('./types');

const EXT_ID = 'zovo.zovo-azure-storage-explorer';
const SECTION = 'azureStorage';
const MB = 1024 * 1024;

let store, tree, view, queue, transfersView, rating, pro, ctx, statusItem;
const gateLog = { opened: [], messages: [], errors: [] };
const openPanels = new Map();
const gateHandlers = new Map(); // gate only: panel key -> its message handler
const gatePosts = new Map(); // gate only: panel key -> messages posted to the webview
const GATE = process.env.ZOVO_AZX_GATE === '1';

const settings = () => {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    pageSize: c.get('pageSize', 1000),
    maxTextPreviewMB: c.get('maxTextPreviewMB', 10),
    confirmOpenOverMB: c.get('confirmOpenOverMB', 200),
    blockSizeMB: c.get('blockSizeMB', 8),
    concurrency: c.get('concurrency', 4),
    parallelTransfers: c.get('parallelTransfers', 3),
    requestTimeoutSeconds: c.get('requestTimeoutSeconds', 30),
    syncExcludes: c.get('syncExcludes', ['.git/**', 'node_modules/**', '.DS_Store', 'Thumbs.db']),
    pricePerGBMonth: c.get('pricePerGBMonth', {}),
    queueMessageEncoding: c.get('queueMessageEncoding', 'text'),
  };
};

// ---------- small helpers ----------
function info(msg, ...items) { gateLog.messages.push({ level: 'info', msg }); return vscode.window.showInformationMessage(msg, ...items); }
function warn(msg, ...items) { gateLog.messages.push({ level: 'warn', msg }); return vscode.window.showWarningMessage(msg, ...items); }

function showError(e, conn, prefix) {
  if (e && (e.aborted || e.code === 'Aborted' || e.name === 'AbortError')) return;
  const d = describeError(e, conn);
  const text = (prefix ? prefix + ' ' : '') + d.message;
  gateLog.errors.push({ msg: text, code: e && (e.code || e.statusCode) });
  // The toast never blocks the command that failed; its buttons act when clicked.
  vscode.window.showErrorMessage(text, ...d.actions).then((pick) => {
    if (pick === 'Edit Connection' && conn) vscode.commands.executeCommand('azureStorage.editConnection', { kind: 'connection', conn });
    if (pick === 'Refresh') tree.refresh();
    if (pick === 'Start Azurite in a Terminal') startAzurite();
  });
}

function connOf(node) {
  const c = node && node.conn ? store.get(node.conn.id) : null;
  if (!c) throw new Error('This connection no longer exists.');
  return c;
}

async function acctOf(node) { return store.account(connOf(node)); }

function writable(conn) {
  if (conn.readOnly) { const e = new Error(`"${conn.name}" is read-only. Turn off Read-only in Edit Connection to change anything.`); e.code = 'ReadOnly'; throw e; }
}

function selection(node, nodes) {
  const list = Array.isArray(nodes) && nodes.length ? nodes : (node ? [node] : view.selection);
  return (list || []).filter(Boolean);
}

function prefixOf(node) {
  if (!node) return '';
  if (node.kind === 'folder') return node.prefix;
  if (node.kind === 'blob') return parentPrefix(node.blob.name);
  return '';
}

function destOf(node) {
  if (!node) return null;
  if (node.kind === 'blob') return { conn: node.conn, container: node.container, prefix: parentPrefix(node.blob.name), node: node.parent };
  if (node.kind === 'container' || node.kind === 'folder') return { conn: node.conn, container: node.container, prefix: prefixOf(node), node };
  return null;
}

async function withProgress(title, fn) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    return fn(progress, ac.signal);
  });
}

/** Every blob under the selected nodes, one container at a time: { conn, container, items: [{ name, size, base }] }. */
async function expandBlobs(nodes, signal) {
  const first = nodes.find((n) => n.kind === 'blob' || n.kind === 'folder');
  if (!first) return { conn: null, container: '', items: [] };
  const conn = connOf(first);
  const acct = await store.account(conn);
  const container = first.container;
  const items = [];
  const seen = new Set();
  for (const n of nodes) {
    if (n.container !== container || n.conn.id !== conn.id) continue;
    if (n.kind === 'blob') { if (!seen.has(n.blob.name)) { seen.add(n.blob.name); items.push({ name: n.blob.name, size: n.blob.size, base: parentPrefix(n.blob.name) }); } }
    else if (n.kind === 'folder') {
      const base = parentPrefix(n.prefix);
      await blob.listAll(acct, container, n.prefix, (list) => { for (const b of list) if (!seen.has(b.name)) { seen.add(b.name); items.push({ name: b.name, size: b.size, base }); } }, signal);
    }
  }
  return { conn, acct, container, items };
}

// ---------- connections ----------
async function addConnection(opts) {
  if (opts && opts.parsed) return saveConnection(opts.parsed, opts);
  const items = [
    { label: '$(key) Connection string', description: 'DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...', id: 'connstr' },
    { label: '$(link) SAS URL', description: 'an account or container SAS URL', id: 'sas' },
    { label: '$(account) Account name and key', id: 'key' },
    { label: '$(beaker) Azurite (local emulator)', description: '127.0.0.1, ports 10000-10002, one click', id: 'azurite' },
    { label: '$(beaker) Azurite on another host', description: 'for example "azurite" in a Dev Container or Docker Compose', id: 'azuriteHost' },
    { label: '$(azure) Microsoft Entra ID', description: 'sign in with your Microsoft account in VS Code', id: 'entra' },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'How do you want to connect to Azure Storage?', ignoreFocusOut: true });
  if (!pick) return null;
  let parsed;
  if (pick.id === 'connstr') {
    const s = await vscode.window.showInputBox({ prompt: 'Paste the connection string (Storage account > Security + networking > Access keys). It is kept in your OS keychain.', password: true, ignoreFocusOut: true, placeHolder: 'DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net' });
    if (!s) return null;
    parsed = connstr.fromConnectionString(s);
  } else if (pick.id === 'sas') {
    const s = await vscode.window.showInputBox({ prompt: 'Paste a SAS URL for the account or for one container. The token is kept in your OS keychain.', password: true, ignoreFocusOut: true, placeHolder: 'https://<account>.blob.core.windows.net/<container>?sv=...&sig=...' });
    if (!s) return null;
    parsed = connstr.fromSasUrl(s);
    if (parsed.sasInfo.expired) {
      const go = await vscode.window.showWarningMessage(`This SAS token expired on ${parsed.sasInfo.expires.slice(0, 16).replace('T', ' ')} UTC, so every request will fail. Save it anyway?`, { modal: true }, 'Save anyway');
      if (go !== 'Save anyway') return null;
    }
  } else if (pick.id === 'key') {
    const a = await vscode.window.showInputBox({ prompt: 'Storage account name', ignoreFocusOut: true, validateInput: (v) => (/^[a-z0-9]{3,24}$/.test(v.trim()) ? null : '3 to 24 lowercase letters and digits') });
    if (!a) return null;
    const k = await vscode.window.showInputBox({ prompt: `Account key for ${a} (key1 or key2). It is kept in your OS keychain.`, password: true, ignoreFocusOut: true });
    if (!k) return null;
    parsed = connstr.fromAccountKey(a, k);
  } else if (pick.id === 'azurite') {
    return connectAzurite();
  } else if (pick.id === 'azuriteHost') {
    const h = await vscode.window.showInputBox({ prompt: 'Host name or IP of Azurite (ports 10000, 10001 and 10002)', value: 'azurite', ignoreFocusOut: true, validateInput: (v) => (/^[A-Za-z0-9.-]+$/.test(v.trim()) ? null : 'A host name like azurite or 172.17.0.2') });
    if (!h) return null;
    return connectAzurite(h.trim());
  } else if (pick.id === 'entra') {
    const a = await vscode.window.showInputBox({ prompt: 'Storage account name. You need a data role on it, for example Storage Blob Data Reader or Contributor.', ignoreFocusOut: true, validateInput: (v) => (/^[a-z0-9]{3,24}$/.test(v.trim()) ? null : '3 to 24 lowercase letters and digits') });
    if (!a) return null;
    const tenant = await vscode.window.showInputBox({ prompt: 'Tenant ID or domain (optional: leave empty for your home tenant)', ignoreFocusOut: true });
    if (tenant === undefined) return null;
    parsed = connstr.forEntra(a.trim(), { tenant: tenant.trim() });
    await store.entraToken({ name: a, tenant: tenant.trim() }, true);
  }
  if (!parsed) return null;
  const name = await vscode.window.showInputBox({ prompt: 'A name for this connection', value: parsed.container ? `${parsed.account}/${parsed.container}` : parsed.account, ignoreFocusOut: true });
  if (name === undefined) return null;
  const ro = await vscode.window.showQuickPick([{ label: 'Read and write', id: false }, { label: 'Read-only', description: 'nothing can be changed from this connection', id: true }], { placeHolder: 'Allow changes?', ignoreFocusOut: true });
  if (!ro) return null;
  return saveConnection(parsed, { name: name || parsed.account, readOnly: ro.id });
}

async function saveConnection(parsed, o = {}) {
  const rec = await store.add(parsed, o);
  tree.refresh();
  if (!o.quiet) info(`Added "${rec.name}". Expand it to see its ${rec.container ? 'blobs' : 'containers, queues and tables'}.`);
  return rec;
}

async function connectAzurite(host) {
  const h = typeof host === 'string' && host ? host : '127.0.0.1';
  const name = h === '127.0.0.1' ? 'Azurite (local)' : `Azurite (${h})`;
  const have = store.list().find((c) => c.kind === 'azurite' && (c.host || '127.0.0.1') === h);
  if (have) { await view.reveal({ kind: 'connection', conn: have }, { expand: true, select: true }).then(undefined, () => {}); return have; }
  return saveConnection(connstr.forAzurite(h), { name, quiet: true });
}

function startAzurite() {
  const dir = path.join(ctx.globalStorageUri.fsPath, 'azurite');
  const t = vscode.window.createTerminal('Azurite');
  t.show();
  // A command the user sees and can stop with Ctrl+C. npx downloads Azurite from npm the first time.
  t.sendText(`npx --yes azurite --silent --location "${dir}" --skipApiVersionCheck`, true);
}

async function editConnection(node) {
  const conn = node && node.conn ? store.get(node.conn.id) : await pickConnection();
  if (!conn) return null;
  const items = [
    { label: '$(edit) Rename', id: 'rename' },
    { label: conn.readOnly ? '$(unlock) Allow changes (turn off Read-only)' : '$(lock) Make read-only', id: 'ro' },
  ];
  if (conn.kind === 'key' || conn.kind === 'sas') items.push({ label: conn.kind === 'sas' ? '$(link) Paste a new SAS URL' : '$(key) Paste a new key or connection string', id: 'secret' });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: conn.name });
  if (!pick) return null;
  if (pick.id === 'rename') {
    const name = await vscode.window.showInputBox({ prompt: 'Name', value: conn.name });
    if (name) await store.update(conn.id, { name });
  } else if (pick.id === 'ro') {
    await store.update(conn.id, { readOnly: !conn.readOnly });
  } else if (pick.id === 'secret') {
    const s = await vscode.window.showInputBox({ prompt: conn.kind === 'sas' ? 'New SAS URL' : 'New connection string, or the account key', password: true, ignoreFocusOut: true });
    if (!s) return null;
    let parsed;
    if (conn.kind === 'sas') parsed = connstr.fromSasUrl(s);
    else parsed = /AccountName=/i.test(s) ? connstr.fromConnectionString(s) : connstr.fromAccountKey(conn.account, s);
    await store.add(parsed, { id: conn.id, name: conn.name, readOnly: conn.readOnly });
  }
  tree.refresh();
  return store.get(conn.id);
}

async function pickConnection() {
  const list = store.list();
  if (!list.length) { await addConnection(); return null; }
  if (list.length === 1) return list[0];
  const p = await vscode.window.showQuickPick(list.map((c) => ({ label: c.name, description: c.account, c })), { placeHolder: 'Connection' });
  return p ? p.c : null;
}

async function removeConnection(node) {
  const conn = connOf(node);
  const ok = await confirm.ask(vscode, `Remove the connection "${conn.name}"?`, 'Only the saved connection and its key in your keychain are removed. Nothing in the storage account changes.', 'Remove');
  if (!ok) return false;
  await store.remove(conn.id);
  tree.refresh();
  return true;
}

// ---------- open ----------
function cacheRoot() { return path.join(ctx.globalStorageUri.fsPath, 'open'); }

async function openBlob(node, opts = {}) {
  const conn = connOf(node);
  const container = node.container;
  const name = node.blob.name;
  const s = settings();
  const t0 = Date.now();
  try {
    const acct = await store.account(conn);
    let size = node.blob.size;
    if (node.blob.tier === 'Archive' && !node.blob.archiveStatus) {
      warn(`${lastSeg(name)} is in the Archive tier. Change its tier to Hot or Cool first (rehydration takes hours).`);
      return { mode: 'archived' };
    }
    const viewer = viewerFor(name);
    const viewerInstalled = viewer ? !!vscode.extensions.getExtension(viewer.id) : false;
    const text = isTextKey(name) && !(viewer && viewerInstalled && viewer.preferViewer);
    let mode = opts.mode || (text ? 'text' : 'download');
    let head = 0;
    if (mode === 'text' && size > s.maxTextPreviewMB * MB) {
      const choice = opts.largeChoice || (await vscode.window.showQuickPick([
        { label: '$(eye) Show the first 1 MB', description: 'read-only, one range request', id: 'head' },
        { label: '$(cloud-download) Download and open the whole file', description: fmtBytes(size), id: 'download' },
      ], { placeHolder: `${lastSeg(name)} is ${fmtBytes(size)}, more than the ${s.maxTextPreviewMB} MB text limit (setting azureStorage.maxTextPreviewMB).` }) || {}).id;
      if (!choice) return null;
      if (choice === 'head') head = MB; else mode = 'download';
    }
    if (mode === 'head') { head = MB; mode = 'text'; }
    if (mode === 'text') {
      const uri = toUri(vscode, conn.id, container, name, head ? `head=${head}` : '');
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
      if (head && size > head) info(`Showing the first 1 MB of ${fmtBytes(size)} (read-only). Download the blob to see all of it.`);
      gateLog.opened.push({ name, mode: head ? 'head' : 'text', ms: Date.now() - t0, size });
      rating.success(uri);
      return { mode: head ? 'head' : 'text', uri };
    }
    if (size > s.confirmOpenOverMB * MB && !opts.yes) {
      const ok = await vscode.window.showWarningMessage(`Download ${fmtBytes(size)} to open ${lastSeg(name)}?`, { modal: true }, 'Download and Open');
      if (ok !== 'Download and Open') return null;
    }
    const root = path.join(cacheRoot(), conn.id, container);
    const sp = safeLocalPath(root, name);
    const local = sp.error ? path.join(root, '_', crypto.createHash('sha1').update(name).digest('hex').slice(0, 12) + '-' + lastSeg(name).replace(/[^\w.-]/g, '_')) : sp.path;
    try { fs.chmodSync(local, 0o644); } catch (e) { /* not cached yet */ }
    await withProgress(`Downloading ${lastSeg(name)}`, async (progress, signal) => {
      let last = 0;
      await blob.downloadFile(acct, container, name, local, { signal, onProgress: (got, total) => { const pct = total ? Math.floor((got / total) * 100) : 0; if (pct > last) { progress.report({ increment: pct - last, message: `${fmtBytes(got)} of ${fmtBytes(total)}` }); last = pct; } } });
    });
    try { fs.chmodSync(local, 0o444); } catch (e) { /* best effort */ }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(local), { preview: true });
    gateLog.opened.push({ name, mode: 'download', ms: Date.now() - t0, size, local });
    rating.success(toUri(vscode, conn.id, container, name));
    if (viewer && !viewerInstalled) suggestViewer(viewer);
    return { mode: 'download', local };
  } catch (e) {
    if (e && (e.aborted || e.code === 'Aborted')) return null;
    rating.failure();
    showError(e, conn, `Could not open ${lastSeg(name)}:`);
    return { error: e };
  }
}

async function suggestViewer(viewer) {
  const k = 'zovo.azurestorage.suggested.v1';
  const seen = ctx.globalState.get(k) || {};
  if (seen[viewer.id] || Object.keys(seen).length >= 3 || GATE) return;
  seen[viewer.id] = Date.now();
  await ctx.globalState.update(k, seen);
  const pick = await vscode.window.showInformationMessage(`${viewer.what} files open in a better view with the free ${viewer.name}.`, 'Show it');
  if (pick === 'Show it') { try { await vscode.commands.executeCommand('extension.open', viewer.id); } catch (e) { vscode.env.openExternal(vscode.Uri.parse(`https://marketplace.visualstudio.com/items?itemName=${viewer.id}`)); } }
}

// ---------- transfers ----------
function transferStatus() {
  const s = queue.summary();
  if (!s.active) { statusItem.hide(); return; }
  statusItem.text = `$(sync~spin) ${s.active} transfer${s.active > 1 ? 's' : ''} ${s.pct}%`;
  statusItem.tooltip = 'Azure Storage transfers. Click to show the queue.';
  statusItem.show();
}

async function uploadCmd(node, nodes, opts = {}) {
  const dest = destOf(node || (view.selection || [])[0]);
  if (!dest) { warn('Select a container or folder first.'); return null; }
  writable(connOf(dest));
  const uris = opts.paths ? opts.paths.map((p) => vscode.Uri.file(p)) : await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: !opts.folders, canSelectFolders: !!opts.folders, openLabel: `Upload to ${dest.container}/${dest.prefix}` });
  if (!uris || !uris.length) return null;
  return uploadPaths(uris.map((u) => u.fsPath), dest, opts);
}

/** Upload local files and folders to dest ({ conn, container, prefix, node }). Folders keep their structure. */
async function uploadPaths(paths, dest, opts = {}) {
  const conn = connOf(dest);
  writable(conn);
  const acct = await store.account(conn);
  const s = settings();
  const isExcluded = excluder(s.syncExcludes);
  const files = [];
  for (const p of paths) {
    let st;
    try { st = await fs.promises.stat(p); } catch (e) { continue; }
    if (st.isDirectory()) {
      const base = path.basename(p);
      for (const f of await walk(p, isExcluded)) files.push({ file: f.file, name: `${dest.prefix}${base}/${f.rel}`, size: f.size });
    } else if (st.isFile()) files.push({ file: p, name: `${dest.prefix}${path.basename(p)}`, size: st.size });
  }
  if (!files.length) { info('Nothing to upload.'); return { items: [] }; }
  // Existing blobs: one listing of the prefix for many files, one HEAD per file for a few.
  const existing = new Set();
  if (files.length > 20) await blob.listAll(acct, dest.container, dest.prefix, (list) => { for (const b of list) existing.add(b.name); });
  else await Promise.all(files.map(async (f) => { if (await blob.exists(acct, dest.container, f.name)) existing.add(f.name); }));
  const clash = files.filter((f) => existing.has(f.name)).map((f) => f.name);
  if (clash.length && !opts.overwrite) {
    const ok = await confirm.ask(vscode, `Replace ${fmtCount(clash.length)} existing blob${clash.length > 1 ? 's' : ''} in ${dest.container}?`, keyList(dest.container, clash), 'Replace');
    if (!ok) return { cancelled: true, items: [] };
  }
  const items = files.map((f) => queue.add({
    kind: 'upload', label: lastSeg(f.name), detail: `${f.file} → ${dest.container}/${f.name}`, total: f.size,
    run: (job, { signal, progress }) => blob.uploadFile(acct, dest.container, f.name, f.file, { signal, onProgress: progress, contentType: contentTypeFor(f.name), blockSizeMB: s.blockSizeMB, concurrency: s.concurrency }),
  }));
  revealTransfers();
  const done = queue.settle(items).then(() => {
    tree.refresh(dest.node);
    const ok = items.filter((i) => i.status === 'done');
    const failed = items.filter((i) => i.status === 'failed');
    const total = ok.reduce((a, i) => a + (i.total || 0), 0);
    if (failed.length) warn(`Uploaded ${fmtCount(ok.length)} of ${fmtCount(items.length)} files. ${failed.length} failed: ${failed[0].error}. Retry them in the Transfers view.`);
    else if (ok.length) { info(`Uploaded ${fmtCount(ok.length)} file${ok.length > 1 ? 's' : ''} (${fmtBytes(total)}) to ${dest.container}/${dest.prefix}.`); rating.success(toUri(vscode, conn.id, dest.container, ok[0].job.label)); }
    return items;
  });
  if (opts.wait) await done;
  return { items, done };
}

function revealTransfers() { if (!GATE) vscode.commands.executeCommand('azureStorage.transfers.focus').then(undefined, () => {}); }

async function downloadCmd(node, nodes, opts = {}) {
  const sel = selection(node, nodes).filter((n) => n.kind === 'blob' || n.kind === 'folder');
  if (!sel.length) return null;
  let root = opts.target;
  if (!root) {
    const pick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Download here' });
    if (!pick || !pick.length) return null;
    root = pick[0].fsPath;
  }
  const { conn, acct, container, items } = await withProgress('Listing blobs', (p, signal) => expandBlobs(sel, signal));
  const plan = [];
  const skipped = [];
  for (const it of items) {
    const sp = safeLocalPath(root, it.name, it.base);
    if (sp.error) skipped.push(`${it.name}: ${sp.error}`); else plan.push({ ...it, file: sp.path });
  }
  const exist = plan.filter((p) => fs.existsSync(p.file));
  if (exist.length && !opts.overwrite) {
    const ok = await confirm.ask(vscode, `Replace ${fmtCount(exist.length)} local file${exist.length > 1 ? 's' : ''}?`, exist.slice(0, 15).map((p) => p.file).join('\n') + (exist.length > 15 ? `\n... and ${exist.length - 15} more` : ''), 'Replace');
    if (!ok) return { cancelled: true };
  }
  if (skipped.length) warn(`Skipped ${skipped.length} blob${skipped.length > 1 ? 's' : ''} whose name would leave the folder: ${skipped.slice(0, 3).join('; ')}`);
  const qitems = plan.map((p) => queue.add({
    kind: 'download', label: lastSeg(p.name), detail: `${container}/${p.name} → ${p.file}`, total: p.size,
    run: (job, { signal, progress }) => blob.downloadFile(acct, container, p.name, p.file, { signal, onProgress: progress }),
  }));
  revealTransfers();
  const done = queue.settle(qitems).then(() => {
    const ok = qitems.filter((i) => i.status === 'done');
    const failed = qitems.filter((i) => i.status === 'failed');
    if (failed.length) warn(`Downloaded ${ok.length} of ${qitems.length}. ${failed.length} failed: ${failed[0].error}. Retry them in the Transfers view.`);
    else if (ok.length) {
      info(`Downloaded ${fmtCount(ok.length)} blob${ok.length > 1 ? 's' : ''} to ${root}.`, 'Reveal').then((p) => { if (p === 'Reveal') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(ok.length === 1 ? plan[0].file : root)); });
      rating.success(toUri(vscode, conn.id, container, plan[0].name));
    }
    return qitems;
  });
  if (opts.wait) await done;
  return { items: qitems, skipped, done };
}

// ---------- change ----------
async function deleteCmd(node, nodes, opts = {}) {
  const sel = selection(node, nodes).filter((n) => n.kind === 'blob' || n.kind === 'folder');
  if (!sel.length) return null;
  writable(connOf(sel[0]));
  const { conn, acct, container, items } = await withProgress('Listing blobs', (p, signal) => expandBlobs(sel, signal));
  if (!items.length) { info('Nothing to delete.'); return null; }
  const sd = await blob.softDeleteInfo(acct);
  const note = sd === null ? 'If soft delete is off for this account, this cannot be undone.' : sd.enabled ? `Soft delete is on: deleted blobs can be restored for ${sd.days} days (in the Azure portal).` : 'Soft delete is off for this account: this cannot be undone.';
  const ok = await confirm.ask(vscode, `Delete ${fmtCount(items.length)} blob${items.length > 1 ? 's' : ''} from ${container}?`, `${note}\n\n${keyList(container, items.map((i) => i.name))}`, 'Delete');
  if (!ok) return { cancelled: true };
  const failed = [];
  let done = 0;
  await withProgress(`Deleting ${fmtCount(items.length)} blobs`, async (progress, signal) => {
    const list = items.slice();
    const worker = async () => {
      while (list.length && !signal.aborted) {
        const it = list.shift();
        try { await blob.deleteBlob(acct, container, it.name, signal); done++; } catch (e) { if (!blob.isAbort(e, signal)) failed.push(`${it.name}: ${describeError(e, conn).message}`); }
        if (done % 25 === 0) progress.report({ message: `${done} of ${items.length}` });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  });
  for (const n of sel) tree.refresh(n.kind === 'blob' ? n.parent : (n.parent || n));
  if (failed.length) warn(`Deleted ${done} of ${items.length}. ${failed.length} failed: ${failed[0]}`);
  else info(`Deleted ${fmtCount(done)} blob${done > 1 ? 's' : ''}.${sd && sd.enabled ? ` Soft delete keeps them for ${sd.days} days.` : ''}`);
  return { done, failed };
}

async function renameCmd(node, nodes, opts = {}) {
  const n = node || (view.selection || [])[0];
  if (!n || (n.kind !== 'blob' && n.kind !== 'folder')) return null;
  const conn = connOf(n);
  writable(conn);
  const acct = await store.account(conn);
  const isFolder = n.kind === 'folder';
  const from = isFolder ? n.prefix : n.blob.name;
  let to = opts.to;
  if (to === undefined) {
    to = await vscode.window.showInputBox({ prompt: `New ${isFolder ? 'folder path' : 'name'} in ${n.container} (a "/" makes folders)`, value: from, valueSelection: [parentPrefix(from).length, (isFolder ? from.length - 1 : from.length)] });
  }
  if (!to || to === from) return null;
  if (isFolder && !to.endsWith('/')) to += '/';
  if (!isFolder && to.endsWith('/')) { warn('A blob name cannot end with "/".'); return null; }
  return moveBlobs(acct, conn, n.container, isFolder ? null : [{ name: from, size: n.blob.size }], isFolder ? from : null, to, [n.parent], opts);
}

/** Server-side copy then delete. items: explicit blobs (rename one blob to `to`), or a folder prefix moved to `to`. */
async function moveBlobs(acct, conn, container, items, fromPrefix, to, refreshNodes, opts = {}) {
  let pairs = [];
  if (fromPrefix !== null && fromPrefix !== undefined) {
    await blob.listAll(acct, container, fromPrefix, (list) => { for (const b of list) pairs.push({ from: b.name, to: to + b.name.slice(fromPrefix.length) }); });
  } else if (items.length === 1 && !to.endsWith('/')) pairs = [{ from: items[0].name, to }];
  else pairs = items.map((i) => ({ from: i.name, to: to + lastSeg(i.name) }));
  pairs = pairs.filter((p) => p.from !== p.to);
  if (!pairs.length) return null;
  const clash = [];
  await Promise.all(pairs.slice(0, 200).map(async (p) => { if (await blob.exists(acct, container, p.to)) clash.push(p.to); }));
  if (!opts.yes) {
    const ok = await confirm.ask(vscode, `${pairs.length === 1 ? 'Rename' : 'Move'} ${fmtCount(pairs.length)} blob${pairs.length > 1 ? 's' : ''}?`,
      `Each blob is copied inside Azure, then the original is deleted.${clash.length ? `\n${clash.length} blob${clash.length > 1 ? 's' : ''} with the new name already exist and will be replaced:\n${keyList(container, clash)}` : ''}\n\n${pairs.slice(0, 15).map((p) => `${p.from} → ${p.to}`).join('\n')}${pairs.length > 15 ? `\n... and ${pairs.length - 15} more` : ''}`, pairs.length === 1 ? 'Rename' : 'Move');
    if (!ok) return { cancelled: true };
  }
  const failed = [];
  let done = 0;
  await withProgress(`Moving ${fmtCount(pairs.length)} blobs`, async (progress, signal) => {
    const list = pairs.slice();
    const worker = async () => {
      while (list.length && !signal.aborted) {
        const p = list.shift();
        try { await blob.renameBlob(acct, container, p.from, p.to, { signal, overwrite: true }); done++; } catch (e) { if (!blob.isAbort(e, signal)) failed.push(`${p.from}: ${describeError(e, conn).message}`); }
        progress.report({ message: `${done} of ${pairs.length}` });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  });
  for (const r of refreshNodes || []) tree.refresh(r);
  if (failed.length) warn(`Moved ${done} of ${pairs.length}. ${failed.length} failed: ${failed[0]}`);
  else info(`${pairs.length === 1 ? 'Renamed' : 'Moved'} ${fmtCount(done)} blob${done > 1 ? 's' : ''}.`);
  return { done, failed };
}

async function onDropBlobs(nodes, dest) {
  const sel = nodes.filter((n) => n.kind === 'blob' && n.container === dest.container && n.conn.id === dest.conn.id);
  if (!sel.length) return null;
  const conn = connOf(dest);
  writable(conn);
  const acct = await store.account(conn);
  const target = prefixOf(dest);
  return moveBlobs(acct, conn, dest.container, sel.map((n) => ({ name: n.blob.name, size: n.blob.size })), null, target, [dest, ...sel.map((n) => n.parent)]);
}

async function setTierCmd(node, nodes, opts = {}) {
  const sel = selection(node, nodes).filter((n) => n.kind === 'blob' || n.kind === 'folder');
  if (!sel.length) return null;
  writable(connOf(sel[0]));
  const tier = opts.tier || (await vscode.window.showQuickPick([
    { label: 'Hot', description: 'frequent reads' }, { label: 'Cool', description: 'kept at least 30 days' }, { label: 'Cold', description: 'kept at least 90 days' },
    { label: 'Archive', description: 'offline: hours to read again, kept at least 180 days' },
  ], { placeHolder: 'Access tier' }) || {}).label;
  if (!tier) return null;
  const { conn, acct, container, items } = await withProgress('Listing blobs', (p, signal) => expandBlobs(sel, signal));
  if (tier === 'Archive' || items.length > 1) {
    const ok = await confirm.ask(vscode, `Move ${fmtCount(items.length)} blob${items.length > 1 ? 's' : ''} to the ${tier} tier?`, `${tier === 'Archive' ? 'Archived blobs cannot be read until they are rehydrated to Hot or Cool, which takes hours and costs a read fee. Early deletion fees apply before 180 days.\n\n' : ''}${keyList(container, items.map((i) => i.name))}`, `Set ${tier}`);
    if (!ok) return { cancelled: true };
  }
  const failed = [];
  let done = 0;
  await withProgress(`Setting ${tier} on ${fmtCount(items.length)} blobs`, async (progress, signal) => {
    const list = items.slice();
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (list.length && !signal.aborted) {
        const it = list.shift();
        try { await blob.setTier(acct, container, it.name, tier, signal); done++; } catch (e) { if (!blob.isAbort(e, signal)) failed.push(`${it.name}: ${describeError(e, conn).message}`); }
      }
    }));
  });
  for (const n of sel) tree.refresh(n.kind === 'blob' ? n.parent : n);
  if (failed.length) warn(`Changed ${done} of ${items.length}. ${failed.length} failed: ${failed[0]}`);
  else info(`${fmtCount(done)} blob${done > 1 ? 's are' : ' is'} now ${tier}.`);
  return { done, failed };
}

async function copyUrl(node) {
  const acct = await acctOf(node);
  const url = node.kind === 'blob' ? blob.plainUrl(acct, node.container, node.blob.name) : blob.plainUrl(acct, node.container);
  await vscode.env.clipboard.writeText(url);
  info(`Copied ${url}`);
  return url;
}

const EXPIRY = { '1h': 3600e3, '1d': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, '365d': 365 * 86400e3 };

async function sasCmd(node, nodes, opts = {}) {
  const acct = await acctOf(node);
  const isBlob = node.kind === 'blob';
  const perm = opts.perm || (await vscode.window.showQuickPick(isBlob ? [
    { label: 'Read', id: 'r' }, { label: 'Read and write', id: 'rw' }, { label: 'Read, write and delete', id: 'rwd' },
  ] : [
    { label: 'Read and list', id: 'rl' }, { label: 'Read, list and write', id: 'rwl' }, { label: 'Read, list, write and delete', id: 'rwdl' },
  ], { placeHolder: 'Permissions of the SAS URL' }) || {}).id;
  if (!perm) return null;
  const exp = opts.exp || (await vscode.window.showQuickPick([
    { label: '1 hour', id: '1h' }, { label: '1 day', id: '1d' }, { label: '7 days', id: '7d' }, { label: '30 days', id: '30d' }, { label: '1 year', id: '365d' },
  ], { placeHolder: 'Valid for' }) || {}).id;
  if (!exp) return null;
  const url = await blob.generateSas(acct, { container: node.container, name: isBlob ? node.blob.name : undefined, permissions: perm, expiresOn: new Date(Date.now() + EXPIRY[exp]) });
  await vscode.env.clipboard.writeText(url);
  info(`Copied a SAS URL (${perm}, valid ${exp}). Anyone with it has these rights until it expires.`);
  return url;
}

async function createContainerCmd(node, nodes, opts = {}) {
  const conn = connOf(node);
  writable(conn);
  const acct = await store.account(conn);
  const name = opts.name || await vscode.window.showInputBox({ prompt: 'Container name', validateInput: (v) => (/^(?!-)(?!.*--)[a-z0-9-]{3,63}(?<!-)$/.test(v) ? null : '3 to 63 lowercase letters, digits and single dashes') });
  if (!name) return null;
  await blob.createContainer(acct, name);
  tree.refresh(node.kind === 'group' ? node : undefined);
  return name;
}

async function deleteContainerCmd(node) {
  const conn = connOf(node);
  writable(conn);
  const acct = await store.account(conn);
  const typed = await vscode.window.showInputBox({ prompt: `Type "${node.container}" to delete the container and every blob in it.`, placeHolder: node.container });
  if (typed !== node.container) return null;
  await blob.deleteContainer(acct, node.container);
  tree.refresh(node.parent);
  return true;
}

async function createQueueOrTable(node, nodes, opts = {}) {
  const conn = connOf(node);
  writable(conn);
  const acct = await store.account(conn);
  const isQ = node.service === 'queue';
  const name = opts.name || await vscode.window.showInputBox({ prompt: `${isQ ? 'Queue' : 'Table'} name`, validateInput: (v) => (isQ ? (/^(?!-)(?!.*--)[a-z0-9-]{3,63}(?<!-)$/.test(v) ? null : '3 to 63 lowercase letters, digits and single dashes') : (/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(v) ? null : '3 to 63 letters and digits, starting with a letter')) });
  if (!name) return null;
  if (isQ) await qt.createQueue(acct, name); else await qt.createTable(acct, name);
  tree.refresh(node);
  return name;
}

async function deleteQueueOrTable(node) {
  const conn = connOf(node);
  writable(conn);
  const acct = await store.account(conn);
  const isQ = node.kind === 'queue';
  const typed = await vscode.window.showInputBox({ prompt: `Type "${node.name}" to delete the ${isQ ? 'queue and all its messages' : 'table and all its entities'}.`, placeHolder: node.name });
  if (typed !== node.name) return null;
  if (isQ) await qt.deleteQueue(acct, node.name); else await qt.deleteTable(acct, node.name);
  tree.refresh(node.parent);
  return true;
}

// ---------- panels ----------
function panelFor(key, title, column) {
  let p = openPanels.get(key);
  if (p) { p.reveal(); return { panel: p, fresh: false }; }
  p = vscode.window.createWebviewPanel('azureStorage.page', title, column || vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'activity.svg');
  openPanels.set(key, p);
  p.onDidDispose(() => openPanels.delete(key));
  if (GATE) {
    const post = p.webview.postMessage.bind(p.webview);
    gatePosts.set(key, []);
    p.webview.postMessage = (m) => { gatePosts.get(key).push(m); return post(m); };
  }
  return { panel: p, fresh: true, key };
}

/** The panel's message handler; the gate calls the same function the webview does. */
function onMessage(key, panel, handler) {
  if (GATE) gateHandlers.set(key, handler);
  panel.webview.onDidReceiveMessage(handler);
}

async function showDetails(node, extra = {}) {
  const conn = connOf(node);
  const acct = await store.account(conn);
  const key = `d:${conn.id}:${node.container}:${node.blob.name}`;
  const { panel, fresh } = panelFor(key, lastSeg(node.blob.name));
  const render = async (more = {}) => {
    const props = await blob.properties(acct, node.container, node.blob.name);
    const canSas = !acct.secret.sas;
    panel.webview.html = panels.detailsHtml(panel.webview, { ...more, props, name: node.blob.name, container: node.container, connName: conn.name, readOnly: conn.readOnly, kind: conn.kind, canSas, sasNote: 'This connection uses a SAS token, so it cannot sign a new one.', showLinks: showLinks(vscode, SECTION) });
    return props;
  };
  await render(extra);
  if (fresh) {
    onMessage(key, panel, async (m) => {
      const post = (text, cls) => panel.webview.postMessage({ type: 'status', text, cls });
      try {
        if (m.cmd === 'open') await openBlob(node);
        else if (m.cmd === 'download') await downloadCmd(node, [node]);
        else if (m.cmd === 'copyUrl') { await copyUrl(node); post('URL copied.', 'ok'); }
        else if (m.cmd === 'refresh') await render();
        else if (m.cmd === 'saveHeaders') { await blob.setHeaders(acct, node.container, node.blob.name, { contentType: m.contentType, cacheControl: m.cacheControl }); await render(); post('Saved.', 'ok'); }
        else if (m.cmd === 'setTier') { const r = await setTierCmd(node, [node], { tier: m.tier }); await render(); if (r && !r.cancelled && !r.failed.length) post(`Tier is now ${m.tier}.`, 'ok'); }
        else if (m.cmd === 'sas') {
          const url = await blob.generateSas(acct, { container: node.container, name: node.blob.name, permissions: m.perm || 'r', expiresOn: new Date(Date.now() + (EXPIRY[m.exp] || EXPIRY['1d'])) });
          await vscode.env.clipboard.writeText(url);
          await render({ sasUrl: url });
          panel.webview.postMessage({ type: 'status', text: 'SAS URL copied to the clipboard.', cls: 'ok' });
        } else if (m.cmd && m.cmd.startsWith('zovo')) await vscode.commands.executeCommand(m.cmd.replace(/^zovo:/, ''));
      } catch (e) { post(describeError(e, conn).message, 'err'); }
    });
  }
  return panel;
}

async function openQueue(node) {
  const conn = connOf(node);
  const acct = await store.account(conn);
  const key = `q:${conn.id}:${node.name}`;
  const { panel, fresh } = panelFor(key, `${node.name} (queue)`);
  if (!fresh) return panel;
  const ws = ctx.globalState.get('azx.queueEncoding') || settings().queueMessageEncoding;
  panel.webview.html = panels.queueHtml(panel.webview, { name: node.name, connName: conn.name, readOnly: conn.readOnly, encoding: ws, showLinks: showLinks(vscode, SECTION) });
  const post = (o) => panel.webview.postMessage(o);
  const refreshCount = async () => { try { const i = await qt.queueInfo(acct, node.name); post({ type: 'count', count: fmtCount(i.approximateMessagesCount) }); } catch (e) { /* the peek shows the error */ } };
  onMessage(key, panel, async (m) => {
    try {
      if (m.cmd === 'peek') { const msgs = await qt.peek(acct, node.name, 32); post({ type: 'messages', messages: msgs }); post({ type: 'status', text: msgs.length ? `Peeked ${msgs.length} message${msgs.length > 1 ? 's' : ''}. Nothing changed.` : 'The queue is empty.' }); await refreshCount(); rating.success(toUri(vscode, conn.id, `queue-${node.name}`, 'peek')); }
      else if (m.cmd === 'send') {
        writable(conn);
        if (!m.text) { post({ type: 'status', text: 'Type a message first.', cls: 'err' }); return; }
        const ttl = m.ttl === '-1' ? -1 : (Number(m.ttl) || undefined);
        await qt.send(acct, node.name, m.text, { encoding: m.encoding, ttlSeconds: ttl });
        await ctx.globalState.update('azx.queueEncoding', m.encoding);
        post({ type: 'sent' }); post({ type: 'status', text: `Sent${m.encoding === 'base64' ? ' (Base64)' : ''}.`, cls: 'ok' });
        post({ type: 'messages', messages: await qt.peek(acct, node.name, 32) }); await refreshCount();
      } else if (m.cmd === 'dequeue') {
        writable(conn);
        const ok = await confirm.ask(vscode, `Dequeue the next message from ${node.name}?`, 'The message is read and then deleted from the queue. Its text is shown here.', 'Dequeue');
        if (!ok) return;
        const msg = await qt.dequeue(acct, node.name);
        post({ type: 'status', text: msg ? `Dequeued and deleted: ${(msg.decoded !== null ? msg.decoded : msg.text).slice(0, 300)}` : 'The queue is empty.', cls: msg ? 'ok' : '' });
        post({ type: 'messages', messages: await qt.peek(acct, node.name, 32) }); await refreshCount();
      } else if (m.cmd === 'clear') {
        writable(conn);
        const ok = await confirm.ask(vscode, `Delete every message in ${node.name}?`, 'This cannot be undone.', 'Clear Queue');
        if (!ok) return;
        await qt.clear(acct, node.name);
        post({ type: 'messages', messages: [] }); post({ type: 'status', text: 'The queue is empty now.', cls: 'ok' }); await refreshCount();
      } else if (m.cmd && m.cmd.startsWith('zovo')) await vscode.commands.executeCommand(m.cmd.replace(/^zovo:/, ''));
    } catch (e) { post({ type: 'status', text: describeError(e, conn).message, cls: 'err' }); gateLog.errors.push({ msg: describeError(e, conn).message }); }
  });
  return panel;
}

async function openTable(node) {
  const conn = connOf(node);
  const acct = await store.account(conn);
  const key = `t:${conn.id}:${node.name}`;
  const { panel, fresh } = panelFor(key, `${node.name} (table)`);
  if (!fresh) return panel;
  panel.webview.html = panels.tableHtml(panel.webview, { name: node.name, connName: conn.name, readOnly: conn.readOnly, showLinks: showLinks(vscode, SECTION) });
  const post = (o) => panel.webview.postMessage(o);
  let next = null;
  let lastQuery = {};
  onMessage(key, panel, async (m) => {
    try {
      if (m.ignore) return;
      if (m.cmd === 'query' || m.cmd === 'more') {
        const more = m.cmd === 'more';
        if (!more) { lastQuery = { filter: (m.filter || '').trim(), top: Math.max(1, Math.min(1000, Number(m.top) || 500)) }; next = null; }
        post({ type: 'status', text: 'Querying...' });
        const r = await qt.query(acct, node.name, { filter: lastQuery.filter, top: lastQuery.top, marker: more ? next : undefined });
        next = r.next || null;
        post({ type: 'rows', rows: r.rows, next: !!next, append: more });
        if (!more) rating.success(toUri(vscode, conn.id, `table-${node.name}`, 'query'));
      } else if (m.cmd === 'saveCell') {
        writable(conn);
        const r = await qt.updateEntity(acct, node.name, { partitionKey: m.pk, rowKey: m.rk, etag: '*', props: { [m.prop]: { type: m.type, value: m.value } } }, 'Merge');
        post({ type: 'saved', i: m.i, prop: m.prop, ptype: m.type, value: m.value, etag: r.etag });
      } else if (m.cmd === 'del') {
        writable(conn);
        const ok = await confirm.ask(vscode, 'Delete this entity?', `PartitionKey: ${m.pk}\nRowKey: ${m.rk}\n\nThis cannot be undone.`, 'Delete');
        if (!ok) return;
        await qt.deleteEntity(acct, node.name, m.pk, m.rk);
        post({ type: 'deleted', i: m.i });
      } else if (m.cmd === 'create') {
        writable(conn);
        const props = {};
        for (const p of JSON.parse(m.props || '[]')) props[p.name] = { type: p.type, value: p.value };
        await qt.createEntity(acct, node.name, { partitionKey: m.pk, rowKey: m.rk, props });
        post({ type: 'created' });
        post({ type: 'status', text: 'Created. Query again to see it.', cls: 'ok' });
      } else if (m.cmd && m.cmd.startsWith('zovo')) await vscode.commands.executeCommand(m.cmd.replace(/^zovo:/, ''));
    } catch (e) {
      const text = describeError(e, conn).message;
      gateLog.errors.push({ msg: text });
      if (m.cmd === 'saveCell') post({ type: 'saveFailed', text }); else post({ type: 'status', text, cls: 'err' });
    }
  });
  return panel;
}

// ---------- Zovo Pro: sync and usage report ----------
async function syncCmd(node, nodes, opts = {}) {
  const dest = destOf(node);
  if (!dest) { warn('Right-click a container or folder to sync it.'); return null; }
  const g = await pro.gate('sync');
  if (!g.ok) return null;
  const direction = opts.direction || (await vscode.window.showQuickPick([
    { label: '$(cloud-upload) Upload: local folder → Azure', id: 'up' }, { label: '$(cloud-download) Download: Azure → local folder', id: 'down' },
  ], { placeHolder: `Sync with ${dest.container}/${dest.prefix}` }) || {}).id;
  if (!direction) return null;
  let root = opts.root;
  if (!root) {
    const pick = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Sync this folder' });
    if (!pick || !pick.length) return null;
    root = pick[0].fsPath;
  }
  const mirror = opts.deleteExtra !== undefined ? opts.deleteExtra : ((await vscode.window.showQuickPick([
    { label: 'Copy new and changed files only', id: false }, { label: 'Mirror: also delete what is only on the target', description: 'you confirm the list first', id: true },
  ], { placeHolder: 'Sync mode' })) || {}).id;
  if (mirror === undefined) return null;
  const job = { connId: dest.conn.id, container: dest.container, prefix: dest.prefix, root, direction, deleteExtra: !!mirror, note: g.note };
  return showSyncPlan(job, opts);
}

async function showSyncPlan(job, opts = {}) {
  const conn = store.get(job.connId);
  const acct = await store.account(conn);
  const make = () => withProgress('Comparing (dry run)', (p, signal) => (job.direction === 'up' ? planUpload : planDownload)({ acct, container: job.container, prefix: job.prefix, root: job.root, excludes: settings().syncExcludes, deleteExtra: job.deleteExtra, signal }));
  let plan = await make();
  const key = `s:${job.connId}:${job.container}:${job.prefix}:${job.root}:${job.direction}`;
  const { panel, fresh } = panelFor(key, 'Sync plan');
  const render = (more = {}) => { panel.webview.html = panels.syncHtml(panel.webview, { plan, connName: conn.name, note: job.note, readOnly: conn.readOnly && job.direction === 'up', showLinks: showLinks(vscode, SECTION), ...more }); };
  render();
  const apply = async () => {
    if (plan.remove.length) {
      const names = plan.remove.map((x) => x.key || x.file);
      const ok = await confirm.ask(vscode, `Delete ${fmtCount(names.length)} ${job.direction === 'up' ? 'blobs in Azure' : 'local files'} as part of the sync?`, names.slice(0, 15).join('\n') + (names.length > 15 ? `\n... and ${names.length - 15} more` : ''), 'Delete and Sync');
      if (!ok) return null;
    }
    render({ applying: true, result: 'Applying...' });
    const r = await withProgress('Syncing', (progress, signal) => applyPlan(plan, { acct, signal, concurrency: settings().parallelTransfers, contentTypeFor, onProgress: (x) => progress.report({ message: `${x.done} of ${x.total}` }) }));
    const text = r.cancelled ? 'Cancelled.' : r.failed.length ? `${r.done - r.failed.length} done, ${r.failed.length} failed: ${r.failed[0].error}` : `Done: ${r.done} change${r.done === 1 ? '' : 's'}${r.deleted ? `, ${r.deleted} deleted` : ''}.`;
    plan = await make();
    render({ result: text });
    tree.refresh();
    if (!r.cancelled && !r.failed.length) rating.success(toUri(vscode, conn.id, job.container, job.prefix || 'sync'));
    return r;
  };
  if (fresh) {
    onMessage(key, panel, async (m) => {
      try {
        if (m.cmd === 'apply') await apply();
        else if (m.cmd === 'replan') { plan = await make(); render(); }
        else if (m.cmd && m.cmd.startsWith('zovo')) await vscode.commands.executeCommand(m.cmd.replace(/^zovo:/, ''));
      } catch (e) { render({ result: describeError(e, conn).message }); }
    });
  }
  if (opts.apply) { const result = await apply(); return { plan, result }; }
  return { plan, panel };
}

async function usageCmd(node, nodes, opts = {}) {
  const dest = destOf(node);
  if (!dest) { warn('Right-click a container or folder for its usage report.'); return null; }
  const g = await pro.gate('usage');
  if (!g.ok) return null;
  const conn = connOf(dest);
  const acct = await store.account(conn);
  const report = await withProgress(`Measuring ${dest.container}/${dest.prefix}`, (progress, signal) => usageReport({ acct, container: dest.container, prefix: dest.prefix, prices: settings().pricePerGBMonth, signal, onProgress: (n, bytes) => progress.report({ message: `${fmtCount(n)} blobs, ${fmtBytes(bytes)}` }) }));
  const { panel } = panelFor(`u:${conn.id}:${dest.container}:${dest.prefix}`, `Usage: ${dest.container}`);
  panel.webview.html = panels.usageHtml(panel.webview, { report, connName: conn.name, note: g.note, showLinks: showLinks(vscode, SECTION) });
  rating.success(toUri(vscode, conn.id, dest.container, dest.prefix || 'usage'));
  return { report, panel };
}

// ---------- activate ----------
function activate(context) {
  const t0 = Date.now();
  ctx = context;
  store = new ConnectionStore({ vscode, context, settings });
  tree = new StorageTree({ vscode, store, settings, onError: (e, conn) => { gateLog.errors.push({ msg: describeError(e, conn).message, code: e && e.code }); } });
  const dnd = createDnd({ vscode, onDropFiles: (uris, dest) => uploadPaths(uris.map((u) => u.fsPath), destOf(dest)).catch((e) => showError(e, dest.conn)), onDropBlobs: (nodes, dest) => onDropBlobs(nodes, dest).catch((e) => showError(e, dest.conn)) });
  view = vscode.window.createTreeView('azureStorage.accounts', { treeDataProvider: tree, dragAndDropController: dnd, canSelectMany: true, showCollapseAll: true });
  context.subscriptions.push(view, store.onDidChange(() => tree.emitter.fire(undefined)));

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusItem.command = 'azureStorage.transfers.focus';
  context.subscriptions.push(statusItem);
  let viewTimer = null;
  queue = new TransferQueue({ concurrency: settings().parallelTransfers, onChange: () => { if (viewTimer) return; viewTimer = setTimeout(() => { viewTimer = null; transfersView.refresh(); transferStatus(); }, 250); } });
  transfersView = new TransfersView({ vscode, queue, fmtBytes });
  context.subscriptions.push(vscode.window.createTreeView('azureStorage.transfers', { treeDataProvider: transfersView }));

  const fsp = new BlobFileSystem({ vscode, store, maxBytes: () => settings().maxTextPreviewMB * MB, onRead: (uri, n, err) => { if (err) rating.failure(); } });
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('azblob', fsp, { isCaseSensitive: true }));

  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: 'Azure Storage Explorer' });
  registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  pro = createPro({ vscode, context });

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { showError(e, a[0] && a[0].conn ? store.get(a[0].conn.id) : null); return undefined; }
  }));
  reg('azureStorage.addConnection', addConnection);
  reg('azureStorage.connectAzurite', () => connectAzurite());
  reg('azureStorage.startAzurite', startAzurite);
  reg('azureStorage.editConnection', editConnection);
  reg('azureStorage.toggleReadOnly', async (n) => { const c = connOf(n); await store.update(c.id, { readOnly: !c.readOnly }); tree.refresh(); });
  reg('azureStorage.removeConnection', removeConnection);
  reg('azureStorage.refresh', (n) => { if (n && (n.kind === 'message' || n.kind === 'more')) n = n.parent; if (n && n.kind === 'connection') store.dropClient(n.conn.id); tree.refresh(n); });
  reg('azureStorage.loadMore', (n) => tree.loadMore(n));
  reg('azureStorage.openBlob', (n, nodes, o) => openBlob(n, o));
  reg('azureStorage.openBlobHead', (n) => openBlob(n, { mode: 'head' }));
  reg('azureStorage.showDetails', (n) => showDetails(n));
  reg('azureStorage.upload', (n, nodes, o) => uploadCmd(n, nodes, o));
  reg('azureStorage.uploadFolder', (n, nodes, o) => uploadCmd(n, nodes, Object.assign({ folders: true }, o)));
  reg('azureStorage.download', downloadCmd);
  reg('azureStorage.delete', deleteCmd);
  reg('azureStorage.rename', renameCmd);
  reg('azureStorage.setTier', setTierCmd);
  reg('azureStorage.copyUrl', copyUrl);
  reg('azureStorage.generateSas', sasCmd);
  reg('azureStorage.createContainer', createContainerCmd);
  reg('azureStorage.deleteContainer', deleteContainerCmd);
  reg('azureStorage.createQueueOrTable', createQueueOrTable);
  reg('azureStorage.deleteQueueOrTable', deleteQueueOrTable);
  reg('azureStorage.openQueue', openQueue);
  reg('azureStorage.openTable', openTable);
  reg('azureStorage.sync', syncCmd);
  reg('azureStorage.usageReport', usageCmd);
  reg('azureStorage.cancelTransfer', (t) => { const id = transferId(t); if (id) queue.cancel(id); });
  reg('azureStorage.retryTransfer', (t) => { const id = transferId(t); if (id) queue.retry(id); });
  reg('azureStorage.cancelAllTransfers', () => queue.cancelAll());
  reg('azureStorage.clearTransfers', () => queue.clearFinished());
  reg('azureStorage.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#azureStorage.start`, false));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${SECTION}.parallelTransfers`)) queue.concurrency = settings().parallelTransfers; if (e.affectsConfiguration(SECTION)) store.disposeAll(); }));
  context.subscriptions.push({ dispose: () => { queue.cancelAll(); store.disposeAll(); } });
  const activationMs = Date.now() - t0;

  if (!GATE) return undefined;
  // A hook for the release gate only (VS Code started with ZOVO_AZX_GATE=1). Normal installs export nothing.
  return { _gate: {
    store, tree, view, queue, confirm, gateLog, pro, activationMs, connstr, blob, qt,
    saveConnection, connectAzurite, openBlob, uploadPaths, downloadCmd, deleteCmd, renameCmd, moveBlobs, setTierCmd, copyUrl, sasCmd,
    showDetails, openQueue, openTable, syncCmd, showSyncPlan, usageCmd, createContainerCmd, openPanels, gateHandlers, gatePosts, rating: () => rating, editConnection, addConnection, settings,
  } };
}

function transferId(t) { if (!t) return 0; if (typeof t === 'number') return t; if (t.id && typeof t.id === 'number') return t.id; return 0; }

function deactivate() { if (queue) queue.cancelAll(); if (store) store.disposeAll(); }

module.exports = { activate, deactivate };
