'use strict';
// Blob operations on top of the SDK: paged listing, streamed upload and download, properties, tier, SAS, rename by
// copy plus delete, and soft-delete aware delete. Nothing here reads a whole blob into memory.
const fs = require('fs');
const path = require('path');
const { SDK } = require('./service');

const MB = 1024 * 1024;
const TIERS = ['Hot', 'Cool', 'Cold', 'Archive'];

function abortErr() { const e = new Error('Cancelled'); e.code = 'Aborted'; e.name = 'AbortError'; e.aborted = true; return e; }
function isAbort(e, signal) { return !!(signal && signal.aborted) || (e && (e.name === 'AbortError' || e.code === 'Aborted')); }

/** One page of containers: { items: [{ name, lastModified, publicAccess, deleted }], next }. */
async function listContainers(acct, { marker, pageSize = 1000, signal } = {}) {
  const svc = acct.blobService();
  if (!svc) return { items: acct.conn.container ? [{ name: acct.conn.container, sasOnly: true }] : [], next: undefined };
  const it = svc.listContainers({ abortSignal: signal }).byPage({ continuationToken: marker || undefined, maxPageSize: pageSize });
  const r = await it.next();
  const page = r.value || {};
  const items = ((page.containerItems) || []).map((c) => ({
    name: c.name,
    lastModified: c.properties && c.properties.lastModified ? new Date(c.properties.lastModified).toISOString() : '',
    publicAccess: (c.properties && c.properties.publicAccess) || '',
    hasLegalHold: !!(c.properties && c.properties.hasLegalHold),
  }));
  return { items, next: page.continuationToken || undefined };
}

function blobItem(b) {
  const p = b.properties || {};
  return {
    name: b.name,
    size: Number(p.contentLength || 0),
    tier: p.accessTier || '',
    tierInferred: !!p.accessTierInferred,
    archiveStatus: p.archiveStatus || '',
    lastModified: p.lastModified ? new Date(p.lastModified).toISOString() : '',
    contentType: p.contentType || '',
    etag: p.etag || '',
    md5: p.contentMD5 ? Buffer.from(p.contentMD5).toString('base64') : '',
    blobType: p.blobType || '',
    deleted: !!b.deleted,
    isFolder: !!(b.metadata && String(b.metadata.hdi_isfolder).toLowerCase() === 'true'),
  };
}

/**
 * One page of one "folder" level: { folders: [prefix/], blobs: [...], next }. ADLS Gen2 directories (blobs with
 * hdi_isfolder=true metadata) count as folders, so empty directories show too.
 */
async function listLevel(acct, container, prefix, { marker, pageSize = 1000, signal } = {}) {
  const cc = acct.container(container);
  const it = cc.listBlobsByHierarchy('/', { prefix: prefix || undefined, includeMetadata: true, abortSignal: signal }).byPage({ continuationToken: marker || undefined, maxPageSize: pageSize });
  const r = await it.next();
  const page = r.value || {};
  const seg = page.segment || {};
  const folders = new Set((seg.blobPrefixes || []).map((p) => p.name));
  const blobs = [];
  for (const b of seg.blobItems || []) {
    const item = blobItem(b);
    if (item.isFolder) { folders.add(item.name.endsWith('/') ? item.name : item.name + '/'); continue; }
    if (item.name.endsWith('/') && item.size === 0) continue; // a "folder marker" blob made by some tools
    blobs.push(item);
  }
  return { folders: [...folders].sort(), blobs, next: page.continuationToken || undefined };
}

/** Every blob under a prefix (flat), page by page: onPage(items). Returns the count. */
async function listAll(acct, container, prefix, onPage, signal) {
  const cc = acct.container(container);
  let n = 0;
  for await (const page of cc.listBlobsFlat({ prefix: prefix || undefined, includeMetadata: true, abortSignal: signal }).byPage({ maxPageSize: 5000 })) {
    if (signal && signal.aborted) throw abortErr();
    const items = (page.segment.blobItems || []).map(blobItem).filter((b) => !b.isFolder);
    n += items.length;
    await onPage(items);
  }
  return n;
}

async function properties(acct, container, name, signal) {
  const p = await acct.container(container).getBlobClient(name).getProperties({ abortSignal: signal });
  return {
    name,
    size: Number(p.contentLength || 0),
    contentType: p.contentType || '',
    contentEncoding: p.contentEncoding || '',
    contentLanguage: p.contentLanguage || '',
    contentDisposition: p.contentDisposition || '',
    cacheControl: p.cacheControl || '',
    md5: p.contentMD5 ? Buffer.from(p.contentMD5).toString('base64') : '',
    etag: p.etag || '',
    lastModified: p.lastModified ? new Date(p.lastModified).toISOString() : '',
    createdOn: p.createdOn ? new Date(p.createdOn).toISOString() : '',
    tier: p.accessTier || '',
    tierInferred: !!p.accessTierInferred,
    archiveStatus: p.archiveStatus || '',
    blobType: p.blobType || '',
    leaseState: p.leaseState || '',
    serverEncrypted: !!p.isServerEncrypted,
    metadata: p.metadata || {},
    versionId: p.versionId || '',
  };
}

