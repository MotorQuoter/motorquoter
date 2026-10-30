// batch 242 — the notes reader (A), the concern-line promotion (B) and the narrow photo question (C). Guards D1-D8.
// £0: every model call is either served from the AMZ3790 cassette (--vision-fixture replay) or answered by a stub here.
// No live call can fire: a request that is neither a stubbed notes call nor a cassette hit throws (cassette MISS).
// The paid One Auto stack is the fixture seam; the Supabase keys are removed so nothing reaches the database.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-notes-reader.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCassette } from './lib/modelCassette.mjs';
import { readNotes, parseReaderOutput, fallbackRead, buildReaderBody, NOTES_READER_SYSTEM, READER_PANELS } from '../lib/notesReader.mjs';
import { CONFIRM_SYSTEM, CONFIRM_ACTION, COUNT_PANELS, confirmQuestion, parseConfirmOutput, applyConfirmations, notesPanels } from '../lib/notesConfirm.mjs';
import { stampCopartNotes, keysFromNotes, copartNotesCodeLines, CODE_LINE_WORDING, NOTES_FALLBACK_LINE } from '../lib/copartNotes.mjs';
import { applyGradeOwnsAction } from '../lib/labour.mjs';
import { isChargedRow } from '../lib/ledgerEdits.mjs';
import { PANEL_PRICE_TABLE } from '../lib/priceBand.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// ── The trigger lot's notes (73052816, BL72LFU, box) ─────────────────────────────────────────────────────────────
const LOT_LINES = ['NUMBER OF KEYS 1', 'TYRE KIT', 'CHARGING CABLES', 'NSF AND NSR DOORS WONT OPEN DUE TO DAMAGE', 'NSF AND WINDOWS SMASHED'];
const EXTRA = ['BONNET DAMAGED', 'UNDIAGNOSED NOISE FROM ENGINE', 'WONT START'];
// What a correct reader answers for these lines (the model's own judgement is only provable live — see the report).
const READ_REPLY = { lines: [
  { n: 1, kind: 'spec', panels: [] }, { n: 2, kind: 'spec', panels: [] }, { n: 3, kind: 'spec', panels: [] },
  { n: 4, kind: 'concern', panels: ['FRONT_DOOR', 'REAR_DOOR'] }, { n: 5, kind: 'concern', panels: ['SIDE_GLASS'] },
  { n: 6, kind: 'concern', panels: ['BONNET'] }, { n: 7, kind: 'concern', panels: [] }, { n: 8, kind: 'concern', panels: [] },
] };
const apiReply = (text, model = 'claude-haiku-4-5') => JSON.stringify({ model, content: [{ type: 'text', text }], stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 } });

// ── Unit: the reader ─────────────────────────────────────────────────────────────────────────────────────────────
test('A: the reader request carries the notes, the enum list, Haiku, and nothing else', () => {
  const b = buildReaderBody(LOT_LINES);
  assert.equal(b.model, 'claude-haiku-4-5');
  assert.equal(b.system, NOTES_READER_SYSTEM);
  const text = b.messages[0].content.map(c => c.text).join('');
  for (const l of LOT_LINES) assert.ok(text.includes(l), l);
  for (const p of ['SIDE_GLASS', 'FRONT_DOOR', 'REAR_DOOR']) assert.ok(READER_PANELS.includes(p) && text.includes(p), p);
  assert.ok(!READER_PANELS.includes('OTHER'));
  assert.ok(b.messages[0].content.every(c => c.type === 'text'), 'no image in the reader call');
});

test('D2: the trigger lot read → both damage lines concerns; glass names SIDE_GLASS; doors name FRONT_DOOR + REAR_DOOR', () => {
  const r = parseReaderOutput(JSON.stringify({ lines: READ_REPLY.lines.slice(0, 5) }), LOT_LINES);
  assert.deepEqual(r.lines.map(l => l.kind), ['spec', 'spec', 'spec', 'concern', 'concern']);
  assert.deepEqual(r.lines[3].panels, ['FRONT_DOOR', 'REAR_DOOR']);
  assert.deepEqual(r.lines[4].panels, ['SIDE_GLASS']);
});

