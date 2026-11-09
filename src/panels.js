'use strict';
// Webview pages: blob details (properties, content type, cache control, tier, SAS URL), queue (peek, send, dequeue,
// clear), table (query, grid with inline edit, add, delete), the sync plan and the usage report (Zovo Pro).
// CSP: default-src 'none'; styles and scripts only by nonce; images only from the webview itself. No network.
const crypto = require('crypto');
const { fmtBytes, fmtCount } = require('./ui');
const support = require('./support');

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:14px 20px 40px;margin:0}
h1{font-size:1.25em;font-weight:600;margin:0 0 2px;word-break:break-all}
h2{font-size:1.02em;font-weight:600;margin:20px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}
.sub{color:var(--vscode-descriptionForeground);margin-bottom:12px;word-break:break-all}
table{border-collapse:collapse;width:100%;max-width:1100px}
td,th{text-align:left;padding:4px 10px 4px 0;vertical-align:top;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.15))}
th{font-weight:600;color:var(--vscode-descriptionForeground);white-space:nowrap}
th.k{width:1%}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
code,.mono{font-family:var(--vscode-editor-font-family);font-size:.95em;word-break:break-all}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 12px;border-radius:2px;cursor:pointer;font:inherit;margin:0 6px 6px 0}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.link{background:none;color:var(--vscode-textLink-foreground);padding:0 6px 0 0;margin:0}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:4px 6px;font:inherit}
textarea{font-family:var(--vscode-editor-font-family);width:100%;max-width:900px;box-sizing:border-box}
input:focus,select:focus,button:focus,textarea:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.warn{color:var(--vscode-editorWarning-foreground)}
.err{color:var(--vscode-errorForeground)}
.ok{color:var(--vscode-testing-iconPassed,#3fb950)}
.muted{color:var(--vscode-descriptionForeground)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
.url{margin-top:8px;padding:8px;background:var(--vscode-textCodeBlock-background);border-radius:3px;word-break:break-all;font-family:var(--vscode-editor-font-family);font-size:.9em;max-width:1000px}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 4px}
.tile{padding:8px 14px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));border-radius:4px;min-width:110px}
.tile b{display:block;font-size:1.35em;font-weight:600}
.bar{height:8px;background:var(--vscode-progressBar-background);border-radius:2px;min-width:1px}
.pro{font-size:.8em;padding:0 5px;border:1px solid var(--vscode-descriptionForeground);border-radius:3px;color:var(--vscode-descriptionForeground);margin-left:4px}
.grid{overflow:auto;max-height:70vh;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}
.grid table{max-width:none}
.grid th{position:sticky;top:0;background:var(--vscode-editor-background);padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.4))}
.grid td{padding:3px 8px;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis;font-family:var(--vscode-editor-font-family);font-size:.92em}
.grid td.ed{cursor:text}
.grid td.ed:hover{background:var(--vscode-list-hoverBackground)}
.grid tr.sel td{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.grid td input{width:100%;box-sizing:border-box;padding:1px 3px}
.t{font-size:.75em;color:var(--vscode-descriptionForeground);font-weight:400}
.msg{white-space:pre-wrap;word-break:break-all;font-family:var(--vscode-editor-font-family);font-size:.92em;max-height:8em;overflow:auto}
#status{min-height:1.4em;margin:6px 0}
.hidden{display:none}
.short{max-height:50vh}
.pad{padding:8px}
${support.FOOTER_CSS}
`;

function page(webview, title, body, script) {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style nonce="${nonce}">${CSS}</style></head>
<body>${body}<script nonce="${nonce}">const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const escH = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function status(text, cls) { const s = $('status'); if (s) { s.textContent = text || ''; s.className = cls || ''; } }
document.addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (!b) return; e.preventDefault(); const d = Object.assign({}, b.dataset); if (typeof collect === 'function') Object.assign(d, collect(d.cmd) || {}); vscode.postMessage(d); });
window.addEventListener('message', (e) => { const m = e.data || {}; if (m.type === 'status') status(m.text, m.cls); if (typeof onHost === 'function') onHost(m); });
${script || ''}</script></body></html>`;
}

const footer = (show) => support.footerHtml('azureStorage', show, '');

