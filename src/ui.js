'use strict';
// Plain-language errors and the one confirmation dialog every delete and overwrite goes through.
const MAX_LISTED = 15;

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${u[i]}`;
}

function fmtCount(n) { return Number(n).toLocaleString('en-US'); }

/** "container/a", "container/b", ... "and 12 more" for a confirmation detail. */
function keyList(container, names, max = MAX_LISTED) {
  const shown = names.slice(0, max).map((k) => `${container}/${k}`);
  if (names.length > max) shown.push(`... and ${fmtCount(names.length - max)} more`);
  return shown.join('\n');
}

/** { message, actions: [label] } for an Azure Storage error, with what to do next. */
function describeError(e, conn) {
  const where = conn ? `"${conn.name}"` : 'the storage account';
  const code = (e && (e.code || (e.details && e.details.errorCode))) || '';
  const status = e && e.statusCode;
  let msg = (e && e.message) || '';
  msg = msg.split('\n')[0].replace(/\s*RequestId:.*$/i, '').trim();
  if (!msg || msg === 'RestError' || msg === 'Error') {
    // The service answered without a message (Azurite does this for some refusals).
    const ep = conn && conn.endpoints ? (conn.endpoints.blob || conn.endpoints.queue || conn.endpoints.table || '') : '';
    let host = '';
    try { host = new URL(ep).hostname; } catch (err) { /* no endpoint */ }
    const named = host && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== 'localhost' && !host.startsWith('[');
    if (status === 400 && conn && (conn.kind === 'azurite' || conn.account === 'devstoreaccount1') && named) {
      return { message: `Azurite at "${host}" answered 400: it reads the account name from a host name like this one. Start Azurite with --disableProductStyleUrl, or connect with its IP address.`, actions: ['Edit Connection'] };
    }
    msg = status ? `${where} answered ${status}${code ? ` (${code})` : ''} without a message.` : `${where} failed${code ? ` (${code})` : ''} without a message.`;
  }
  if (status === 403 && conn && conn.kind === 'sas' && conn.sasExpires && Date.parse(conn.sasExpires) < Date.now()) {
    return { message: `The SAS token of ${where} expired on ${conn.sasExpires.slice(0, 16).replace('T', ' ')} UTC. Paste a new SAS URL.`, actions: ['Edit Connection'] };
  }
  switch (code) {
    case 'AuthenticationFailed': {
      if (conn && conn.kind === 'sas' && conn.sasExpires && Date.parse(conn.sasExpires) < Date.now()) return { message: `The SAS token of ${where} expired on ${conn.sasExpires.slice(0, 16).replace('T', ' ')} UTC. Paste a new SAS URL.`, actions: ['Edit Connection'] };
      if (/Signature did not match|signature/i.test(msg)) return { message: `${where} refused the key: the signature does not match. Check the account name and key (or paste the connection string again).`, actions: ['Edit Connection'] };
      if (/expired|Signed expiry time/i.test(msg)) return { message: `The SAS token of ${where} has expired. Paste a new SAS URL.`, actions: ['Edit Connection'] };
      return { message: `${where} refused the sign-in (AuthenticationFailed). Check the key or SAS token.`, actions: ['Edit Connection'] };
    }
    case 'AuthorizationFailure':
      if (conn && (conn.kind === 'key' || conn.kind === 'connstr')) return { message: `${where} refused the request (AuthorizationFailure). With an account key this usually means the key is wrong, or the account's firewall does not allow your IP address.`, actions: ['Edit Connection'] };
      return { message: `${where} does not allow this action (AuthorizationFailure). A SAS token may lack the permission (for example list, read or write), the account's firewall may block your IP address, or your Entra ID role may lack "Storage Blob Data Contributor".`, actions: [] };
    case 'AuthorizationPermissionMismatch': case 'AuthorizationResourceTypeMismatch': case 'AuthorizationServiceMismatch':
      return { message: `${where} does not allow this action (${code}). A SAS token may lack the permission (for example list, read or write), or your Entra ID role may lack "Storage Blob Data Contributor".`, actions: [] };
    case 'AuthorizationSourceIPMismatch': return { message: `${where} refuses requests from your IP address (firewall or SAS IP range).`, actions: [] };
    case 'ContainerNotFound': return { message: 'The container does not exist (it may have been deleted).', actions: ['Refresh'] };
    case 'BlobNotFound': return { message: 'The blob does not exist (it may have been deleted or renamed).', actions: ['Refresh'] };
    case 'QueueNotFound': return { message: 'The queue does not exist.', actions: ['Refresh'] };
    case 'TableNotFound': return { message: 'The table does not exist.', actions: ['Refresh'] };
    case 'ResourceNotFound': return { message: 'Not found. It may have been deleted.', actions: ['Refresh'] };
    case 'ContainerAlreadyExists': case 'QueueAlreadyExists': case 'TableAlreadyExists': return { message: 'A resource with this name already exists.', actions: [] };
    case 'ConditionNotMet': case 'UpdateConditionNotSatisfied': return { message: 'It changed on the server since you opened it, so nothing was overwritten. Refresh and try again.', actions: ['Refresh'] };
    case 'BlobAlreadyExists': return { message: 'A blob with this name already exists.', actions: [] };
    case 'InvalidHeaderValue': case 'InvalidQueryParameterValue': case 'UnsupportedHeader':
      if (/api.?version|x-ms-version/i.test(msg)) return { message: `${where} does not support this API version. If it is Azurite, update it (npm i -g azurite) or start it with --skipApiVersionCheck.`, actions: [] };
      return { message: msg, actions: [] };
    case 'InvalidResourceName': return { message: 'The name is not valid here. Containers and queues: 3 to 63 lowercase letters, digits and dashes. Tables: 3 to 63 letters and digits, starting with a letter.', actions: [] };
    case 'BlobArchived': return { message: 'This blob is in the Archive tier. Change its tier to Hot or Cool (rehydration takes hours) before you read it.', actions: [] };
    case 'ServerBusy': case 'OperationTimedOut': return { message: `${where} is busy (${code}). Try again in a moment.`, actions: [] };
    case 'AbortError': case 'Aborted': return { message: 'Cancelled.', actions: [] };
    case 'ReadOnly': return { message: msg, actions: ['Edit Connection'] };
    case 'ECONNREFUSED': {
      const az = conn && conn.kind === 'azurite';
      return { message: az ? `Azurite does not answer at ${conn.host || '127.0.0.1'}. Start it (npx azurite, or the Docker image mcr.microsoft.com/azure-storage/azurite) and refresh.` : `${where} refused the connection: ${msg}`, actions: az ? ['Start Azurite in a Terminal', 'Refresh'] : ['Edit Connection'] };
    }
    case 'ENOTFOUND': case 'EAI_AGAIN': return { message: `The host of ${where} was not found (${code}). Check the account name or endpoint, the network or the VPN.`, actions: ['Edit Connection'] };
    case 'ETIMEDOUT': case 'ECONNRESET': case 'Timeout': return { message: `${where} did not answer in time (${code}). Check the network, VPN or proxy.`, actions: ['Refresh'] };
    default:
      if (e && e.name === 'AbortError') return { message: 'Cancelled.', actions: [] };
      if (status === 403) return { message: `${where} answered 403 Forbidden: ${msg}`, actions: ['Edit Connection'] };
      return { message: msg.length > 400 ? msg.slice(0, 400) + '...' : msg, actions: [] };
  }
}

/**
 * The confirmation used for every delete and overwrite: a modal that names the bucket and lists the keys.
 * Returns true only when the user chose the button. A test hook can replace `impl` to record and answer.
 */
const confirm = {
  impl: null,
  log: [],
  async ask(vscode, message, detail, button) {
    this.log.push({ message, detail, button, at: Date.now() });
    if (this.log.length > 200) this.log.shift();
    if (this.impl) return !!(await this.impl({ message, detail, button }));
    const r = await vscode.window.showWarningMessage(message, { modal: true, detail }, button);
    return r === button;
  },
};

module.exports = { fmtBytes, fmtCount, keyList, describeError, confirm, MAX_LISTED };
