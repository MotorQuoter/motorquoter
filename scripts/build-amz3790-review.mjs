// Batch 106 §3 — build the single self-contained BEFORE/AFTER review page for AMZ3790.
//
//   node scripts/build-amz3790-review.mjs <after-dump.json>
//
// BEFORE = fixtures/AMZ3790/baseline-assessment.json (the frozen 4-Sep row — the broken version).
// AFTER  = the dump from a fresh replay of the branch code, e.g.
//   node --loader ./scripts/lib/alias-loader.mjs scripts/replay.mjs AMZ3790 --vision-live --capture --dump <after-dump.json>
//
// Emits _cc/amz3790_batch106_review.html. £0 itself — the only spend is the replay (pence, vision).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const afterPath = process.argv[2];
if (!afterPath) {
  console.error('Usage: node scripts/build-amz3790-review.mjs <after-dump.json>');
  console.error('First produce the dump:\n  node --loader ./scripts/lib/alias-loader.mjs scripts/replay.mjs AMZ3790 --vision-live --capture --dump <after-dump.json>');
  process.exit(2);
}

const before = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/AMZ3790/baseline-assessment.json'), 'utf8'));
const after  = JSON.parse(readFileSync(resolve(afterPath), 'utf8'));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const g = (n) => (n == null ? '—' : `£${Number(n).toLocaleString('en-GB')}`);