// ---------------- blob details ----------------
function detailsHtml(webview, d) {
  const p = d.props || {};
  const rows = [
    ['Size', `${fmtBytes(p.size)} <span class="muted">(${fmtCount(p.size || 0)} bytes)</span>`],
    ['Last modified', esc(p.lastModified)],
    ['Created', esc(p.createdOn)],
    ['Blob type', esc(p.blobType)],
    ['Access tier', `${esc(p.tier || 'n/a')}${p.tierInferred ? ' <span class="muted">(account default)</span>' : ''}${p.archiveStatus ? ` <span class="warn">${esc(p.archiveStatus)}</span>` : ''}`],
    ['Content type', esc(p.contentType) || '<span class="muted">none</span>'],
    ['Cache-Control', esc(p.cacheControl) || '<span class="muted">none</span>'],
    ['Content-MD5', p.md5 ? `<code>${esc(p.md5)}</code>` : '<span class="muted">none (uploaded in blocks)</span>'],
    ['ETag', `<code>${esc(p.etag)}</code>`],
  ];
  if (p.contentEncoding) rows.push(['Content-Encoding', esc(p.contentEncoding)]);
  if (p.contentDisposition) rows.push(['Content-Disposition', esc(p.contentDisposition)]);
  if (p.leaseState && p.leaseState !== 'available') rows.push(['Lease', esc(p.leaseState)]);
  if (p.versionId) rows.push(['Version ID', `<code>${esc(p.versionId)}</code>`]);
  const meta = Object.entries(p.metadata || {});
  const ro = d.readOnly;
  const tiers = ['Hot', 'Cool', 'Cold', 'Archive'].map((t) => `<option${t === p.tier ? ' selected' : ''}>${t}</option>`).join('');
  const body = `
<h1>${esc(d.name.split('/').pop() || d.name)}</h1>
<div class="sub"><span class="mono">${esc(d.container)}/${esc(d.name)}</span> · ${esc(d.connName)}${ro ? ' · <b>read-only</b>' : ''}</div>
<div class="row">
<button data-cmd="open">Open</button><button class="secondary" data-cmd="download">Download...</button><button class="secondary" data-cmd="copyUrl">Copy URL</button><button class="secondary" data-cmd="refresh">Refresh</button>
</div>
<div id="status"></div>
<h2>Properties</h2>
<table>${rows.map(([k, v]) => `<tr><th class="k">${k}</th><td>${v}</td></tr>`).join('')}</table>
${meta.length ? `<h2>Metadata</h2><table>${meta.map(([k, v]) => `<tr><th class="k mono">${esc(k)}</th><td class="mono">${esc(v)}</td></tr>`).join('')}</table>` : ''}
<h2>Content type and cache</h2>
<div class="row"><label for="ct">Content-Type</label><input id="ct" size="40" value="${esc(p.contentType)}" ${ro ? 'disabled' : ''}></div>
<div class="row"><label for="cc">Cache-Control</label><input id="cc" size="40" placeholder="for example max-age=3600" value="${esc(p.cacheControl)}" ${ro ? 'disabled' : ''}></div>
<div class="row"><button data-cmd="saveHeaders" ${ro ? 'disabled' : ''}>Save</button></div>
<h2>Access tier</h2>
<div class="row"><select id="tier" ${ro ? 'disabled' : ''}>${tiers}</select><button data-cmd="setTier" ${ro ? 'disabled' : ''}>Change tier</button>
<span class="muted">Archive is cheapest but cannot be read until it is moved back to Hot or Cool, which takes hours.</span></div>
<h2>Shared access signature (SAS) URL</h2>
${d.canSas ? `<div class="row">
<label><input type="checkbox" id="p_r" checked> read</label><label><input type="checkbox" id="p_w"> write</label><label><input type="checkbox" id="p_c"> create</label><label><input type="checkbox" id="p_d"> delete</label>
<select id="exp"><option value="1h">1 hour</option><option value="1d" selected>1 day</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="365d">1 year</option></select>
<button data-cmd="sas">Generate and copy</button></div>
<div class="muted">${d.kind === 'entra' ? 'Signed with a user delegation key from your Microsoft sign-in (at most 7 days).' : 'Signed on this computer with the account key. Anyone with the URL has these rights until it expires.'}</div>
${d.sasUrl ? `<div class="url" id="sasurl">${esc(d.sasUrl)}</div>` : ''}` : `<div class="muted">${esc(d.sasNote || 'This connection cannot sign a SAS URL.')}</div>`}
${footer(d.showLinks)}`;
  const script = `function collect(cmd){ if(cmd==='saveHeaders') return {contentType:$('ct').value, cacheControl:$('cc').value}; if(cmd==='setTier') return {tier:$('tier').value};
 if(cmd==='sas'){ const p=['r','w','c','d'].filter(x=>$('p_'+x)&&$('p_'+x).checked).join(''); return {perm:p, exp:$('exp').value}; } return {}; }`;
  return page(webview, d.name, body, script);
}

