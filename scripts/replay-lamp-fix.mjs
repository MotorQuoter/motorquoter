// CB7 regression harness — replays the 15 archived probe exports
// (test-results/probe/) through the OLD parts path (frozen pre-fix reference,
// inlined below) and the NEW path (imported from lib/parts.mjs — the literal
// shipped functions; tested path = shipped path).
//
// Assertions per run (approved 12 Jun):
//   (i)   tier-2 → exactly one _lampMandated priced row in gated output;
//         paired verdict iv===true → price >= band (max rule), else price === band (Q1 clamp)
//   (ii)  parts_sum equals the parts-column sum to the penny (A2)
//   (iii) lamp_inserted / lamp_delta match the final gated rows (A3)
//   (iv)  totals match the fixture table below; OLD path must reproduce the
//         archived ledger totals (validates inputs + replay)
//
// Fixture expectations (Vincent, 12 Jun — BL75 F1 £2,885 per rule-B ruling):
// see RUNS table. Exit 1 on any failure.
//
// Run: node scripts/replay-lamp-fix.mjs

import fs from 'node:fs';
import {
  isLampLine, normName, sumPartsRealistic, lampVerdictFor,
  reconcileParts, applyVisibilityGate, finalizeLampInstrumentation,
} from '../lib/parts.mjs';

// ---------- OLD PATH — frozen pre-fix reference (route.js as of core-slots 0c690f6) ----------
function oldReconcile(parts, lampResult) {
  if (!lampResult?.tier2Fired || !lampResult.lampAllowance) {
    return { parts, allowanceParts: [] };
  }
  const band = lampResult.lampAllowance;
  const lampCount = lampResult.lampCount ?? 1;
  const lampIndices = [];
  parts.forEach((p, i) => { if (isLampLine(p.name)) lampIndices.push(i); });
  let workParts = [...parts];
  const allowanceParts = [];
  if (lampCount === 2) {
    if (lampIndices.length >= 1) {
      const idx0 = lampIndices[0];
      const cost0 = workParts[idx0].used ?? workParts[idx0].oem ?? 0;
      const effective0 = Math.max(cost0, band);
      workParts = workParts.map((item, i) => i === idx0 ? { ...item, oem: null, used: effective0 } : item);
      if (lampIndices.length >= 2) {
        for (let n = 1; n < lampIndices.length; n++) {
          allowanceParts.push({ name: workParts[lampIndices[n]].name, action: 'replace', used: band, _allowance: true });
        }
        const toRemove = new Set(lampIndices.slice(1));
        workParts = workParts.filter((_, i) => !toRemove.has(i));
      } else {
        allowanceParts.push({ name: 'Front headlamp', action: 'replace', used: band, _allowance: true });
      }
    } else {
      const labourIdx = workParts.findIndex(p => /labour|paint|prep/i.test(p.name));
      const at = labourIdx >= 0 ? labourIdx : workParts.length;
      workParts = [...workParts.slice(0, at), { name: 'Front headlamp', action: 'replace', oem: null, used: band, _inserted: true }, ...workParts.slice(at)];
      allowanceParts.push({ name: 'Front headlamp', action: 'replace', used: band, _allowance: true });
    }
  } else {
    if (lampIndices.length >= 1) {
      const idx = lampIndices[0];
      const modelCost = workParts[idx].used ?? workParts[idx].oem ?? 0;
      const effective = Math.max(modelCost, band);
      workParts = workParts.map((item, i) => i === idx ? { ...item, oem: null, used: effective } : item);
    } else {
      const labourIdx = workParts.findIndex(p => /labour|paint|prep/i.test(p.name));
      const at = labourIdx >= 0 ? labourIdx : workParts.length;
      workParts = [...workParts.slice(0, at), { name: 'Front headlamp', action: 'replace', oem: null, used: band, _inserted: true }, ...workParts.slice(at)];
    }
  }
  return { parts: workParts, allowanceParts };
}

function oldGate(reconciledParts, costedParts) {
  if (costedParts.length === 0 && reconciledParts.filter(p => !p._allowance).length > 0) {
    return reconciledParts;
  }
  return reconciledParts.filter(rp => {
    if (rp._allowance) return true;
    const verdict = costedParts.find(cp => normName(cp.partName) === normName(rp.name));
    if (!verdict) return true;
    if (verdict._labourSafe) return true;
    if (verdict.independentlyVisible === true) return true;
    return false;
  });
}

// ---------- Fixture table: [export path, archived (old) total, expected new total] ----------
// null archived/expected = excluded/discarded run, replayed for behaviour only.
const RUNS = [
  ['SF69YBB/claude-fable-5/run-1',           null, null],  // DISCARDED — truncation, no parts data
  ['SF69YBB/claude-fable-5/run-2',           null, null],  // EXCLUDED — lamp path dead; old === new asserted
  ['SF69YBB/claude-fable-5/run-3',           4500, 4650],
  ['SF69YBB/claude-fable-5/run-4',           3975, 4125],
  ['SF69YBB/claude-fable-5/run-5',           4195, 4345],
  ['SF69YBB/claude-opus-4-8/run-1',          4120, 4470],
  ['SF69YBB/claude-opus-4-8/run-2',          3200, 3550],
  ['SF69YBB/claude-opus-4-8/run-3',          3730, 4080],
  ['BL75JAU/claude-fable-5/run-1',           2460, 2885],  // rule B: iv=true lamp kept at max(425, 350)
  ['BL75JAU/claude-fable-5/run-2',           3475, 3475],
  ['BL75JAU/claude-fable-5/run-3',           3100, 3450],  // lamps=1 shape
  ['BL75JAU/claude-opus-4-8/run-0-excluded', 3170, 3520],
  ['BL75JAU/claude-opus-4-8/run-1',          3145, 3145],
  ['BL75JAU/claude-opus-4-8/run-2',          3245, 3595],
  ['BL75JAU/claude-opus-4-8/run-3',          3045, 3045],
];

