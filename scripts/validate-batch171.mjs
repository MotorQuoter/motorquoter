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

console.log(`\nbatch171: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