/**
 * Streamed upload. Files up to singleShotMB go in one request; bigger files in blocks (blockSizeMB, at most 50,000
 * blocks), concurrency blocks at a time. Memory: about blockSize x concurrency. onProgress(sentBytes, total).
 */
async function uploadFile(acct, container, name, file, opts = {}) {
  acct.assertWritable();
  const st = await fs.promises.stat(file);
  const bc = acct.container(container).getBlockBlobClient(name);
  let blockSize = Math.max(1, opts.blockSizeMB || 8) * MB;
  while (st.size / blockSize > 50000) blockSize *= 2;
  const conditions = opts.overwrite === false ? { ifNoneMatch: '*' } : (opts.ifMatch ? { ifMatch: opts.ifMatch } : undefined);
  const headers = { blobContentType: opts.contentType || undefined };
  try {
    await bc.uploadFile(file, {
      blockSize,
      maxSingleShotSize: Math.min(st.size + 1, (opts.singleShotMB || 32) * MB),
      concurrency: Math.max(1, Math.min(16, opts.concurrency || 4)),
      abortSignal: opts.signal,
      blobHTTPHeaders: headers,
      conditions,
      onProgress: (ev) => opts.onProgress && opts.onProgress(ev.loadedBytes, st.size),
    });
  } catch (e) {
    if (isAbort(e, opts.signal)) throw abortErr();
    throw e;
  }
  return { size: st.size };
}

/** Upload a small text or buffer (Save of an opened blob). */
async function uploadData(acct, container, name, data, opts = {}) {
  acct.assertWritable();
  const bc = acct.container(container).getBlockBlobClient(name);
  const r = await bc.uploadData(data, { blobHTTPHeaders: { blobContentType: opts.contentType || undefined }, conditions: opts.ifMatch ? { ifMatch: opts.ifMatch } : undefined, abortSignal: opts.signal });
  return { etag: r.etag };
}

/**
 * Streamed download to dest through a ".part" file that is renamed at the end, so a cancelled download never leaves a
 * half file under the real name. onProgress(gotBytes, total).
 */
async function downloadFile(acct, container, name, dest, opts = {}) {
  const bc = acct.container(container).getBlobClient(name);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let total = 0;
  try {
    const r = await bc.download(opts.offset || 0, opts.count, { abortSignal: opts.signal, maxRetryRequests: 5, onProgress: (ev) => opts.onProgress && opts.onProgress(ev.loadedBytes, total) });
    total = Number(r.contentLength || 0);
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      const body = r.readableStreamBody;
      const fail = (e) => { body.destroy(); out.destroy(); reject(e); };
      body.on('error', fail);
      out.on('error', fail);
      out.on('finish', resolve);
      if (opts.signal) opts.signal.addEventListener('abort', () => fail(abortErr()), { once: true });
      body.pipe(out);
    });
    await fs.promises.rename(part, dest);
    return { size: total, etag: r.etag };
  } catch (e) {
    await fs.promises.rm(part, { force: true }).catch(() => {});
    if (isAbort(e, opts.signal)) throw abortErr();
    throw e;
  }
}

/** The first `count` bytes as a Buffer (for "show the first 1 MB" of large text). */
async function readHead(acct, container, name, count, signal) {
  const bc = acct.container(container).getBlobClient(name);
  const size = Number((await bc.getProperties({ abortSignal: signal })).contentLength || 0);
  const n = Math.min(count, size);
  if (!n) return Buffer.alloc(0);
  return bc.downloadToBuffer(0, n, { abortSignal: signal });
}

/** Set content type, cache control and the other headers. The service replaces all of them, so the rest are kept. */
async function setHeaders(acct, container, name, changes) {
  acct.assertWritable();
  const bc = acct.container(container).getBlobClient(name);
  const p = await bc.getProperties();
  const h = {
    blobContentType: p.contentType, blobContentEncoding: p.contentEncoding, blobContentLanguage: p.contentLanguage,
    blobContentDisposition: p.contentDisposition, blobCacheControl: p.cacheControl, blobContentMD5: p.contentMD5,
  };
  if (changes.contentType !== undefined) h.blobContentType = changes.contentType;
  if (changes.cacheControl !== undefined) h.blobCacheControl = changes.cacheControl;
  if (changes.contentEncoding !== undefined) h.blobContentEncoding = changes.contentEncoding;
  if (changes.contentDisposition !== undefined) h.blobContentDisposition = changes.contentDisposition;
  await bc.setHTTPHeaders(h, { conditions: { ifMatch: p.etag } });
}