// ---------------- queue ----------------
function queueHtml(webview, d) {
  const ro = d.readOnly;
  const body = `
<h1>${esc(d.name)}</h1>
<div class="sub">Queue · ${esc(d.connName)}${ro ? ' · <b>read-only</b>' : ''}</div>
<div class="row"><span>Messages (approximate): <b id="count">${d.count === undefined ? '?' : fmtCount(d.count)}</b></span></div>
<div class="row">
<button data-cmd="peek">Peek 32</button><button class="secondary" data-cmd="dequeue" ${ro ? 'disabled' : ''}>Dequeue next...</button><button class="secondary" data-cmd="clear" ${ro ? 'disabled' : ''}>Clear queue...</button>
<label><input type="checkbox" id="dec" checked> Show Base64 messages decoded</label>
</div>
<div id="status"></div>
<div id="list" class="grid short"></div>
<h2>Send a message</h2>
<textarea id="text" rows="5" placeholder='{"orderId": 42}' ${ro ? 'disabled' : ''}></textarea>
<div class="row"><select id="enc" ${ro ? 'disabled' : ''}><option value="text"${d.encoding === 'text' ? ' selected' : ''}>Send as plain text</option><option value="base64"${d.encoding === 'base64' ? ' selected' : ''}>Send Base64-encoded (Azure Functions reads this)</option></select>
<label>Time to live <select id="ttl" ${ro ? 'disabled' : ''}><option value="">7 days (default)</option><option value="3600">1 hour</option><option value="86400">1 day</option><option value="-1">never expires</option></select></label>
<button data-cmd="send" ${ro ? 'disabled' : ''}>Send</button></div>
${footer(d.showLinks)}`;
  const script = `let msgs = [];
function collect(cmd){ if(cmd==='send') return {text:$('text').value, encoding:$('enc').value, ttl:$('ttl').value}; return {}; }
function render(){ const dec=$('dec').checked; if(!msgs.length){ $('list').innerHTML='<div class="muted pad">No messages to show. Peek reads up to 32 messages without changing them.</div>'; return; }
 $('list').innerHTML='<table><tr><th>#</th><th>Message</th><th>Inserted</th><th>Expires</th><th class="num">Dequeued</th><th>ID</th></tr>'+msgs.map((m,i)=>'<tr><td class="num">'+(i+1)+'</td><td><div class="msg">'+escH(dec&&m.decoded!==null&&m.decoded!==undefined?m.decoded:m.text)+'</div>'+(dec&&m.decoded!==null&&m.decoded!==undefined?'<span class="t">Base64, shown decoded</span>':'')+'</td><td>'+escH((m.insertedOn||'').slice(0,19).replace('T',' '))+'</td><td>'+escH((m.expiresOn||'').slice(0,19).replace('T',' '))+'</td><td class="num">'+m.dequeueCount+'</td><td class="mono t">'+escH(m.id)+'</td></tr>').join('')+'</table>'; }
$('dec').addEventListener('change', render);
function onHost(m){ if(m.type==='messages'){ msgs=m.messages||[]; render(); } if(m.type==='count'){ $('count').textContent=m.count; } if(m.type==='sent'){ $('text').value=''; } }
render(); vscode.postMessage({cmd:'peek'});`;
  return page(webview, d.name, body, script);
}

