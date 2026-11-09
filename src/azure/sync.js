'use strict';
// Zovo Pro tools. Folder sync: plan*() only reads and returns what would change (new, changed, deleted: the dry-run
// diff); applyPlan() does it. Deletes happen only when the plan was made with deleteExtra and the user confirmed the
// listed names. Usage report: size, count and an estimated monthly cost per folder and tier.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeLocalPath, localToKey } = require('./paths');
const blob = require('./blob');

const MD5_LIMIT = 256 * 1024 * 1024;

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function excluder(patterns) {
  const res = (patterns || []).map(globToRegex);
  return (rel) => res.some((r) => r.test(rel) || r.test(rel.split('/').pop()));
}

/** Every regular file under root (symlinks are not followed): [{ file, rel, size, mtimeMs }]. */
async function walk(root, isExcluded, signal) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    if (signal && signal.aborted) throw blob.abortErr();
    const relDir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      if (isExcluded(rel) || isExcluded(rel + '/')) continue;
      if (e.isDirectory()) stack.push(rel);
      else if (e.isFile()) {
        const file = path.join(root, ...rel.split('/'));
        try { const st = await fs.promises.stat(file); out.push({ file, rel, size: st.size, mtimeMs: st.mtimeMs }); } catch (err) { /* vanished */ }
      }
    }
  }
  return out;
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('base64')));
  });
}

async function sameContent(local, remote, direction) {
  if (local.size !== remote.size) return false;
  if (remote.md5 && local.size <= MD5_LIMIT) return (await md5File(local.file)) === remote.md5;
  const rt = Date.parse(remote.lastModified) || 0;
  // No MD5 on the blob (block uploads): equal size and a not-newer source counts as unchanged.
  return direction === 'up' ? local.mtimeMs <= rt + 2000 : rt <= local.mtimeMs + 2000;
}

function normPrefix(prefix) { return prefix && !prefix.endsWith('/') ? prefix + '/' : (prefix || ''); }

async function listRemote(acct, container, prefix, signal) {
  const map = new Map();
  await blob.listAll(acct, container, prefix, (items) => { for (const b of items) if (!b.name.endsWith('/')) map.set(b.name, b); }, signal);
  return map;
}

/** Plan local folder -> container/prefix. */
async function planUpload({ acct, container, prefix, root, excludes, deleteExtra, signal }) {
  const p = normPrefix(prefix);
  const isExcluded = excluder(excludes);
  const [locals, remote] = await Promise.all([walk(root, isExcluded, signal), listRemote(acct, container, p, signal)]);
  const plan = { direction: 'up', container, prefix: p, root, create: [], change: [], remove: [], same: 0, skipped: [], bytes: 0, deleteExtra: !!deleteExtra };
  const seen = new Set();
  for (const l of locals) {
    const key = localToKey(root, l.file, p);
    if (!key) { plan.skipped.push({ path: l.file, why: 'outside the folder' }); continue; }
    seen.add(key);
    const r = remote.get(key);
    if (!r) { plan.create.push({ key, file: l.file, size: l.size }); plan.bytes += l.size; }
    else if (!(await sameContent(l, r, 'up'))) { plan.change.push({ key, file: l.file, size: l.size, remoteSize: r.size }); plan.bytes += l.size; }
    else plan.same++;
  }
  if (deleteExtra) {
    for (const [key, r] of remote) {
      if (seen.has(key)) continue;
      if (isExcluded(key.slice(p.length))) continue;
      plan.remove.push({ key, size: r.size });
    }
  }
  return plan;
}

/** Plan container/prefix -> local folder. Names that would leave the folder are skipped and listed. */
async function planDownload({ acct, container, prefix, root, excludes, deleteExtra, signal }) {
  const p = normPrefix(prefix);
  const isExcluded = excluder(excludes);
  const [locals, remote] = await Promise.all([walk(root, isExcluded, signal).catch(() => []), listRemote(acct, container, p, signal)]);
  const byPath = new Map(locals.map((l) => [path.resolve(l.file), l]));
  const plan = { direction: 'down', container, prefix: p, root, create: [], change: [], remove: [], same: 0, skipped: [], bytes: 0, deleteExtra: !!deleteExtra };
  const seen = new Set();
  for (const [key, r] of remote) {
    if (isExcluded(key.slice(p.length))) continue;
    const sp = safeLocalPath(root, key, p);
    if (sp.error) { plan.skipped.push({ key, why: sp.error }); continue; }
    seen.add(sp.path);
    const l = byPath.get(sp.path);
    if (!l) { plan.create.push({ key, file: sp.path, size: r.size }); plan.bytes += r.size; }
    else if (!(await sameContent(l, r, 'down'))) { plan.change.push({ key, file: sp.path, size: r.size, localSize: l.size }); plan.bytes += r.size; }
    else plan.same++;
  }
  if (deleteExtra) for (const [abs, l] of byPath) if (!seen.has(abs)) plan.remove.push({ file: abs, size: l.size });
  return plan;
}

