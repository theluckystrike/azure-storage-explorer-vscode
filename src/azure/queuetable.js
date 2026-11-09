'use strict';
// Queue and Table operations. Queues: list, peek (up to 32, nothing changes), send, dequeue one (after a
// confirmation, done by the caller), clear. Tables: list, query with an OData filter (paged), create, merge or replace
// with the entity's ETag, delete.

// ---------- queues ----------
async function listQueues(acct, { marker, pageSize = 1000, signal } = {}) {
  const svc = acct.queueService();
  if (!svc) return { items: acct.conn.queue ? [{ name: acct.conn.queue, sasOnly: true }] : [], next: undefined };
  const r = await svc.listQueues({ abortSignal: signal }).byPage({ continuationToken: marker || undefined, maxPageSize: pageSize }).next();
  const page = r.value || {};
  return { items: (page.queueItems || []).map((q) => ({ name: q.name })), next: page.continuationToken || undefined };
}

/** Base64 text that decodes to readable UTF-8: Azure Functions and Storage Explorer send messages like this. */
function decodeMaybeBase64(text) {
  const t = String(text || '');
  if (t.length < 4 || t.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  const buf = Buffer.from(t, 'base64');
  if (buf.toString('base64') !== t) return null;
  const s = buf.toString('utf8');
  if (s.includes('�')) return null;
  if (/[\x00-\x08\x0E-\x1F]/.test(s)) return null;
  return s;
}

function msgItem(m) {
  const text = m.messageText || '';
  return {
    id: m.messageId,
    text,
    decoded: decodeMaybeBase64(text),
    insertedOn: m.insertedOn ? new Date(m.insertedOn).toISOString() : '',
    expiresOn: m.expiresOn ? new Date(m.expiresOn).toISOString() : '',
    dequeueCount: m.dequeueCount || 0,
  };
}

async function queueInfo(acct, name) {
  const p = await acct.queueClient(name).getProperties();
  return { approximateMessagesCount: p.approximateMessagesCount || 0, metadata: p.metadata || {} };
}

async function peek(acct, name, count = 32) {
  const r = await acct.queueClient(name).peekMessages({ numberOfMessages: Math.max(1, Math.min(32, count)) });
  return (r.peekedMessageItems || []).map(msgItem);
}

/** encoding: "text" sends as typed; "base64" sends Base64 of the UTF-8 text (what Azure Functions expects). */
async function send(acct, name, text, { encoding = 'text', ttlSeconds, visibilitySeconds } = {}) {
  acct.assertWritable();
  const body = encoding === 'base64' ? Buffer.from(String(text), 'utf8').toString('base64') : String(text);
  if (Buffer.byteLength(body) > 64 * 1024) { const e = new Error(`The message is ${Math.ceil(Buffer.byteLength(body) / 1024)} KB; a queue message holds at most 64 KB.`); e.code = 'MessageTooLarge'; throw e; }
  const r = await acct.queueClient(name).sendMessage(body, { messageTimeToLive: ttlSeconds || undefined, visibilityTimeout: visibilitySeconds || undefined });
  return { id: r.messageId };
}

/** Receive the next message (hidden for 30 s), delete it, return it. The caller asks first. */
async function dequeue(acct, name) {
  acct.assertWritable();
  const qc = acct.queueClient(name);
  const r = await qc.receiveMessages({ numberOfMessages: 1, visibilityTimeout: 30 });
  const m = (r.receivedMessageItems || [])[0];
  if (!m) return null;
  await qc.deleteMessage(m.messageId, m.popReceipt);
  return msgItem(m);
}

async function clear(acct, name) {
  acct.assertWritable();
  await acct.queueClient(name).clearMessages();
}

async function createQueue(acct, name) { acct.assertWritable(); await acct.queueClient(name).create(); }
async function deleteQueue(acct, name) { acct.assertWritable(); await acct.queueClient(name).delete(); }

// ---------- tables ----------
async function listTables(acct, { marker, pageSize = 1000 } = {}) {
  const svc = acct.tableService();
  if (!svc) return { items: acct.conn.table ? [{ name: acct.conn.table, sasOnly: true }] : [], next: undefined };
  const r = await svc.listTables().byPage({ continuationToken: marker || undefined, maxPageSize: pageSize }).next();
  const page = r.value || [];
  return { items: page.map((t) => ({ name: t.name })), next: page.continuationToken || undefined };
}

const SYSTEM = new Set(['partitionKey', 'rowKey', 'timestamp', 'etag', 'odata.etag', 'odata.metadata']);

/** A raw SDK value (with disableTypeConversion) -> { type, value: string }. */
function typed(v) {
  if (v && typeof v === 'object' && 'type' in v && 'value' in v) return { type: v.type, value: String(v.value) };
  if (typeof v === 'boolean') return { type: 'Boolean', value: String(v) };
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'Int32' : 'Double', value: String(v) };
  if (v === null || v === undefined) return { type: 'String', value: '' };
  return { type: 'String', value: String(v) };
}

/** An entity for the grid: { partitionKey, rowKey, timestamp, etag, props: { name: {type, value} } }. */
function rowOf(e) {
  const props = {};
  for (const [k, v] of Object.entries(e)) {
    if (SYSTEM.has(k) || k.endsWith('@odata.type')) continue;
    props[k] = typed(v);
  }
  const ts = e.timestamp && typeof e.timestamp === 'object' ? e.timestamp.value : e.timestamp;
  return { partitionKey: String(typed(e.partitionKey).value), rowKey: String(typed(e.rowKey).value), timestamp: ts ? String(ts) : '', etag: e.etag || e['odata.etag'] || '', props };
}

