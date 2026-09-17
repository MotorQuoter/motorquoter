// validate-disputed-notvisible-bumper.mjs — batch 151 (CK75ONW, stored run 16 Sep). £0, pure.
//   V1 — a disputed non-quarter COST panel with damaged > clean is costed at band, note kept for the buyer.
//   V2 — zero-rule B is gone: a panel no photo shows is flagged, never charged, whatever its neighbours.
//   V3 — the §4 note says "torn away" only when the bumper is read as ABSENT.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-disputed-notvisible-bumper.mjs
import { readFileSync } from 'fs';
import { disagreeMajorityRows, DISAGREE_MAJORITY_EXCLUDED, buildBuyerFlags } from '../lib/parts.mjs';
import { applyGradeOwnsAction } from '../lib/labour.mjs';
import { PANEL_PRICE_TABLE } from '../lib/priceBand.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');
const DISPLAY = { BOOT_LID: 'Boot lid', BONNET: 'Bonnet', WINDSCREEN: 'Windscreen', REAR_QUARTER: 'Rear quarter panel', FRONT_DOOR: 'Front door' };
const flag = (panelId) => ({ panelId, partName: DISPLAY[panelId] || panelId, zone: 'rear', weight: 'medium', reason: 'the listing photographs disagree on this part', _amalgDisagree: true });
const twin = (panelId, sev) => ({ panelId, independentlyVisible: false, _amalgDisagree: true, _ledgerSeverity: sev });

