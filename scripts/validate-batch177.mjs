// validate-batch177.mjs — batch 177: SV24YCN fixes (P1–P5) and the M1 measurement switch (off). £0, pure, no model calls.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch177.mjs
// Unit cases come from SV24YCN's stored row (_cc/scratch/b176/row-800068f0.json, Vincent's 22 Sep preview run on 8032d99)
// where it is on disk; every rule is also checked on its own, so the validator still means something without it.
import { readFileSync, existsSync } from 'fs';
import { panelOwnReadsConfirm, presenceMissingReason, M1_COST_DISPUTED, M1_DISPUTED_COSTED_REASON } from '@/app/api/salvage/assess/route.js';
import { dropNotVisibleForCharged, seedChecklistFromFlags, buildBuyerFlags } from '@/lib/parts.mjs';
import { applyFogBumperRule, frontImpactIsOneCorner, FOG_SECOND_ONE_CORNER_LINE } from '@/lib/partsCompleteness.mjs';
import { buildMileageCorroborationSlot, noMotUnderThree } from '@/lib/mileageCorroboration.mjs';
import { PANEL_CLASS, PANEL_BEHAVIOUR } from '@/lib/panelEnum.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ROW_PATH = new URL('../_cc/scratch/b176/row-800068f0.json', import.meta.url);
const SV = existsSync(ROW_PATH) ? JSON.parse(readFileSync(ROW_PATH, 'utf8')).assessment : null;
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── P1 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- P1: the §4 bumper-off note respects the panel\'s own evidence --');
{
  const cps = [{ panelId: 'FRONT_WING', _severeOverride: true }, { panelId: 'REAR_QUARTER' }];
  ok('SEVERE override → confirmed (severe-override)', panelOwnReadsConfirm('FRONT_WING', cps, null) === 'severe-override');
  ok('probe consistent-with-claim → confirmed (probe)', panelOwnReadsConfirm('REAR_QUARTER', cps, { panels: [{ panelId: 'REAR_QUARTER', verdict: 'consistent-with-claim' }] }) === 'probe');
  ok('thin evidence (no override, probe not consistent) → null: the note still fires', panelOwnReadsConfirm('REAR_QUARTER', cps, { panels: [{ panelId: 'REAR_QUARTER', verdict: 'cannot-determine' }] }) === null);
  ok('route: the §4 loop skips a confirmed panel before it builds the note',
    route.indexOf('const _confirmedBy = panelOwnReadsConfirm(panelId, coreObs.costedParts, assessment._attributionProbe);') > 0
    && route.indexOf('const _confirmedBy = panelOwnReadsConfirm(') < route.indexOf('reason: bumperLimitReason(end, panelWord, _why)'));
  if (SV) {
    ok('(SV24YCN) the stored run carried the wing note', SV._flaggedParts.some((f) => f.panelId === 'FRONT_WING' && f._bumperOffLimit));
    ok('(SV24YCN) the stored probe says the wing is consistent-with-claim → now confirmed, no note', panelOwnReadsConfirm('FRONT_WING', [], SV._attributionProbe) === 'probe');
  }
}

// ── P2 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- P2: a not-visible floor flag goes when the panel is charged --');
{
  const flags = [{ panelId: 'FOG_LAMP', _amalgNotVisible: true }, { panelId: 'SILL', _amalgNotVisible: true }, { panelId: 'FOG_LAMP', _fogCheck: true }];
  const rows = [{ panelId: 'FOG_LAMP', name: 'Front fog lamp', action: 'replace', used: 50 }];
  const gone = dropNotVisibleForCharged([flags], rows);
  ok('the FOG_LAMP not-visible flag goes; the uncharged SILL one and the non-floor fog flag stay', gone.length === 1 && flags.length === 2 && flags.every((f) => !(f._amalgNotVisible && f.panelId === 'FOG_LAMP')));
  ok('route: runs once the ledger is final, before the checklist seed', route.indexOf('dropNotVisibleForCharged([assessment._flaggedParts, coreObs.flaggedParts], gatedParts)') > route.indexOf('assessment._reconciledParts = gatedParts;')
    && route.indexOf('dropNotVisibleForCharged([assessment._flaggedParts') < route.indexOf('seedChecklistFromFlags(checklistText, buyerFlags'));
  if (SV) {
    const f2 = clone(SV._flaggedParts);
    const d = dropNotVisibleForCharged([f2], SV._reconciledParts);
    ok('(SV24YCN) exactly the FOG_LAMP "not clear" flag goes (two fogs are charged)', d.length === 1 && d[0].panelId === 'FOG_LAMP');
    ok('(SV24YCN) the other not-visible flags (side structure, sill, side skirt) stay', ['SIDE_STRUCTURE', 'SILL', 'SIDE_SKIRT'].every((p) => f2.some((f) => f.panelId === p && f._amalgNotVisible)));
  }
}

