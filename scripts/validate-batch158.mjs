// validate-batch158.mjs — batch 158 A1 + A3 (and, after Part B, the prompt rules). £0, pure, no model calls.
//
//   A1  a panel the photographs DISAGREE on that ends up NOT costed reaches the inspection flags and the
//       WhatsApp checklist, in Vincent's words. It is never costed — that is batch 151 V1, reverted in 156.
//   A3  a trim item is never described as wheel/tyre damage. The wheel net is keyed on the panelId.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch158.mjs
import { readFileSync } from 'fs';
import { PANEL, PANEL_DISPLAY } from '../lib/panelEnum.mjs';
import {
  discloseSplitVoteUncosted, SPLIT_VOTE_REASON, isSplitVote, buildBuyerFlags, seedChecklistFromFlags,
} from '../lib/parts.mjs';
import { wheelNetParts, isWheelNetRow } from '@/app/api/salvage/assess/route.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8');
const parts = readFileSync(new URL('../lib/parts.mjs', import.meta.url), 'utf8');

// ── A1 ──────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- A1: a split-vote panel that is not costed is still inspected --');
const VOTES = { BONNET: { views: 5, resolving: 3, damaged: 1, clean: 2, notVisible: 0, branch: 'disagree' } };
ok('a split vote is at least one damaged AND at least one clean', isSplitVote({ damaged: 1, clean: 2 })
  && !isSplitVote({ damaged: 3, clean: 0 }) && !isSplitVote({ damaged: 0, clean: 3 }) && !isSplitVote(null));
ok("the wording is Vincent's, code-owned", SPLIT_VOTE_REASON('Bonnet')
  === 'Photographs disagree on the Bonnet — some show damage, some do not. Not included in the repair total; check it on inspection before bidding.');

// CK75ONW verbatim: the bonnet-skin read cleared the disagree floor, leaving a low-weight breadcrumb that
// asserted the panel was FINE ("hood skin intact … no separate panel cost"). The disclosure replaces it.
{
  const flags = [{ panelId: 'BONNET', partName: 'Bonnet', zone: 'front', weight: 'low',
    reason: 'Bonnet sits proud / shut line disturbed — hood skin intact; refits with the structural repair, no separate panel cost.', _bonnetDisplaced: true }];
  const out = discloseSplitVoteUncosted({ pvVotes: VOTES, gatedParts: [{ panelId: 'FRONT_BUMPER', used: 360 }], flags, display: PANEL_DISPLAY });
  ok('the existing flag is REWORDED, not doubled', out.length === 1 && out[0].action === 'reworded' && flags.length === 1);
  ok('it no longer claims the panel is intact', !/intact/i.test(flags[0].reason) && flags[0].reason === SPLIT_VOTE_REASON('Bonnet'));
  ok('it is raised off "low" so it reads as an inspection item', flags[0].weight === 'medium');
  ok('it is marked for the buyer-flag filter and the checklist', flags[0]._splitVoteUncosted === true);
}
{
  const flags = [];
  const out = discloseSplitVoteUncosted({ pvVotes: VOTES, gatedParts: [], flags, display: PANEL_DISPLAY });
  ok('with no flag at all, one is added', out[0].action === 'added' && flags.length === 1 && flags[0].panelId === 'BONNET');
}
ok('a COSTED split-vote panel is left alone (this rule never costs and never duplicates)',
  discloseSplitVoteUncosted({ pvVotes: VOTES, gatedParts: [{ panelId: 'BONNET', used: 300 }], flags: [], display: PANEL_DISPLAY }).length === 0);
ok('a panel costed as a £0 repair counts as costed',
  discloseSplitVoteUncosted({ pvVotes: VOTES, gatedParts: [{ panelId: 'BONNET', used: null, oem: null, _repairNoPart: true }], flags: [], display: PANEL_DISPLAY }).length === 0);
ok('a unanimous panel is not touched',
  discloseSplitVoteUncosted({ pvVotes: { BONNET: { damaged: 3, clean: 0 } }, gatedParts: [], flags: [], display: PANEL_DISPLAY }).length === 0);
ok('a flag-class panel keeps its own wording',
  discloseSplitVoteUncosted({ pvVotes: { SPARE_WHEEL: { damaged: 1, clean: 1 } }, gatedParts: [], flags: [], display: PANEL_DISPLAY }).length === 0);
ok('the rule adds no money anywhere', !/discloseSplitVoteUncosted[\s\S]{0,600}gatedParts\.push/.test(route));

