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
import { CONFIRM_SYSTEM, CONFIRM_ACTION, COUNT_PANELS, confirmQuestion, parseConfirmOutput, applyConfirmations, notesPanels,
  noteMinimum, applyNoteMinimum, withNoteAdditions, NOTE_KEYWORDS, cornerMinimums } from '../lib/notesConfirm.mjs';
import { stampCopartNotes, notesConcernLines, keysFromNotes, copartNotesCodeLines, CODE_LINE_WORDING, NOTES_FALLBACK_LINE } from '../lib/copartNotes.mjs';
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
  // batch 242 Part 4: question strings pinned word for word.
  assert.equal(confirmQuestion('SIDE_GLASS').split('\n')[0], 'How many door or side windows are broken, shattered or missing in these photos? Count a window as broken if its frame is empty or glass fragments are visible inside the car. Answer only from what you can see in the photos. Reply 0 if none.');
  assert.equal(confirmQuestion('FRONT_DOOR').split('\n')[0], 'How many front doors are damaged or missing in these photos? Answer only from what you can see. Reply 0 if none.');
  assert.equal(confirmQuestion('BONNET').split('\n')[0], 'Is the bonnet damaged or missing in any of these photos? Answer only from what you can see in the photos.');
  for (const [id, label] of [['WINDSCREEN', 'windscreen'], ['REAR_GLASS', 'rear glass'], ['CREW_WINDOW', 'crew window'], ['BODY_SIDE_GLAZING', 'body-side glazing'], ['CAB_REAR_GLASS', 'cab rear glass']]) {
    assert.equal(confirmQuestion(id).split('\n')[0], `Is the ${label} broken, shattered or missing in any of these photos? Count it as broken if the frame is empty or glass fragments are visible. Answer only from what you can see in the photos.`, id);
  }
  // Code-owned plurals: every counted panel (bar SIDE_GLASS's fixed question) has one; no generated "+s" anywhere.
  const PLURALS = { FRONT_DOOR: 'front doors', REAR_DOOR: 'rear doors', FRONT_WING: 'front wings', REAR_QUARTER: 'rear quarter panels',
    SILL: 'sills', SIDE_SKIRT: 'side skirts', DOOR_MIRROR: 'door mirrors', HEADLAMP: 'headlamps', REAR_LAMP: 'rear lamps', FOG_LAMP: 'fog lamps' };
  assert.deepEqual([...COUNT_PANELS].filter(id => id !== 'SIDE_GLASS').sort(), Object.keys(PLURALS).sort());
  for (const [id, pl] of Object.entries(PLURALS)) {
    assert.equal(confirmQuestion(id).split('\n')[0], `How many ${pl} are damaged or missing in these photos? Answer only from what you can see. Reply 0 if none.`, id);
  }
  for (const id of Object.keys(CONFIRM_ACTION)) assert.doesNotMatch(confirmQuestion(id), /glasss|ss are|\bdamaged in\b/, id);
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