async function setTier(acct, container, name, tier, signal) {
  acct.assertWritable();
  if (!TIERS.includes(tier)) throw new Error(`Unknown tier ${tier}.`);
  await acct.container(container).getBlobClient(name).setAccessTier(tier, { abortSignal: signal });
}

/** { enabled, days } of blob soft delete, or null when the connection cannot read the service properties. */
async function softDeleteInfo(acct) {
  const svc = acct.blobService();
  if (!svc) return null;
  try {
    const p = await svc.getProperties();
    const d = p.deleteRetentionPolicy || {};
    return { enabled: !!d.enabled, days: d.days || 0 };
  } catch (e) {
    return null;
  }
}

async function deleteBlob(acct, container, name, signal) {
  acct.assertWritable();
  await acct.container(container).getBlobClient(name).delete({ deleteSnapshots: 'include', abortSignal: signal });
}

/** Copy a blob inside the same account (server-side, no download), then wait for the copy to finish. */
async function copyBlob(acct, srcContainer, srcName, dstContainer, dstName, { signal, overwrite = false } = {}) {
  acct.assertWritable();
  const src = acct.container(srcContainer).getBlobClient(srcName);
  const dst = acct.container(dstContainer).getBlobClient(dstName);
  const srcUrl = acct.secret.sas ? src.url : src.url; // a SAS client's url already carries the token
  const poller = await dst.beginCopyFromURL(srcUrl, { abortSignal: signal, conditions: overwrite ? undefined : { ifNoneMatch: '*' }, intervalInMs: 500 });
  const r = await poller.pollUntilDone();
  if (r.copyStatus && r.copyStatus !== 'success') throw new Error(`The copy ended with status ${r.copyStatus}.`);
  return r;
}

/** Rename = server-side copy, then delete the source once the copy succeeded. */
async function renameBlob(acct, container, from, to, opts = {}) {
  await copyBlob(acct, container, from, container, to, opts);
  await deleteBlob(acct, container, from, opts.signal);
}

async function exists(acct, container, name) {
  return acct.container(container).getBlobClient(name).exists();
}

/**
 * A SAS URL for a blob or a container. Account key: a service SAS. Entra ID: a user delegation SAS (at most 7 days).
 * A connection that is itself a SAS cannot sign a new one.
 */
async function generateSas(acct, { container, name, permissions = 'r', expiresOn, startsOn, httpsOnly = true }) {
  const S = SDK().blob;
  if (acct.secret.sas) { const e = new Error('This connection uses a SAS token, so it cannot sign a new one. Copy the URL instead, or connect with the account key or Entra ID.'); e.code = 'NoSigner'; throw e; }
  const perms = name ? S.BlobSASPermissions.parse(permissions) : S.ContainerSASPermissions.parse(permissions);
  const values = { containerName: container, blobName: name || undefined, permissions: perms, startsOn: startsOn || new Date(Date.now() - 5 * 60 * 1000), expiresOn };
  const ep = acct.conn.endpoints.blob || '';
  if (acct.isEmulator()) values.version = require('./service').AZURITE_API_VERSION;
  if (httpsOnly && ep.startsWith('https:')) values.protocol = S.SASProtocol.Https;
  let q;
  if (acct.conn.kind === 'entra') {
    const svc = acct.blobService();
    const max = Date.now() + 7 * 24 * 3600 * 1000 - 60000;
    if (expiresOn.getTime() > max) values.expiresOn = new Date(max);
    const key = await svc.getUserDelegationKey(values.startsOn, values.expiresOn);
    q = S.generateBlobSASQueryParameters(values, key, acct.conn.account).toString();
  } else {
    q = S.generateBlobSASQueryParameters(values, acct.sharedKey()).toString();
  }
  const base = name ? acct.container(container).getBlobClient(name).url : acct.container(container).url;
  return `${base.split('?')[0]}?${q}`;
}

/** The plain URL of a blob or container, without any SAS token. */
function plainUrl(acct, container, name) {
  const u = name ? acct.container(container).getBlobClient(name).url : acct.container(container).url;
  return u.split('?')[0];
}

async function createContainer(acct, name) {
  acct.assertWritable();
  await acct.container(name).create();
}

async function deleteContainer(acct, name) {
  acct.assertWritable();
  await acct.container(name).delete();
}

module.exports = {
  MB, TIERS, listContainers, listLevel, listAll, properties, uploadFile, uploadData, downloadFile, readHead, setHeaders, setTier,
  softDeleteInfo, deleteBlob, copyBlob, renameBlob, exists, generateSas, plainUrl, createContainer, deleteContainer, blobItem, abortErr, isAbort,
};