// ---------------- table ----------------
function tableHtml(webview, d) {
  const ro = d.readOnly;
  const body = `
<h1>${esc(d.name)}</h1>
<div class="sub">Table · ${esc(d.connName)}${ro ? ' · <b>read-only</b>' : ''}</div>
<div class="row"><input id="filter" size="70" placeholder="OData filter, for example PartitionKey eq 'orders' and Amount gt 100" value="${esc(d.filter || '')}">
<select id="top"><option>100</option><option selected>500</option><option>1000</option></select>
<button data-cmd="query">Query</button><button class="secondary" data-cmd="more" id="more" disabled>Load more</button></div>
<div class="row"><button class="secondary" data-cmd="add" ${ro ? 'disabled' : ''}>Add entity</button><button class="secondary" data-cmd="del" id="del" disabled>Delete selected...</button>
<span class="muted">${ro ? 'Read-only connection.' : 'Double-click a cell to edit it. Enter saves, Esc cancels.'}</span></div>
<div id="status"></div>
<div id="grid" class="grid"></div>
<div id="addform" class="hidden">
<h2>New entity</h2>
<div class="row"><label>PartitionKey <input id="npk" size="24"></label><label>RowKey <input id="nrk" size="24"></label></div>
<table id="nprops"><tr><th>Property</th><th>Type</th><th>Value</th></tr></table>
<div class="row"><button class="secondary" id="addprop">Add property</button><button data-cmd="create">Create</button><button class="secondary" id="canceladd">Cancel</button></div>
</div>
${footer(d.showLinks)}`;
  const types = ['String', 'Int32', 'Int64', 'Double', 'Boolean', 'DateTime', 'Guid', 'Binary'];
  const script = `const RO=${ro ? 'true' : 'false'}; const TYPES=${JSON.stringify(types)};
let rows=[], cols=[], colTypes={}, sel=-1, next=null;
function computeCols(){ const seen=new Map(); for(const r of rows) for(const [k,v] of Object.entries(r.props)) { if(!seen.has(k)) seen.set(k,v.type); } cols=[...seen.keys()]; colTypes=Object.fromEntries(seen); }
function render(){ computeCols(); if(!rows.length){ $('grid').innerHTML='<div class="muted pad">No entities match.</div>'; return; }
 let h='<table><tr><th>#</th><th>PartitionKey</th><th>RowKey</th><th>Timestamp</th>'+cols.map(c=>'<th title="'+escH(colTypes[c])+'">'+escH(c)+' <span class="t">'+escH(colTypes[c])+'</span></th>').join('')+'</tr>';
 rows.forEach((r,i)=>{ h+='<tr data-i="'+i+'"'+(i===sel?' class="sel"':'')+'><td class="num t">'+(i+1)+'</td><td>'+escH(r.partitionKey)+'</td><td>'+escH(r.rowKey)+'</td><td class="t">'+escH((r.timestamp||'').slice(0,19).replace('T',' '))+'</td>'+cols.map(c=>{ const v=r.props[c]; return '<td class="ed" data-c="'+escH(c)+'" title="'+(v?escH(v.type):'')+'">'+(v?escH(v.value):'<span class="t">-</span>')+'</td>'; }).join('')+'</tr>'; });
 $('grid').innerHTML=h+'</table>'; $('del').disabled = RO || sel<0; }
$('grid').addEventListener('click',(e)=>{ const tr=e.target.closest('tr[data-i]'); if(!tr) return; sel=Number(tr.dataset.i); for(const x of document.querySelectorAll('#grid tr.sel')) x.classList.remove('sel'); tr.classList.add('sel'); $('del').disabled = RO || sel<0; });
$('grid').addEventListener('dblclick',(e)=>{ if(RO) return; const td=e.target.closest('td.ed'); if(!td||td.querySelector('input')) return; const tr=td.closest('tr'); const i=Number(tr.dataset.i); const c=td.dataset.c; const r=rows[i]; const v=r.props[c]||{type:colTypes[c]||'String',value:''};
 const inp=document.createElement('input'); inp.value=v.value; td.textContent=''; td.appendChild(inp); inp.focus(); inp.select(); let done=false;
 const finish=(save)=>{ if(done) return; done=true; if(save && inp.value!==v.value){ td.textContent=inp.value; status('Saving '+c+'...'); vscode.postMessage({cmd:'saveCell', i:String(i), pk:r.partitionKey, rk:r.rowKey, prop:c, type:v.type, value:inp.value}); } else render(); };
 inp.addEventListener('keydown',(k)=>{ if(k.key==='Enter') finish(true); if(k.key==='Escape') finish(false); }); inp.addEventListener('blur',()=>finish(false)); });
function propRow(){ const tr=document.createElement('tr'); tr.innerHTML='<td><input class="pn" size="18"></td><td><select class="pt">'+TYPES.map(t=>'<option>'+t+'</option>').join('')+'</select></td><td><input class="pv" size="40"></td>'; $('nprops').appendChild(tr); }
$('addprop').addEventListener('click',(e)=>{ e.preventDefault(); propRow(); });
$('canceladd').addEventListener('click',(e)=>{ e.preventDefault(); $('addform').classList.add('hidden'); });
function collect(cmd){ if(cmd==='query'||cmd==='more') return {filter:$('filter').value, top:$('top').value};
 if(cmd==='add'){ $('addform').classList.remove('hidden'); if($('nprops').rows.length<2) propRow(); $('npk').focus(); return {ignore:'1'}; }
 if(cmd==='del'){ const r=rows[sel]; return r?{pk:r.partitionKey, rk:r.rowKey, i:String(sel)}:{ignore:'1'}; }
 if(cmd==='create'){ const props=[]; for(const tr of $('nprops').querySelectorAll('tr')){ const n=tr.querySelector('.pn'); if(!n||!n.value.trim()) continue; props.push({name:n.value.trim(), type:tr.querySelector('.pt').value, value:tr.querySelector('.pv').value}); } return {pk:$('npk').value, rk:$('nrk').value, props:JSON.stringify(props)}; }
 return {}; }
$('filter').addEventListener('keydown',(k)=>{ if(k.key==='Enter') vscode.postMessage({cmd:'query', filter:$('filter').value, top:$('top').value}); });
function onHost(m){ if(m.type==='rows'){ if(m.append) rows=rows.concat(m.rows); else { rows=m.rows; sel=-1; } next=m.next; $('more').disabled=!next; render(); status(rows.length.toLocaleString('en-US')+' entities shown'+(next?' (more available)':''), ''); }
 if(m.type==='saved'){ const r=rows[Number(m.i)]; if(r){ r.etag=m.etag; r.props[m.prop]={type:m.ptype,value:m.value}; r.timestamp=m.timestamp||r.timestamp; } render(); status('Saved.','ok'); }
 if(m.type==='saveFailed'){ render(); status(m.text,'err'); }
 if(m.type==='deleted'){ rows.splice(Number(m.i),1); sel=-1; render(); status('Deleted.','ok'); }
 if(m.type==='created'){ $('addform').classList.add('hidden'); $('npk').value=''; $('nrk').value=''; for(const tr of [...$('nprops').querySelectorAll('tr')].slice(1)) tr.remove(); } }
vscode.postMessage({cmd:'query', filter:$('filter').value, top:$('top').value});`;
  return page(webview, d.name, body, script);
}