// ── Part 9 (Vincent, 3 Nov: "notes"): the note sets the minimum count, the photos confirm ─────────────────────────
// Runs one note line through code end to end at the band: reader read → code additions → note minimum → ledger add.
function costNote(line, panels, photo, { yesNo = {} } = {}) {
  const read = withNoteAdditions({ fallback: false, lines: [{ line, kind: 'concern', panels }] });
  const asked = read.lines[0].panels;
  const answers = asked.map(id => COUNT_PANELS.has(id)
    ? { panelId: id, count: photo[id] ?? 0, verdict: 'count', photos: [] }
    : { panelId: id, count: yesNo[id] ? 1 : 0, verdict: yesNo[id] ? 'yes' : 'no', photos: [] });
  const final = applyNoteMinimum(answers, read, { log: () => {} });
  const parts = [];
  applyConfirmations({ gatedParts: parts, answers: final, bandKey: 'Upper-exec', priceTable: PANEL_PRICE_TABLE, isCharged: isChargedRow, log: () => {} });
  const n = (id) => parts.filter(r => r.panelId === id).length;
  return { read, final, parts, n };
}
test('Part 9 cases 1-9: note minimum × photo count → costed count', () => {
  const W = 'NSF AND WINDOWS SMASHED';
  assert.equal(costNote(W, ['SIDE_GLASS'], { SIDE_GLASS: 1 }).n('SIDE_GLASS'), 2, 'case 1');
  const c2 = costNote(W, ['SIDE_GLASS'], { SIDE_GLASS: 0 });
  assert.equal(c2.n('SIDE_GLASS'), 0, 'case 2'); assert.equal(c2.final[0].noteMin, 2); assert.equal(c2.final[0].count, 0);
  assert.equal(costNote(W, ['SIDE_GLASS'], { SIDE_GLASS: 3 }).n('SIDE_GLASS'), 3, 'case 3');
  assert.equal(costNote('WINDOW SMASHED', ['SIDE_GLASS'], { SIDE_GLASS: 1 }).n('SIDE_GLASS'), 1, 'case 4');
  for (const l of ['3 WINDOWS SMASHED', 'THREE WINDOWS SMASHED']) assert.equal(costNote(l, ['SIDE_GLASS'], { SIDE_GLASS: 1 }).n('SIDE_GLASS'), 3, `case 5 ${l}`);
  const c6 = costNote('NSF AND NSR DOORS WONT OPEN DUE TO DAMAGE', ['FRONT_DOOR', 'REAR_DOOR'], { FRONT_DOOR: 1, REAR_DOOR: 1 });
  assert.deepEqual([c6.n('FRONT_DOOR'), c6.n('REAR_DOOR')], [1, 1], 'case 6: "DOORS" is shared, not a plural of either');
  const c7 = costNote(W, ['FRONT_WING', 'SIDE_GLASS'], { FRONT_WING: 1, SIDE_GLASS: 1 });
  assert.equal(c7.n('FRONT_WING'), 1, 'case 7: WINDOWS is not the wing keyword'); assert.equal(c7.n('SIDE_GLASS'), 2);
  const c8 = costNote('5 WINDOWS SMASHED', ['SIDE_GLASS'], { SIDE_GLASS: 1 });
  assert.equal(c8.n('SIDE_GLASS'), 4, 'case 8: cap'); assert.equal(c8.final[0].noteMin, 5);
  const c9 = costNote('ALL WINDOWS SMASHED', ['SIDE_GLASS'], { SIDE_GLASS: 1 }, { yesNo: { WINDSCREEN: true, REAR_GLASS: false } });
  assert.deepEqual(c9.read.lines[0].panels, ['SIDE_GLASS', 'WINDSCREEN', 'REAR_GLASS'], 'case 9: code adds the screens');
  assert.deepEqual(c9.read.lines[0].codePanels, ['WINDSCREEN', 'REAR_GLASS']);
  assert.deepEqual([c9.n('SIDE_GLASS'), c9.n('WINDSCREEN'), c9.n('REAR_GLASS')], [4, 1, 0], 'case 9');
  for (const r of c9.parts) assert.equal(r.action, 'replace');
});
test('Part 9: noteMinimum rules, the additions, single-instance unchanged, logged', () => {
  assert.equal(noteMinimum('NSF AND WINDOWS SMASHED', 'FRONT_WING'), 1);
  assert.equal(noteMinimum('NSF AND OSF WINGS DAMAGED', 'FRONT_WING'), 2);
  assert.equal(noteMinimum('2 FRONT DOORS DAMAGED', 'FRONT_DOOR'), 2);
  assert.equal(noteMinimum('BOTH REAR DOORS DAMAGED', 'REAR_DOOR'), 2);
  assert.equal(noteMinimum('NSF AND NSR DOORS WONT OPEN', 'REAR_DOOR'), 1);
  assert.equal(noteMinimum('TWO SIDE WINDOWS BROKEN', 'SIDE_GLASS'), 2);
  assert.equal(noteMinimum('ALL WINDOWS SMASHED', 'SIDE_GLASS'), 4);
  assert.equal(noteMinimum('WINDSCREEN CRACKED', 'SIDE_GLASS'), 1, 'WINDSCREEN is not WINDOW');
  assert.equal(noteMinimum('ANYTHING', 'BONNET'), 1, 'no keyword table → 1');
  assert.deepEqual(Object.keys(NOTE_KEYWORDS).sort(), [...COUNT_PANELS].sort(), 'one keyword row per counted panel');
  // no additions without "ALL WINDOWS", on spec lines, or on a fallback read
  assert.equal(withNoteAdditions({ fallback: false, lines: [{ line: 'WINDOWS SMASHED', kind: 'concern', panels: ['SIDE_GLASS'] }] }).lines[0].codePanels, undefined);
  assert.equal(withNoteAdditions({ fallback: false, lines: [{ line: 'ALL WINDOWS TINTED', kind: 'spec', panels: [] }] }).lines[0].panels.length, 0);
  const fb = fallbackRead(['ALL WINDOWS SMASHED'], 'x');
  assert.deepEqual(withNoteAdditions(fb), fb);
  // already named by the reader → not added twice
  assert.deepEqual(withNoteAdditions({ fallback: false, lines: [{ line: 'ALL WINDOWS SMASHED', kind: 'concern', panels: ['SIDE_GLASS', 'WINDSCREEN'] }] }).lines[0].codePanels, ['REAR_GLASS']);
  const logs = [];
  const out = applyNoteMinimum([{ panelId: 'SIDE_GLASS', count: 1, photos: [8] }, { panelId: 'BONNET', count: 1, verdict: 'yes', photos: [] }],
    { lines: [{ line: 'NSF AND WINDOWS SMASHED', kind: 'concern', panels: ['SIDE_GLASS'] }] }, { log: (m) => logs.push(m) });
  assert.deepEqual(out[0], { panelId: 'SIDE_GLASS', count: 2, photos: [8], photoCount: 1, noteMin: 2 });
  assert.deepEqual(out[1], { panelId: 'BONNET', count: 1, verdict: 'yes', photos: [] }, 'single-instance unchanged');
  assert.deepEqual(logs, ['[NOTES CONFIRM] SIDE_GLASS photos=1 noteMin=2 → costed count 2']);
});