// ── P3 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- P3: the front fog count follows the corners struck --');
{
  ok('one corner = span not full_width AND < 2 damaged headlamps', frontImpactIsOneCorner('single_corner', 1) === true && frontImpactIsOneCorner('single_corner', 0) === true);
  ok('full width if either test says so', frontImpactIsOneCorner('full_width', 1) === false && frontImpactIsOneCorner('single_corner', 2) === false && frontImpactIsOneCorner(null, 0) === false);
  const seed = { used: 50, oem: null };
  const one = applyFogBumperRule({ costedParts: [], frontBumperGone: true, frontBumperConfirmed: true, fogSeed: seed, frontOneCorner: true });
  ok('bumper gone + one corner → ONE front fog seeded', one.costedToAdd.length === 1 && one.costedToAdd[0].used === 50);
  ok('…and the second-fog line, verbatim', one.flagsToAdd.length === 1 && one.flagsToAdd[0].reason === 'Second front fog lamp — confirm it is present and undamaged.' && FOG_SECOND_ONE_CORNER_LINE === one.flagsToAdd[0].reason);
  const two = applyFogBumperRule({ costedParts: [], frontBumperGone: true, frontBumperConfirmed: true, fogSeed: seed, frontOneCorner: false });
  ok('bumper gone + full width → TWO (the 31 Jul rule holds)', two.costedToAdd.length === 2 && two.flagsToAdd.length === 0);
  const modelOne = applyFogBumperRule({ costedParts: [{ panelId: 'FOG_LAMP', name: 'Fog lamp', used: 40 }], frontBumperGone: true, frontBumperConfirmed: true, fogSeed: seed, frontOneCorner: true });
  ok('one corner, the model already costed one fog → nothing added, the second is asked about', modelOne.costedToAdd.length === 0 && modelOne.flagsToAdd.length === 1);
  const unconf = applyFogBumperRule({ costedParts: [], frontBumperGone: true, frontBumperConfirmed: false, fogSeed: seed, frontOneCorner: true });
  ok('unconfirmed bumper branch unchanged (flag, no cost)', unconf.costedToAdd.length === 0 && unconf.flagsToAdd[0]._fogUnconfirmedParent === true);
  const rear = applyFogBumperRule({ costedParts: [], rearBumperGone: true, rearBumperConfirmed: true, fogSeed: seed, frontOneCorner: true });
  ok('rear unchanged (one rear fog)', rear.costedToAdd.length === 1 && rear.costedToAdd[0].zone === 'rear' && rear.flagsToAdd.length === 0);
  ok('the checklist carries the line verbatim', seedChecklistFromFlags('1. x', one.flagsToAdd).includes('2. Second front fog lamp — confirm it is present and undamaged.'));
  ok('route: the fog rule gets the one-corner test; the headlamp count is stamped',
    route.includes('frontOneCorner: frontImpactIsOneCorner(assessment._lampObs?.damageSpan, assessment._damagedHeadlampsSeen)') && route.includes('assessment._damagedHeadlampsSeen = _damagedLampsSeen;'));
  if (SV) {
    ok('(SV24YCN) stored span is single_corner; the log shows at most 1 damaged headlamp per view → one corner', SV._lampObs.damageSpan === 'single_corner' && frontImpactIsOneCorner(SV._lampObs.damageSpan, 1));
    const r = applyFogBumperRule({ costedParts: SV._reconciledParts.filter((p) => p.panelId !== 'FOG_LAMP'), frontBumperGone: true, frontBumperConfirmed: true, fogSeed: seed, frontOneCorner: true });
    ok('(SV24YCN) the stored £50 ×2 becomes £50 ×1 + the second-fog line', SV._reconciledParts.filter((p) => p.panelId === 'FOG_LAMP').length === 2 && r.costedToAdd.length === 1 && r.flagsToAdd.length === 1);
  }
}