test('A: strict parse — off-enum panels dropped, spec lines carry no panels, a missing line is a concern, no side survives', () => {
  const r = parseReaderOutput(JSON.stringify({ lines: [
    { n: 1, kind: 'spec', panels: ['BONNET'] }, { n: 2, kind: 'banana', panels: ['ENGINE', 'side_glass', 'NSF_DOOR'] },
  ] }), ['A', 'B', 'C']);
  assert.deepEqual(r.lines, [
    { line: 'A', kind: 'spec', panels: [] },
    { line: 'B', kind: 'concern', panels: ['SIDE_GLASS'] },
    { line: 'C', kind: 'concern', panels: [] },
  ]);
  assert.equal(parseReaderOutput('not json', ['A']), null);
  assert.equal(parseReaderOutput('{"lines": 3}', ['A']), null);
});

test('D4: reader failure (HTTP error, throw, timeout, refusal, unparseable, 529) → fallback read (no panels), logged', async () => {
  const fails = {
    http: async () => new Response('x', { status: 500 }),
    throw: async () => { throw new Error('network down'); },
    timeout: async (_u, init) => { await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))); },
    refusal: async () => new Response(JSON.stringify({ content: [], stop_reason: 'refusal', usage: {} }), { status: 200 }),
    garbage: async () => new Response(apiReply('I think line 4 is bad'), { status: 200 }),
  };
  for (const [name, fetchImpl] of Object.entries(fails)) {
    const logs = [];
    const r = await readNotes(LOT_LINES, { fetchImpl, timeoutMs: 50, log: (m) => logs.push(m) });
    assert.deepEqual(r, fallbackRead(LOT_LINES, r.why), name);
    assert.ok(r.fallback && r.lines.every(l => l.kind === 'concern' && l.panels.length === 0), name);
    assert.ok(logs.some(m => m.startsWith('[NOTES READER] fallback')), `${name}: ${logs.join(' | ')}`);
  }
  const ex = await readNotes(LOT_LINES, { fetchImpl: async () => new Response('', { status: 529 }),
    retry: async () => ({ res: null, exhausted: true }), log: () => {} });
  assert.ok(ex.fallback);
  let calls = 0;
  const none = await readNotes([], { fetchImpl: async () => { calls++; }, log: () => {} });
  assert.deepEqual(none.lines, []); assert.equal(calls, 0, 'no notes → no call');
});