// ── Part 10 (Vincent, 3 Nov): "ALL WINDOWS" adds side glass; Copart corner codes count doors and wings ──────────────
test('Part 10 cases 10-18: corner codes count, ALL WINDOWS adds side glass, codes only raise', () => {
  const c10 = costNote('NSF AND OSF DOORS DAMAGED', ['FRONT_DOOR'], { FRONT_DOOR: 1 });
  assert.equal(c10.n('FRONT_DOOR'), 2, 'case 10'); assert.equal(c10.n('REAR_DOOR'), 0, 'case 10: no rear code → no rear door');
  assert.equal(c10.read.lines[0].codePanels, undefined, 'case 10: no rear code → nothing added');
  const c11 = costNote('OSF OSR DOORS WONT OPEN', ['FRONT_DOOR', 'REAR_DOOR'], { FRONT_DOOR: 1, REAR_DOOR: 1 });
  assert.deepEqual([c11.n('FRONT_DOOR'), c11.n('REAR_DOOR')], [1, 1], 'case 11');
  const c12 = costNote('NSF NSR OSF OSR DOORS DAMAGED', ['FRONT_DOOR', 'REAR_DOOR'], { FRONT_DOOR: 1, REAR_DOOR: 1 });
  assert.deepEqual([c12.n('FRONT_DOOR'), c12.n('REAR_DOOR')], [2, 2], 'case 12');
  assert.equal(costNote('N/S/F AND O/S/F WINGS DAMAGED', ['FRONT_WING'], { FRONT_WING: 1 }).n('FRONT_WING'), 2, 'case 13');
  const c14 = costNote('NSR AND OSR WINGS DAMAGED', [], { REAR_QUARTER: 1 });
  assert.deepEqual(c14.read.lines[0].codePanels, ['REAR_QUARTER'], 'case 14: added by code');
  assert.equal(c14.n('REAR_QUARTER'), 2, 'case 14'); assert.equal(c14.n('FRONT_WING'), 0);
  const c15 = costNote('NSF AND OSF DOORS DAMAGED', ['FRONT_DOOR'], { FRONT_DOOR: 0 });
  assert.equal(c15.n('FRONT_DOOR'), 0, 'case 15: flag stays'); assert.equal(c15.final[0].noteMin, 2);
  const c16 = costNote('ALL WINDOWS SMASHED', ['WINDSCREEN'], { SIDE_GLASS: 1 }, { yesNo: { WINDSCREEN: true, REAR_GLASS: true } });
  assert.deepEqual(c16.read.lines[0].codePanels, ['SIDE_GLASS', 'REAR_GLASS'], 'case 16: side glass added by code');
  assert.deepEqual([c16.n('SIDE_GLASS'), c16.n('WINDSCREEN'), c16.n('REAR_GLASS')], [4, 1, 1], 'case 16');
  assert.equal(costNote('NSF AND WINDOWS SMASHED', ['SIDE_GLASS'], { SIDE_GLASS: 1 }).n('SIDE_GLASS'), 2, 'case 17');
  // case 18: the costed COUNT is 1 (codes ignored for a headlamp). The money is Part 11's: a headlamp is priced from the
  // lot's resolved lamp band (`lamp`), which this helper does not pass — so no row here; see Part 11 cases 19-23.
  const c18 = costNote('NSF HEADLAMP SMASHED', ['HEADLAMP'], { HEADLAMP: 1 });
  assert.deepEqual([c18.final[0].count, c18.final[0].noteMin], [1, 1], 'case 18');
  assert.equal(PANEL_PRICE_TABLE.HEADLAMP, undefined); assert.equal(c18.n('HEADLAMP'), 0);
  // code forms + raise-only
  assert.deepEqual([...cornerMinimums('N S F AND O / S / F DOORS')], [['FRONT_DOOR', 2]]);
  assert.deepEqual([...cornerMinimums('NSF NSF DOORS')], [['FRONT_DOOR', 1]], 'distinct codes only');
  assert.deepEqual([...cornerMinimums('NSF HEADLAMP')], [], 'other panel words: codes ignored');
  assert.deepEqual([...cornerMinimums('DOORS DAMAGED')], [], 'no code → nothing');
  assert.equal(noteMinimum('NSF AND 3 WINDOWS SMASHED', 'SIDE_GLASS'), 3, 'codes never lower a stated number');
  assert.equal(noteMinimum('NSF NSR OSF WINDOWS', 'SIDE_GLASS'), 3, 'WINDOWS = total distinct codes');
  assert.equal(noteMinimum('NSF AND NSR DOORS WONT OPEN DUE TO DAMAGE', 'FRONT_DOOR'), 1, 'case 6 unchanged');
});

