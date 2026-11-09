'use strict';
// The transfer queue: uploads and downloads run a few at a time, each with progress, Cancel and Retry. The queue
// itself is plain JS (tests use it without VS Code); TransfersView shows it as a tree.

let seq = 0;

class TransferQueue {
  /** run(job, { signal, progress(bytes, total) }) does one transfer. */
  constructor({ concurrency = 3, onChange } = {}) {
    this.concurrency = concurrency;
    this.items = [];
    this.onChange = onChange || (() => {});
    this.active = 0;
    this._waiters = [];
  }

  /** job: { kind: 'upload'|'download', label, detail, total, run } -> item */
  add(job) {
    const item = { id: ++seq, kind: job.kind, label: job.label, detail: job.detail || '', total: job.total || 0, bytes: 0, status: 'queued', error: '', job, startedAt: 0, endedAt: 0, ac: null, rate: 0 };
    this.items.push(item);
    this._trim();
    this.onChange();
    this._pump();
    return item;
  }

  _trim() {
    // Keep at most 200 finished rows; running and queued ones are never dropped.
    const finished = this.items.filter((i) => i.status === 'done');
    if (finished.length > 200) { const drop = new Set(finished.slice(0, finished.length - 200)); this.items = this.items.filter((i) => !drop.has(i)); }
  }

  _pump() {
    while (this.active < this.concurrency) {
      const next = this.items.find((i) => i.status === 'queued');
      if (!next) break;
      this._start(next);
    }
    if (!this.active && !this.items.some((i) => i.status === 'queued')) { const w = this._waiters; this._waiters = []; w.forEach((f) => f()); }
  }

  _start(item) {
    this.active++;
    item.status = 'running';
    item.error = '';
    item.bytes = 0;
    item.startedAt = Date.now();
    item.ac = new AbortController();
    this.onChange();
    let lastFire = 0;
    const progress = (bytes, total) => {
      item.bytes = bytes;
      if (total) item.total = total;
      const secs = (Date.now() - item.startedAt) / 1000;
      item.rate = secs > 0.2 ? bytes / secs : 0;
      if (Date.now() - lastFire > 400) { lastFire = Date.now(); this.onChange(); }
    };
    Promise.resolve()
      .then(() => item.job.run(item.job, { signal: item.ac.signal, progress }))
      .then((res) => { item.status = 'done'; item.result = res; if (item.total) item.bytes = item.total; })
      .catch((e) => {
        if (item.ac.signal.aborted || (e && (e.aborted || e.name === 'AbortError' || e.code === 'Aborted'))) { item.status = 'cancelled'; item.error = 'Cancelled'; }
        else { item.status = 'failed'; item.error = (e && e.message ? e.message : String(e)).split('\n')[0]; item.cause = e; }
      })
      .finally(() => {
        item.endedAt = Date.now();
        item.ac = null;
        this.active--;
        this.onChange(item);
        this._pump();
      });
  }

  cancel(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    if (item.status === 'queued') { item.status = 'cancelled'; item.error = 'Cancelled'; this.onChange(item); this._pump(); return true; }
    if (item.status === 'running' && item.ac) { item.ac.abort(); return true; }
    return false;
  }

  cancelAll() { for (const i of this.items) if (i.status === 'queued' || i.status === 'running') this.cancel(i.id); }

  retry(id) {
    const item = this.items.find((i) => i.id === id);
    if (!item || (item.status !== 'failed' && item.status !== 'cancelled')) return false;
    item.status = 'queued';
    item.error = '';
    item.bytes = 0;
    this.onChange();
    this._pump();
    return true;
  }

  clearFinished() { this.items = this.items.filter((i) => i.status === 'queued' || i.status === 'running'); this.onChange(); }

  /** Resolves when nothing is queued or running. */
  idle() { if (!this.active && !this.items.some((i) => i.status === 'queued')) return Promise.resolve(); return new Promise((r) => this._waiters.push(r)); }

  /** Resolves when every item in `items` has finished (done, failed or cancelled). */
  async settle(items) {
    while (items.some((i) => i.status === 'queued' || i.status === 'running')) await new Promise((r) => setTimeout(r, 100));
    return items;
  }

  summary() {
    const run = this.items.filter((i) => i.status === 'running' || i.status === 'queued');
    const total = run.reduce((s, i) => s + (i.total || 0), 0);
    const bytes = run.reduce((s, i) => s + (i.bytes || 0), 0);
    return { active: run.length, failed: this.items.filter((i) => i.status === 'failed').length, pct: total ? Math.floor((bytes / total) * 100) : 0 };
  }
}

function fmtRate(bps, fmtBytes) { return bps > 0 ? `${fmtBytes(bps)}/s` : ''; }

class TransfersView {
  constructor({ vscode, queue, fmtBytes }) {
    this.vscode = vscode;
    this.queue = queue;
    this.fmtBytes = fmtBytes;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() { this.emitter.fire(undefined); }

  getChildren(el) {
    if (el) return [];
    return this.queue.items.slice().reverse();
  }

  getTreeItem(i) {
    const vs = this.vscode;
    const t = new vs.TreeItem(i.label, vs.TreeItemCollapsibleState.None);
    const pct = i.total ? Math.min(100, Math.floor((i.bytes / i.total) * 100)) : 0;
    const icons = { queued: 'clock', running: 'sync~spin', done: 'pass', failed: 'error', cancelled: 'circle-slash' };
    t.iconPath = new vs.ThemeIcon(icons[i.status] || 'circle', i.status === 'failed' ? new vs.ThemeColor('errorForeground') : undefined);
    const dir = i.kind === 'upload' ? '↑' : '↓';
    if (i.status === 'running') t.description = `${dir} ${pct}% of ${this.fmtBytes(i.total)} ${fmtRate(i.rate, this.fmtBytes)}`;
    else if (i.status === 'done') t.description = `${dir} ${this.fmtBytes(i.total || i.bytes)} done`;
    else if (i.status === 'failed') t.description = `${dir} failed: ${i.error}`;
    else if (i.status === 'cancelled') t.description = `${dir} cancelled`;
    else t.description = `${dir} waiting`;
    t.tooltip = `${i.kind === 'upload' ? 'Upload' : 'Download'}: ${i.detail || i.label}\n${t.description}`;
    t.contextValue = `transfer-${i.status}`;
    t.id = `transfer-${i.id}-${i.status}`;
    return t;
  }
}

module.exports = { TransferQueue, TransfersView };