// ── Unit: wording (B) ────────────────────────────────────────────────────────────────────────────────────────────
const READ = parseReaderOutput(JSON.stringify(READ_REPLY), [...LOT_LINES, ...EXTRA]);
test('B: every concern line promoted word for word with the fixed wording, by source; spec lines never', () => {
  const a = { 'Red Flags': '- model flag', 'WhatsApp Inspection Checklist': '1. model item' };
  const r = stampCopartNotes(a, { copartNotes: [...LOT_LINES, ...EXTRA].join('\n') }, { notesRead: READ });
  assert.deepEqual(r.concernLines, [
    'The auction notes say: "NSF AND NSR DOORS WONT OPEN DUE TO DAMAGE". Not costed. Auction notes can understate the problem — check before bidding.',
    'The auction notes say: "NSF AND WINDOWS SMASHED". Not costed. Auction notes can understate the problem — check before bidding.',
    'The auction notes say: "BONNET DAMAGED". Not costed. Auction notes can understate the problem — check before bidding.',
    'The auction notes say: "UNDIAGNOSED NOISE FROM ENGINE". Not costed. Auction notes can understate the problem — check before bidding.',
    'The auction notes say: "WONT START". Not costed. Auction notes can understate the problem — check before bidding.',
  ]);
  const rf = a['Red Flags'].split('\n');
  assert.equal(rf.length, 6); assert.equal(rf[5], '- model flag');
  assert.ok(!/KEYS|TYRE KIT|CHARGING CABLES/.test(a['Red Flags'] + a['WhatsApp Inspection Checklist']), 'spec never promoted');
  assert.match(a['WhatsApp Inspection Checklist'], /^1\. model item\n2\. The auction notes say: "NSF AND NSR DOORS/);
  // idempotent
  const before = JSON.stringify(a);
  stampCopartNotes(a, { copartNotes: [...LOT_LINES, ...EXTRA].join('\n') }, { notesRead: READ });
  assert.equal(JSON.stringify(a), before);
  // paste source → Copart's name
  const p = stampCopartNotes({}, FIX.vehicleDetails,   // AMZ3790's real paste: source 'paste'
    { notesRead: { lines: [{ line: 'ENGINE WILL NOT START - REASON UNKNOWN', kind: 'concern', panels: [] }] } });
  assert.equal(p.source, 'paste');
  assert.deepEqual(p.concernLines, ['Copart\'s notes say: "ENGINE WILL NOT START - REASON UNKNOWN". Not costed. Auction notes can understate the problem — check before bidding.']);
});

test('B (Part 3): a costed panel ends with Costed in the repair breakdown: <label> × <n>.; count only on multi-instance; never a side', () => {
  const a = {};
  const r = stampCopartNotes(a, { copartNotes: [...LOT_LINES, ...EXTRA].join('\n') }, { notesRead: READ,
    chargedCounts: new Map([['SIDE_GLASS', 2], ['FRONT_DOOR', 1], ['BONNET', 1]]), countPanels: COUNT_PANELS });
  assert.equal(r.concernLines[0], 'The auction notes say: "NSF AND NSR DOORS WONT OPEN DUE TO DAMAGE". Auction notes can understate the problem — check before bidding. Costed in the repair breakdown: front door × 1.');
  assert.equal(r.concernLines[1], 'The auction notes say: "NSF AND WINDOWS SMASHED". Auction notes can understate the problem — check before bidding. Costed in the repair breakdown: side glass × 2.');
  assert.equal(r.concernLines[2], 'The auction notes say: "BONNET DAMAGED". Auction notes can understate the problem — check before bidding. Costed in the repair breakdown: bonnet.');
  assert.ok(!/\b(NS|OS|nearside|offside|left|right)\b/i.test(r.concernLines.map(l => l.split('". ')[1]).join(' ')), 'no side in our words');
});

test('B: pyro + stolen code lines unchanged and still first; Cat A/B stop line stays on top', () => {
  const lines = ['PYRO FUSES BYPASSED FOR INSPECTION', 'STOLEN RECOVERED VEHICLE'];
  assert.deepEqual(copartNotesCodeLines(lines, 'box'), [CODE_LINE_WORDING.PYRO.neutral, CODE_LINE_WORDING.STOLEN.neutral]);
  const a = { 'Red Flags': '- STOP LINE\n- model' };
  stampCopartNotes(a, { copartNotes: lines.join('\n') }, { catABStopLine: 'STOP LINE',
    notesRead: fallbackRead(lines) });
  const rf = a['Red Flags'].split('\n');
  assert.equal(rf[0], '- STOP LINE');
  assert.equal(rf[1], `- ${CODE_LINE_WORDING.PYRO.neutral}`);
  assert.equal(rf[2], `- ${CODE_LINE_WORDING.STOLEN.neutral}`);
  assert.equal(rf[3], `- ${NOTES_FALLBACK_LINE}`, 'reader fallback → one line, not each note');
  assert.equal(rf[4], '- model');
  assert.equal(rf.length, 5);
  // with no reader result, exactly the batch 202 behaviour
  const b = { 'Red Flags': '- model' };
  const r = stampCopartNotes(b, { copartNotes: lines.join('\n') });
  assert.deepEqual(r.concernLines, []);
  assert.equal(b['Red Flags'], `- ${CODE_LINE_WORDING.PYRO.neutral}\n- ${CODE_LINE_WORDING.STOLEN.neutral}\n- model`);
});

test('D3: spec lines ("NUMBER OF KEYS 1", a trim line) are not promoted; keys parsing unchanged', () => {
  const lines = ['NUMBER OF KEYS 1', 'ALLOY WHEEL SIZE 19" WHEELS'];
  const read = parseReaderOutput(JSON.stringify({ lines: [{ n: 1, kind: 'spec', panels: [] }, { n: 2, kind: 'spec', panels: [] }] }), lines);
  const a = { 'Red Flags': '- model' };
  const r = stampCopartNotes(a, { copartNotes: lines.join('\n') }, { notesRead: read });
  assert.deepEqual(r.concernLines, []);
  assert.equal(a['Red Flags'], '- model');
  assert.deepEqual(keysFromNotes(lines), { count: 1, secondSet: false });
  assert.deepEqual(notesPanels(read), []);
});

// ── Unit: the narrow question (C) ────────────────────────────────────────────────────────────────────────────────
test('C: code-owned questions — count form for multi-instance, yes/no otherwise; no note text', () => {
  assert.equal(confirmQuestion('SIDE_GLASS').split('\n')[0], 'How many side glass panels (door or side windows) are damaged in these photos? Answer only from what you can see. Reply 0 if none.');
  assert.equal(confirmQuestion('FRONT_DOOR').split('\n')[0], 'How many front doors are damaged in these photos? Answer only from what you can see. Reply 0 if none.');
  assert.equal(confirmQuestion('BONNET').split('\n')[0], 'Is the bonnet damaged in any of these photos? Answer only from what you can see in the photos.');
  assert.deepEqual(parseConfirmOutput('{"count":2,"photos":[5,9]}', 'SIDE_GLASS'), { panelId: 'SIDE_GLASS', count: 2, verdict: 'count', photos: [4, 8] });
  assert.equal(parseConfirmOutput('{"count":9,"photos":[]}', 'FRONT_DOOR').count, 2, 'capped at 2 doors');
  assert.equal(parseConfirmOutput('{"count":"cannot-tell","photos":[]}', 'SIDE_GLASS').count, 0);
  assert.equal(parseConfirmOutput('{"verdict":"yes","photos":[1]}', 'BONNET').count, 1);
  for (const t of ['{"verdict":"no"}', '{"verdict":"cannot-tell"}', 'garbage']) assert.equal(parseConfirmOutput(t, 'BONNET').count, 0, t);
  assert.deepEqual(notesPanels(READ), ['FRONT_DOOR', 'REAR_DOOR', 'SIDE_GLASS', 'BONNET']);
});

test('ruling 2: the action table — glass/lamps/mirror replace, body panels repair, nothing else', () => {
  const replace = Object.keys(CONFIRM_ACTION).filter(k => CONFIRM_ACTION[k] === 'replace').sort();
  const repair = Object.keys(CONFIRM_ACTION).filter(k => CONFIRM_ACTION[k] === 'repair').sort();
  console.log('ACTION TABLE replace:', replace.join(', '));
  console.log('ACTION TABLE repair :', repair.join(', '));
  assert.deepEqual(replace, ['BODY_SIDE_GLAZING', 'CAB_REAR_GLASS', 'CREW_WINDOW', 'DOOR_MIRROR', 'FOG_LAMP', 'HEADLAMP', 'REAR_GLASS', 'REAR_LAMP', 'SIDE_GLASS', 'WINDSCREEN']);
  assert.deepEqual(repair, ['BED_SIDE_L', 'BED_SIDE_R', 'BONNET', 'BOOT_LID', 'DROP_TAILGATE', 'FRONT_BUMPER', 'FRONT_DOOR', 'FRONT_WING', 'REAR_BUMPER', 'REAR_DOOR', 'REAR_QUARTER', 'ROOF', 'SIDE_SKIRT', 'SILL']);
  for (const k of ['WHEEL', 'TYRE', 'AIRBAG', 'FRONT_STRUCTURE', 'OTHER', 'RADIATOR_PACK']) assert.equal(CONFIRM_ACTION[k], undefined, k);
  // a confirmed replace row is never downgraded by applyGradeOwnsAction, even on a body panel with a MINOR grade
  const rows = [{ panelId: 'FRONT_DOOR', action: 'replace', used: 100, oem: 200, _notesConfirmed: true }];
  applyGradeOwnsAction(rows, new Map([['FRONT_DOOR', 'MINOR']]), new Map());
  assert.equal(rows[0].action, 'replace'); assert.equal(rows[0].used, 100);
});

test('D8: SIDE_GLASS count 2 → 0 charged adds 2 × replace at the band; 1 charged adds 1; 2 charged adds none', () => {
  const band = 'Upper-exec';
  const e = PANEL_PRICE_TABLE.SIDE_GLASS[band];
  assert.deepEqual(e, { oem: 235, used: 130 });
  const ans = [{ panelId: 'SIDE_GLASS', count: 2, verdict: 'count', photos: [4, 8] }];
  const glass = { panelId: 'SIDE_GLASS', name: 'Side glass', action: 'replace', used: 130, oem: 235 };
  for (const [have, expectAdd] of [[0, 2], [1, 1], [2, 0]]) {
    const parts = Array.from({ length: have }, () => ({ ...glass }));
    const added = applyConfirmations({ gatedParts: parts, answers: ans, bandKey: band, priceTable: PANEL_PRICE_TABLE, isCharged: isChargedRow, log: () => {} });
    assert.equal(added.length, expectAdd, `have ${have}`);
    assert.equal(parts.length, 2, `have ${have} → 2 charged after`);
    for (const r of added) assert.deepEqual([r.action, r.used, r.oem, r._notesConfirmed], ['replace', 130, 235, true]);
  }
  // count 0 / no band / no table entry → nothing
  const p = [];
  applyConfirmations({ gatedParts: p, answers: [{ panelId: 'SIDE_GLASS', count: 0 }], bandKey: band, priceTable: PANEL_PRICE_TABLE, isCharged: isChargedRow, log: () => {} });
  applyConfirmations({ gatedParts: p, answers: ans, bandKey: null, priceTable: PANEL_PRICE_TABLE, isCharged: isChargedRow, log: () => {} });
  assert.equal(p.length, 0);
});

// ── End to end: runAssessment on AMZ3790, cassette for the recorded calls, stubs for the two new calls ──────────
for (const line of readFileSync(resolve(ROOT, '.env.local'), 'utf8').split('\n')) {
  if (!line.includes('=') || line.trim().startsWith('#')) continue;
  const i = line.indexOf('='); const k = line.slice(0, i).trim();
  if (!(k in process.env)) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}
delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.NEXT_PUBLIC_SUPABASE_URL;   // nothing reaches the DB
const { runAssessment } = await import('@/app/api/salvage/assess/route.js');
const { __setOneAutoReplayProvider } = await import('@/lib/oneautoCache.js');
const DIR = resolve(ROOT, 'fixtures', 'AMZ3790');
const FIX = JSON.parse(readFileSync(resolve(DIR, 'fixture.json'), 'utf8'));
const IMAGES = readdirSync(resolve(DIR, 'images')).filter(f => /\.(jpe?g|png)$/i.test(f)).sort()
  .map(f => `data:image/jpeg;base64,${readFileSync(resolve(DIR, 'images', f)).toString('base64')}`);
const paid = FIX.paidFixtures || {};
const map = { BREGO_GB: paid.bregoValuation, BREGO_ROI: paid.bregoValuation, CAZANA_GB: paid.cazanaValuation ?? null,
  SALVAGEGUIDE: paid.salvageGuide, SALVAGEHISTORY: paid.salvageHistory };
__setOneAutoReplayProvider((t) => map[t] ?? null);

// readerReply: object (JSON answer) | 'fail' (HTTP 500). confirmCounts: panelId → answer object.
async function runLot({ notes, readerReply, confirm = {} }) {
  const cassette = installCassette({ mode: 'replay', cassettePath: resolve(DIR, 'model-cassette.json'), log: () => {} });
  const viaCassette = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (!/api\.anthropic\.com/.test(url || '')) return viaCassette(input, init);
    const body = JSON.parse(init.body);
    if (body.system === NOTES_READER_SYSTEM) {
      bodies.push({ kind: 'reader', body: init.body });
      return readerReply === 'fail' ? new Response('boom', { status: 500 }) : new Response(apiReply(JSON.stringify(readerReply)), { status: 200 });
    }
    if (body.system === CONFIRM_SYSTEM) {
      const q = body.messages[0].content.at(-1).text;
      const panelId = Object.keys(CONFIRM_ACTION).find(id => confirmQuestion(id) === q);
      bodies.push({ kind: 'confirm', panelId, body: init.body });
      return new Response(apiReply(JSON.stringify(confirm[panelId] ?? { count: 0, verdict: 'no', photos: [] }), 'claude-opus-4-8'), { status: 200 });
    }
    bodies.push({ kind: 'recorded', body: init.body });
    return viaCassette(input, init);
  };
  const logs = []; const origLog = console.log; const origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(' ')); console.warn = (...a) => logs.push(a.join(' '));
  let assessment;
  try {
    ({ assessment } = await runAssessment({ images: IMAGES, vd: { ...FIX.vehicleDetails, copartNotes: notes },
      market: FIX.market || 'GB', roiTier: FIX.vehicleDetails?.roiTier || 'roi_free' }));
  } finally {
    console.log = origLog; console.warn = origWarn;
    globalThis.fetch = viaCassette;
  }
  const stats = cassette.uninstall();
  return { assessment, bodies, stats, logs };
}
const ALL_NOTES = [...LOT_LINES, ...EXTRA].join('\n');
const ledger = (a) => JSON.stringify(a._reconciledParts);
const ALL_SPEC = { lines: [...LOT_LINES, ...EXTRA].map((_, i) => ({ n: i + 1, kind: 'spec', panels: [] })) };