// No code-written buyer string carries a side: concern-line endings (the quoted note removed), ledger row names, the
// checklist lines code writes.
const SIDE_WORDS = /\b(NSF|OSF|NSR|OSR|N\/S|O\/S|nearside|near side|offside|off side|left|right)\b/i;
const codeWritten = (l) => l.replace(/"[^"]*"/, '""');
test('Part 10 guard: no side in any code-written buyer string (corner codes count only)', () => {
  const cases = [
    ['NSF AND OSF DOORS DAMAGED', ['FRONT_DOOR'], { FRONT_DOOR: 1 }], ['OSF OSR DOORS WONT OPEN', ['FRONT_DOOR', 'REAR_DOOR'], { FRONT_DOOR: 1, REAR_DOOR: 1 }],
    ['NSF NSR OSF OSR DOORS DAMAGED', ['FRONT_DOOR', 'REAR_DOOR'], { FRONT_DOOR: 1, REAR_DOOR: 1 }], ['N/S/F AND O/S/F WINGS DAMAGED', ['FRONT_WING'], { FRONT_WING: 1 }],
    ['NSR AND OSR WINGS DAMAGED', [], { REAR_QUARTER: 1 }], ['ALL WINDOWS SMASHED', ['WINDSCREEN'], { SIDE_GLASS: 1 }],
    ['NSF AND WINDOWS SMASHED', ['SIDE_GLASS'], { SIDE_GLASS: 1 }], ['NSF HEADLAMP SMASHED', ['HEADLAMP'], { HEADLAMP: 1 }],
  ];
  let checked = 0;
  for (const [line, panels, photo] of cases) {
    const c = costNote(line, panels, photo, { yesNo: { WINDSCREEN: true, REAR_GLASS: true } });
    for (const r of c.parts) { assert.doesNotMatch(r.name, SIDE_WORDS, `row name ${r.name}`); checked++; }
    const charged = new Map(); for (const r of c.parts) charged.set(r.panelId, (charged.get(r.panelId) || 0) + 1);
    for (const src of ['box', 'paste']) {
      const a = { 'Red Flags': '', 'WhatsApp Inspection Checklist': '' };
      stampCopartNotes(a, src === 'box' ? { copartNotes: line } : { rawCopartPaste: `Notes\n${line}` }, { notesRead: c.read, chargedCounts: charged, countPanels: COUNT_PANELS });
      for (const l of [...notesConcernLines(c.read, src, charged, COUNT_PANELS), ...a['Red Flags'].split('\n'), ...a['WhatsApp Inspection Checklist'].split('\n')].filter(Boolean)) {
        assert.doesNotMatch(codeWritten(l), SIDE_WORDS, `${src}: ${l}`); checked++;
      }
    }
  }
  console.log(`Part 10 guard: ${checked} code-written strings checked, none carries a side`);
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

// ── Part 11 (Vincent, 3 Nov: "fix first"): a confirmed headlamp is costed through the lot's lamp band ─────────────
const { resolveLampBand } = await import('@/app/api/salvage/assess/route.js');
const { reconcileParts } = await import('@/lib/parts.mjs');
const { HEADLAMP_BANDS } = await import('@/lib/lampBands.mjs');
const { applyEdits, ledgerHash } = await import('@/lib/ledgerEdits.mjs');
// The lamp the route passes in: the request-scope resolution (orphan path), exactly as route.js builds it.
const lampFrom = (spec, photo) => { const r = resolveLampBand(spec, photo); return { type: r.resolvedType, band: r.bandValue, assumed: r.lampTypeAssumed, tier2: false }; };
function confirmLamp(line, photoCount, lamp, engineRows = []) {
  const read = withNoteAdditions({ fallback: false, lines: [{ line, kind: 'concern', panels: ['HEADLAMP'] }] });
  const final = applyNoteMinimum([{ panelId: 'HEADLAMP', count: photoCount, verdict: 'count', photos: [] }], read, { log: () => {} });
  const parts = engineRows.map(r => ({ ...r }));
  const logs = [];
  const added = applyConfirmations({ gatedParts: parts, answers: final, bandKey: 'Upper-exec', priceTable: PANEL_PRICE_TABLE, isCharged: isChargedRow, lamp, log: (m) => logs.push(m) });
  return { final, parts, added, logs };
}
// An engine-made headlamp row, from reconcileParts itself (tier-2 insert) — the shape the confirmed row must match.
const engineLamp = (band) => reconcileParts([], { tier2Fired: true, lampAllowance: band, lampCount: 1 }, [], 0, null).parts.find(r => r._lampMandated);
const SHAPE = ['name', 'action', 'oem', 'used', '_inserted', '_lampMandated', '_band', '_modelLampCost'];
const shapeOf = (r) => Object.fromEntries(SHAPE.map(k => [k, r[k]]));

test('Part 11 cases 19-23: a confirmed headlamp is costed at the lot\'s lamp band, engine-row shape, repriced by the buyer\'s lamp edit', () => {
  // 19 — photo resolves halogen, nothing charged, photos yes → 1 row at the halogen band, same shape as an engine row
  const halo = lampFrom(null, 'halogen');
  assert.deepEqual([halo.type, halo.band, halo.assumed], ['halogen', HEADLAMP_BANDS.halogen, false]);
  const c19 = confirmLamp('NSF HEADLAMP SMASHED', 1, halo);
  assert.equal(c19.added.length, 1, 'case 19');
  const eng = engineLamp(HEADLAMP_BANDS.halogen);
  assert.ok(eng, 'reconcileParts made an engine headlamp row');
  assert.deepEqual(shapeOf(c19.added[0]), shapeOf(eng), 'case 19: same shape as an engine headlamp row');
  assert.equal(c19.added[0].panelId, 'HEADLAMP'); assert.equal(c19.added[0]._notesConfirmed, true);
  assert.equal(c19.added[0]._orphanAssumedDisclosure, undefined, 'type not assumed');
  assert.ok(isChargedRow(c19.added[0]));
  console.log(`Part 11 c19: row=${JSON.stringify(c19.added[0])} engine=${JSON.stringify(eng)}`);

  // 20 — unresolved → LED default, assumed; plural note → noteMin 2 → 2 rows, assumed marker as on an engine orphan row
  const unres = lampFrom(null, null);
  assert.deepEqual([unres.type, unres.band, unres.assumed], ['led', HEADLAMP_BANDS.led, true]);
  const c20 = confirmLamp('HEADLAMPS SMASHED', 1, unres);
  assert.equal(c20.added.length, 2, 'case 20'); assert.equal(c20.final[0].noteMin, 2);
  const orphan = reconcileParts([{ name: 'Headlamp', action: 'replace', used: 999 }], null, [], 0, null, unres.band, true, HEADLAMP_BANDS.led).parts.find(r => r._lampMandated);
  for (const r of c20.added) {
    assert.deepEqual([r.used, r._band, r._lampMandated], [HEADLAMP_BANDS.led, HEADLAMP_BANDS.led, true]);
    assert.equal(r._orphanAssumedDisclosure, true, 'case 20: the same "type assumed" marker the engine orphan row carries');
  }
  assert.equal(orphan._orphanAssumedDisclosure, true, 'engine orphan row carries it too');
  // on tier 2 the engine discloses from lampResult, not the row — the confirmed row follows the same split
  assert.equal(confirmLamp('HEADLAMP SMASHED', 1, { ...unres, tier2: true }).added[0]._orphanAssumedDisclosure, undefined);

  // 21 — hid, one engine headlamp already charged (an inserted row, no panelId), photos 1, plural note → noteMin 2 → add 1
  const hid = lampFrom(null, 'hid');
  const c21 = confirmLamp('NSF AND OSF HEADLAMPS SMASHED', 1, hid, [engineLamp(HEADLAMP_BANDS.hid)]);
  assert.equal(c21.final[0].noteMin, 2); assert.equal(c21.final[0].count, 2);
  assert.equal(c21.added.length, 1, 'case 21: cost the difference (2 − 1)');
  assert.equal(c21.added[0].used, HEADLAMP_BANDS.hid);
  assert.equal(c21.parts.filter(r => r._lampMandated).length, 2);
  // the engine row has no panelId — a panelId-only count would have added 2 (double charge)
  assert.equal(engineLamp(HEADLAMP_BANDS.hid).panelId, undefined);

  // 22 — photos say no → nothing, flag stays
  const c22 = confirmLamp('HEADLAMP SMASHED', 0, halo);
  assert.equal(c22.added.length, 0, 'case 22'); assert.equal(c22.parts.length, 0);

  // 23 — case 19's ledger, then the buyer corrects the lamp type to LED → the confirmed row reprices like an engine row
  const ledger = [...c19.parts, eng];
  const sum = ledger.reduce((t, r) => t + (r.used ?? r.oem ?? 0), 0);
  const ed = applyEdits({ _reconciledParts: ledger, _partsReconciliation: { parts_sum: sum } },
    { stamp: ledgerHash(ledger), strikes: [], adds: [], lampType: 'led' });
  assert.equal(ed.stampMismatch, false);
  const notesRow = ed.rows.find(r => r._notesConfirmed);
  const engRow = ed.rows.find(r => r._lampMandated && !r._notesConfirmed);
  assert.equal(notesRow.used, HEADLAMP_BANDS.led, 'case 23: repriced to the led band');
  assert.deepEqual(notesRow._lampTypeCorrected, engRow._lampTypeCorrected, 'case 23: exactly as the engine row');
  assert.deepEqual(notesRow._lampTypeCorrected, { from: HEADLAMP_BANDS.halogen, to: HEADLAMP_BANDS.led });
  assert.equal(ed.lampTypeCorrection.rowsRepriced, 2);
  // no band at all → nothing costed, logged
  const nob = confirmLamp('HEADLAMP SMASHED', 1, null);
  assert.equal(nob.added.length, 0); assert.ok(nob.logs.some(l => l.includes('HEADLAMP confirmed 1 but NOT costed — no resolved lamp band')));
});

// Part 11 end to end: the route hands the confirm step the lamp THIS lot's engine rows use. Two headlamps confirmed by
// the photos (count 2) on AMZ3790: whatever the engine already charged, the added rows sit at the engine's own lamp band.
const lampRun = await runLot({ notes: ['NUMBER OF KEYS 1', 'BOTH HEADLAMPS SMASHED'].join('\n'),
  readerReply: { lines: [{ n: 1, kind: 'spec', panels: [] }, { n: 2, kind: 'concern', panels: ['HEADLAMP'] }] },
  confirm: { HEADLAMP: { count: 2, photos: [1] } } });
test('Part 11 end to end: the route prices a confirmed headlamp at this lot\'s lamp band; total headlamps = 2; disclosure follows the engine', () => {
  assert.equal(lampRun.stats.missed, 0);
  const a = lampRun.assessment;
  const lamps = a._reconciledParts.filter(r => r._lampMandated && isChargedRow(r));
  const added = a._reconciledParts.filter(r => r._notesConfirmed && r._lampMandated);
  const engine = lamps.filter(r => !r._notesConfirmed);
  console.log(`Part 11 e2e: engine lamp rows=${JSON.stringify(engine.map(r => r.used))} added=${JSON.stringify(added.map(r => r.used))} log=${lampRun.logs.find(l => l.startsWith('[NOTES CONFIRM] HEADLAMP confirmed'))}`);
  assert.equal(lamps.length, 2, 'two headlamps in the money');
  const bands = new Set(lamps.map(r => r._band));
  assert.equal(bands.size, 1, 'one lamp band for every headlamp on the lot');
  assert.ok(Object.values(HEADLAMP_BANDS).includes([...bands][0]), 'the band is a lib/lampBands.mjs figure');
  const disclosed = (a['Inspection Flags'] || '') + JSON.stringify(a._buyerFlags || '') + (a['Red Flags'] || '');
  console.log(`Part 11 e2e: assumed-type disclosure present=${/Lamp type could not be confirmed/.test(disclosed)} (added row marker=${added.some(r => r._orphanAssumedDisclosure)})`);
  if (added.some(r => r._orphanAssumedDisclosure)) assert.match(disclosed, /Lamp type could not be confirmed/);
  console.log(`Part 11 e2e: engine lamp panelIds=${JSON.stringify(engine.map(r => r.panelId ?? null))} line → ${(a['Red Flags'] || '').split('\n').find(l => l.includes('HEADLAMPS SMASHED'))}`);
  assert.ok((a['Red Flags'] || '').includes('The auction notes say: "BOTH HEADLAMPS SMASHED". Auction notes can understate the problem — check before bidding. Costed in the repair breakdown: headlamp × 2.'));
});

// Part 9 end to end on the stored 577ecf56 answers (SIDE_GLASS 1, FRONT_WING 1, FRONT_DOOR 1, REAR_DOOR 1). The
// reference run is identical except its glass line says "WINDOW" (note minimum 1), so the only difference is the note.
const READ_577 = { lines: [
  { n: 1, kind: 'spec', panels: [] }, { n: 2, kind: 'spec', panels: [] }, { n: 3, kind: 'spec', panels: [] },
  { n: 4, kind: 'concern', panels: ['FRONT_DOOR', 'REAR_DOOR'] }, { n: 5, kind: 'concern', panels: ['FRONT_WING', 'SIDE_GLASS'] },
] };
const ANS_577 = { SIDE_GLASS: { count: 1, photos: [9] }, FRONT_WING: { count: 1, photos: [1, 10] }, FRONT_DOOR: { count: 1, photos: [1, 9] },
  REAR_DOOR: { count: 1, photos: [1, 4, 9] } };
const run577 = await runLot({ notes: LOT_LINES.join('\n'), readerReply: READ_577, confirm: ANS_577 });
const ref577 = await runLot({ notes: [...LOT_LINES.slice(0, 4), 'NSF AND WINDOW SMASHED'].join('\n'), readerReply: READ_577, confirm: ANS_577 });
test('Part 9 end to end (577ecf56 answers): a second side glass replace at the band; the glass line says × 2; nothing else moves', () => {
  for (const r of [run577, ref577]) assert.equal(r.stats.missed, 0);
  const band = run577.assessment._priceBandKey;
  const e = PANEL_PRICE_TABLE.SIDE_GLASS[band];
  const glass = (a) => a._reconciledParts.filter(r => r.panelId === 'SIDE_GLASS');
  console.log(`Part 9 e2e: band=${band} SIDE_GLASS rows ref=${JSON.stringify(glass(ref577.assessment).map(r => [r.action, r.used, r.oem]))} run=${JSON.stringify(glass(run577.assessment).map(r => [r.action, r.used, r.oem]))}`);
  assert.equal(glass(ref577.assessment).length, 1);
  assert.equal(glass(run577.assessment).length, 2);
  for (const r of glass(run577.assessment)) { assert.deepEqual([r.action, r.used, r.oem], ['replace', e.used, e.oem]); assert.ok(isChargedRow(r)); }
  const others = (a) => JSON.stringify(a._reconciledParts.filter(r => r.panelId && r.panelId !== 'SIDE_GLASS'));
  assert.equal(others(run577.assessment), others(ref577.assessment), 'no other panel row moves');
  const labourRow = (x) => JSON.stringify(x._reconciledParts.filter(r => !r.panelId));
  console.log(`Part 9 e2e: labour/no-panel rows ref=${labourRow(ref577.assessment)} run=${labourRow(run577.assessment)} parts_sum ref=${ref577.assessment.parts_sum} run=${run577.assessment.parts_sum}`);
  assert.equal(labourRow(run577.assessment), labourRow(ref577.assessment), 'labour row unchanged');
  const sg = run577.assessment._notesConfirm.answers.find(a => a.panelId === 'SIDE_GLASS');
  assert.deepEqual([sg.photoCount, sg.noteMin, sg.count], [1, 2, 2]);
  assert.ok(run577.logs.includes('[NOTES CONFIRM] SIDE_GLASS photos=1 noteMin=2 → costed count 2'));
  const rf = run577.assessment['Red Flags'];
  console.log(`Part 9 e2e: glass line → ${rf.split('\n').find(l => l.includes('WINDOWS SMASHED'))}`);
  assert.ok(rf.includes('The auction notes say: "NSF AND WINDOWS SMASHED". Auction notes can understate the problem — check before bidding. Costed in the repair breakdown: front wing × 1, side glass × 2.'));
  // Part 10: unchanged — doors 1 + 1, wing 1; no side in a code-written line or a notes-confirmed row
  assert.ok(rf.includes('The auction notes say: "NSF AND NSR DOORS WONT OPEN DUE TO DAMAGE". Auction notes can understate the problem — check before bidding. Costed in the repair breakdown: front door × 1, rear door × 1.'));
  const fin = Object.fromEntries(run577.assessment._notesConfirm.answers.map(x => [x.panelId, x.count]));
  assert.deepEqual(fin, { FRONT_DOOR: 1, REAR_DOOR: 1, FRONT_WING: 1, SIDE_GLASS: 2 });
  const codeLines = [...rf.split('\n'), ...run577.assessment['WhatsApp Inspection Checklist'].split('\n')].filter(l => l.includes('The auction notes say:'));
  assert.ok(codeLines.length >= 4);
  for (const l of codeLines) assert.doesNotMatch(codeWritten(l), SIDE_WORDS, l);
  for (const r of run577.assessment._reconciledParts.filter(r => r._notesConfirmed)) assert.doesNotMatch(r.name, SIDE_WORDS, r.name);
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