// It must SURVIVE the buyer-flag disagree filter — the bonnet is absent from _preGateParts by construction.
{
  const flagged = [{ panelId: 'BONNET', partName: 'Bonnet', zone: 'front', weight: 'medium',
    reason: SPLIT_VOTE_REASON('Bonnet'), _amalgDisagree: true, _splitVoteUncosted: true }];
  const kept = buildBuyerFlags({ _flaggedParts: flagged, _preGateParts: [{ panelId: 'FRONT_BUMPER' }] });
  ok('it survives the buyer-flag filter with no _preGateParts entry', kept.some(f => f.panelId === 'BONNET'));
  const other = buildBuyerFlags({ _flaggedParts: [{ panelId: 'GRILLE', partName: 'Grille', _amalgDisagree: true }], _preGateParts: [{ panelId: 'FRONT_BUMPER' }] });
  ok('an ordinary uncorroborated disagree flag is still filtered', !other.some(f => f.panelId === 'GRILLE'));
}
// …and reach the checklist even though the model's own checklist already mentions the panel.
{
  const existing = '1. Show the bonnet and front closure — confirm the shut lines.';
  const seeded = seedChecklistFromFlags(existing, [{ panelId: 'BONNET', partName: 'Bonnet', weight: 'medium',
    reason: SPLIT_VOTE_REASON('Bonnet'), _splitVoteUncosted: true }], {});
  ok('a phrase-match on the panel name does not suppress it', seeded.includes(SPLIT_VOTE_REASON('Bonnet')));
  ok('the checklist says exactly what the flag says', seeded.split('\n').pop().endsWith(SPLIT_VOTE_REASON('Bonnet')));
  const twice = seedChecklistFromFlags(seeded, [{ panelId: 'BONNET', partName: 'Bonnet', _splitVoteUncosted: true }], {});
  ok('it is never seeded twice', twice.split(SPLIT_VOTE_REASON('Bonnet')).length - 1 === 1);
}

// ── A3 ──────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- A3: trim is never called wheel/tyre damage --');
const row = (panelId, name) => ({ panelId, name, action: 'replace', used: 90 });
ok('a wheel row is in the net', isWheelNetRow(row(PANEL.WHEEL, 'Wheel')) && isWheelNetRow(row(PANEL.TYRE, 'Tyre')));
ok('the arch moulding is NOT (the CK75ONW defect)', !isWheelNetRow(row(PANEL.WHEEL_ARCH_MOULDING, 'Wheel arch moulding')));
ok('nor is the arch liner', !isWheelNetRow(row(PANEL.WHEEL_ARCH_LINER, 'Wheel arch liner')));
ok('spare and displaced wheels stay excluded, as before',
  !isWheelNetRow(row(PANEL.SPARE_WHEEL, 'Spare wheel')) && !isWheelNetRow(row(PANEL.DISPLACED_WHEEL, 'Displaced wheel')));
ok('a model-written row with no panelId still falls back to the name',
  isWheelNetRow({ name: 'Alloy wheel', used: 200 }) && !isWheelNetRow({ name: 'Rear bumper', used: 200 }));
ok('wheelNetParts no longer returns the moulding',
  wheelNetParts([row(PANEL.WHEEL_ARCH_MOULDING, 'Wheel arch moulding'), row(PANEL.WHEEL, 'Wheel')])
    .every(p => p.panelId === PANEL.WHEEL));
ok('the net is keyed on the panel, not the word', /WHEEL_NET_PANELS\s*=\s*new Set\(\[PANEL\.WHEEL, PANEL\.TYRE\]\)/.test(route));
// The checklist seeder had the same bug in its own copy of the regex: a moulding flag was skipped as
// "wheelnet", so it was dropped from the checklist as well as misnamed there.
ok('the seeder skips only real wheel/tyre panels', /WHEEL_NET_PANEL_IDS\.has\(flag\.panelId\)/.test(parts));
{
  const seeded = seedChecklistFromFlags('1. Existing.', [{ panelId: PANEL.WHEEL_ARCH_MOULDING, partName: 'Wheel arch moulding', weight: 'medium' }], {});
  ok('a moulding flag now reaches the checklist', /Wheel arch moulding/.test(seeded));
  const wheel = seedChecklistFromFlags('1. Existing.', [{ panelId: PANEL.WHEEL, partName: 'Wheel', weight: 'medium' }], {});
  ok('a real wheel flag is still covered by the wheel-net line', !/Show Wheel close-up/.test(wheel));
}

// ── PART B — the prompt rules (text asserts; no model call, no scoring) ────────────────────
console.log('\n-- B2/B3: the per-photo rules the prompt now states --');
// B2 — a torn-off bumper is not evidence about the panel behind it (CK75ONW: three rear-corner frames
// graded the quarter SEVERE while the flank frames and the main call read it clean).
ok('B2: the corner-read block exists', /--- CORNER READS: THE BUMPER IS NOT THE PANEL BEHIND IT ---/.test(route)
  && /--- END CORNER READS ---/.test(route));
ok('B2: at a rear corner, bumper/cladding/lamp-aperture damage is NOT the quarter',
  /is NOT REAR_QUARTER/.test(route));