const base = await runLot({ notes: ALL_NOTES, readerReply: ALL_SPEC });
const full = await runLot({ notes: ALL_NOTES, readerReply: READ_REPLY,
  confirm: { SIDE_GLASS: { count: 2, photos: [3, 4] }, FRONT_DOOR: { count: 1, photos: [2] }, REAR_DOOR: { count: 0, photos: [] },
    BONNET: { verdict: 'yes', photos: [1] } } });

test('D1: the notes text is in the reader prompt and NO other — every photo/assessment call is a cassette hit, the questions carry no note', () => {
  for (const run of [base, full]) {
    assert.equal(run.stats.missed, 0, 'a recorded call changed its body (notes leaked?)');
    assert.ok(run.stats.served >= 30, `served ${run.stats.served}`);
  }
  const readers = full.bodies.filter(b => b.kind === 'reader');
  assert.equal(readers.length, 1);
  for (const l of [...LOT_LINES, ...EXTRA]) assert.ok(readers[0].body.includes(l), `reader has "${l}"`);
  const others = full.bodies.filter(b => b.kind !== 'reader');
  console.log(`D1: ${others.length} other request bodies checked (${others.filter(b => b.kind === 'recorded').length} recorded photo/assessment calls, ${others.filter(b => b.kind === 'confirm').length} narrow questions)`);
  for (const b of others) for (const l of [...LOT_LINES, ...EXTRA]) assert.ok(!b.body.includes(l), `${b.kind}${b.panelId ? ' ' + b.panelId : ''} carries "${l}"`);
  for (const frag of ['WINDOWS SMASHED', 'WONT OPEN', 'UNDIAGNOSED NOISE']) assert.ok(!others.some(b => b.body.includes(frag)), frag);
});

