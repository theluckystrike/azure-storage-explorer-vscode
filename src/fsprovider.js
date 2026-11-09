'use strict';
// "azblob:" file system for text blobs opened in an editor tab: azblob://<connection id>/<container>/<blob name>.
// Reads stream into memory only up to the text size limit (the caller checks the size first). Save uploads the text
// back with the blob's ETag as a condition, so a blob changed by someone else is never overwritten silently.
const path = require('path');
const blob = require('./azure/blob');
const { contentTypeFor } = require('./types');

function toUri(vscode, connId, container, name, query) {
  return vscode.Uri.from({ scheme: 'azblob', authority: connId, path: `/${container}/${name}`, query: query || '' });
}

function fromUri(uri) {
  const p = uri.path.replace(/^\//, '');
  const i = p.indexOf('/');
  if (i < 0) return { connId: uri.authority, container: p, name: '' };
  return { connId: uri.authority, container: p.slice(0, i), name: p.slice(i + 1), query: uri.query || '' };
}

class BlobFileSystem {
  constructor({ vscode, store, maxBytes, onRead }) {
    this.vscode = vscode;
    this.store = store;
    this.maxBytes = maxBytes;
    this.onRead = onRead || (() => {});
    this.etags = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
  }

  watch() { return { dispose() {} }; }

  async stat(uri) {
    const { connId, container, name } = fromUri(uri);
    const vs = this.vscode;
    if (!name) return { type: vs.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const acct = await this.store.account(connId);
    try {
      const p = await blob.properties(acct, container, name);
      return { type: vs.FileType.File, ctime: Date.parse(p.createdOn) || 0, mtime: Date.parse(p.lastModified) || 0, size: p.size, permissions: acct.conn.readOnly ? vs.FilePermission.Readonly : undefined };
    } catch (e) {
      if (e && (e.statusCode === 404 || e.code === 'BlobNotFound')) throw vs.FileSystemError.FileNotFound(uri);
      throw e;
    }
  }

  readDirectory() { return []; }
  createDirectory() { throw this.vscode.FileSystemError.NoPermissions('Create folders from the Azure Storage view.'); }

  async readFile(uri) {
    const { connId, container, name, query } = fromUri(uri);
    const acct = await this.store.account(connId);
    try {
      const head = /(^|&)head=(\d+)/.exec(query || '');
      let buf;
      if (head) buf = await blob.readHead(acct, container, name, Number(head[2]));
      else {
        const p = await blob.properties(acct, container, name);
        if (p.size > this.maxBytes()) { const e = new Error(`${path.posix.basename(name)} is larger than the text limit. Use "Open the First 1 MB" or Download.`); e.code = 'TooLarge'; throw e; }
        buf = await acct.container(container).getBlobClient(name).downloadToBuffer();
        this.etags.set(uri.toString(), p.etag);
      }
      this.onRead(uri, buf.length, null);
      return buf;
    } catch (e) {
      this.onRead(uri, 0, e);
      if (e && (e.statusCode === 404 || e.code === 'BlobNotFound')) throw this.vscode.FileSystemError.FileNotFound(uri);
      throw e;
    }
  }

  async writeFile(uri, content) {
    const { connId, container, name, query } = fromUri(uri);
    const vs = this.vscode;
    if (/(^|&)head=/.test(query || '')) throw vs.FileSystemError.NoPermissions('This tab shows only the first part of the blob, so it cannot be saved back.');
    const acct = await this.store.account(connId);
    if (acct.conn.readOnly) throw vs.FileSystemError.NoPermissions(`"${acct.conn.name}" is read-only.`);
    const etag = this.etags.get(uri.toString());
    try {
      const r = await blob.uploadData(acct, container, name, Buffer.from(content), { ifMatch: etag, contentType: contentTypeFor(name) });
      this.etags.set(uri.toString(), r.etag);
    } catch (e) {
      if (e && (e.statusCode === 412 || e.code === 'ConditionNotMet')) throw vs.FileSystemError.Unavailable(`${path.posix.basename(name)} changed in Azure since you opened it, so it was not overwritten. Close the tab and open the blob again.`);
      throw e;
    }
    this.emitter.fire([{ type: vs.FileChangeType.Changed, uri }]);
  }

  delete() { throw this.vscode.FileSystemError.NoPermissions('Delete blobs from the Azure Storage view (it asks first).'); }
  rename() { throw this.vscode.FileSystemError.NoPermissions('Rename blobs from the Azure Storage view.'); }
}

module.exports = { BlobFileSystem, toUri, fromUri };
