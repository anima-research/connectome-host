/**
 * The context-curve page served at GET /curve (web-ui-module).
 *
 * Self-contained HTML: fetches /debug/context/curve (same origin, same basic
 * auth) and renders (a) an XY plot of cumulative raw-history tokens vs
 * cumulative rendered context tokens — each segment one compiled entry, slope
 * = local compression rate, colored by fold level — and (b) the full raw
 * compiled window, filterable by kind. Both themes; no external resources.
 *
 * Born 2026-07-12 during the mythos inversion incident: the curve makes a
 * misallocated resolution profile visible at a glance (an inversion reads as
 * a flat shelf right before the tail; depth debt as a too-steep middle).
 */
export const CURVE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>context curve</title>
<style>
:root{
  --surface:#FBFAF7; --ink:#211E19; --ink-2:#5C574D; --muted:#8A857C;
  --hair:#E8E4DB; --hair-2:#F0EDE5;
  --c-raw:#B45309; --c-l1:#6D97E9; --c-l2:#4B78D6; --c-l3:#3B6FD4; --c-l4:#24408F;
  --chip-ink:#FBFAF7; --tip-bg:#211E19; --tip-ink:#FBFAF7;
}
@media (prefers-color-scheme: dark){:root{
  --surface:#17191D; --ink:#E9E6DF; --ink-2:#B0ACA2; --muted:#8B8FA0;
  --hair:#2A2D34; --hair-2:#22252B;
  --c-raw:#C97426; --c-l1:#8FB0F4; --c-l2:#6E9CEF; --c-l3:#5D8FE8; --c-l4:#4573C9;
  --chip-ink:#17191D; --tip-bg:#E9E6DF; --tip-ink:#17191D;
}}
html{background:var(--surface)}
body{margin:0;background:var(--surface);color:var(--ink);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 24px 80px}
h1{font-family:Palatino,"Iowan Old Style","Palatino Linotype",serif;
  font-size:26px;font-weight:600;margin:0 0 4px;text-wrap:balance}
.meta{color:var(--muted);font-size:13px;margin:0 0 20px}
.mono,pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:0 0 24px}
.tile{border:1px solid var(--hair);border-radius:6px;padding:11px 13px}
.tile .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.tile .v{font-size:22px;font-weight:600;margin-top:2px}
.tile .v small{font-size:12px;font-weight:400;color:var(--ink-2)}
.plotbox{border:1px solid var(--hair);border-radius:6px;padding:14px 10px 6px;margin-bottom:10px}
.legend{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:6px 8px 10px;font-size:13px;color:var(--ink-2)}
.legend .sw{display:inline-block;width:14px;height:4px;border-radius:2px;vertical-align:middle;margin-right:6px}
svg text{font:11px ui-monospace,Menlo,monospace;fill:var(--muted)}
.gridline{stroke:var(--hair-2);stroke-width:1}
.axis{stroke:var(--hair);stroke-width:1}
.guide{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 4;opacity:.6}
.seg{fill:none;stroke-width:2.5;stroke-linecap:round}
.seg.raw{stroke:var(--c-raw)} .seg.L1{stroke:var(--c-l1)} .seg.L2{stroke:var(--c-l2)}
.seg.L3{stroke:var(--c-l3)} .seg.L4{stroke:var(--c-l4)} .seg.L5{stroke:var(--c-l4)}
.hit{fill:none;stroke:transparent;stroke-width:16;cursor:pointer}
.seg.hot{stroke-width:4.5}
.xhair{stroke:var(--muted);stroke-width:1;stroke-dasharray:2 3;opacity:0;pointer-events:none}
#tip{position:fixed;z-index:10;max-width:380px;background:var(--tip-bg);color:var(--tip-ink);
  border-radius:6px;padding:10px 12px;font-size:12.5px;line-height:1.45;pointer-events:none;
  opacity:0;transition:opacity .08s;box-shadow:0 4px 18px rgba(0,0,0,.25)}