test('C + rulings 1/4/5 end to end: count questions for SIDE_GLASS/FRONT_DOOR/REAR_DOOR; BONNET already charged is not asked', () => {
  const asked = full.bodies.filter(b => b.kind === 'confirm').map(b => b.panelId).sort();
  assert.deepEqual(asked, ['FRONT_DOOR', 'REAR_DOOR', 'SIDE_GLASS']);
  assert.ok(full.logs.includes('[NOTES CONFIRM] BONNET already charged — question skipped (ruling 5)'));
  const confirmBody = JSON.parse(full.bodies.find(b => b.kind === 'confirm').body);
  assert.equal(confirmBody.model, 'claude-opus-4-8');
  assert.equal(confirmBody.messages[0].content.filter(c => c.type === 'image').length, IMAGES.length);
});

test('D8 end to end: 2 × SIDE_GLASS replace at the band survive to the final ledger; FRONT_DOOR added as a repair; nothing else moves', () => {
  const band = full.assessment._priceBandKey;
  const e = PANEL_PRICE_TABLE.SIDE_GLASS[band];
  const glass = full.assessment._reconciledParts.filter(r => r.panelId === 'SIDE_GLASS');
  console.log(`D8 e2e: band=${band} SIDE_GLASS rows=${JSON.stringify(glass.map(r => [r.action, r.used, r.oem]))}`);
  assert.equal(glass.length, 2);
  for (const r of glass) { assert.equal(r.action, 'replace'); assert.equal(r.used, e.used); assert.equal(r.oem, e.oem); assert.ok(isChargedRow(r)); }
  const door = full.assessment._reconciledParts.filter(r => r.panelId === 'FRONT_DOOR');
  assert.equal(door.length, 1); assert.equal(door[0].action, 'repair'); assert.ok(isChargedRow(door[0]));
  const lab = (a) => a._reconciledParts.find(r => !r.panelId);
  console.log(`D8 e2e: FRONT_DOOR row=${JSON.stringify(door[0])} labour ${JSON.stringify(lab(base.assessment)?.oem ?? lab(base.assessment)?.used)} → ${JSON.stringify(lab(full.assessment)?.oem ?? lab(full.assessment)?.used)}`);
  assert.equal(full.assessment._reconciledParts.filter(r => r.panelId === 'REAR_DOOR').length, 0, 'count 0 → nothing');
  // every other row is the baseline's row
  const strip = (a) => JSON.stringify(a._reconciledParts.filter(r => !['SIDE_GLASS', 'FRONT_DOOR'].includes(r.panelId) && r.panelId));
  assert.equal(strip(full.assessment), strip(base.assessment));
  assert.deepEqual([...full.assessment._notesConfirm.added].sort(), ['FRONT_DOOR', 'SIDE_GLASS', 'SIDE_GLASS']);
  const rf = full.assessment['Red Flags'];
  assert.ok(rf.includes('The auction notes say: "NSF AND WINDOWS SMASHED". Auction notes can understate the problem — check before bidding. Costed in the repair breakdown: side glass × 2.'));
  assert.ok(rf.includes('The auction notes say: "NSF AND NSR DOORS WONT OPEN DUE TO DAMAGE". Auction notes can understate the problem — check before bidding. Costed in the repair breakdown: front door × 1.'));
  assert.ok(rf.includes('The auction notes say: "BONNET DAMAGED". Auction notes can understate the problem — check before bidding. Costed in the repair breakdown: bonnet.'));
});

