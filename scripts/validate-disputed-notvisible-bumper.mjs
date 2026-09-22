// validate-disputed-notvisible-bumper.mjs — batch 151 (CK75ONW, stored run 16 Sep), V1 section rewritten
// by batch 156 T0. £0, pure.
//   V1 — REVERTED (batch 156 T0). A disputed panel is FLAGGED, NOT COSTED. The tests below assert the rule
//        is gone: no owner, no call site, no buyer-flag carve-out.
//   V2 — zero-rule B is gone: a panel no photo shows is flagged, never charged, whatever its neighbours.
//   V3 — the §4 note says "torn away" only when the bumper is read as ABSENT. SUPERSEDED by batch 179: one wording for all.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-disputed-notvisible-bumper.mjs
//
// RULINGS:
//   - V1 REVERTED (Vincent, 18 Sep: "Yes revert"). The batch 155 scorecard measured it over 16 labelled lots:
//     5 panels Vincent labels CLEAN became phantoms (+£2,685) and it gained ZERO hits. The batch 152 ruling
//     that V1 "stays as built" is SUPERSEDED. Ties and minorities were never costed and still are not.
//   - V2 and V3 are UNCHANGED and still locked below.
//   - V3 `aperture` and `severe` sentences APPROVED as built (pinned verbatim below).
import { readFileSync } from 'fs';
import { buildBuyerFlags } from '../lib/parts.mjs';
import * as PARTS from '../lib/parts.mjs';
import { applyGradeOwnsAction } from '../lib/labour.mjs';
import { PANEL_PRICE_TABLE } from '../lib/priceBand.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');
const DISPLAY = { BOOT_LID: 'Boot lid', BONNET: 'Bonnet', WINDSCREEN: 'Windscreen', REAR_QUARTER: 'Rear quarter panel', FRONT_DOOR: 'Front door' };
const flag = (panelId) => ({ panelId, partName: DISPLAY[panelId] || panelId, zone: 'rear', weight: 'medium', reason: 'the listing photographs disagree on this part', _amalgDisagree: true });
const twin = (panelId, sev) => ({ panelId, independentlyVisible: false, _amalgDisagree: true, _ledgerSeverity: sev });

// ── V1 ─ REVERTED (batch 156 T0) ────────────────────────────────────────────────
console.log('\n-- V1 REVERTED: a disputed panel is flagged, not costed --');
{
  const parts = readFileSync(new URL('../lib/parts.mjs', import.meta.url), 'utf8');
  ok('V1 gone: lib/parts.mjs exports no disagreeMajorityRows', PARTS.disagreeMajorityRows === undefined);
  ok('V1 gone: lib/parts.mjs exports no DISAGREE_MAJORITY_EXCLUDED', PARTS.DISAGREE_MAJORITY_EXCLUDED === undefined);
  ok('V1 gone: no owner is left in the source', !/function disagreeMajorityRows/.test(parts));
  ok('V1 gone: route.js never calls it and logs no [DISAGREE MAJORITY]',
    !route.includes('disagreeMajorityRows({') && !route.includes('[DISAGREE MAJORITY]'));
  ok('V1 gone: the _disagreeMajorityCosted mark is set nowhere', !parts.includes('_disagreeMajorityCosted = true'));
  // The buyer-flag carve-out is gone with it: a disputed flag whose panel the main call never implicated
  // is dropped again, EVEN IF something stamped the old mark on it.
  const marked = buildBuyerFlags({
    _flaggedParts: [{ ...flag('BOOT_LID'), _disagreeMajorityCosted: true }, flag('FRONT_DOOR')],
    _preGateParts: [{ panelId: 'FRONT_BUMPER' }],
  });
  ok('V1 gone: the carve-out no longer rescues a disputed flag', !marked.some((f) => f.panelId === 'BOOT_LID'));
  ok('V1 gone: an uncosted disputed panel is filtered as before', !marked.some((f) => f.panelId === 'FRONT_DOOR'));
  // Everything the revert must NOT touch.
  const corroborated = buildBuyerFlags({ _flaggedParts: [flag('BOOT_LID')], _preGateParts: [{ panelId: 'BOOT_LID' }] });
  ok('UNTOUCHED: a disputed flag the main call implicated still survives', corroborated.some((f) => f.panelId === 'BOOT_LID'));
  const q4 = buildBuyerFlags({ _flaggedParts: [{ ...flag('REAR_QUARTER'), _q4Declined: true }], _preGateParts: [{ panelId: 'FRONT_BUMPER' }] });
  ok('UNTOUCHED: the batch 132 Q4-declined carve-out still exempts a quarter flag', q4.some((f) => f.panelId === 'REAR_QUARTER'));
  ok('UNTOUCHED: the gate still keeps a disputed panel the MODEL costed (_disagreeCosted)',
    parts.includes('_disagreeCosted: true') && parts.includes('verdict._amalgDisagree'));
}