// ---------------- sync plan (Pro) ----------------
function syncHtml(webview, d) {
  const plan = d.plan;
  const up = plan.direction === 'up';
  const list = (items, label, cls) => {
    if (!items.length) return '';
    const shown = items.slice(0, 300);
    return `<h2>${label} <span class="muted">(${fmtCount(items.length)})</span></h2><table>${shown.map((x) => `<tr><td class="mono ${cls || ''}">${esc(x.key || x.file)}</td><td class="num">${fmtBytes(x.size)}</td></tr>`).join('')}${items.length > shown.length ? `<tr><td class="muted">... and ${fmtCount(items.length - shown.length)} more</td><td></td></tr>` : ''}</table>`;
  };
  const target = `${plan.container}/${plan.prefix}`;
  const body = `
<h1>Sync plan (dry run)<span class="pro">Pro</span></h1>
<div class="sub">${up ? `<span class="mono">${esc(plan.root)}</span> → <span class="mono">${esc(target)}</span>` : `<span class="mono">${esc(target)}</span> → <span class="mono">${esc(plan.root)}</span>`} · ${esc(d.connName)}</div>
${d.note ? `<div class="muted">${esc(d.note)}</div>` : ''}
<div class="tiles"><div class="tile"><b>${fmtCount(plan.create.length)}</b>new</div><div class="tile"><b>${fmtCount(plan.change.length)}</b>changed</div><div class="tile"><b>${fmtCount(plan.remove.length)}</b>${up ? 'to delete in Azure' : 'to delete locally'}</div><div class="tile"><b>${fmtCount(plan.same)}</b>same</div><div class="tile"><b>${fmtBytes(plan.bytes)}</b>to copy</div></div>
<p class="muted">Nothing has changed yet. ${plan.deleteExtra ? 'Mirror mode: files that exist only on the target are deleted after you confirm the list.' : 'Files that exist only on the target are kept.'}</p>
<div class="row">${plan.create.length + plan.change.length + plan.remove.length ? `<button data-cmd="apply" ${d.applying || d.readOnly ? 'disabled' : ''}>Apply ${fmtCount(plan.create.length + plan.change.length + plan.remove.length)} changes</button>` : '<span class="ok">Already in sync.</span>'}<button class="secondary" data-cmd="replan">Plan again</button></div>
<div id="status">${d.result ? esc(d.result) : ''}</div>
${list(plan.create, 'New')}${list(plan.change, 'Changed')}${list(plan.remove, 'Delete', 'warn')}
${plan.skipped.length ? `<h2>Skipped <span class="muted">(${fmtCount(plan.skipped.length)})</span></h2><table>${plan.skipped.slice(0, 100).map((s) => `<tr><td class="mono">${esc(s.key || s.path)}</td><td class="warn">${esc(s.why)}</td></tr>`).join('')}</table>` : ''}
${footer(d.showLinks)}`;
  return page(webview, 'Sync plan', body, '');
}