test('D5: mechanical concerns are promoted with no figure, no panel, no ledger row', () => {
  for (const run of [full]) {
    const rf = run.assessment['Red Flags'].split('\n');
    for (const l of ['UNDIAGNOSED NOISE FROM ENGINE', 'WONT START']) {
      const line = rf.find(x => x.includes(`"${l}"`));
      assert.equal(line, `- The auction notes say: "${l}". Not costed. Auction notes can understate the problem — check before bidding.`);
      assert.ok(!/£|\d/.test(line.replace(`"${l}"`, '')), 'no figure');
      assert.ok(run.assessment['WhatsApp Inspection Checklist'].includes(line.slice(2)));
    }
  }
  const mech = ['UNDIAGNOSED NOISE FROM ENGINE', 'WONT START'];
  return runLot({ notes: mech.join('\n'), readerReply: { lines: [{ n: 1, kind: 'concern', panels: [] }, { n: 2, kind: 'concern', panels: [] }] } })
    .then(run => {
      assert.equal(run.bodies.filter(b => b.kind === 'confirm').length, 0, 'no panel → no question');
      assert.equal(ledger(run.assessment), ledger(base.assessment), 'ledger identical');
      assert.equal(run.assessment['Red Flags'].split('\n').filter(l => l.includes('auction notes say')).length, 2);
    });
});

