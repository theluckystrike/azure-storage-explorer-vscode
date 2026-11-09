'use strict';
// Pure parsing of the ways a user can connect: a connection string, an account name plus key, a SAS URL (account or
// container), the Azurite development account, or an Entra ID sign-in. No network, no VS Code: tests call it directly.

// The Azurite and Azure Storage Emulator development account. Microsoft publishes this key in the docs; it is not a
// secret and only works against a local emulator.
const AZURITE_ACCOUNT = 'devstoreaccount1';
const AZURITE_KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const AZURITE_PORTS = { blob: 10000, queue: 10001, table: 10002 };

class ConnError extends Error {
  constructor(message, code) { super(message); this.code = code || 'BadConnection'; }
}

/** "a=b;c=d==" -> { a: 'b', c: 'd==' }. Keys are matched case-insensitively and returned in canonical case. */
function parseConnectionString(s) {
  if (typeof s !== 'string' || !s.trim()) throw new ConnError('The connection string is empty.');
  const canon = {
    defaultendpointsprotocol: 'DefaultEndpointsProtocol', accountname: 'AccountName', accountkey: 'AccountKey',
    endpointsuffix: 'EndpointSuffix', blobendpoint: 'BlobEndpoint', queueendpoint: 'QueueEndpoint', tableendpoint: 'TableEndpoint',
    fileendpoint: 'FileEndpoint', sharedaccesssignature: 'SharedAccessSignature', usedevelopmentstorage: 'UseDevelopmentStorage',
    developmentstorageproxyuri: 'DevelopmentStorageProxyUri',
  };
  const out = {};
  for (const raw of s.trim().replace(/^"|"$/g, '').split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const i = part.indexOf('=');
    if (i <= 0) throw new ConnError(`This part of the connection string has no "=": "${part.slice(0, 40)}".`);
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[canon[k.toLowerCase()] || k] = v;
  }
  return out;
}

function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }

/** Endpoints for Azurite on a host (127.0.0.1 by default; "azurite" in a Dev Container, for example). */
function azuriteEndpoints(host = '127.0.0.1', ports = AZURITE_PORTS, protocol = 'http') {
  const h = String(host || '127.0.0.1').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return {
    blob: `${protocol}://${h}:${ports.blob}/${AZURITE_ACCOUNT}`,
    queue: `${protocol}://${h}:${ports.queue}/${AZURITE_ACCOUNT}`,
    table: `${protocol}://${h}:${ports.table}/${AZURITE_ACCOUNT}`,
  };
}

function standardEndpoints(account, protocol = 'https', suffix = 'core.windows.net') {
  return {
    blob: `${protocol}://${account}.blob.${suffix}`,
    queue: `${protocol}://${account}.queue.${suffix}`,
    table: `${protocol}://${account}.table.${suffix}`,
  };
}

