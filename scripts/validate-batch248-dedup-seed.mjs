// batch 248 B5 (Vincent, 18 Nov) — a checklist line seeded from a gate dedup flag ("duplicate part row excluded…") must not
// say "could not be confirmed" when that panel is charged; the panel's own flag wording reaches the checklist instead.
// batch 248 C4: the buyer never sees the dedup flag at all (Inspection Flags, checklist, PDF, cards); it stays in _flaggedParts.
// £0. Synthetic + the LC72NZV stored row (production data, gitignored fixtures/b248/ — skips cleanly without it).
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch248-dedup-seed.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { seedChecklistFromFlags, applyVisibilityGate, buildBuyerFlags, isGateDedupFlag, GATE_DEDUP_REASON } from '@/lib/parts.mjs';
import { buildDamageCards } from '@/lib/damageCards.mjs';
import { isChargedRow } from '@/lib/ledgerEdits.mjs';

const DEDUP_REASON = 'duplicate part row excluded from repair total — only the first entry for this part is included; verify repair scope on inspection';
const dedup = (pid = 'FRONT_WING') => ({ partName: 'Front wing', zone: 'front', weight: 'medium', reason: DEDUP_REASON, _gateGenerated: true, _gateDedup: true, _dedupPanelId: pid });
const BUMPER_OFF = { panelId: 'FRONT_WING', partName: 'Front wing', zone: 'front', weight: 'medium', _bumperOffLimit: true,
  reason: 'Costed on the photographs. The front bumper is off on this side, so check the wing on inspection and strike the line if it is sound.' };

test('the gate marks its dedup flag (and gives it no panelId, so the Z2 costed-reason rewrite cannot reword it)', () => {
  const verdicts = [{ panelId: 'FRONT_WING', partName: 'Front wing', independentlyVisible: true, zone: 'front' }];
  const rows = [{ name: 'Front wing', panelId: 'FRONT_WING', action: 'replace', oem: 175, used: 95 },
    { name: 'Front wing', panelId: 'FRONT_WING', action: 'replace', oem: 175, used: 95 }];
  const flags = [];
  const g = applyVisibilityGate(rows, verdicts, flags, null);
  assert.equal(g.gatedParts.filter(r => r.panelId === 'FRONT_WING').length, 1, 'the dedup stays (Vincent: one wing)');
  const f = flags.find(x => x._gateDedup);
  assert.ok(f, 'dedup flag raised');
  assert.equal(f.reason, DEDUP_REASON);
  assert.equal(f._dedupPanelId, 'FRONT_WING');
  assert.equal(f.panelId, undefined);
});

test('charged panel: the dedup flag seeds nothing; the bumper-off flag\'s own wording is the line', () => {
  const out = seedChecklistFromFlags('1. Model item.', [dedup(), BUMPER_OFF], { chargedPanelIds: new Set(['FRONT_WING']) });
  assert.ok(!/could not be confirmed/.test(out), out);
  assert.ok(out.includes(`2. ${BUMPER_OFF.reason}`), out);
});

test('uncharged panel (or no charged set): the dedup flag seeds its line as before', () => {
  const out = seedChecklistFromFlags('1. Model item.', [dedup()], { chargedPanelIds: new Set() });
  assert.ok(out.includes('2. Show Front wing close-up — could not be confirmed from the listing photographs.'), out);
  assert.ok(seedChecklistFromFlags('1. x', [dedup()]).includes('could not be confirmed'), 'default unchanged');
  // other _gateGenerated flags are untouched
  const other = { partName: 'Bracket', zone: 'front', weight: 'medium', reason: 'x', _gateGenerated: true };
  assert.ok(seedChecklistFromFlags('1. x', [other], { chargedPanelIds: new Set(['FRONT_WING']) }).includes('Show Bracket close-up — could not be confirmed'));
});