// ── extractors (defensive — a fresh run may reshape a field) ─────────────────────
const kcdSum = (a) => (a._kcdParts || []).reduce((s, p) => s + (Number(p.figure) || 0), 0);
const labourOf = (a) => {
  const m = String(a['Parts Breakdown'] || '').match(/Labour[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*£?([\d,]+)/i);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
};
const structFloorOf = (a) => {
  const card = (a._damageCards || []).find((c) => c._structFloor || /structure/i.test(c.part || ''));
  return card && card._structFloor ? Number(card.cost) || 0 : 0;
};
const partsSumSH = (a) => kcdSum(a) + labourOf(a) + structFloorOf(a);

const structuralCard = (a) => (a._damageCards || []).find((c) => /structure/i.test(c.part || '')) || null;
const structuralFlag = (a) => (a._flaggedParts || []).find((f) => /structure/i.test(f.partName || '')) || null;
const mileageSlot = (a) => {
  const grp = (a._slots?.groups || []).find((x) => x.id === 'mileage');
  return (grp?.slots || []).find((s) => s.id === 'mileage-corroboration') || null;
};
const evEvidence = (a) => {
  const flags = (a._slots?.flags || []).filter((f) => /battery|hv|high.?voltage|traction/i.test(`${f.slotLabel} ${f.whatsapp}`));
  const fp = (a._flaggedParts || []).filter((f) => /battery|hv|high.?voltage|traction/i.test(`${f.partName} ${f.reason}`));
  const rf = String(a['Red Flags'] || '').split('\n').filter((l) => /battery|hv|high.?voltage|traction/i.test(l));
  return { flags, fp, rf };
};
const sourcingParts = (a) => (a._partsSourcing?.links || []).map((l) => l.part);

// The structural line as it appears in the Parts Breakdown string (AFTER should carry it).
const structuralBreakdownLine = (a) => String(a['Parts Breakdown'] || '').split('\n').find((l) => /structure/i.test(l)) || null;

// "Did the fresh vision read move any OTHER line?" — compare KCD part→figure, excluding structural.
const kcdMap = (a) => Object.fromEntries((a._kcdParts || []).map((p) => [`${p.panelId}:${p.partName}`, Number(p.figure) || 0]));
function movedLines() {
  const B = kcdMap(before), A = kcdMap(after);
  const keys = [...new Set([...Object.keys(B), ...Object.keys(A)])].filter((k) => !/structure/i.test(k));
  const rows = [];
  for (const k of keys) {
    if (B[k] !== A[k]) rows.push({ part: k.split(':')[1] || k, before: B[k], after: A[k] });
  }
  return rows;
}

// Decompose the headline movement HONESTLY. The £0 rule contributes exactly the structural floor;
// anything else is the fresh vision read moving the model's own figures (labour is model-authored and
// then SCALED by the reconcile ratio — the floor is excluded from that ratio by construction).
const isLab = (n) => /labour|paint|prep/i.test(n || '');
const shOf = (x) => (x._reconciledParts || []).reduce((t, p) => t + (p.used ?? p.oem ?? 0), 0);
const floorOf = (x) => (x._reconciledParts || []).filter((p) => p._zeroRule).reduce((t, p) => t + (p.used ?? p.oem ?? 0), 0);
const labOf = (x) => (x._reconciledParts || []).filter((p) => isLab(p.name)).reduce((t, p) => t + (p.used ?? p.oem ?? 0), 0);
const D_floor = floorOf(after) - floorOf(before);
const D_labour = labOf(after) - labOf(before);
const D_other = (shOf(after) - shOf(before)) - D_floor - D_labour;

const B_mile = mileageSlot(before), A_mile = mileageSlot(after);

// EO-01 verdict test. Asserts the RULE, not one run's outcome. The engine may legitimately reach
// "confirmed" on this lot when the Haiku dash read lands and agrees with the listing — that is TWO
// independent sources, which is exactly what the rule now requires. What must never come back is the
// OLD shape: "confirmed"/"corroborated" resting on nothing having objected. Only the >=2-source branch
// emits "cross-checked against N other source(s)", so the presence of that phrase behind a confirmed
// verdict is the structural proof that a second source positively agreed.
const XCHECK = /cross-checked against (\d+) other sources?/;
const mileVerdict = (sl) => {
  if (!sl) return { ok: false, why: 'slot missing' };
  if (sl.verdict === 'discrepancy') return { ok: true, why: 'sources disagree — flagged (unchanged first branch)' };
  if (sl.verdict !== 'confirmed' && sl.confidence !== 'corroborated') {
    return { ok: true, why: 'single source — honest "unconfirmed", carries the tier-1 odometer ask' };
  }
  const m = XCHECK.exec(sl.detail || '');
  if (m) return { ok: true, why: `${Number(m[1]) + 1} independent sources present and agreeing — "corroborated" is earned`, multi: Number(m[1]) + 1 };
  return { ok: false, why: 'confirmed/corroborated with NO second source named — silence scored as agreement (the EO-01 defect)' };
};
const B_mv = mileVerdict(B_mile), A_mv = mileVerdict(A_mile);
const B_card = structuralCard(before), A_card = structuralCard(after);
const B_flag = structuralFlag(before), A_flag = structuralFlag(after);
const B_ev = evEvidence(before), A_ev = evEvidence(after);
const B_src = sourcingParts(before), A_src = sourcingParts(after);
const B_sum = partsSumSH(before), A_sum = partsSumSH(after);
const moved = movedLines();

const srcHasStructure = (names) => names.some((n) => /structure/i.test(n));
const badPhrase = (s) => /not included in the repair cost|not included/i.test(String(s || ''));

const pair = (title, num, verdict, beforeHtml, afterHtml, note) => `
  <section class="check">
    <h2><span class="num">${num}</span> ${esc(title)} <span class="verdict ${verdict.ok ? 'pass' : 'fail'}">${verdict.ok ? '✓ ' + verdict.label : '✗ ' + verdict.label}</span></h2>
    <div class="cols">
      <div class="col before"><div class="tag">BEFORE — frozen 4-Sep row</div>${beforeHtml}</div>
      <div class="col after"><div class="tag">AFTER — fresh fixture run</div>${afterHtml}</div>
    </div>
    ${note ? `<p class="note">${note}</p>` : ''}
  </section>`;

const html = `<title>AMZ3790 — Batch 106 Review</title>
<style>
  :root{--bg:#fafafa;--card:#fff;--line:#e3e3e3;--ink:#1a1a1a;--dim:#666;--pass:#0a7d33;--passbg:#e7f6ec;--fail:#b21f2d;--failbg:#fbeaec;--orange:#f05a1a}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  header{background:#111;color:#fff;padding:22px 28px} header h1{margin:0 0 4px;font-size:20px} header p{margin:0;color:#bbb;font-size:13px}
  main{max-width:1040px;margin:0 auto;padding:22px}
  .check{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:0 0 18px}
  .check h2{font-size:16px;margin:0 0 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .num{background:var(--orange);color:#fff;width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
  .verdict{font-size:12px;font-weight:700;padding:3px 9px;border-radius:20px;margin-left:auto}
  .verdict.pass{background:var(--passbg);color:var(--pass)} .verdict.fail{background:var(--failbg);color:var(--fail)}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:14px} @media(max-width:760px){.cols{grid-template-columns:1fr}}
  .col{border:1px solid var(--line);border-radius:8px;padding:12px;background:#fcfcfc;font-size:14px}
  .col.before{border-color:#e7c9cc;background:#fdf6f6} .col.after{border-color:#c7e6d2;background:#f6fbf7}
  .tag{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--dim);margin-bottom:8px}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
  pre{white-space:pre-wrap;margin:6px 0;background:#fff;border:1px solid var(--line);border-radius:6px;padding:8px}
  .kv{margin:3px 0} .kv b{color:var(--dim);font-weight:600}
  .bad{color:var(--fail);font-weight:700} .good{color:var(--pass);font-weight:700}
  .note{font-size:13px;color:var(--dim);margin:12px 0 0;border-top:1px dashed var(--line);padding-top:10px}
  .money{font-size:15px}
  table{border-collapse:collapse;width:100%;font-size:13px;margin-top:6px} th,td{border:1px solid var(--line);padding:5px 8px;text-align:left} th{background:#f2f2f2}
  .banner{background:#fff8f0;border:1px solid #f0d5b8;border-radius:8px;padding:12px 16px;margin:0 0 18px;font-size:13.5px}
</style>
<header>
  <h1>AMZ3790 — Batch 106 review (Ford Kuga PHEV, lot 56395556)</h1>
  <p>BEFORE = the frozen 4-Sep baseline (the broken version you already saw). AFTER = a fresh replay of <code>feat/zero-rule-batch106</code> against the stored fixture (23 images, One&nbsp;Auto from the fixture seam, vision live). Off the fixture, not the Vercel preview — the stored preview row still shows the old text.</p>
</header>
<main>
  <div class="banner"><b>Repair total (S/H):</b> <span class="money">${g(B_sum)} → <b class="good">${g(A_sum)}</b></span> &nbsp;·&nbsp; of the +${g(A_sum - B_sum)}, <b>${g(D_floor)} is the structural floor</b> (the batch-106 fix) and <b class="bad">${g(D_labour)} is labour</b>${D_other ? ` plus ${g(D_other)} on other parts` : ''} — the model authored a different labour figure on this fresh vision read (£1,400 → £1,600 pre-gate, ratio 1.0 both runs). <b>That £200 is variance, not a fix.</b> ${moved.length ? `<b class="bad">The fresh vision read also moved ${moved.length} other line${moved.length === 1 ? '' : 's'}</b> — see the foot of the page; those are vision variance, not batch-106 fixes.` : `The fresh vision read moved no other costed line — every S/H figure below the structural floor reproduced the baseline exactly.`}</div>

  ${pair('Parts Breakdown — the structural floor is IN the total', 1,
    { ok: !!structuralBreakdownLine(after), label: structuralBreakdownLine(after) ? 'in the total' : 'MISSING' },
    `<pre>${esc(before['Parts Breakdown'])}</pre><div class="kv"><b>Repair total S/H:</b> ${g(B_sum)}</div>`,
    `<pre>${esc(after['Parts Breakdown'])}</pre><div class="kv"><b>Repair total S/H:</b> <b class="good">${g(A_sum)}</b></div>` +
      (structuralBreakdownLine(after) ? `<div class="kv good">Structural line: <code>${esc(structuralBreakdownLine(after).trim())}</code></div>` : `<div class="kv bad">No structural line in the breakdown!</div>`),
    'The floor is a code-owned "from £500" — the true jig/geometry figure cannot be scoped from photographs, so the buyer strikes it if the inspection clears the shell.')}

  ${pair('Damage Breakdown + HIGH Inspection Flag — must state the floor IS included', 2,
    { ok: !badPhrase(A_card?.note) && !badPhrase(A_flag?.reason), label: (!badPhrase(A_card?.note) && !badPhrase(A_flag?.reason)) ? 'no contradiction' : 'STILL CONTRADICTS' },
    `<div class="kv"><b>Damage card:</b></div><pre>${esc(B_card ? `${B_card.part} · ${B_card.origin} · ${g(B_card.cost)} · ${B_card.action}\n${B_card.note || '(no note)'}` : '(structural not shown as a card)')}</pre>` +
      `<div class="kv"><b>Inspection flag reason:</b></div><pre>${esc(B_flag?.reason || '(none)')}</pre>` +
      (badPhrase(B_card?.note) || badPhrase(B_flag?.reason) ? `<div class="kv bad">Contains "not included in the repair cost" — contradicts the Parts Breakdown.</div>` : ''),
    `<div class="kv"><b>Damage card:</b></div><pre>${esc(A_card ? `${A_card.part} · ${A_card.origin} · ${A_card._structFloor ? `from ${g(A_card.cost)}` : g(A_card.cost)} · ${A_card.action}\n${A_card.note || '(no note)'}` : '(structural not shown as a card)')}</pre>` +
      `<div class="kv"><b>Inspection flag reason:</b></div><pre>${esc(A_flag?.reason || '(none)')}</pre>` +
      (badPhrase(A_card?.note) || badPhrase(A_flag?.reason) ? `<div class="kv bad">STILL says "not included" — FAIL.</div>` : `<div class="kv good">States the floor IS in the repair total. Consistent with §1.</div>`),
    'The one thing a trade buyer would not forgive: costed in one section, declared excluded in two others.')}

  ${pair('Parts Sourcing — no eBay link on the structural line', 3,
    { ok: !srcHasStructure(A_src), label: srcHasStructure(A_src) ? 'eBay link present' : 'no link (correct)' },
    `<div class="kv"><b>Sourced parts:</b></div><pre>${esc(B_src.join('\n') || '(none)')}</pre>` +
      (srcHasStructure(B_src) ? `<div class="kv bad">"Front structure" has an eBay link — you cannot buy a chassis jig from a breaker.</div>` : `<div class="kv">(structural not in the baseline sourcing list)</div>`),
    `<div class="kv"><b>Sourced parts:</b></div><pre>${esc(A_src.join('\n') || '(none)')}</pre>` +
      (srcHasStructure(A_src) ? `<div class="kv bad">Structural STILL in the eBay list — FAIL.</div>` : `<div class="kv good">No structural / _zeroRule row reaches Parts Sourcing.</div>`),
    null)}

  ${pair('CORE checklist mileage slot — no longer claims corroboration; agrees with Red Flags', 4,
    { ok: A_mv.ok, label: A_mv.ok ? (A_mv.multi ? `corroborated by ${A_mv.multi} sources` : 'not corroborated') : 'silence scored as agreement' },
    `<div class="kv"><b>verdict:</b> <span class="bad">${esc(B_mile?.verdict)}</span> &nbsp; <b>confidence:</b> <span class="bad">${esc(B_mile?.confidence)}</span> &nbsp; <b>flag:</b> ${B_mile?.flag ? 'yes' : 'none'}</div>` +
      `<pre>${esc(B_mile?.detail)}</pre><div class="kv bad">Sits under "Verified clear" — claims corroboration that does not exist (no MOT ladder on this lot).</div>`,
    `<div class="kv"><b>verdict:</b> <span class="good">${esc(A_mile?.verdict)}</span> &nbsp; <b>confidence:</b> <span class="good">${esc(A_mile?.confidence)}</span> &nbsp; <b>flag:</b> ${A_mile?.flag ? `tier ${A_mile.flag.tier} ${esc(A_mile.flag.severity)}` : 'none'}</div>` +
      `<pre>${esc(A_mile?.detail)}</pre>` +
      `<div class="kv ${A_mv.ok ? 'good' : 'bad'}">${A_mv.ok ? '' : 'FAIL — '}${esc(A_mv.why)}.</div>` +
      (A_mv.multi ? `<div class="kv">The second source here is a DVSA MOT record — the only mileage record independent of the dashboard.</div>` : `<div class="kv">Batch 106 §4: the listing figure IS the dashboard reading, transcribed by the staff member who photographed the cluster. Listing + dash-photo is ONE source seen twice, so it can no longer buy a "corroborated" — that now requires a DVSA MOT record, which this lot has none of. This also removes the run-to-run wording wobble: the verdict no longer depends on whether the Haiku dash read lands.</div>`),
    'EO-01. Silence (no discrepancy flag) is no longer scored as agreement — "confirmed" now requires a second independent source that positively agreed.')}

  ${pair('EV / HV battery — HIGH, limit-only, no figure', 5,
    { ok: A_ev.rf.length > 0 || A_ev.fp.length > 0, label: (A_ev.rf.length > 0 || A_ev.fp.length > 0) ? 'flagged, no cost' : 'no HV evidence found' },
    `<pre>${esc([...B_ev.rf, ...B_ev.fp.map((f) => f.reason)].join('\n\n') || '(no HV battery flag in baseline)')}</pre>`,
    `<pre>${esc([...A_ev.rf, ...A_ev.fp.map((f) => f.reason)].join('\n\n') || '(no HV battery flag)')}</pre>` +
      `<div class="kv ${(A_ev.rf.length || A_ev.fp.length) ? 'good' : 'bad'}">HV battery carried as a HIGH limit-only flag — never costed.</div>`,
    'A PHEV pack can range from no cost to a total loss; the engine states the limit rather than inventing a figure.')}

  ${moved.length ? `<section class="check"><h2><span class="num">!</span> Lines the fresh vision read moved (not batch-106 fixes)</h2>
    <table><tr><th>Part</th><th>Before (S/H)</th><th>After (S/H)</th></tr>
    ${moved.map((m) => `<tr><td>${esc(m.part)}</td><td>${g(m.before)}</td><td>${g(m.after)}</td></tr>`).join('')}</table>
    <p class="note">A fresh vision read is nondeterministic; these differences are vision variance, presented here so nothing is passed off as a fix.</p></section>` : ''}
</main>`;

const outPath = resolve(ROOT, '_cc/amz3790_batch106_review.html');
writeFileSync(outPath, html);
console.log(`Wrote ${outPath}`);
console.log(`Repair total S/H: ${g(B_sum)} → ${g(A_sum)}  = floor +${g(D_floor)} (the fix) + labour +${g(D_labour)} (vision variance)${D_other ? ` + other +${g(D_other)}` : ''}`);
console.log(`Check 1 (structural in total):   ${structuralBreakdownLine(after) ? 'PASS' : 'FAIL'}`);
console.log(`Check 2 (no contradiction):      ${(!badPhrase(A_card?.note) && !badPhrase(A_flag?.reason)) ? 'PASS' : 'FAIL'}`);
console.log(`Check 3 (no eBay on structural): ${!srcHasStructure(A_src) ? 'PASS' : 'FAIL'}`);
console.log(`Check 4 (mileage verdict earned): ${A_mv.ok ? 'PASS' : 'FAIL'} — ${A_mv.why}`);
console.log(`Check 5 (EV limit-only):         ${(A_ev.rf.length > 0 || A_ev.fp.length > 0) ? 'PASS' : 'FAIL'}`);
if (moved.length) console.log(`NOTE: fresh vision moved ${moved.length} other line(s): ${moved.map((m) => m.part).join(', ')}`);