// ── V2 ──────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- V2: a part no photo shows is flagged, not charged --');
{
  ok("V2: no family-B row can be built (no _zeroRule: 'B')", !route.includes("_zeroRule: 'B'"));
  ok('V2: the neighbour set is gone', !route.includes('ZERO_RULE_ADJACENCY ='));
  const i = route.indexOf('} else if (f._amalgNotVisible) {');
  const block = route.slice(i, route.indexOf('} else if', i + 10));
  ok('V2: the not-visible branch only continues — no row, no figure', i > 0 && /continue;/.test(block) && !/injected\s*=|gatedParts\.push/.test(block));
  // CK75ONW, reasoned from the report: RADIATOR_PACK £580 and SLAM_PANEL £120 (LUXURY) no longer charged.
  const lux = (p) => PANEL_PRICE_TABLE[p].Luxury;
  ok(`V2: CK75ONW S/H −£${lux('RADIATOR_PACK').used + lux('SLAM_PANEL').used} (radiator £580 + slam £120)`, lux('RADIATOR_PACK').used === 580 && lux('SLAM_PANEL').used === 120);
}

// ── V3 ──────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- V3: "torn away" only when the bumper is read as absent --');
{
  const { bumperOffWhy, bumperLimitReason } = await import('@/app/api/salvage/assess/route.js');
  ok('V3: absent read → absent', bumperOffWhy(true, true, true) === 'absent');
  ok('V3: CK75ONW (fitted, aperture open) → aperture', bumperOffWhy(false, true, false) === 'aperture');
  ok('V3: fitted, SEVERE, no aperture → severe', bumperOffWhy(false, false, true) === 'severe');
  ok('V3: nothing → null', bumperOffWhy(false, false, false) === null);
  const absent = bumperLimitReason('front', 'wing', 'absent');
  const aperture = bumperLimitReason('front', 'wing', 'aperture');
  const severe = bumperLimitReason('rear', 'quarter panel', 'severe');
  // batch 179 (Vincent, 22 Sep): ONE wording for every branch — it replaces V3's three sentences (and batch 103's "torn
  // away … cannot be determined"). The limb is still recorded on the flag; it no longer changes the words.
  ok('batch 179: absent → the one wording, verbatim', absent === 'Costed on the photographs. The front bumper is off on this side, so check the wing on inspection and strike the line if it is sound.');
  // batch 180 (Vincent, 22 Sep): the two FITTED limbs say "is damaged" — the bumper is still on (KT73YAJ, SF69YBB).
  ok('batch 180: aperture → "is damaged", verbatim', aperture === 'Costed on the photographs. The front bumper is damaged on this side, so check the wing on inspection and strike the line if it is sound.');
  ok('batch 180: severe → "is damaged", its own end and panel', severe === 'Costed on the photographs. The rear bumper is damaged on this side, so check the quarter panel on inspection and strike the line if it is sound.');
  ok('batch 180: no fitted limb says "is off"', ![aperture, severe, bumperLimitReason('rear', 'quarter panel', 'aperture'), bumperLimitReason('front', 'wing', 'severe')].some((r) => /bumper is off/.test(r)));
  ok('batch 180: only the absent limb says "is off"', /bumper is off on this side/.test(absent));
  for (const [k, r] of [['absent', absent], ['aperture', aperture], ['severe', severe]]) {
    ok(`batch 179: ${k} never says "cannot be determined" / "cannot be fully seen" / "torn away"`, !/cannot be (?:determined|fully seen)|torn away/i.test(r));
    ok(`batch 179: ${k} still says it is costed and gives the strike line`, /^Costed on the photographs\./.test(r) && /strike the line if it is sound\.$/.test(r));
  }
  ok('V3: the note reads the recorded limb', route.includes('reason: bumperLimitReason(end, panelWord, _why)'));
  ok('V3: the limb is recorded from the same three reads the note-only signal uses',
    route.includes("front: bumperOffWhy(_frontOffNew, lampObs?.apertureExposed === true, frontBumperSevere)")
    && route.includes("rear:  bumperOffWhy(_rearOffNew,  lampObs?.rearApertureExposed === true, rearBumperSevere)"));
  ok('V3: no literal "torn away" note is left in the §4 loop', !route.includes('reason: `The ${end} bumper is torn away'));
  ok('V3: the money path is untouched (presence read only)', route.includes('const frontBumperOff = _bumperLegacy ? _frontOffLegacy : _frontOffNew;'));
}

console.log(`\ndisputed-notvisible-bumper: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
