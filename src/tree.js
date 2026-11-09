'use strict';
// The Azure Storage tree: connection > Blob Containers / Queues / Tables > container > folders and blobs.
// Every level loads lazily, one page at a time, with a "Load more" row. Nothing connects until a node is expanded.
const blob = require('./azure/blob');
const qt = require('./azure/queuetable');
const { fmtBytes, describeError } = require('./ui');

const DND_MIME = 'application/vnd.code.tree.azureStorage.blobs';
// Tree item ids carry a per-window nonce, so VS Code does not restore expanded connections at start-up: nothing
// connects until the user expands a node in this window.
const SESSION = require('crypto').randomBytes(3).toString('hex');

function lastSeg(name) { const n = name.endsWith('/') ? name.slice(0, -1) : name; return n.slice(n.lastIndexOf('/') + 1) || n; }
function shortDate(iso) { return iso ? iso.slice(0, 16).replace('T', ' ') : ''; }

class StorageTree {
  constructor({ vscode, store, settings, onError }) {
    this.vscode = vscode;
    this.store = store;
    this.settings = settings;
    this.onError = onError || (() => {});
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.pages = new Map(); // node key -> { items: [...nodes], next }
  }

  keyOf(n) {
    if (!n) return 'root';
    switch (n.kind) {
      case 'connection': return `c:${n.conn.id}`;
      case 'group': return `g:${n.conn.id}:${n.service}`;
      case 'container': return `b:${n.conn.id}:${n.container}`;
      case 'folder': return `f:${n.conn.id}:${n.container}:${n.prefix}`;
      case 'blob': return `o:${n.conn.id}:${n.container}:${n.blob.name}`;
      case 'queue': return `q:${n.conn.id}:${n.name}`;
      case 'table': return `t:${n.conn.id}:${n.name}`;
      default: return `${n.kind}:${n.conn ? n.conn.id : ''}:${n.label || ''}`;
    }
  }

  refresh(node) {
    if (!node) this.pages.clear();
    else if (node.kind === 'connection') { for (const key of [...this.pages.keys()]) if (key.split(':')[1] === node.conn.id) this.pages.delete(key); }
    else { const k = this.keyOf(node); for (const key of [...this.pages.keys()]) if (key === k || key.startsWith(k + ':') || key.startsWith(k.replace(/^b:/, 'f:') + ':')) this.pages.delete(key); }
    this.emitter.fire(node && node.kind !== 'blob' ? node : undefined);
  }

  getParent(n) { return n.parent; }

  async getChildren(n) {
    if (!n) {
      return this.store.list().sort((a, b) => a.name.localeCompare(b.name)).map((conn) => ({ kind: 'connection', conn }));
    }
    try {
      if (n.kind === 'connection') return this.groups(n);
      if (n.kind === 'group' || n.kind === 'container' || n.kind === 'folder') return await this.paged(n, false);
      return [];
    } catch (e) {
      const d = describeError(e, n.conn);
      this.onError(e, n.conn);
      return [{ kind: 'message', conn: n.conn, parent: n, label: d.message, error: true }];
    }
  }

  groups(n) {
    const c = n.conn;
    const out = [];
    const has = (s) => (c.services || []).includes(s) && c.endpoints && c.endpoints[s];
    if (has('blob')) out.push({ kind: 'group', conn: c, service: 'blob', parent: n });
    if (has('queue')) out.push({ kind: 'group', conn: c, service: 'queue', parent: n });
    if (has('table')) out.push({ kind: 'group', conn: c, service: 'table', parent: n });
    return out;
  }