test('the route builds the charged set with isChargedRow (rule 7) and passes it to the seed', () => {
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  assert.ok(src.includes("const chargedPanelIds = new Set((assessment._reconciledParts || []).filter(isChargedRow).map(r => r.panelId).filter(Boolean));"));
  assert.ok(/seedChecklistFromFlags\(checklistText, buyerFlags, \{ lampTier2Fired: !!lampResult\?\.tier2Fired, chargedPanelIds \}\)/.test(src));
});

// ── LC72NZV stored row ──
test('C4: the dedup flag reaches no buyer surface — buildBuyerFlags (Inspection Flags, checklist seed, PDF) and the cards drop it; _flaggedParts keeps it', () => {
  assert.equal(GATE_DEDUP_REASON, DEDUP_REASON);
  const legacy = { partName: 'Front wing', zone: 'front', weight: 'medium', reason: DEDUP_REASON, _gateGenerated: true };   // stored before the B5 mark
  for (const f of [dedup(), legacy]) assert.equal(isGateDedupFlag(f), true);
  assert.equal(isGateDedupFlag(BUMPER_OFF), false);
  const a = { _flaggedParts: [dedup(), legacy, BUMPER_OFF] };
  assert.deepEqual(buildBuyerFlags(a), [BUMPER_OFF]);
  assert.equal(a._flaggedParts.length, 3, 'kept internally');
  const cards = buildDamageCards({ gatedParts: [], flaggedParts: a._flaggedParts });
  assert.ok(!cards.some(c => c.note === DEDUP_REASON), 'no card');
  assert.ok(cards.some(c => c.note === BUMPER_OFF.reason));
  for (const f of ['app/salvage/success/page.js', 'app/api/salvage/pdf/route.js']) assert.ok(readFileSync(f, 'utf8').includes('buildBuyerFlags(assessment)'), `${f} reads the flags through buildBuyerFlags`);
  assert.ok(readFileSync('app/api/salvage/assess/route.js', 'utf8').includes('const buyerFlags = buildBuyerFlags(assessment);'), 'the checklist seed reads buildBuyerFlags');
});

const FIX_PATH = 'fixtures/b248/lc72nzv-row.json';
const ROW = existsSync(FIX_PATH) ? JSON.parse(readFileSync(FIX_PATH, 'utf8')) : null;
const SKIP = ROW ? false : `${FIX_PATH} is not on disk (production-row data, kept out of git) — fixture test skipped`;
if (SKIP) console.log(`SKIP: ${SKIP}`);

test('LC72NZV: checklist 17 "could not be confirmed" goes; the bumper-off "check the wing … strike the line" line arrives', { skip: SKIP }, () => {
  const a = ROW.assessment;
  const stored = a['WhatsApp Inspection Checklist'];
  assert.ok(stored.includes('17. Show Front wing close-up — could not be confirmed from the listing photographs.'), 'stored run had the line');
  // pre-seed text: the model + lamp items (1-9); flags as stored, the dedup one marked as the gate now marks it
  const pre = stored.split('\n').filter(l => { const n = parseInt(l, 10); return n >= 1 && n <= 9; }).join('\n');
  const flags = a._flaggedParts.map(f => /^duplicate part row excluded/.test(f.reason || '') ? { ...f, _gateDedup: true, _dedupPanelId: 'FRONT_WING' } : f);
  const charged = new Set(a._reconciledParts.filter(isChargedRow).map(r => r.panelId).filter(Boolean));
  assert.ok(charged.has('FRONT_WING'));
  const out = seedChecklistFromFlags(pre, flags, { lampTier2Fired: true, chargedPanelIds: charged });
  assert.ok(!/Front wing close-up — could not be confirmed/.test(out), out);
  assert.equal(out.split('\n').filter(l => l.includes('check the wing on inspection and strike the line if it is sound')).length, 1, out);
});

test('C4 LC72NZV stored row: the "Front wing" dedup flag (stored before the mark) is gone from Inspection Flags, kept in _flaggedParts', { skip: SKIP }, () => {
  const a = structuredClone(ROW.assessment);
  assert.equal(a._flaggedParts.filter(isGateDedupFlag).length, 1);
  assert.ok(!buildBuyerFlags(a).some(f => f.reason === DEDUP_REASON));
});
