'use strict';
// Saved connections. The list (names, endpoints, read-only flag) is in globalState; keys, connection strings and SAS
// tokens are only in SecretStorage (the OS keychain). Entra ID connections store no secret: VS Code keeps the session.
const crypto = require('crypto');
const { Account, tokenCredentialFrom } = require('./azure/service');

const LIST_KEY = 'azx.connections.v1';
const SECRET = (id) => `azx.secret.${id}`;
const STORAGE_SCOPE = 'https://storage.azure.com/.default';

class ConnectionStore {
  constructor({ vscode, context, settings }) {
    this.vscode = vscode;
    this.context = context;
    this.settings = settings;
    this.accounts = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  list() { return (this.context.globalState.get(LIST_KEY) || []).slice(); }
  get(id) { return this.list().find((c) => c.id === id) || null; }

  async _write(list) { await this.context.globalState.update(LIST_KEY, list); this.emitter.fire(); }

  /** parsed: from connstr.js; o: { name, readOnly }. Returns the saved record. */
  async add(parsed, o = {}) {
    const id = o.id || crypto.randomBytes(6).toString('hex');
    const rec = {
      id,
      name: o.name || parsed.account,
      kind: parsed.kind,
      account: parsed.account,
      endpoints: parsed.endpoints,
      services: parsed.services,
      readOnly: !!o.readOnly,
      created: new Date().toISOString(),
    };
    if (parsed.container) rec.container = parsed.container;
    if (parsed.queue) rec.queue = parsed.queue;
    if (parsed.table) rec.table = parsed.table;
    if (parsed.host) rec.host = parsed.host;
    if (parsed.tenant) rec.tenant = parsed.tenant;
    if (parsed.sasInfo) { rec.sasExpires = parsed.sasInfo.expires; rec.sasPermissions = parsed.sasInfo.permissions; }
    const secret = parsed.secret || {};
    if (parsed.kind !== 'azurite' && (secret.accountKey || secret.sas)) await this.context.secrets.store(SECRET(id), JSON.stringify(secret));
    const list = this.list().filter((c) => c.id !== id);
    list.push(rec);
    this.dropClient(id);
    await this._write(list);
    return rec;
  }

  async update(id, changes) {
    const list = this.list();
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return null;
    list[i] = Object.assign({}, list[i], changes);
    this.dropClient(id);
    await this._write(list);
    return list[i];
  }

  async remove(id) {
    await this.context.secrets.delete(SECRET(id));
    this.dropClient(id);
    await this._write(this.list().filter((c) => c.id !== id));
  }

  async secretOf(conn) {
    if (conn.kind === 'azurite') return { accountKey: require('./azure/connstr').AZURITE_KEY };
    if (conn.kind === 'entra') return {};
    const raw = await this.context.secrets.get(SECRET(conn.id));
    if (!raw) { const e = new Error(`The key of "${conn.name}" is not in the keychain of this computer. Choose Edit Connection and paste it again.`); e.code = 'NoSecret'; throw e; }
    return JSON.parse(raw);
  }

  /** The Account for a connection (SDK clients are created on first use). */
  async account(conn) {
    const c = typeof conn === 'string' ? this.get(conn) : this.get(conn.id) || conn;
    if (!c) throw new Error('This connection no longer exists.');
    const have = this.accounts.get(c.id);
    if (have && have.conn.readOnly === c.readOnly) return have;
    const secret = await this.secretOf(c);
    const s = this.settings();
    const opts = { timeoutMs: (s.requestTimeoutSeconds || 30) * 1000 };
    if (c.kind === 'entra') opts.tokenCredential = tokenCredentialFrom(() => this.entraToken(c, true));
    const a = new Account(c, secret, opts);
    this.accounts.set(c.id, a);
    return a;
  }

  /** A Microsoft session from VS Code's built-in sign-in, for Azure Storage. Asks only when the user acted. */
  async entraToken(conn, createIfNone = true) {
    const scopes = [STORAGE_SCOPE];
    if (conn.tenant) scopes.push(`VSCODE_TENANT:${conn.tenant}`);
    let session = await this.vscode.authentication.getSession('microsoft', scopes, { silent: true });
    if (!session && createIfNone !== false) session = await this.vscode.authentication.getSession('microsoft', scopes, { createIfNone: true });
    if (!session) { const e = new Error(`Sign in with Microsoft to open "${conn.name}".`); e.code = 'NoSession'; throw e; }
    return { token: session.accessToken };
  }

  dropClient(id) { const a = this.accounts.get(id); if (a) a.dispose(); this.accounts.delete(id); }
  disposeAll() { for (const id of [...this.accounts.keys()]) this.dropClient(id); }
}

module.exports = { ConnectionStore, LIST_KEY, SECRET, STORAGE_SCOPE };
