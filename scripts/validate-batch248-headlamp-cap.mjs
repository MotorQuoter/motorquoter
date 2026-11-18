// batch 248 B4 (Vincent, 18 Nov) — a missing headlamp counts as a damaged lamp for the pair cap; the surplus-lamp line
// never says "single front corner" on a full-width span. £0, synthetic shapes + the LC72NZV stored row (production data,
// gitignored fixtures/b248/ — skips cleanly without it).
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch248-headlamp-cap.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { reconcileParts, applyVisibilityGate, lampSurplusReason, LAMP_SURPLUS_LIMIT_REASON, LAMP_SURPLUS_CAP_REASON,
  LAMP_PAIR_LIMIT_REASON } from '@/lib/parts.mjs';
import { computeLampResult, damagedHeadlampsSeen } from '../app/api/salvage/assess/route.js';

const lamp = (iv, inst) => ({ panelId: 'HEADLAMP', partName: 'Headlamp', independentlyVisible: iv, zone: 'front', inst });
const view = (...rows) => ({ instanceParts: rows });
const verdict = (iv) => [{ panelId: 'HEADLAMP', partName: 'Headlamp', independentlyVisible: iv, zone: 'front' }];
const modelLamp = (used) => ({ name: 'Headlamp', action: 'replace', oem: null, used, panelId: 'HEADLAMP' });
const LABOUR = { name: 'Labour & paint', action: '—', oem: 1000, used: null };
function chain(lr, iv = true) {
  const cp = verdict(iv), flags = [];
  const r = reconcileParts([modelLamp(350), modelLamp(350), LABOUR], lr, cp, 0, null, lr.lampAllowance, false, lr.lampAllowance);
  const g = applyVisibilityGate(r.parts, cp, flags, lr);
  return { rows: g.gatedParts.filter(p => p.panelId === 'HEADLAMP' || /headlamp/i.test(p.name || '')), flags };
}

test('the pair-cap count (countMissing) counts iv:missing as well as iv:true; the default (fog one-corner) is unchanged', () => {
  const pair = (v) => damagedHeadlampsSeen(v, { countMissing: true });
  assert.equal(pair([view(lamp('missing', 1), lamp('missing', 2))]), 2, 'LC72NZV view 6');
  assert.equal(pair([view(lamp(true, 1), lamp('missing', 2))]), 2);
  assert.equal(pair([view(lamp(true, 1), lamp('na', 2))]), 1, 'CK75ONW run 2: one lamp seen damaged');
  assert.equal(pair([view(lamp(true, 1)), view(lamp('missing', 1))]), 1, 'two views, one lamp each → the per-view maximum, 1');
  assert.equal(pair([view(lamp(false, 1), lamp('na', 2))]), 0);
  // default: damaged only — what the batch 177 P3 fog rule reads, so fog money does not move
  assert.equal(damagedHeadlampsSeen([view(lamp('missing', 1), lamp('missing', 2))]), 0);
  assert.equal(damagedHeadlampsSeen([view(lamp(true, 1), lamp('missing', 2))]), 1);
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  assert.ok(src.includes('frontImpactIsOneCorner(assessment._lampObs?.damageSpan, assessment._damagedHeadlampsSeen)'));
  assert.ok(src.includes('assessment._damagedHeadlampsSeen = _damagedLampsSeen;'));
  assert.ok(src.includes('const _damagedLampsSeen = damagedHeadlampsSeen(perViewResults);'));
});

test('full-width + both lamps missing → lampCount 2, a pair, the second-aperture checklist line; CK75ONW run 2 unchanged', () => {
  const pair = computeLampResult('offside', true, null, null, null, 'full_width', false, 2);
  assert.equal(pair.lampCount, 2);
  assert.ok(pair.checklistEntry2nd, 'pair → both apertures on the checklist');
  const ck = computeLampResult('offside', true, null, null, null, 'full_width', false, 1);
  assert.equal(ck.lampCount, 1, 'one lamp seen damaged, two apertures exposed → still one lamp');
  assert.equal(ck.checklistEntry2nd, null);
});