/** Account name from an endpoint URL: "https://acct.blob.core.windows.net" or path style "http://h:10000/acct". */
function accountFromEndpoint(u) {
  let url;
  try { url = new URL(u); } catch (e) { return ''; }
  const first = url.pathname.split('/').filter(Boolean)[0];
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === 'localhost' || /^\[/.test(url.hostname) || (url.port && /^1[01]\d{3}$/.test(url.port));
  if (isIp && first) return decodeURIComponent(first);
  return url.hostname.split('.')[0];
}

/**
 * A connection string -> { kind, account, endpoints: {blob, queue, table}, secret: {accountKey|sas}, services }.
 * services lists what the string can reach (a SAS string may cover only blob).
 */
function fromConnectionString(s) {
  const p = parseConnectionString(s);
  if (/^true$/i.test(p.UseDevelopmentStorage || '')) {
    let host = '127.0.0.1';
    if (p.DevelopmentStorageProxyUri) { try { host = new URL(p.DevelopmentStorageProxyUri).hostname; } catch (e) { /* keep */ } }
    return { kind: 'azurite', account: AZURITE_ACCOUNT, endpoints: azuriteEndpoints(host), secret: { accountKey: AZURITE_KEY }, services: ['blob', 'queue', 'table'] };
  }
  const protocol = (p.DefaultEndpointsProtocol || 'https').toLowerCase();
  if (protocol !== 'https' && protocol !== 'http') throw new ConnError(`DefaultEndpointsProtocol must be https or http, not "${p.DefaultEndpointsProtocol}".`);
  const sas = p.SharedAccessSignature ? p.SharedAccessSignature.replace(/^\?/, '') : '';
  let account = p.AccountName || '';
  const explicit = { blob: p.BlobEndpoint, queue: p.QueueEndpoint, table: p.TableEndpoint };
  if (!account) for (const k of ['blob', 'queue', 'table']) if (explicit[k]) { account = accountFromEndpoint(explicit[k]); if (account) break; }
  if (!account) throw new ConnError('The connection string has no AccountName and no BlobEndpoint.');
  if (!p.AccountKey && !sas) throw new ConnError('The connection string has neither an AccountKey nor a SharedAccessSignature.');
  if (p.AccountKey && !/^[A-Za-z0-9+/=\s]+$/.test(p.AccountKey)) throw new ConnError('The AccountKey is not base64. Copy it again from the portal (Access keys).');
  const std = standardEndpoints(account, protocol, p.EndpointSuffix || 'core.windows.net');
  const endpoints = {};
  const services = [];
  for (const k of ['blob', 'queue', 'table']) {
    if (explicit[k]) { endpoints[k] = trimSlash(explicit[k]); services.push(k); }
    else if (!explicit.blob && !explicit.queue && !explicit.table) { endpoints[k] = std[k]; services.push(k); }
  }
  if (sas) {
    const q = new URLSearchParams(sas);
    const ss = q.get('ss');
    if (ss) for (const [k, letter] of [['blob', 'b'], ['queue', 'q'], ['table', 't']]) if (!ss.includes(letter)) { const i = services.indexOf(k); if (i >= 0) services.splice(i, 1); }
    return { kind: 'sas', account, endpoints, secret: { sas }, services, sasInfo: sasInfo(sas) };
  }
  return { kind: 'key', account, endpoints, secret: { accountKey: p.AccountKey.replace(/\s+/g, '') }, services };
}

/** What a SAS token allows and until when. */
function sasInfo(sas) {
  const q = new URLSearchParams(String(sas || '').replace(/^\?/, ''));
  const se = q.get('se');
  const expires = se ? Date.parse(se) : NaN;
  return {
    version: q.get('sv') || '',
    services: q.get('ss') || '',
    resourceTypes: q.get('srt') || '',
    resource: q.get('sr') || '',
    permissions: q.get('sp') || '',
    expires: Number.isFinite(expires) ? new Date(expires).toISOString() : '',
    expired: Number.isFinite(expires) ? expires < Date.now() : false,
    hasSig: q.has('sig'),
  };
}

/**
 * A SAS URL (account or container) -> the same shape as fromConnectionString.
 * "https://acct.blob.core.windows.net/?sv=..&ss=bq&srt=sco&sig=.." or "https://acct.blob.core.windows.net/box?sv=..&sr=c&sig=..".
 */
function fromSasUrl(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch (e) { throw new ConnError('This is not a URL. A SAS URL starts with https:// and has ?sv=...&sig=... at the end.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConnError('A SAS URL starts with https://.');
  const sas = url.search.replace(/^\?/, '');
  const info = sasInfo(sas);
  if (!info.hasSig) throw new ConnError('The URL has no SAS token (no "sig=" part). Copy the full "Blob SAS URL" or "SAS token" from the portal.');
  const host = url.hostname;
  const segs = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const pathStyle = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost' || /^1[01]\d{3}$/.test(url.port);
  const account = pathStyle ? (segs.shift() || '') : host.split('.')[0];
  if (!account) throw new ConnError('The URL has no account name.');
  const base = `${url.protocol}//${url.host}${pathStyle ? '/' + account : ''}`;
  const m = /^([a-z0-9-]+)\.(blob|queue|table|dfs|file)\.(.+)$/i.exec(host);
  let service = m ? m[2].toLowerCase() : 'blob';
  if (service === 'dfs') service = 'blob';
  if (pathStyle && url.port) service = { 10000: 'blob', 10001: 'queue', 10002: 'table' }[url.port] || 'blob';
  if (service === 'file') throw new ConnError('File shares are not supported in this version. Use a Blob, Queue or Table SAS URL.');
  if (info.resource === 'b' || info.resource === 'bs' || info.resource === 'bv' || (segs.length > 1 && service === 'blob')) {
    throw new ConnError('This SAS URL points to one blob. Use a container SAS URL or an account SAS URL; to download one blob, paste the URL into a browser.');
  }
  const endpoints = {};
  const services = [];
  const EMU_PORTS = { blob: 10000, queue: 10001, table: 10002 };
  if (pathStyle && info.services && /^1000[0-2]$/.test(url.port)) {
    // Azurite: an account SAS covers the services in "ss", each on its own port.
    for (const [k, letter] of [['blob', 'b'], ['queue', 'q'], ['table', 't']]) {
      if (info.services.includes(letter)) { endpoints[k] = `${url.protocol}//${url.hostname}:${EMU_PORTS[k]}/${account}`; services.push(k); }
    }
  } else if (m && info.services) {
    // An account SAS lists its services in "ss"; build the endpoints of the others from the host name.
    for (const [k, letter] of [['blob', 'b'], ['queue', 'q'], ['table', 't']]) {
      if (info.services.includes(letter)) { endpoints[k] = `${url.protocol}//${m[1]}.${k}.${m[3]}`; services.push(k); }
    }
  } else {
    endpoints[service] = base;
    services.push(service);
  }
  if (!services.length) { endpoints[service] = base; services.push(service); }
  const out = { kind: 'sas', account, endpoints, secret: { sas }, services, sasInfo: info };
  if (service === 'blob' && segs.length === 1) out.container = segs[0];
  if (service === 'queue' && segs.length === 1) out.queue = segs[0];
  if (service === 'table' && segs.length === 1) out.table = segs[0].replace(/\(\)$/, '');
  return out;
}

/** Account name and key typed by hand. */
function fromAccountKey(account, key, opts = {}) {
  const a = String(account || '').trim();
  if (!/^[a-z0-9]{3,24}$/.test(a) && a !== AZURITE_ACCOUNT) throw new ConnError('A storage account name has 3 to 24 lowercase letters and digits.');
  const k = String(key || '').replace(/\s+/g, '');
  if (!k || !/^[A-Za-z0-9+/]+=*$/.test(k)) throw new ConnError('The account key is not base64. Copy key1 or key2 from the portal (Security + networking, Access keys).');
  return { kind: 'key', account: a, endpoints: standardEndpoints(a, 'https', opts.suffix || 'core.windows.net'), secret: { accountKey: k }, services: ['blob', 'queue', 'table'] };
}

/** Entra ID (Microsoft sign-in in VS Code): no secret is stored, VS Code keeps the session. */
function forEntra(account, opts = {}) {
  const a = String(account || '').trim();
  if (!/^[a-z0-9]{3,24}$/.test(a)) throw new ConnError('A storage account name has 3 to 24 lowercase letters and digits.');
  return { kind: 'entra', account: a, endpoints: standardEndpoints(a, 'https', opts.suffix || 'core.windows.net'), secret: {}, services: ['blob', 'queue', 'table'], tenant: opts.tenant || '' };
}

function forAzurite(host = '127.0.0.1') {
  return { kind: 'azurite', account: AZURITE_ACCOUNT, endpoints: azuriteEndpoints(host), secret: { accountKey: AZURITE_KEY }, services: ['blob', 'queue', 'table'], host };
}

/** A connection string with the key or signature hidden, for display. */
function redact(s) {
  return String(s || '').replace(/(AccountKey=)[^;]+/ig, '$1•••').replace(/(SharedAccessSignature=)[^;]+/ig, '$1•••').replace(/([?&]sig=)[^&]+/ig, '$1•••');
}

module.exports = {
  AZURITE_ACCOUNT, AZURITE_KEY, AZURITE_PORTS, ConnError,
  parseConnectionString, fromConnectionString, fromSasUrl, fromAccountKey, forEntra, forAzurite, sasInfo,
  azuriteEndpoints, standardEndpoints, accountFromEndpoint, redact,
};