const TYPES = ['String', 'Int32', 'Int64', 'Double', 'Boolean', 'DateTime', 'Guid', 'Binary'];

/** A grid value back to what the SDK sends, checked: throws a plain message for a value that does not fit the type. */
function toSdkValue(name, type, value) {
  const s = String(value);
  switch (type) {
    case 'String': return s;
    case 'Boolean': if (!/^(true|false)$/i.test(s.trim())) throw new Error(`${name}: a Boolean is true or false.`); return /^true$/i.test(s.trim());
    case 'Int32': { const n = Number(s); if (!/^-?\d+$/.test(s.trim()) || n > 2147483647 || n < -2147483648) throw new Error(`${name}: an Int32 is a whole number from -2147483648 to 2147483647.`); return n; }
    case 'Int64': if (!/^-?\d+$/.test(s.trim())) throw new Error(`${name}: an Int64 is a whole number.`); { const b = BigInt(s.trim()); if (b > 9223372036854775807n || b < -9223372036854775808n) throw new Error(`${name}: the number is too large for Int64.`); } return { value: s.trim(), type: 'Int64' };
    case 'Double': if (!/^(-?\d+(\.\d+)?([eE][-+]?\d+)?|NaN|-?Infinity|INF|-INF)$/.test(s.trim())) throw new Error(`${name}: a Double is a number like 3.14.`); { const n = Number(s.trim().replace(/^(-?)INF$/, '$1Infinity')); return { value: Number.isFinite(n) ? n : (Number.isNaN(n) ? 'NaN' : (n > 0 ? 'Infinity' : '-Infinity')), type: 'Double' }; }
    case 'DateTime': { const t = Date.parse(s.trim()); if (!Number.isFinite(t)) throw new Error(`${name}: a DateTime looks like 2026-11-09T12:00:00Z.`); return { value: new Date(t).toISOString(), type: 'DateTime' }; }
    case 'Guid': if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim())) throw new Error(`${name}: a Guid looks like 3f2504e0-4f89-11d3-9a0c-0305e82c3301.`); return { value: s.trim(), type: 'Guid' };
    case 'Binary': if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s.trim())) throw new Error(`${name}: Binary is Base64 text.`); return { value: s.trim(), type: 'Binary' };
    default: throw new Error(`${name}: unknown type ${type}.`);
  }
}

function checkName(n) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(n)) throw new Error(`"${n}" is not a valid property name (letters, digits and _, starting with a letter or _).`);
  if (/^(PartitionKey|RowKey|Timestamp)$/i.test(n)) throw new Error(`"${n}" is a system property.`);
}

function checkKey(what, k) {
  if (typeof k !== 'string') throw new Error(`${what} is required.`);
  if (/[\\/#?\x00-\x1f\x7f-\x9f]/.test(k)) throw new Error(`${what} cannot contain / \\ # ? or control characters.`);
  if (Buffer.byteLength(k) > 1024) throw new Error(`${what} is longer than 1 KB.`);
}

/** One page of entities. filter: an OData filter like "PartitionKey eq 'p1' and Age gt 30" (empty = all). */
async function query(acct, table, { filter, top = 500, marker, select } = {}) {
  const tc = acct.tableClient(table);
  const it = tc.listEntities({ queryOptions: { filter: filter || undefined, select: select && select.length ? select : undefined }, disableTypeConversion: true }).byPage({ maxPageSize: top, continuationToken: marker || undefined });
  const r = await it.next();
  const page = r.value || [];
  return { rows: page.map(rowOf), next: page.continuationToken || undefined };
}

function entityFrom(pk, rk, props) {
  checkKey('PartitionKey', pk);
  checkKey('RowKey', rk);
  const e = { partitionKey: pk, rowKey: rk };
  for (const [k, { type, value }] of Object.entries(props || {})) { checkName(k); e[k] = toSdkValue(k, type, value); }
  return e;
}

/** Save an edited row. mode "Replace" drops properties that are not in props; "Merge" keeps them. */
async function updateEntity(acct, table, row, mode = 'Replace') {
  acct.assertWritable();
  const e = entityFrom(row.partitionKey, row.rowKey, row.props);
  const r = await acct.tableClient(table).updateEntity(e, mode, { etag: row.etag || '*' });
  return { etag: r.etag };
}

async function createEntity(acct, table, row) {
  acct.assertWritable();
  const e = entityFrom(row.partitionKey, row.rowKey, row.props);
  const r = await acct.tableClient(table).createEntity(e);
  return { etag: r.etag };
}

async function deleteEntity(acct, table, pk, rk, etag) {
  acct.assertWritable();
  await acct.tableClient(table).deleteEntity(pk, rk, { etag: etag || '*' });
}

async function createTable(acct, name) { acct.assertWritable(); await acct.tableClient(name).createTable(); }
async function deleteTable(acct, name) { acct.assertWritable(); await acct.tableClient(name).deleteTable(); }

module.exports = {
  listQueues, queueInfo, peek, send, dequeue, clear, createQueue, deleteQueue, decodeMaybeBase64,
  listTables, query, updateEntity, createEntity, deleteEntity, createTable, deleteTable, rowOf, typed, toSdkValue, entityFrom, TYPES,
};
