// validate-batch171.mjs — batch 171. £0, pure, no model calls. Unit checks built from CK75ONW run 2's stored row
// (_cc/scratch/b170/row-f75db268.json — the cassette holds run 1's reads, so replay cannot show run 2's case).
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch171.mjs
import { readFileSync, existsSync } from 'fs';
import { groupByPanelId, amalgamate } from '@/app/api/salvage/assess/route.js';
import { applyVisibilityGate, nameOtherFlags, otherDisplayName, OTHER_FALLBACK_NAME, buildBuyerFlags, seedChecklistFromFlags } from '../lib/parts.mjs';
import { isChargedRow } from '../lib/ledgerEdits.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };
const route = readFileSync(new URL('../app/api/salvage/assess/route.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const RUN2_PATH = new URL('../_cc/scratch/b170/row-f75db268.json', import.meta.url);
const RUN2 = existsSync(RUN2_PATH) ? JSON.parse(readFileSync(RUN2_PATH, 'utf8')).assessment : null;
const pv = (idx, rows) => ({ idx, costedParts: rows, instanceParts: [] });
const rec = (panelId, iv, severity, zone, extra = {}) => ({ panelId, independentlyVisible: iv, severity, zone, ...extra });

// ── P1 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- P1: OTHER is never costed, and never shown as "Other" --');
{
  // CK75ONW run 2: [PER-VIEW][12] panel=OTHER iv=true zone=underside (SEVERE), [24] panel=OTHER iv=na zone=interior.
  const views = [pv(12, [rec('OTHER', true, 'SEVERE', 'underside')]), pv(24, [rec('OTHER', null, null, 'interior')])];
  const r = amalgamate(groupByPanelId(views), new Map());
  ok('run 2 OTHER 1/1 damaged → NOT a costed verdict', !r.costedParts.some((c) => c.panelId === 'OTHER' && c.independentlyVisible === true));
  ok('…it is a flag instead', r.flaggedParts.some((f) => f.panelId === 'OTHER'));
  nameOtherFlags(r.flaggedParts, views);
  ok(`…named "${OTHER_FALLBACK_NAME}" (a literal OTHER carries no word), never "Other"`,
    r.flaggedParts.filter((f) => f.panelId === 'OTHER').every((f) => f.partName === OTHER_FALLBACK_NAME));
}
{
  // The model row, whatever its source: run 2's stored _preGateParts carries {"oem":180,"name":"Other","panelId":"OTHER"}.
  const pre = RUN2 ? RUN2._preGateParts : [{ oem: 180, name: 'Other', used: null, action: 'replace', panelId: 'OTHER' }];
  ok('(fixture) run 2 _preGateParts holds the £180 Other row', pre.some((p) => p.panelId === 'OTHER' && p.oem === 180));
  const flags = [];
  const verdicts = [{ panelId: 'OTHER', partName: 'Other', independentlyVisible: true }, ...pre.filter((p) => p.panelId && p.panelId !== 'OTHER').map((p) => ({ panelId: p.panelId, partName: p.name, independentlyVisible: true, zone: 'front' }))];
  const { gatedParts } = applyVisibilityGate(pre, verdicts, flags, { tier2Fired: false });
  ok('gate: no OTHER row survives — even with an iv:true verdict behind it', !gatedParts.some((p) => p.panelId === 'OTHER'));
  ok('gate: nothing charged under OTHER', !gatedParts.filter((p) => p.panelId === 'OTHER').some(isChargedRow));
  ok('gate: the row becomes a named inspection flag', flags.some((f) => f.panelId === 'OTHER' && f._otherNotCosted && f.partName === OTHER_FALLBACK_NAME));
}
{
  const views = [pv(10, [rec('OTHER', null, null, 'underside', { _freeName: 'UNDERSIDE' })])];   // GY75CJU view 10
  const flags = [{ panelId: 'OTHER', partName: 'Other', reason: 'x' }];
  nameOtherFlags(flags, views);
  ok('an unknown ID routed to OTHER keeps the model\'s word: "UNDERSIDE" → "Underside" (GY75CJU)', flags[0].partName === 'Underside');
  ok('several words join; "other"/"none" never count as a name', otherDisplayName(['REAR_DIFFUSER', 'rear-diffuser', 'OTHER']) === 'Rear diffuser' && otherDisplayName(['none']) === OTHER_FALLBACK_NAME);
  const a = { _flaggedParts: flags, _preGateParts: [] };
  ok('buyer flags (screen + PDF) show the name, not "Other"', buildBuyerFlags(a).every((f) => f.partName !== 'Other'));
  ok('the checklist never says "Show Other"', !/Show Other\b/.test(seedChecklistFromFlags('1. x', buildBuyerFlags(a))));
}
ok('route: OTHER is in the flag-only set', /\|\| effClass === PANEL_CLASS\.OTHER;/.test(route));
ok('route: the unknown-ID branch keeps the word (_freeName: rawId)', route.includes('partName: PANEL_DISPLAY[PANEL.OTHER], _freeName: rawId }'));
ok('route: OTHER flags are named right after amalgamate', route.includes('nameOtherFlags(pvResult.flaggedParts, perViewResults);'));

// ── P3 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- P3: a headlamp pair needs two damaged headlamps seen --');
{
  const { computeLampResult, damagedHeadlampsSeen } = await import('@/app/api/salvage/assess/route.js');
  // CK75ONW run 2: [PER-VIEW][0] HEADLAMP iv=true inst=1; [1] iv=na; [9] two instances iv=na; _lampObs full_width + apertureExposed.
  const h = (iv, inst) => ({ panelId: 'HEADLAMP', independentlyVisible: iv, zone: 'front', inst });
  const v0 = { idx: 0, costedParts: [h(true, 1)], instanceParts: [h(true, 1)] };
  const v9 = { idx: 9, costedParts: [h(null, 1)], instanceParts: [h(null, 1), h(null, 2)] };
  const run2Views = [v0, { idx: 1, costedParts: [h(null)], instanceParts: [] }, v9];
  ok('(fixture) run 2 _lampObs is full_width + apertureExposed', !RUN2 || (RUN2._lampObs.damageSpan === 'full_width' && RUN2._lampObs.apertureExposed === true));
  ok('run 2: the per-view reads resolved ONE damaged headlamp', damagedHeadlampsSeen(run2Views) === 1);
  const r = computeLampResult('central', true, 'led', 'missing', null, 'full_width', false, damagedHeadlampsSeen(run2Views));
  ok('run 2: apertureExposed + full_width + 1 seen → lampCount 1 (was 2)', r.lampCount === 1);
  const pair = computeLampResult('central', true, 'led', 'missing', null, 'full_width', false, 2);
  ok('two damaged headlamps seen in one view → the pair stands', pair.lampCount === 2);
  const none = computeLampResult('central', true, 'led', 'missing', null, 'full_width', false, 0);
  ok('none seen → minimum 1', none.lampCount === 1);
  const legacy = computeLampResult('central', true, 'led', 'missing', null, 'full_width', false);
  ok('no count passed (older callers, validate-headlamp-pair) → geometry as before (2)', legacy.lampCount === 2);
  const single = computeLampResult('central', false, 'led', null, null, 'full_width', false, 2);
  ok('the cap never raises: tier 1 (aperture not exposed) stays 1', single.lampCount === 1);
  ok('a zone-demoted (na) vote does not count', damagedHeadlampsSeen([{ idx: 3, costedParts: [], instanceParts: [h(null, 1), h(true, 2)] }]) === 1);
  ok('route passes the per-view count into computeLampResult', route.includes('damagedHeadlampsSeen(perViewResults)   // batch 171 P3'));
}

// ── P4 ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n-- P4 (inverted by batch 175): the synthesis is KEPT WHOLE, and the front bumper is recorded for inspection --');
{
  // batch 175 (Vincent, 22 Sep): a part-status hit no longer drops anything — the clause drop (dropDemotedClauses) is gone.
  // "the front bumper is displaced" was TRUE (CK75ONW label: damaged), so it stays and the bumper is recorded instead.
  const parts = await import('../lib/parts.mjs');
  const { bindClaimClasses, findProseDamageUncosted } = parts;
  // CK75ONW run 2 _raw Visible Damage Summary, first sentence verbatim (the binder dropped it whole, batch 170 T1.7).
  const SYN = 'A near-delivery 2025 Ioniq 5 Premium (current-generation BEV, ~5,900 miles) carrying two separate impacts — a full-width rear-end hit that has torn the rear bumper away and displaced the rear closing structure, plus a lighter front-end disturbance where the front bumper is displaced and the front grille/slam-panel area is exposed; the biggest unseeable risk is the rear chassis-leg/boot-floor integrity and high-voltage battery-zone condition behind the rear impact, neither of which can be confirmed from the photographs.';
  if (RUN2) ok('(fixture) the sentence is run 2\'s own text', RUN2._raw.includes(SYN));
  const ctx = { lampType: 'led', allowedFigures: [], partActions: [], demoted: ['Front bumper'], evVerdict: null };
  const r = bindClaimClasses(SYN, ctx, 'speculation');
  ok('the synthesis survives', /near-delivery 2025 Ioniq 5 Premium/.test(r.text) && /biggest unseeable risk/.test(r.text));
  ok('…its rear-impact clause survives', /torn the rear bumper away and displaced the rear closing structure/.test(r.text));
  ok('…and its front-bumper clause is KEPT (batch 175; was: dropped)', /the front bumper is displaced/.test(r.text) && r.text === SYN);
  ok('…nothing is dropped (batch 175; was: one part-status-clause drop)', r.dropped.length === 0);
  const found = findProseDamageUncosted(SYN, [{ panelId: 'FRONT_BUMPER', name: 'Front bumper' }], 'speculation');
  ok('…the front bumper is recorded as prose damage on an uncosted panel ("displaced")', found.length === 1 && found[0].panelId === 'FRONT_BUMPER');
  ok('a one-clause cost-driver sentence is KEPT too (batch 175; was: dropped whole)',
    bindClaimClasses('The front bumper is the biggest cost on the car. The roof is clean.', ctx, 'speculation').dropped.length === 0);
  ok('the clause drop is gone (dropDemotedClauses no longer exported)', !('dropDemotedClauses' in parts));
  ok('another class still drops: a figure not in the ledger',
    bindClaimClasses('The front bumper is damaged; the repair costs £999 in total. The roof is clean.', { ...ctx, allowedFigures: [100] }, 'redflags').dropped.some((d) => d.class === 'figure'));
}

console.log(`\nbatch171: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