// ---------------- usage report (Pro) ----------------
function usageHtml(webview, d) {
  const r = d.report;
  const maxF = Math.max(1, ...r.folders.map((f) => f.bytes));
  const money = (n) => `USD ${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
  const body = `
<h1>Usage and cost report<span class="pro">Pro</span></h1>
<div class="sub"><span class="mono">${esc(r.container)}/${esc(r.prefix)}</span> · ${esc(d.connName)}</div>
${d.note ? `<div class="muted">${esc(d.note)}</div>` : ''}
<div class="tiles"><div class="tile"><b>${fmtBytes(r.bytes)}</b>stored</div><div class="tile"><b>${fmtCount(r.count)}</b>blobs</div><div class="tile"><b>${money(r.monthly)}</b>a month (estimate)</div></div>
<p class="muted">Storage cost only, from list prices per GB-month (LRS, pay as you go): ${r.tiers.map((t) => `${esc(t.tier)} ${t.price}`).join(', ')}. Transactions, egress and redundancy options are not included. Set your own prices in the setting azureStorage.pricePerGBMonth.</p>
<h2>By access tier</h2>
<table><tr><th>Tier</th><th class="num">Blobs</th><th class="num">Size</th><th class="num">Per month</th></tr>${r.tiers.map((t) => `<tr><td>${esc(t.tier)}</td><td class="num">${fmtCount(t.count)}</td><td class="num">${fmtBytes(t.bytes)}</td><td class="num">${money(t.monthly)}</td></tr>`).join('')}</table>
<h2>By folder</h2>
<table><tr><th>Folder</th><th class="num">Blobs</th><th class="num">Size</th><th></th></tr>${r.folders.slice(0, 200).map((f) => `<tr><td class="mono">${esc(f.folder)}</td><td class="num">${fmtCount(f.count)}</td><td class="num">${fmtBytes(f.bytes)}</td><td><div class="bar" style="width:${Math.max(0.5, (f.bytes / maxF) * 100).toFixed(1)}%"></div></td></tr>`).join('')}</table>
<h2>Largest blobs</h2>
<table><tr><th>Blob</th><th>Tier</th><th class="num">Size</th></tr>${r.largest.map((b) => `<tr><td class="mono">${esc(b.name)}</td><td>${esc(b.tier)}</td><td class="num">${fmtBytes(b.size)}</td></tr>`).join('')}</table>
<p class="muted">Oldest change ${esc((r.oldest || '').slice(0, 10))}, newest ${esc((r.newest || '').slice(0, 10))}.</p>
${footer(d.showLinks)}`;
  return page(webview, 'Usage report', body.replace(/style="width:([\d.]+)%"/g, (m, w) => `data-w="${w}"`), `for (const el of document.querySelectorAll('[data-w]')) el.style.width = el.dataset.w + '%';`);
}

module.exports = { detailsHtml, queueHtml, tableHtml, syncHtml, usageHtml, esc, page };