test('D4 end to end (Part 3): reader fails → ONE fallback line in Red Flags + checklist, no note line promoted, nothing asked, nothing costed', async () => {
  const run = await runLot({ notes: ALL_NOTES, readerReply: 'fail' });
  assert.ok(run.logs.some(l => l.startsWith('[NOTES READER] fallback')));
  assert.equal(run.bodies.filter(b => b.kind === 'confirm').length, 0);
  assert.equal(ledger(run.assessment), ledger(base.assessment));
  const rf = run.assessment['Red Flags'].split('\n');
  assert.equal(rf.filter(l => l.startsWith('- The auction notes say:')).length, 0, 'no note line promoted');
  assert.equal(rf.filter(l => l === `- ${NOTES_FALLBACK_LINE}`).length, 1);
  const ck = run.assessment['WhatsApp Inspection Checklist'];
  assert.equal(ck.split(NOTES_FALLBACK_LINE).length - 1, 1, 'once in the checklist');
  assert.ok(!/The auction notes say:/.test(ck));
  assert.deepEqual(run.assessment._copartNotes.lines, [...LOT_LINES, ...EXTRA], 'notes still shown as written');
  assert.equal(run.assessment._notesRead.fallback, true);
});

test('D6: a re-run carries the notes forward (rerun-submit) and runs the reader again', async () => {
  const rr = src('app/api/salvage/rerun-submit/route.js');
  assert.ok(/copartNotes: carryForwardNotes\(session\.vehicle_details\?\.copartNotes, vehicleDetails\?\.copartNotes\)/.test(rr));
  const route = src('app/api/salvage/assess/route.js');
  const fnStart = route.indexOf('export async function runAssessment(');
  const at = route.indexOf('const notesReadPromise = readNotes(copartNotes(enrichedVd).lines');
  assert.ok(fnStart > 0 && at > fnStart, 'the reader runs inside runAssessment, on every run');
  const again = await runLot({ notes: ALL_NOTES, readerReply: READ_REPLY, confirm: { SIDE_GLASS: { count: 2, photos: [] } } });
  assert.equal(again.bodies.filter(b => b.kind === 'reader').length, 1, 'second run → reader fired again');
});

test('D7: stored reports without the new stamp render as before — no surface reads the new fields; the stamp runs only at assessment', () => {
  for (const f of ['app/api/salvage/pdf/route.js', 'app/salvage/success/page.js', 'app/salvage/page.js']) {
    assert.ok(!/_notesRead|_notesConfirm|notesReader|notesConfirm/.test(src(f)), f);
  }
  const callers = ['app/api/salvage/pdf/route.js', 'app/salvage/success/page.js', 'app/api/salvage/rerun-submit/route.js']
    .filter(f => /stampCopartNotes\(/.test(src(f)));
  assert.deepEqual(callers, [], 'nothing re-stamps a stored report');
});