// ── P4 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- P4: presence checks get their own branch --');
{
  ok('spare wheel wording, verbatim', presenceMissingReason('SPARE_WHEEL', PANEL_CLASS.PRESENCE_CHECK) === 'No spare wheel seen — the well may hold a tyre repair kit; confirm what is supplied.');
  ok('parcel shelf: same shape, its own name', presenceMissingReason('PARCEL_SHELF', PANEL_BEHAVIOUR.PARCEL_SHELF) === 'No parcel shelf seen — confirm what is supplied.');
  ok('EV battery presence keeps the HIGH flag-class branch (not a boot accessory)', presenceMissingReason('EV_BATTERY_PRESENCE', PANEL_CLASS.PRESENCE_CHECK) === null);
  ok('a structural flag-only member keeps HIGH', presenceMissingReason('FRONT_STRUCTURE', PANEL_BEHAVIOUR.FRONT_STRUCTURE) === null);
  ok('route: a presence-check missing vote is LOW; the flag-class branch stays HIGH',
    /weight: 'low', reason: presenceMissingReason\(panelId, effClass\), _flagClassRead: true, _presenceMissing: true/.test(route)
    && route.includes("flaggedParts.push({ panelId, partName, zone, weight: 'high', reason: flagClassReason, _flagClassRead: true });"));
  // The seed's wheel-net rule (batch 158 A3) skips SPARE_WHEEL, as it did when the flag was HIGH — unchanged here.
  const spare = { panelId: 'SPARE_WHEEL', partName: 'Spare wheel', weight: 'low', reason: presenceMissingReason('SPARE_WHEEL', PANEL_CLASS.PRESENCE_CHECK), _presenceMissing: true };
  ok('spare wheel: no checklist line, as before (wheel-net skip)', seedChecklistFromFlags('1. x', [spare]) === '1. x');
  const shelf = { panelId: 'PARCEL_SHELF', partName: 'Parcel shelf', weight: 'low', reason: presenceMissingReason('PARCEL_SHELF', PANEL_CLASS.PRESENCE_CHECK), _presenceMissing: true };
  ok('another presence check: the checklist line is the wording, not "confirm the cosmetic damage extent"', seedChecklistFromFlags('1. x', [shelf]).includes('2. No parcel shelf seen — confirm what is supplied.'));
  if (SV) ok('(SV24YCN) the stored run flagged the spare wheel HIGH (the case)', SV._flaggedParts.some((f) => f.panelId === 'SPARE_WHEEL' && f.weight === 'high'));
}

// ── P5 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- P5: odometer read stored; wording for a car with no MOT yet --');
{
  const vd = (x) => ({ _mileageSourceCount: 1, ...x });
  const agree = buildMileageCorroborationSlot(vd({ _noMotUnder3: true, _photoOdometerAgrees: true }), 14968, 'listing_odometer');
  ok('under 3 + photo agrees → the new wording, verbatim', agree.detail === '14,968 miles — the listing and the dashboard photo agree; no MOT record exists yet (car under 3 years), so nothing independent corroborates it.');
  ok('…still unconfirmed (batch 106: one source)', agree.verdict === 'unconfirmed');
  const differ = buildMileageCorroborationSlot(vd({ _noMotUnder3: true, _photoOdometerAgrees: false }), 14968, 'listing_odometer');
  ok('photo differs / null → today\'s wording', /only mileage source available for this lot; nothing independent corroborates it$/.test(differ.detail));
  const older = buildMileageCorroborationSlot(vd({ _noMotUnder3: false, _photoOdometerAgrees: true }), 14968, 'listing_odometer');
  ok('older car → today\'s wording', /only mileage source available/.test(older.detail));
  ok('route: the photo read is stamped every time, null included', route.includes('assessment._photoOdometer = { value: photoOdometer, raw: _photoOdoRaw };') && route.includes('_photoOdoRaw = raw;'));
  ok('route: agreement is exact; under 3 = no DVSA mileage and < 3 years by registration year (lib helper; the route stays clock-free)',
    route.includes('enrichedVd._photoOdometerAgrees = photoOdometer != null && photoOdometer === _listedNum;')
    && route.includes('enrichedVd._noMotUnder3 = noMotUnderThree(enrichedVd.year, _dvsaMileagePresent);')
    && noMotUnderThree('2024', false, 2026) === true && noMotUnderThree('2023', false, 2026) === false && noMotUnderThree('2025', true, 2026) === false
    && route.includes(".replace(/,/g, '').match(/\\d+/); return m ? parseInt(m[0], 10) : NaN; })();"));
  if (SV) ok('(SV24YCN) the stored slot is today\'s single-source wording (the case)', JSON.stringify(SV._slots).includes('14,968 miles from the listing description — this is the only mileage source available for this lot'));
}

// ── M1 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- M1: the disputed-panel costing switch is OFF --');
{
  ok('M1 is off by default (MQ_M1_COST_DISPUTED unset)', process.env.MQ_M1_COST_DISPUTED === 'on' || M1_COST_DISPUTED === false);
  ok('the switch reads only MQ_M1_COST_DISPUTED === "on"', route.includes("export const M1_COST_DISPUTED = process.env.MQ_M1_COST_DISPUTED === 'on';"));
  ok('the costing block runs only behind the switch', route.includes('    if (M1_COST_DISPUTED) {'));
  ok('the note, verbatim', M1_DISPUTED_COSTED_REASON('Front door') === 'Photographs disagree on the Front door — costed on the views that show damage; remove the line if it is sound on inspection.');
  const a = { _flaggedParts: [{ panelId: 'FRONT_DOOR', _amalgDisagree: true, _m1CostedDisputed: true }], _preGateParts: [{ panelId: 'BONNET' }] };
  ok('a costed disputed panel keeps its flag (so the note reaches the buyer)', buildBuyerFlags(a).length === 1);
}

console.log(`\nbatch177: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