  async fetchPage(n, marker) {
    const acct = await this.store.account(n.conn);
    const pageSize = this.settings().pageSize;
    if (n.kind === 'group' && n.service === 'blob') {
      const r = await blob.listContainers(acct, { marker, pageSize });
      return { items: r.items.map((c) => ({ kind: 'container', conn: n.conn, container: c.name, info: c, parent: n })), next: r.next };
    }
    if (n.kind === 'group' && n.service === 'queue') {
      const r = await qt.listQueues(acct, { marker, pageSize });
      return { items: r.items.map((q) => ({ kind: 'queue', conn: n.conn, name: q.name, parent: n })), next: r.next };
    }
    if (n.kind === 'group' && n.service === 'table') {
      const r = await qt.listTables(acct, { marker, pageSize });
      return { items: r.items.map((t) => ({ kind: 'table', conn: n.conn, name: t.name, parent: n })), next: r.next };
    }
    const prefix = n.kind === 'folder' ? n.prefix : '';
    const r = await blob.listLevel(acct, n.container, prefix, { marker, pageSize });
    const items = [];
    for (const f of r.folders) items.push({ kind: 'folder', conn: n.conn, container: n.container, prefix: f, parent: n });
    for (const b of r.blobs) items.push({ kind: 'blob', conn: n.conn, container: n.container, blob: b, parent: n });
    return { items, next: r.next };
  }

  async paged(n, more) {
    const k = this.keyOf(n);
    let p = this.pages.get(k);
    if (!p || more) {
      const r = await this.fetchPage(n, p && more ? p.next : undefined);
      if (p && more) { p.items.push(...r.items); p.next = r.next; p.loads++; } else { p = { items: r.items, next: r.next, loads: 1 }; }
      this.pages.set(k, p);
    }
    const out = p.items.slice();
    if (p.next) out.push({ kind: 'more', conn: n.conn, parent: n, label: `Load more (${p.items.length.toLocaleString('en-US')} shown)` });
    if (!out.length) out.push({ kind: 'message', conn: n.conn, parent: n, label: n.kind === 'group' ? `No ${n.service === 'blob' ? 'containers' : n.service === 'queue' ? 'queues' : 'tables'} yet` : 'Empty' });
    return out;
  }

  async loadMore(moreNode) {
    const parent = moreNode.parent;
    await this.paged(parent, true);
    this.emitter.fire(parent);
  }

  /** Items loaded so far under a node (for the gate and for "select all"). */
  loaded(n) { const p = this.pages.get(this.keyOf(n)); return p ? p.items : []; }