@media (prefers-reduced-motion: reduce){#tip{transition:none}}
#tip .h{font-weight:600;margin-bottom:2px}
#tip .d{opacity:.75}
.chip{display:inline-block;min-width:2.2em;text-align:center;border-radius:4px;padding:1px 7px;
  font:600 11px/1.7 ui-monospace,Menlo,monospace;color:var(--chip-ink)}
.chip.raw{background:var(--c-raw)} .chip.L1{background:var(--c-l1)} .chip.L2{background:var(--c-l2)}
.chip.L3{background:var(--c-l3)} .chip.L4{background:var(--c-l4)} .chip.L5{background:var(--c-l4)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:30px 0 14px;position:sticky;top:0;
  background:var(--surface);padding:10px 0;border-bottom:1px solid var(--hair);z-index:5}
.filters button{border:1px solid var(--hair);background:none;color:var(--ink-2);border-radius:99px;
  padding:4px 14px;font:13px system-ui,sans-serif;cursor:pointer}
.filters button[aria-pressed="true"]{border-color:var(--ink-2);color:var(--ink);font-weight:600}
.filters button:focus-visible{outline:2px solid var(--c-l3);outline-offset:2px}
.entry{border:1px solid var(--hair);border-radius:6px;margin-bottom:8px;scroll-margin-top:70px}
.entry[hidden]{display:none}
.entry summary{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;cursor:pointer;
  padding:9px 12px;list-style:none}
.entry summary::-webkit-details-marker{display:none}
.entry summary:focus-visible{outline:2px solid var(--c-l3);outline-offset:-2px}
.entry .who{font-weight:600;font-size:13.5px}
.entry .stat{color:var(--muted);font-size:12px;margin-left:auto;white-space:nowrap}
.entry .peek{color:var(--ink-2);font-size:13px;flex-basis:100%;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;margin:0}
.entry[open] .peek{display:none}
.entry pre{margin:0;border-top:1px solid var(--hair);padding:12px 14px;white-space:pre-wrap;
  word-break:break-word;font-size:12.5px;line-height:1.5;max-height:480px;overflow-y:auto}
.entry .imgs{color:var(--muted);font-size:12px;padding:0 14px 10px}
.note{color:var(--muted);font-size:13px;margin:6px 0 0}
#status{color:var(--muted);padding:40px 0;text-align:center}
</style>
</head>
<body>
<div class="wrap">
<h1 id="title">context curve</h1>
<p class="meta" id="meta">loading…</p>
<div id="status">compiling the live window…</div>
<div id="content" hidden>
<div class="tiles" id="tiles"></div>
<div class="plotbox">
  <svg id="plot" viewBox="0 0 1040 470" role="img"
    aria-label="Cumulative raw tokens versus rendered context tokens, colored by fold level"></svg>
  <div class="legend" id="legend"></div>
  <p class="note" style="padding:0 8px 8px">Each segment is one context entry, oldest → newest.
  Slope = how much window each token of history costs: flat = deeply folded, 45° = verbatim.
  The dashed guide is 1:1 (uncompressed). Hover for detail; click a segment to jump to its text below.</p>
</div>
<div class="filters" id="filters" role="group" aria-label="Filter entries by kind"></div>
<div id="list"></div>
</div>
</div>
<div id="tip" role="status"></div>
<script>
(async () => {
const status = document.getElementById('status');
let payload;
try {
  const res = await fetch('/debug/context/curve' + location.search, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  payload = await res.json();
} catch (e) {
  status.textContent = 'failed to load: ' + e.message;
  return;
}
const D = payload.entries;
document.getElementById('title').textContent = payload.agent + ' — compiled context';
document.title = payload.agent + ' — context curve';
document.getElementById('meta').textContent =
  'branch ' + payload.branch + ' · compiled ' + payload.generatedAt.slice(0, 16).replace('T', ' ') +
  'Z · budget ' + Math.round(payload.budget.maxTokens / 1000) + 'k (hard ' +
  Math.round((payload.budget.maxTokens - payload.budget.reserveForResponse) / 1000) + 'k)';

let cx = 0, cy = 0;
for (const e of D) { e.x0 = cx; e.y0 = cy; cx += e.rawCovered; cy += e.rendered; e.x1 = cx; e.y1 = cy; }
const KINDS = ['raw','L1','L2','L3','L4','L5'].filter(k => D.some(e => e.kind === k));
const fmt = n => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1000 ? Math.round(n/1000)+'k' : String(n);
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
const date = s => s ? new Date(s).toISOString().slice(0,16).replace('T',' ') : '';

const totRaw = cx, totRen = cy;
document.getElementById('tiles').innerHTML =
  '<div class="tile"><div class="k">Raw history covered</div><div class="v mono">' + fmt(totRaw) + ' <small>tok est</small></div></div>' +
  '<div class="tile"><div class="k">Rendered context</div><div class="v mono">' + fmt(totRen) + ' <small>tok est</small></div></div>' +
  '<div class="tile"><div class="k">Compression</div><div class="v mono">' + (totRaw/Math.max(1,totRen)).toFixed(1) + ':1</div></div>' +
  '<div class="tile"><div class="k">Entries</div><div class="v mono">' + D.length + ' <small>' +
    KINDS.map(k => k + ':' + D.filter(e => e.kind === k).length).join(' · ') + '</small></div></div>';

// ---- plot ----
const svg = document.getElementById('plot');
const W = 1040, H = 470, m = {l:58, r:16, t:34, b:34};
const maxX = totRaw, maxY = totRen * 1.04;
const sx = x => m.l + (W-m.l-m.r) * x / maxX;
const sy = y => H - m.b - (H-m.t-m.b) * y / maxY;
let S = '';
const yt = 5, xt = 6;
for (let i = 0; i <= yt; i++){
  const v = maxY/yt*i, y = sy(v);
  S += '<line class="gridline" x1="'+m.l+'" x2="'+(W-m.r)+'" y1="'+y+'" y2="'+y+'"/>';
  S += '<text x="'+(m.l-8)+'" y="'+(y+4)+'" text-anchor="end">'+fmt(Math.round(v))+'</text>';
}
for (let i = 0; i <= xt; i++){
  const v = maxX/xt*i, x = sx(v);
  S += '<text x="'+x+'" y="'+(H-m.b+18)+'" text-anchor="middle">'+fmt(Math.round(v))+'</text>';
}
S += '<line class="axis" x1="'+m.l+'" x2="'+(W-m.r)+'" y1="'+sy(0)+'" y2="'+sy(0)+'"/>';
S += '<text x="'+(W-m.r)+'" y="'+(H-6)+'" text-anchor="end">cumulative raw tokens (history) →</text>';
S += '<text x="14" y="18" text-anchor="start">rendered ↑</text>';
const gx = Math.min(maxX, maxY);
S += '<line class="guide" x1="'+sx(0)+'" y1="'+sy(0)+'" x2="'+sx(gx)+'" y2="'+sy(gx)+'"/>';
S += '<text x="'+(sx(gx)+6)+'" y="'+(sy(gx)+2)+'">1:1</text>';
for (const e of D){
  const p = 'x1="'+sx(e.x0)+'" y1="'+sy(e.y0)+'" x2="'+sx(e.x1)+'" y2="'+sy(e.y1)+'"';
  S += '<line class="seg '+e.kind+'" data-i="'+e.i+'" '+p+'/>';
  S += '<line class="hit" data-i="'+e.i+'" '+p+'/>';
}
S += '<line id="xh" class="xhair" y1="'+m.t+'" y2="'+(H-m.b)+'" x1="0" x2="0"/>';
svg.innerHTML = S;

document.getElementById('legend').innerHTML = KINDS.map(k =>
  '<span><span class="sw" style="background:var(--c-'+k.toLowerCase()+')"></span>' +
  (k === 'raw' ? 'raw (verbatim)' : k + ' summary') + ' · ' + D.filter(e=>e.kind===k).length + '</span>'
).join('');

const tip = document.getElementById('tip');
const xh = document.getElementById('xh');
let hot = null;
function show(e, ev){
  const el = svg.querySelector('.seg[data-i="'+e.i+'"]');
  if (hot && hot !== el) hot.classList.remove('hot');
  el.classList.add('hot'); hot = el;
  const r = e.rawCovered && e.rendered ? (e.rawCovered/e.rendered).toFixed(1) : '—';
  tip.innerHTML =
    '<div class="h"><span class="chip '+e.kind+'">'+e.kind+'</span> '+esc(e.id ?? '')+' · '+esc(e.participant)+'</div>' +
    '<div>'+fmt(e.rawCovered)+' raw → '+fmt(e.rendered)+' rendered ('+r+':1) · '+e.msgCount+' msg'+(e.nImages ? ' · '+e.nImages+' img' : '')+'</div>' +
    '<div class="d">'+date(e.dateFirst)+(e.dateLast && e.dateLast !== e.dateFirst ? ' → '+date(e.dateLast) : '')+'</div>' +
    '<div class="d">'+esc(e.text.slice(0,150))+'…</div>';
  tip.style.opacity = 1;
  const tw = 390;
  tip.style.left = Math.min(ev.clientX + 14, innerWidth - tw) + 'px';
  tip.style.top = Math.min(ev.clientY + 14, innerHeight - 150) + 'px';
  const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
  const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
  xh.setAttribute('x1', loc.x); xh.setAttribute('x2', loc.x); xh.style.opacity = 1;
}
svg.addEventListener('pointermove', ev => {
  const t = ev.target.closest('.hit');
  if (t) show(D[+t.dataset.i], ev);
});
svg.addEventListener('pointerleave', () => {
  tip.style.opacity = 0; xh.style.opacity = 0;
  if (hot) hot.classList.remove('hot'); hot = null;
});
svg.addEventListener('click', ev => {
  const t = ev.target.closest('.hit');
  if (!t) return;
  const el = document.getElementById('e' + t.dataset.i);
  if (el){ el.hidden = false; el.open = true; el.scrollIntoView({behavior:'smooth', block:'start'}); }
});

// ---- entries ----
document.getElementById('list').innerHTML = D.map(e => {
  const r = e.rawCovered && e.rendered ? (e.rawCovered/e.rendered).toFixed(1) : '—';
  return '<details class="entry" id="e'+e.i+'" data-kind="'+e.kind+'">' +
  '<summary><span class="chip '+e.kind+'">'+e.kind+'</span><span class="who">'+esc(e.participant)+'</span>' +
    '<span class="stat mono">'+fmt(e.rawCovered)+'→'+fmt(e.rendered)+' ('+r+':1)'+(e.dateFirst ? ' · '+date(e.dateFirst) : '')+'</span>' +
    '<p class="peek">'+esc(e.text.slice(0,180))+'</p></summary>' +
  (e.nImages ? '<div class="imgs">［'+e.nImages+' inline image'+(e.nImages>1?'s':'')+' not shown in this dump］</div>' : '') +
  '<pre>'+esc(e.text)+'</pre></details>';
}).join('');

// ---- filters ----
const fl = document.getElementById('filters');
fl.innerHTML = ['all', ...KINDS].map(k =>
  '<button aria-pressed="'+(k==='all')+'" data-k="'+k+'">'+k+' · '+(k==='all' ? D.length : D.filter(e=>e.kind===k).length)+'</button>'
).join('');
fl.addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  fl.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  const k = b.dataset.k;
  document.querySelectorAll('.entry').forEach(el => { el.hidden = k !== 'all' && el.dataset.kind !== k; });
});

status.hidden = true;
document.getElementById('content').hidden = false;
})();
</script>
</body>
</html>
`;
