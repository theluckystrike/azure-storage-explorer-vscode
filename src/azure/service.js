'use strict';
// One storage account (or one container, queue or table for a narrow SAS) and its SDK clients. The Azure SDKs are
// required here only, the first time a connection is used, so activation loads none of them.
// Network: only the endpoints of this connection. The SDKs send no telemetry of their own; the user agent only
// names the SDK and this extension.

const UA = 'zovo-azure-storage-explorer';
let sdk = null;
function SDK() {
  if (!sdk) {
    sdk = {
      blob: require('@azure/storage-blob'),
      queue: require('@azure/storage-queue'),
      tables: require('@azure/data-tables'),
    };
  }
  return sdk;
}

// Azurite releases trail the SDK: Azurite 3.35 refuses the SDK's 2026 API version with "API version not supported".
// For Azurite connections the requests use an older API version that every Azurite since 2025 accepts.
const AZURITE_API_VERSION = '2025-05-05';
function pinVersion(pipeline, version) {
  // First in the chain, so the header is set before the Shared Key signature is computed.
  pipeline.factories.unshift({ create: (next) => ({ sendRequest: (req) => { req.headers.set('x-ms-version', version); return next.sendRequest(req); } }) });
  return pipeline;
}

class ReadOnlyError extends Error {
  constructor(name) { super(`"${name}" is read-only. Turn off "Read-only" in Edit Connection to change anything.`); this.code = 'ReadOnly'; }
}

/**
 * conn: { id, name, kind, account, endpoints, services, container?, queue?, table?, readOnly, host? }
 * secret: { accountKey?, sas? }. tokenCredential: an @azure/core-auth TokenCredential for kind "entra".
 */
class Account {
  constructor(conn, secret, opts = {}) {
    this.conn = conn;
    this.secret = secret || {};
    this.opts = opts;
    this._c = {};
  }

  get kind() { return this.conn.kind; }
  /** Azurite: the one-click entry, or any connection to its development account (connection string, SAS URL). */
  isEmulator() { return this.conn.kind === 'azurite' || this.conn.account === 'devstoreaccount1'; }
  has(service) { return (this.conn.services || []).includes(service) && !!(this.conn.endpoints || {})[service]; }
  assertWritable() { if (this.conn.readOnly) throw new ReadOnlyError(this.conn.name); }

  pipelineOptions() {
    const timeoutMs = this.opts.timeoutMs || 30000;
    return {
      userAgentOptions: { userAgentPrefix: UA },
      retryOptions: { maxTries: this.opts.maxTries || 3, tryTimeoutInMs: Math.max(timeoutMs, 5000), retryDelayInMs: 500, maxRetryDelayInMs: 4000 },
      keepAliveOptions: { enable: true },
    };
  }

  pipeline(S, kind) {
    const p = S.newPipeline(this.credential(kind), this.pipelineOptions());
    return this.isEmulator() ? pinVersion(p, AZURITE_API_VERSION) : p;
  }

  sharedKey() {
    if (!this.secret.accountKey) return null;
    if (!this._c.key) this._c.key = new (SDK().blob.StorageSharedKeyCredential)(this.conn.account, this.secret.accountKey);
    return this._c.key;
  }

  withSas(url) {
    if (!this.secret.sas) return url;
    return url + (url.includes('?') ? '&' : '?') + this.secret.sas;
  }

  credential(kind) {
    const S = SDK();
    if (this.conn.kind === 'entra') return this.opts.tokenCredential;
    if (this.secret.accountKey) {
      if (kind === 'tables') return new S.tables.AzureNamedKeyCredential(this.conn.account, this.secret.accountKey);
      if (kind === 'queue') return new S.queue.StorageSharedKeyCredential(this.conn.account, this.secret.accountKey);
      return this.sharedKey();
    }
    if (this.secret.sas && kind === 'tables') return new S.tables.AzureSASCredential(this.secret.sas);
    return kind === 'queue' ? new S.queue.AnonymousCredential() : new S.blob.AnonymousCredential();
  }

  // ---------- blob ----------
  /** The service client, or null for a container-only SAS. */
  blobService() {
    if (this._c.blob !== undefined) return this._c.blob;
    const S = SDK().blob;
    if (!this.has('blob') || this.conn.container) { this._c.blob = null; return null; }
    const ep = this.conn.endpoints.blob;
    const pipeline = this.pipeline(S, 'blob');
    this._c.blob = new S.BlobServiceClient(this.secret.sas ? this.withSas(ep) : ep, pipeline);
    return this._c.blob;
  }

  container(name) {
    const svc = this.blobService();
    if (svc) return svc.getContainerClient(name);
    const S = SDK().blob;
    const pipeline = this.pipeline(S, 'blob');
    const url = `${this.conn.endpoints.blob}/${encodeURIComponent(name)}`;
    return new S.ContainerClient(this.withSas(url), pipeline);
  }

  // ---------- queue ----------
  queueService() {
    if (this._c.queue !== undefined) return this._c.queue;
    const S = SDK().queue;
    if (!this.has('queue') || this.conn.queue) { this._c.queue = null; return null; }
    const ep = this.conn.endpoints.queue;
    const pipeline = this.pipeline(S, 'queue');
    this._c.queue = new S.QueueServiceClient(this.secret.sas ? this.withSas(ep) : ep, pipeline);
    return this._c.queue;
  }

  queueClient(name) {
    const svc = this.queueService();
    if (svc) return svc.getQueueClient(name);
    const S = SDK().queue;
    const pipeline = this.pipeline(S, 'queue');
    return new S.QueueClient(this.withSas(`${this.conn.endpoints.queue}/${encodeURIComponent(name)}`), pipeline);
  }

  // ---------- tables ----------
  tableOptions() {
    const ep = this.conn.endpoints.table || '';
    return { allowInsecureConnection: ep.startsWith('http:'), userAgentOptions: { userAgentPrefix: UA }, retryOptions: { maxRetries: 2 } };
  }

  tableService() {
    if (this._c.table !== undefined) return this._c.table;
    if (!this.has('table') || this.conn.table) { this._c.table = null; return null; }
    const S = SDK().tables;
    this._c.table = new S.TableServiceClient(this.conn.endpoints.table, this.credential('tables'), this.tableOptions());
    return this._c.table;
  }

  tableClient(name) {
    const S = SDK().tables;
    return new S.TableClient(this.conn.endpoints.table, name, this.credential('tables'), this.tableOptions());
  }

  dispose() { this._c = {}; }
}

/** A TokenCredential backed by a function that returns a VS Code Microsoft session access token. */
function tokenCredentialFrom(getAccessToken) {
  return {
    async getToken() {
      const t = await getAccessToken();
      if (!t) return null;
      return { token: t.token, expiresOnTimestamp: t.expiresOn || Date.now() + 45 * 60 * 1000 };
    },
  };
}

module.exports = { Account, ReadOnlyError, tokenCredentialFrom, SDK, UA, AZURITE_API_VERSION };