ok('B2: the quarter is iv:true only on its OWN metal above the bumper line',
  /quarter's OWN METAL is dented, creased or split ABOVE the bumper line/.test(route));
ok('B2: a covered or out-of-shot quarter is iv:na, not iv:true',
  /REAR_QUARTER is iv:na — not iv:true/.test(route));
ok('B2: the same rule is stated for the front wing', /is NOT FRONT_WING/.test(route)
  && /wing's own metal is deformed above the bumper line/.test(route));
ok('B2: it says plainly what a torn-off bumper is and is not evidence of',
  /It is NOT evidence about the panel behind it/.test(route));
ok('B2: the bonnet leading edge is BONNET even beside a missing grille',
  /Damage on the bonnet's own front leading edge, or anywhere on its horizontal skin, is BONNET/.test(route));
ok('B2: the existing wing-edge rule is kept, not replaced',
  /--- BONNET: WING-EDGE & DISPLACEMENT ---/.test(route)
  && /Damage on the vertical fender, at or above the front wheel arch[\s\S]{0,120}is FRONT_WING/.test(route));
// B3 — an edge/return crease is replace-grade. The MODEL grades; code keeps SEVERE → replace, so there
// must be no new code rule about edges.
ok('B3: SEVERE now covers a crease into an edge, flange, swage line or lamp aperture',
  route.includes("ALSO SEVERE: a crease, fold or kink that runs INTO a panel's edge, return flange, swage line or"));
ok('B3: it says why — it cannot be dressed out', /cannot be dressed out, so the panel is replaced/.test(route));
ok('B3: MODERATE and MINOR are untouched', /MODERATE = clear impact damage, repair-grade/.test(route)
  && /MINOR    = cosmetic — scuff \/ scratch \/ light dent, refinish only/.test(route));
ok('B3: NO code rule about edges was added — the model grades and code keeps SEVERE → replace',
  !/swage|return flange/i.test(readFileSync(new URL('../lib/labour.mjs', import.meta.url), 'utf8'))
  && !/swage|return flange/i.test(readFileSync(new URL('../lib/parts.mjs', import.meta.url), 'utf8')));

// ── batch 159 T2 + T3 — the buyer-facing controls and wording ──────────────────────────
console.log('\n-- batch 159 T2/T3: wording and the per-line controls --');
{
  const page = readFileSync(new URL('../app/salvage/success/page.js', import.meta.url), 'utf8');
  const pdf  = readFileSync(new URL('../app/api/salvage/pdf/route.js', import.meta.url), 'utf8');
  // T2 — a buyer reads "engine" as the motor. Every buyer-facing use that meant OUR assessment is gone.
  ok('T2: the lamp picklist says "As assessed", not "Keep engine type"',
    page.includes('As assessed — {lampTypeLabel(engineLampType)}') && !page.includes('Keep engine type'));
  ok('T2: the corrected-lamp line says "we assessed", not "engine:"',
    page.includes('corrected by you (we assessed:') && !page.includes('corrected by you (engine:'));
  ok('T2: the repair banner says "we assessed" on BOTH surfaces',
    page.includes('Adjusted by you — we assessed') && pdf.includes('Adjusted by you - we assessed'));
  ok('T2: no buyer-facing "engine estimate" is left on either surface',
    !page.includes('engine estimate') && !pdf.includes('engine estimate'));
  ok('T2: the lamp-source fallback reads "assumed", not "engine"',
    !/lampSourceText\[engineLampSource\] \|\| 'engine'/.test(page));
  // T3 — the controls are labelled, sized, and on their own line.
  ok('T3: every costed line offers a labelled Change button', page.includes("{am ? 'Changed — edit' : 'Change'}"));
  ok('T3: the strike control is labelled, not a bare glyph',
    page.includes("{struck ? '↺ Restore' : '✕ Remove'}") && !page.includes("{struck ? '↺' : '✕'}"));
  ok('T3: the controls sit on their own line, not glued to the part name',
    /marginTop: 6, display: 'flex', flexWrap: 'wrap'/.test(page));
  ok('T3: 13px text and a 32px touch target, in the orange outline style',
    /minHeight: 32, fontSize: 13[\s\S]{0,120}border: '1\.5px solid var\(--orange\)'/.test(page));
  ok('T3: the bottom button reads "Adjust ledger" and becomes "Done"',
    page.includes("{editMode ? 'Done' : 'Adjust ledger'}"));
  ok('T3: the helper text explains repair/replace and your own figure',
    /Press <b>Adjust ledger<\/b>[\s\S]{0,300}repair and replace[\s\S]{0,120}your own figure/.test(page));
  // The PDF is generated from the ledger rows, so it can never print a control.
  ok('T3: the PDF prints no control text', !/'Change'|✕ Remove|↺ Restore|'edit'/.test(pdf));
}

console.log(`\nbatch158: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