  getTreeItem(n) {
    const vs = this.vscode;
    const C = vs.TreeItemCollapsibleState;
    let t;
    switch (n.kind) {
      case 'connection': {
        const c = n.conn;
        t = new vs.TreeItem(c.name, C.Collapsed);
        const kinds = { key: 'account key', connstr: 'connection string', sas: 'SAS', azurite: 'Azurite', entra: 'Entra ID' };
        t.description = `${kinds[c.kind] || c.kind}${c.readOnly ? ' · read-only' : ''}`;
        const lines = [`${c.name}`, `Account: ${c.account}`, `Sign-in: ${kinds[c.kind] || c.kind}`];
        if (c.sasExpires) lines.push(`SAS expires: ${shortDate(c.sasExpires)} UTC`);
        if (c.readOnly) lines.push('Read-only: nothing can be changed from this connection.');
        for (const s of ['blob', 'queue', 'table']) if (c.endpoints && c.endpoints[s]) lines.push(`${s}: ${c.endpoints[s]}`);
        t.tooltip = lines.join('\n');
        t.iconPath = new vs.ThemeIcon(c.kind === 'azurite' ? 'beaker' : c.readOnly ? 'lock' : 'azure');
        t.contextValue = `connection${c.readOnly ? '-ro' : ''}`;
        break;
      }
      case 'group': {
        const labels = { blob: 'Blob Containers', queue: 'Queues', table: 'Tables' };
        t = new vs.TreeItem(labels[n.service], C.Collapsed);
        t.iconPath = new vs.ThemeIcon(n.service === 'blob' ? 'archive' : n.service === 'queue' ? 'list-ordered' : 'table');
        t.contextValue = `group-${n.service}`;
        break;
      }
      case 'container':
        t = new vs.TreeItem(n.container, C.Collapsed);
        t.iconPath = new vs.ThemeIcon('package');
        t.description = n.info && n.info.publicAccess ? `public ${n.info.publicAccess}` : '';
        t.tooltip = `${n.container}${n.info && n.info.lastModified ? `\nModified ${shortDate(n.info.lastModified)}` : ''}${n.info && n.info.publicAccess ? `\nAnonymous read access: ${n.info.publicAccess}` : ''}`;
        t.contextValue = 'container';
        break;
      case 'folder':
        t = new vs.TreeItem(lastSeg(n.prefix), C.Collapsed);
        t.iconPath = vs.ThemeIcon.Folder;
        t.tooltip = `${n.container}/${n.prefix}`;
        t.contextValue = 'folder';
        break;
      case 'blob': {
        const b = n.blob;
        t = new vs.TreeItem(lastSeg(b.name), C.None);
        t.resourceUri = vs.Uri.from({ scheme: 'azblob', authority: n.conn.id, path: `/${n.container}/${b.name}` });
        t.iconPath = vs.ThemeIcon.File;
        const tier = b.tier ? `${b.tier}${b.tierInferred ? '' : ''}` : '';
        t.description = [fmtBytes(b.size), tier, shortDate(b.lastModified)].filter(Boolean).join(' · ');
        t.tooltip = new vs.MarkdownString([
          `**${b.name.replace(/[*_`[\]]/g, '\\$&')}**`, '',
          `Size: ${fmtBytes(b.size)} (${b.size.toLocaleString('en-US')} bytes)`,
          `Tier: ${b.tier || 'n/a'}${b.archiveStatus ? ` (${b.archiveStatus})` : ''}`,
          `Modified: ${shortDate(b.lastModified)} UTC`,
          `Content type: ${b.contentType || 'none'}`,
          `Type: ${b.blobType || ''}`,
        ].join('  \n'));
        t.command = { command: 'azureStorage.openBlob', title: 'Open', arguments: [n] };
        t.contextValue = 'blob';
        break;
      }
      case 'queue':
        t = new vs.TreeItem(n.name, C.None);
        t.iconPath = new vs.ThemeIcon('mail');
        t.command = { command: 'azureStorage.openQueue', title: 'Open Queue', arguments: [n] };
        t.contextValue = 'queue';
        break;
      case 'table':
        t = new vs.TreeItem(n.name, C.None);
        t.iconPath = new vs.ThemeIcon('table');
        t.command = { command: 'azureStorage.openTable', title: 'Open Table', arguments: [n] };
        t.contextValue = 'table';
        break;
      case 'more':
        t = new vs.TreeItem(n.label, C.None);
        t.iconPath = new vs.ThemeIcon('ellipsis');
        t.command = { command: 'azureStorage.loadMore', title: 'Load more', arguments: [n] };
        t.contextValue = 'more';
        break;
      default:
        t = new vs.TreeItem(n.label || '', C.None);
        t.iconPath = new vs.ThemeIcon(n.error ? 'warning' : 'info');
        t.tooltip = n.label;
        t.contextValue = n.error ? 'error' : 'message';
    }
    t.id = `${SESSION}|${this.keyOf(n)}`;
    return t;
  }
}

/** Drag files from the OS or the Explorer onto a container or folder to upload; drag blobs onto a folder to move. */
function createDnd({ vscode, onDropFiles, onDropBlobs }) {
  return {
    dragMimeTypes: [DND_MIME],
    dropMimeTypes: [DND_MIME, 'text/uri-list', 'files'],
    handleDrag(source, dt) {
      const items = source.filter((n) => n.kind === 'blob' || n.kind === 'folder');
      if (items.length) dt.set(DND_MIME, new vscode.DataTransferItem(items));
    },
    async handleDrop(target, dt) {
      if (!target) return;
      const dest = target.kind === 'blob' ? target.parent : target;
      if (!dest || (dest.kind !== 'container' && dest.kind !== 'folder')) return;
      const internal = dt.get(DND_MIME);
      if (internal && Array.isArray(internal.value) && internal.value.length) { if (onDropBlobs) await onDropBlobs(internal.value, dest); return; }
      const uris = [];
      const list = dt.get('text/uri-list');
      if (list) {
        const text = await list.asString();
        for (const line of text.split(/\r?\n/)) { const l = line.trim(); if (l && !l.startsWith('#')) { try { uris.push(vscode.Uri.parse(l)); } catch (e) { /* skip */ } } }
      }
      if (!uris.length) dt.forEach((item) => { const f = item.asFile && item.asFile(); if (f && f.uri) uris.push(f.uri); });
      const files = uris.filter((u) => u.scheme === 'file');
      if (files.length) await onDropFiles(files, dest);
    },
  };
}

module.exports = { StorageTree, createDnd, DND_MIME, lastSeg };