// ── V1 ──────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- V1: a majority-damaged disputed panel is costed --');
{
  // CK75ONW verbatim: _pvVotes.BOOT_LID = {views:3, damaged:2, clean:1, branch:"disagree"}, LUXURY band, no model row.
  const flags = [flag('BOOT_LID')];
  const pvVotes = { BOOT_LID: { views: 3, resolving: 3, damaged: 2, clean: 1, notVisible: 0, branch: 'disagree', severeVotes: 1 } };
  const lux = PANEL_PRICE_TABLE.BOOT_LID.Luxury;
  for (const sev of ['SEVERE', 'MODERATE']) {
    const f = [flag('BOOT_LID')];
    const { rows } = disagreeMajorityRows({ flags: f, costedParts: [twin('BOOT_LID', sev)], pvVotes, gatedParts: [], bandKey: 'Luxury', display: DISPLAY });
    ok(`V1: CK75ONW tailgate (${sev}) → one row at LUXURY band £${lux.oem}/£${lux.used}`,
      rows.length === 1 && rows[0].oem === lux.oem && rows[0].used === lux.used && rows[0].panelId === 'BOOT_LID');
    ok(`V1: ${sev} → ${sev === 'SEVERE' ? 'replace' : 'repair'} (grade picks, as for other panels)`, rows[0].action === (sev === 'SEVERE' ? 'replace' : 'repair'));
    ok(`V1: ${sev} row is NOT a £0-rule row (so grade and panel work apply)`, rows[0]._zeroRule === undefined && rows[0]._disagreeCosted === true);
    ok(`V1: ${sev} — the disagree flag is kept and marked`, f[0]._amalgDisagree === true && f[0]._disagreeMajorityCosted === true);
    // The grade then owns the price exactly as for any body panel.
    const g = [{ ...rows[0] }];
    applyGradeOwnsAction(g, new Map([['BOOT_LID', sev]]));
    ok(`V1: ${sev} after applyGradeOwnsAction → ${sev === 'SEVERE' ? 'replace, part kept' : 'repair, £0 part (panel work carries it)'}`,
      sev === 'SEVERE' ? (g[0].action === 'replace' && g[0].used === lux.used) : (g[0]._repairNoPart === true && g[0].used === null));
  }
  // Ties, minorities, exclusions.
  const run = (pid, d, c, extra = {}) => {
    const f = [flag(pid)];
    const r = disagreeMajorityRows({ flags: f, costedParts: [twin(pid, 'MODERATE')], pvVotes: { [pid]: { damaged: d, clean: c, branch: 'disagree' } },
      gatedParts: extra.gatedParts || [], bandKey: 'Executive', display: DISPLAY });
    return { r, f };
  };
  ok('V1: a tie (1d/1c) is NOT costed (report only)', run('BOOT_LID', 1, 1).r.rows.length === 0);
  ok('V1: a minority (1d/3c) is NOT costed (report only)', run('FRONT_DOOR', 1, 3).r.rows.length === 0);
  ok('V1: a minority leaves the flag unmarked', !run('FRONT_DOOR', 1, 3).f[0]._disagreeMajorityCosted);
  ok('V1: the rear quarter is excluded (Q4 rule owns it)', DISAGREE_MAJORITY_EXCLUDED.includes('REAR_QUARTER') && run('REAR_QUARTER', 3, 1).r.rows.length === 0);
  const already = run('BONNET', 3, 2, { gatedParts: [{ panelId: 'BONNET', name: 'Bonnet', oem: 300, used: 165, _disagreeCosted: true }] });
  ok('V1: a panel already in the money (model row the gate kept) is not doubled', already.r.rows.length === 0);
  const repaired = run('BONNET', 3, 2, { gatedParts: [{ panelId: 'BONNET', name: 'Bonnet', oem: null, used: null, _repairNoPart: true }] });
  ok('V1: a repaired panel (£0 part) counts as in the money too', repaired.r.rows.length === 0);
  ok('V1: a flag-class panel is never costed', run('AIRBAG', 2, 1).r.rows.length === 0);
  ok('V1: no band → no row', disagreeMajorityRows({ flags: [flag('BONNET')], costedParts: [], pvVotes: { BONNET: { damaged: 3, clean: 1, branch: 'disagree' } }, gatedParts: [], bandKey: null }).rows.length === 0);
  const two = [flag('BONNET'), flag('BONNET')];
  ok('V1: two disagree flags for one panel (G-split) → ambiguous, not costed',
    disagreeMajorityRows({ flags: two, costedParts: [], pvVotes: { BONNET: { damaged: 3, clean: 1, branch: 'disagree' } }, gatedParts: [], bandKey: 'Executive' }).rows.length === 0);
  // SA26KVT: a non-body part (windscreen) is replaced — the band figure is a part, glass has no repair path.
  const ws = disagreeMajorityRows({ flags: [flag('WINDSCREEN')], costedParts: [twin('WINDSCREEN', 'MODERATE')], pvVotes: { WINDSCREEN: { damaged: 3, clean: 2, branch: 'disagree' } }, gatedParts: [], bandKey: 'Prestige', display: DISPLAY });
  ok('V1: SA26KVT windscreen (MODERATE, 3d/2c) → replace at £480/£265', ws.rows.length === 1 && ws.rows[0].action === 'replace' && ws.rows[0].oem === 480 && ws.rows[0].used === 265);
  // The buyer keeps the note: buildBuyerFlags would drop an _amalgDisagree flag with no model row.
  const buyer = buildBuyerFlags({ _flaggedParts: [{ ...flags[0], _disagreeMajorityCosted: true }, flag('FRONT_DOOR')], _preGateParts: [{ panelId: 'FRONT_BUMPER' }] });
  ok('V1: the costed disputed panel survives the buyer-flag filter', buyer.some((f) => f.panelId === 'BOOT_LID'));
  ok('V1: an uncosted disputed panel with no model row is still filtered as before', !buyer.some((f) => f.panelId === 'FRONT_DOOR'));
  // Wiring.
  const v1 = route.indexOf('disagreeMajorityRows({');
  ok('V1: route calls the owner once', v1 > 0 && route.indexOf('disagreeMajorityRows({', v1 + 1) === -1);
  ok('V1: before the £0-rule pass builds damagedPanels (so it counts for the structure floor)', v1 < route.indexOf('const damagedPanels = new Set(gatedParts.filter('));
  ok('V1: before the labour block grades rows', v1 < route.indexOf('applyGradeOwnsAction(gatedParts, sevByPanel)'));
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
  ok('V3: absent keeps the batch 103 §4 wording', absent.startsWith('The front bumper is torn away on this side.'));
  ok('V3: aperture never says "torn away"', !/torn away/i.test(aperture) && /open on this side/.test(aperture));
  ok('V3: severe never says "torn away"', !/torn away/i.test(severe) && /badly damaged/.test(severe));
  for (const [k, r] of [['absent', absent], ['aperture', aperture], ['severe', severe]]) {
    ok(`V3: ${k} still states the limit and the strike line`, /included in the repair total/.test(r) && /strike the line/.test(r));
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
