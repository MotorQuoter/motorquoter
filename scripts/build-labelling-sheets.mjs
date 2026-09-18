// build-labelling-sheets.mjs — batch 153 S2. £0, local only.
//
// One self-contained HTML labelling sheet per lot (photos embedded) plus an index, for VINCENT to label
// panels BLIND (30 Jul labelling protocol): the sheet never shows an engine verdict. Labels already stated
// by Vincent (fixtures/<LOT>/ground-truth.json, seeded in S1) are pre-ticked and marked as stated. "Save"
// downloads ground-truth.json in the S1 schema; Vincent drops it into fixtures/<LOT>/.
//
// Code never writes a label from engine output — this script only READS the ground-truth file.
//
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/build-labelling-sheets.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PANEL_DISPLAY } from '../lib/panelEnum.mjs';
import { PAIRS, listLots, lotInfo } from './lib/labelVocabulary.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, '_cc', 'labelling');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// opts.only  — render ONLY these panel ids (batch 156 T3: the trim-only sheet, 3 rows per lot).
// opts.label — what the header calls this sheet.
// A subset sheet SAVES A WHOLE FILE: it starts from the lot's existing labels and overlays the rows on
// screen, so dropping its download into fixtures/<LOT>/ can never delete a label that is not shown.
function sheet(info, opts = {}) {
  const { lot, dir, vd, bodyClass, photos, gt } = info;
  const subset = Array.isArray(opts.only);
  const panels = subset ? info.panels.filter((p) => opts.only.includes(p)) : info.panels;
  const seeded = gt?.panels || {};
  const imgs = photos.map((f, i) => {
    const ext = /\.png$/i.test(f) ? 'png' : 'jpeg';
    const b64 = readFileSync(resolve(dir, 'images', f)).toString('base64');
    return `<figure id="p${i + 1}"><img src="data:image/${ext};base64,${b64}" alt="Photo ${i + 1}" loading="lazy"><figcaption>Photo ${i + 1} <span class="fn">${esc(f)}</span></figcaption></figure>`;
  }).join('\n');
  const rows = panels.map((p) => {
    const s = seeded[p];
    const pair = PAIRS.has(p);
    const opt = (v, t) => `<label class="opt"><input type="radio" name="${p}" value="${v}"${s?.label === v ? ' checked' : ''}> ${t}</label>`;
    return `<tr data-panel="${p}"${s ? ' class="seeded"' : ''}>
  <td><b>${esc(PANEL_DISPLAY[p] || p)}</b><br><code>${p}</code>${s ? `<br><span class="stated">already stated — ${esc(s.source)}</span>` : ''}</td>
  <td>${opt('damaged', 'damaged')}${opt('clean', 'clean')}${opt('cannot-tell', "can't tell")}<button type="button" class="clr" data-clear="${p}">clear</button></td>
  <td>${pair ? `<input type="number" min="0" max="4" class="count" data-count="${p}" value="${s?.count ?? ''}" placeholder="units">` : ''}</td>
  <td><input type="text" class="note" data-note="${p}" value="${esc(s?.note ?? '')}" placeholder="note"></td>
</tr>`;
  }).join('\n');
  const seededJson = JSON.stringify(seeded).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Label ${esc(lot)}${subset ? ' — ' + esc(opts.label || 'subset') : ''}</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--mut:#6b6b66;--line:#ddd;--acc:#f05a1a;--seed:#fff4ec}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#9a9a94;--line:#333;--seed:#2a1d15}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:18px;margin:0}header .mut{color:var(--mut)}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button.save{background:var(--acc);color:#fff;border-color:var(--acc)}
main{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px;padding:16px}
@media (max-width:900px){main{grid-template-columns:1fr}}
.photos{display:flex;flex-direction:column;gap:14px}
figure{margin:0}figure img{width:100%;height:auto;border-radius:6px;display:block;cursor:zoom-in}
figure img.zoom{position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#000;z-index:10;border-radius:0;cursor:zoom-out}
figcaption{font-weight:600;padding:4px 0}.fn{font-weight:400;color:var(--mut);font-size:12px}
.panel{position:sticky;top:60px;max-height:calc(100vh - 76px);overflow:auto}
table{width:100%;border-collapse:collapse}td{border-bottom:1px solid var(--line);padding:6px 4px;vertical-align:top}
tr.seeded{background:var(--seed)}.stated{color:var(--acc);font-size:12px}
.opt{display:inline-block;margin-right:8px;white-space:nowrap}.count{width:64px}.note{width:100%;min-width:90px}
code{font-size:11px;color:var(--mut)}.clr{padding:2px 6px;font-size:12px}
</style></head><body>
<header><h1>${esc(lot)}${subset ? ` <span class="mut">— ${esc(opts.label || 'subset')}</span>` : ''}</h1><span class="mut">${esc(vd.make)} ${esc(vd.model)} · ${esc(vd.bodyStyle)} · panel set: ${esc(bodyClass)} · ${photos.length} photos</span>
<span class="mut">Label from the photos only. The engine's verdicts are deliberately not shown.</span>
${subset ? `<span class="mut">Only the ${panels.length} ${esc(opts.label || 'subset')} row(s) are shown. Saving keeps every other label this lot already has.</span>` : ''}
<button type="button" class="save" id="save">Save ground-truth.json</button><a href="${subset ? '../index.html' : 'index.html'}">all lots</a></header>
<main><section class="photos">${imgs || '<p>No photos on disk for this lot.</p>'}</section>
<section class="panel"><table><tbody>
${rows}
</tbody></table></section></main>
<script>
const LOT = ${JSON.stringify(lot)};
const SEEDED = ${seededJson};
const SUBSET = ${subset};
document.querySelectorAll('[data-clear]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('input[name="' + b.dataset.clear + '"]').forEach(r => { r.checked = false; });
}));
document.querySelectorAll('figure img').forEach(img => img.addEventListener('click', () => img.classList.toggle('zoom')));
document.getElementById('save').addEventListener('click', () => {
  const today = new Date().toISOString().slice(0, 10);
  // A subset sheet starts from what the lot already has, then overlays the rows on screen.
  const panels = SUBSET ? JSON.parse(JSON.stringify(SEEDED)) : {};
  document.querySelectorAll('tr[data-panel]').forEach(tr => {
    const p = tr.dataset.panel;
    const r = tr.querySelector('input[type=radio]:checked');
    if (!r) return;
    const seed = SEEDED[p];
    const entry = { label: r.value };
    const c = tr.querySelector('[data-count]');
    if (c && c.value !== '') entry.count = Number(c.value);
    const n = tr.querySelector('[data-note]').value.trim();
    if (n) entry.note = n;
    const unchanged = seed && seed.label === entry.label && (seed.count ?? null) === (entry.count ?? null);
    entry.source = unchanged ? seed.source : 'Vincent ' + today + ' (labelling sheet)';
    panels[p] = entry;
  });
  const out = { lot: LOT, labelledBy: 'Vincent', labelledOn: today, panels };
  const blob = new Blob([JSON.stringify(out, null, 2) + '\\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ground-truth.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
</script></body></html>
`;
}

const lots = listLots(ROOT);
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const summary = [];
for (const lot of lots) {
  const info = await lotInfo(ROOT, lot);
  writeFileSync(resolve(OUT, `${lot}.html`), sheet(info));
  const labelled = Object.keys(info.gt?.panels || {}).length;
  summary.push({ lot, photos: info.photos.length, panels: info.panels.length, labelled, bodyClass: info.bodyClass, ev: info.ev });
  console.log(`${lot}: ${info.photos.length} photo(s), ${info.panels.length} panel(s) (${info.bodyClass}${info.ev ? ', EV' : ''}), ${labelled} already stated → _cc/labelling/${lot}.html`);
}
const idx = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Labelling Sheets</title>
<style>:root{--bg:#fafaf8;--fg:#1d1d1b;--line:#ddd}@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--line:#333}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:760px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left}a{color:#f05a1a}</style></head><body>
<h1>Ground-truth labelling</h1>
<p>Open a lot, label each panel from the photos, press <b>Save</b>, and drop the downloaded <code>ground-truth.json</code> into <code>fixtures/&lt;LOT&gt;/</code>. The sheets never show what the engine said.</p>
<table><thead><tr><th>Lot</th><th>Photos</th><th>Panels</th><th>Already stated</th></tr></thead><tbody>
${summary.map((s) => `<tr><td><a href="${s.lot}.html">${s.lot}</a></td><td>${s.photos || '<b>none on disk</b>'}</td><td>${s.panels} (${s.bodyClass}${s.ev ? ', EV' : ''})</td><td>${s.labelled}</td></tr>`).join('\n')}
</tbody></table></body></html>
`;
writeFileSync(resolve(OUT, 'index.html'), idx);
console.log('index → _cc/labelling/index.html');

// ── batch 156 T3 — THE TRIM-ONLY SHEET ─────────────────────────────────────────────
// Three rows per lot, 16 lots, nothing else on screen — the trim items are the only unlabelled rows left.
// One file per lot rather than one 80 MB page: the photographs are embedded, and Vincent cannot label trim
// without them. Each file still SAVES A COMPLETE ground-truth.json (see sheet()), so it is safe to drop in.
const TRIM_ONLY = ['WHEEL_ARCH_MOULDING', 'WHEEL_ARCH_LINER', 'REAR_LIGHT_STRIP'];
const TRIM_OUT = resolve(OUT, 'trim');
if (!existsSync(TRIM_OUT)) mkdirSync(TRIM_OUT, { recursive: true });
const trimSummary = [];
for (const lot of lots) {
  const info = await lotInfo(ROOT, lot);
  const shown = info.panels.filter((p) => TRIM_ONLY.includes(p));
  writeFileSync(resolve(TRIM_OUT, `${lot}.html`), sheet(info, { only: TRIM_ONLY, label: 'trim items' }));
  const done = shown.filter((p) => info.gt?.panels?.[p]).length;
  trimSummary.push({ lot, rows: shown.length, done, photos: info.photos.length });
}
const trimIdx = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trim labelling</title>
<style>:root{--bg:#fafaf8;--fg:#1d1d1b;--line:#ddd}@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--line:#333}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:760px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left}a{color:#f05a1a}</style></head><body>
<h1>Trim items — ${TRIM_ONLY.length} rows × ${trimSummary.length} lots</h1>
<p>Wheel arch moulding, wheel arch liner, and rear light strip / tailgate garnish. Trim is named as trim,
never as the panel behind it: a scuffed or missing trim piece on straight metal is the TRIM item, not the
wing, quarter or tailgate. Each sheet saves a <b>complete</b> <code>ground-truth.json</code> — every label
the lot already has is kept.</p>
<table><thead><tr><th>Lot</th><th>Trim rows</th><th>Already stated</th><th>Photos</th></tr></thead><tbody>
${trimSummary.map((s) => `<tr><td><a href="${s.lot}.html">${s.lot}</a></td><td>${s.rows}</td><td>${s.done}</td><td>${s.photos}</td></tr>`).join('\n')}
</tbody></table>
<p><a href="../index.html">← the full sheets</a></p></body></html>
`;
writeFileSync(resolve(TRIM_OUT, 'index.html'), trimIdx);
console.log(`trim-only → _cc/labelling/trim/index.html (${trimSummary.length} lots × ${TRIM_ONLY.length} rows = ${trimSummary.reduce((n, s) => n + s.rows, 0)} rows, ${trimSummary.reduce((n, s) => n + s.done, 0)} stated)`);