test('the surplus line: "single front corner" only on a span that is not full-width; Vincent\'s wording on a capped full-width lot', () => {
  assert.equal(LAMP_SURPLUS_CAP_REASON, 'A second headlamp is costed, but only one could be confirmed damaged or missing from these photographs. Strike the line on the ledger if the inspection shows it sound.');
  assert.equal(lampSurplusReason({ spanSource: 'full_width' }), LAMP_SURPLUS_CAP_REASON);
  assert.equal(lampSurplusReason({ spanSource: 'full_width-defaulted' }), LAMP_SURPLUS_CAP_REASON);
  assert.equal(lampSurplusReason({ spanSource: 'single_corner' }), LAMP_SURPLUS_LIMIT_REASON);
  assert.ok(!/single front corner/.test(LAMP_SURPLUS_CAP_REASON));
  // end to end through the money chain
  const capped = computeLampResult('offside', true, null, null, null, 'full_width', false, 1);
  const c = chain(capped);
  assert.equal(c.rows.filter(r => r._lampSurplus).length, 1);
  assert.equal(c.flags.find(f => f._lampSurplusLimit).reason, LAMP_SURPLUS_CAP_REASON);
  const corner = computeLampResult('offside', true, null, null, null, 'single_corner', false, 1);
  assert.equal(chain(corner).flags.find(f => f._lampSurplusLimit).reason, LAMP_SURPLUS_LIMIT_REASON);
});

// ── LC72NZV stored row ──
const FIX_PATH = 'fixtures/b248/lc72nzv-row.json';
const ROW = existsSync(FIX_PATH) ? JSON.parse(readFileSync(FIX_PATH, 'utf8')) : null;
const SKIP = ROW ? false : `${FIX_PATH} is not on disk (production-row data, kept out of git) — fixture test skipped`;
if (SKIP) console.log(`SKIP: ${SKIP}`);

test('LC72NZV: stored lamp observation + the view-6 missing pair → two lamps at band, pair wording, no "single front corner"', { skip: SKIP }, () => {
  const a = ROW.assessment, o = a._lampObs;
  assert.equal(a._lampResult.lampCount, 1, 'stored run: capped to one lamp');
  assert.equal(a._damagedHeadlampsSeen, 0);
  // the per-view instances are not stored on the row; the run log records view 6 as HEADLAMP inst 1 + 2, both iv=missing
  const seen = damagedHeadlampsSeen([view(lamp('missing', 1), lamp('missing', 2))], { countMissing: true });
  const lr = computeLampResult(o.struckSide, o.apertureExposed, null, null, null, o.damageSpan, o._spanDefaulted === true, seen);
  assert.equal(lr.lampCount, 2);
  assert.ok(lr.checklistEntry2nd);
  // The stored surplus flag is raised only on a gate verdict of iv:true (parts.mjs, the _lampSurplus branch), so the run's
  // HEADLAMP verdict was true. Both verdicts are checked: true → the pair passes as costed rows with no limit line; missing →
  // the batch 111 pair limit line. Neither path says "single front corner" and neither has a surplus row.
  for (const iv of [true, 'missing']) {
    const c = chain(lr, iv);
    assert.equal(c.rows.length, 2, `iv=${iv}`);
    assert.ok(c.rows.every(r => r.used === a._lampResult.lampAllowance), 'both at the £350 band — the money is unchanged');
    assert.equal(c.rows.filter(r => r._lampSurplus).length, 0, 'no surplus row');
    assert.ok(c.rows.every(r => r._lampPair), 'both are pair rows');
    assert.ok(c.flags.every(f => !/single front corner/.test(f.reason || '')));
    if (iv === 'missing') assert.ok(c.flags.some(f => f.reason === LAMP_PAIR_LIMIT_REASON), 'pair wording');
    else assert.equal(c.flags.filter(f => f._lampSurplusLimit).length, 0);
  }
});