// Mute lib log lines during replay so the results table stays readable.
function quiet(fn) {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = log; console.error = err; }
}

let failures = 0;
const fail = (run, msg) => { failures++; console.error(`  FAIL ${run}: ${msg}`); };
const rows = [];

for (const [rel, archived, expected] of RUNS) {
  const j = JSON.parse(fs.readFileSync(`test-results/probe/${rel}.json`, 'utf8'));
  const rawParts = j.rawParts || [];
  const costedParts = j.costedParts || [];
  const lampResult = j.lampResult || null;
  if (!rawParts.length) {
    rows.push([rel, '—', '—', '—', 'no parts data (skipped)']);
    continue;
  }

  const { oldSum, gated, finalInstr, allowanceParts } = quiet(() => {
    const o = oldReconcile(rawParts, lampResult);
    const oldSum = sumPartsRealistic(oldGate(o.parts, costedParts));
    const n = reconcileParts(rawParts, lampResult, costedParts);
    const { gatedParts } = applyVisibilityGate(n.parts, costedParts, [...(j.flaggedParts || [])], lampResult);
    const finalInstr = finalizeLampInstrumentation(gatedParts, lampResult);
    return { oldSum, gated: gatedParts, finalInstr, allowanceParts: n.allowanceParts };
  });
  const newSum = sumPartsRealistic(gated);
  const tier2 = !!(lampResult?.tier2Fired && lampResult.lampAllowance);
  const notes = [];

  // (i) exactly one mandated priced row on tier-2; price rule per paired verdict
  const mandated = gated.filter(p => p._lampMandated);
  if (tier2) {
    if (mandated.length !== 1) fail(rel, `(i) expected exactly 1 _lampMandated row, got ${mandated.length}`);
    for (const m of mandated) {
      const v = lampVerdictFor(costedParts, m.name, m._lampOrdinal ?? null);
      if (v && v.independentlyVisible === true) {
        if (!(m.used >= m._band)) fail(rel, `(i) iv=true row priced £${m.used} < band £${m._band}`);
        notes.push(`kept iv=true @£${m.used}`);
      } else {
        if (m.used !== m._band) fail(rel, `(i) iv≠true row must be clamped to band £${m._band}, got £${m.used}`);
        notes.push(`clamped to band £${m._band}`);
      }
    }
  } else {
    if (mandated.length !== 0) fail(rel, `(i) non-tier-2 run has ${mandated.length} mandated row(s)`);
    if (newSum !== oldSum) fail(rel, `(i) non-tier-2 run changed: old £${oldSum} new £${newSum}`);
    notes.push('lamp path inert; old === new');
  }

  // (ii) parts_sum = column sum to the penny (independent re-summation)
  const columnSum = gated.reduce((acc, p) => acc + (p.used ?? p.oem ?? 0), 0);
  if (newSum !== columnSum) fail(rel, `(ii) parts_sum £${newSum} != column sum £${columnSum}`);

  // (iii) instrumentation matches final gated rows (independent recomputation)
  const expDelta = mandated.reduce((acc, p) => acc + ((p.used ?? p.oem ?? 0) - (p._modelLampCost ?? 0)), 0);
  const expInserted = mandated.some(p => p._inserted);
  if (tier2) {
    if (finalInstr.lamp_delta !== expDelta) fail(rel, `(iii) lamp_delta ${finalInstr.lamp_delta} != rows ${expDelta}`);
    if (finalInstr.lamp_inserted !== expInserted) fail(rel, `(iii) lamp_inserted ${finalInstr.lamp_inserted} != rows ${expInserted}`);
  } else if (finalInstr.lamp_delta !== 0 || finalInstr.lamp_inserted !== false || finalInstr.lamp_count !== 0) {
    fail(rel, `(iii) non-tier-2 instrumentation not zeroed: ${JSON.stringify(finalInstr)}`);
  }

  // (iv) totals vs fixture table
  if (archived != null && oldSum !== archived) fail(rel, `(iv) OLD replay £${oldSum} != archived £${archived}`);
  if (expected != null && newSum !== expected) fail(rel, `(iv) NEW £${newSum} != expected £${expected}`);

  rows.push([rel, `£${oldSum}`, `£${newSum}`, expected != null ? `£${expected}` : '—',
    `${notes.join('; ')}; allowance rows: ${allowanceParts.length}`]);
}

console.log('\nrun | old(replay) | new | expected | notes');
for (const r of rows) console.log(r.join(' | '));
console.log(failures === 0 ? `\nALL GREEN — ${rows.length} runs replayed, 0 failures` : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