/** Run a plan. opts: { acct, concurrency, signal, contentTypeFor, onProgress({done,total,bytes,totalBytes,current}) }. */
async function applyPlan(plan, opts) {
  const { acct, signal } = opts;
  if (plan.direction === 'up') acct.assertWritable();
  const items = [...plan.create, ...plan.change];
  const total = items.length + plan.remove.length;
  let done = 0;
  let bytes = 0;
  const failed = [];
  const report = (current) => opts.onProgress && opts.onProgress({ done, total, bytes, totalBytes: plan.bytes, current });
  const queue = items.slice();
  const worker = async () => {
    while (queue.length) {
      if (signal && signal.aborted) return;
      const it = queue.shift();
      report(it.key);
      try {
        if (plan.direction === 'up') {
          await blob.uploadFile(acct, plan.container, it.key, it.file, { signal, contentType: opts.contentTypeFor ? opts.contentTypeFor(it.key) : undefined, concurrency: 2 });
        } else {
          const check = safeLocalPath(plan.root, it.key, plan.prefix);
          if (check.error || check.path !== it.file) throw new Error('unsafe path: ' + (check.error || it.file));
          await blob.downloadFile(acct, plan.container, it.key, it.file, { signal });
        }
        bytes += it.size;
      } catch (e) {
        if (blob.isAbort(e, signal)) return;
        failed.push({ item: it, error: e && e.message ? e.message.split('\n')[0] : String(e) });
      }
      done++;
      report(it.key);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, opts.concurrency || 4)) }, worker));
  let deleted = 0;
  if (plan.remove.length && !(signal && signal.aborted)) {
    if (plan.direction === 'up') {
      for (const x of plan.remove) {
        try { await blob.deleteBlob(acct, plan.container, x.key, signal); deleted++; } catch (e) { failed.push({ item: x, error: e.message.split('\n')[0] }); }
      }
    } else {
      const rootAbs = path.resolve(plan.root) + path.sep;
      for (const x of plan.remove) {
        if (!path.resolve(x.file).startsWith(rootAbs)) continue;
        try { await fs.promises.unlink(x.file); deleted++; } catch (e) { failed.push({ item: x, error: e.message }); }
      }
    }
    done += plan.remove.length;
    report('');
  }
  return { done, failed, deleted, cancelled: !!(signal && signal.aborted) };
}

// List prices in USD per GB-month (LRS, East US, pay as you go; checked on the Azure pricing page in 2026, E).
// Settings can replace them; the report says they are estimates.
const DEFAULT_PRICES = { Hot: 0.0184, Cool: 0.01, Cold: 0.0036, Archive: 0.00099, '': 0.0184 };

/** Usage of a container (or a prefix): totals, per top-level folder, per tier, the 10 largest blobs. */
async function usageReport({ acct, container, prefix, prices, signal, onProgress }) {
  const p = normPrefix(prefix);
  const P = Object.assign({}, DEFAULT_PRICES, prices || {});
  const rep = { container, prefix: p, count: 0, bytes: 0, folders: new Map(), tiers: new Map(), largest: [], oldest: '', newest: '' };
  await blob.listAll(acct, container, p, (items) => {
    for (const b of items) {
      rep.count++;
      rep.bytes += b.size;
      const rest = b.name.slice(p.length);
      const i = rest.indexOf('/');
      const folder = i < 0 ? '(files here)' : rest.slice(0, i + 1);
      const f = rep.folders.get(folder) || { count: 0, bytes: 0 };
      f.count++; f.bytes += b.size; rep.folders.set(folder, f);
      const tier = b.tier || 'Hot';
      const t = rep.tiers.get(tier) || { count: 0, bytes: 0 };
      t.count++; t.bytes += b.size; rep.tiers.set(tier, t);
      if (rep.largest.length < 10 || b.size > rep.largest[rep.largest.length - 1].size) {
        rep.largest.push({ name: b.name, size: b.size, tier });
        rep.largest.sort((a, c) => c.size - a.size);
        if (rep.largest.length > 10) rep.largest.pop();
      }
      if (b.lastModified) {
        if (!rep.oldest || b.lastModified < rep.oldest) rep.oldest = b.lastModified;
        if (!rep.newest || b.lastModified > rep.newest) rep.newest = b.lastModified;
      }
    }
    if (onProgress) onProgress(rep.count, rep.bytes);
  }, signal);
  const GB = 1024 ** 3;
  const tiers = [...rep.tiers].map(([tier, v]) => ({ tier, ...v, monthly: (v.bytes / GB) * (P[tier] !== undefined ? P[tier] : P.Hot), price: P[tier] !== undefined ? P[tier] : P.Hot })).sort((a, b) => b.bytes - a.bytes);
  const folders = [...rep.folders].map(([folder, v]) => ({ folder, ...v })).sort((a, b) => b.bytes - a.bytes);
  return { container, prefix: p, count: rep.count, bytes: rep.bytes, folders, tiers, largest: rep.largest, monthly: tiers.reduce((s, t) => s + t.monthly, 0), oldest: rep.oldest, newest: rep.newest };
}

module.exports = { planUpload, planDownload, applyPlan, walk, excluder, globToRegex, sameContent, usageReport, DEFAULT_PRICES, md5File };
