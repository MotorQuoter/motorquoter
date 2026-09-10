// validate-perview-parse — batch 108 task A.
//
// WHY THIS FILE EXISTS. Batch 107 asked one question — "did the model emit one AIRBAG line for
// AMZ3790's cabin, or two?" — and the answer was unobtainable at ANY price. `parsePartVerdicts`
// dropped every line its grammar refused without a word, and the raw per-view text was never logged,
// returned or stored. So a malformed second bag line and a never-written second bag line produced
// byte-identical artefacts, and a causal claim got made on evidence that could not distinguish them.
//
// The fix is NOT tolerance. The grammar is deliberately strict and is UNCHANGED by this batch — a
// malformed line must still be dropped, because a half-understood damage record is worse than none.
// What changed is that the drop is now REPORTED (`unmatched`) and always logged by the caller.
//
// This validator pins both halves at once, on the LITERAL shipped function:
//   1. the 8 variants that parse today still parse to exactly the same objects  (no tolerance gained)
//   2. the 6 that fail land in `unmatched` VERBATIM and never in `costedParts`  (no evidence lost)
// The 14 variants are the ones executed in TASK-0 recon, 10 Sep, against this same function.
//
// ⛔ If a future change makes any of the 6 parse, that is a GRAMMAR change and needs a ruling —
// this file failing is the intended alarm, not an inconvenience to be re-baselined away.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePartVerdicts } from '@/app/api/salvage/assess/route.js';

const AIRBAG_OBJ = (over = {}) => ({
  panelId: 'AIRBAG',
  partName: 'SRS airbag (deployed)',
  zone: 'interior',
  independentlyVisible: true,
  severity: 'SEVERE',
  partHeight: null,
  srsPosition: 'passenger',
  ...over,
});

// ── 1. THE EIGHT THAT MATCH — pinned to the exact objects, not merely to "it parsed" ─────────────
// A test that only asserted costedParts.length === 1 would pass while the fields silently rotted.
const MATCHING = [
  ['baseline control (contract form)',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:passenger',        AIRBAG_OBJ()],
  ['sev omitted — sev is the one optional field the grammar allows to vanish',
   'PART: AIRBAG | iv:true | z:interior | pos:passenger',                     AIRBAG_OBJ({ severity: null })],
  ['pos:Passenger — the regex is case-insensitive and posRaw is lowercased',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:Passenger',        AIRBAG_OBJ()],
  ['z:front not z:interior — zone is carried, never corrected',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:front | pos:passenger',           AIRBAG_OBJ({ zone: 'front' })],
  ['ph AND pos, in contract order',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | ph:mid | pos:passenger', AIRBAG_OBJ({ partHeight: 'mid' })],
  ['driver line, contract form',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:driver',           AIRBAG_OBJ({ srsPosition: 'driver' })],
  ['no pos at all — the pre-batch-107 form still parses, srsPosition null',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:interior',                        AIRBAG_OBJ({ srsPosition: null })],
  ['a non-AIRBAG panel — pos is AIRBAG-only, null everywhere else',
   'PART: FRONT_BUMPER | iv:true | sev:MODERATE | z:front',
   { panelId: 'FRONT_BUMPER', partName: 'Front bumper', zone: 'front', independentlyVisible: true,
     severity: 'MODERATE', partHeight: null, srsPosition: null }],
];

for (const [name, line, expected] of MATCHING) {
  test(`MATCHES: ${name}`, () => {
    const r = parsePartVerdicts(line);
    assert.equal(r.costedParts.length, 1, 'should produce exactly one costed record');
    assert.deepEqual(r.costedParts[0], expected);
    assert.deepEqual(r.unmatched, [], 'a line that parsed must never also be reported unmatched');
  });
}

// ── 2. THE SIX THAT FAIL — must be DROPPED and REPORTED, both, every time ────────────────────────
// Each of these is a plausible thing a model actually writes. Before batch 108 all six vanished
// without trace; the AMZ3790 second bag may well have been one of them — unprovably, which is the
// whole point. They must keep failing (grammar unchanged) and must now always surface.
const FAILING = [
  ['pos: passenger — ONE SPACE after the colon kills the ENTIRE line, not just the position',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos: passenger'],
  ['pos placed before ph — field ORDER is rigid',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:passenger | ph:mid'],
  ['pos:front-passenger — the enum admits bare `passenger` only',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:front-passenger'],
  ['pos:passenger-front — the same compound, the other way round',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:passenger-front'],
  ['trailing text after pos — the regex is anchored, annotation is fatal',
   'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:passenger (dash top)'],
  ['markdown-bulleted line — the model formatting its answer as a list',
   '- PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:passenger'],
];

for (const [name, line] of FAILING) {
  test(`DROPPED but REPORTED: ${name}`, () => {
    const r = parsePartVerdicts(line);
    assert.deepEqual(r.costedParts, [], 'a refused line must NEVER reach costedParts');
    assert.deepEqual(r.flaggedParts, [], 'nor flaggedParts');
    assert.deepEqual(r.unmatched, [line.trim()], 'and must be reported VERBATIM, exactly once');
  });
}

test('a backtick-wrapped line is refused and reported (7th TASK-0 failing variant)', () => {
  const line = '`PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:passenger`';
  const r = parsePartVerdicts(line);
  assert.deepEqual(r.costedParts, []);
  assert.deepEqual(r.unmatched, [line]);
});

// ── 3. THE FAILURE SHAPE THAT STARTED THIS — one bag survives, one dies, and now we SEE it ───────
test('THE AMZ3790 SHAPE: driver parses, passenger is refused — and no longer vanishes', () => {
  const raw = [
    'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:driver',
    'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:front-passenger',
  ].join('\n');
  const r = parsePartVerdicts(raw);
  // The engine's observable behaviour is UNCHANGED — still one bag, still positions=[driver] …
  assert.equal(r.costedParts.length, 1);
  assert.equal(r.costedParts[0].srsPosition, 'driver');
  // … but the second bag is now on the record instead of being indistinguishable from silence.
  assert.deepEqual(r.unmatched, ['PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:front-passenger']);
});

test('both bags well-formed → two records, nothing unmatched (batch 107 plumbing still works)', () => {
  const raw = [
    'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:driver',
    'PART: AIRBAG | iv:true | sev:SEVERE | z:interior | pos:passenger',
  ].join('\n');
  const r = parsePartVerdicts(raw);
  assert.deepEqual(r.costedParts.map(c => c.srsPosition), ['driver', 'passenger']);
  assert.deepEqual(r.unmatched, []);
});

// ── 4. HV: LINES ARE HANDLED, NOT LOST — so they must never be reported unmatched ────────────────
// The contract asks for exactly one HV: line per photo with three legal values (route.js :1772).
// parseHvLines reads it on a separate pass and returns false for `absent`/`na` BY DESIGN. Reporting
// those as UNPARSED would fire on essentially every view and drown the signal A1 exists to give.
for (const v of ['visible', 'absent', 'na']) {
  test(`HV: ${v} — a legal HV line is never reported unmatched`, () => {
    const r = parsePartVerdicts(`HV: ${v}`);
    assert.deepEqual(r.unmatched, [], `HV: ${v} is contract-legal and fully handled`);
    assert.deepEqual(r.costedParts, []);
  });
}

test('HV: lines are case-insensitive and tolerate surrounding whitespace', () => {
  assert.deepEqual(parsePartVerdicts('   hv:  NA   ').unmatched, []);
});

test('a MALFORMED HV: line IS reported — the observation was intended and did not register', () => {
  const r = parsePartVerdicts('HV: yes');
  assert.deepEqual(r.unmatched, ['HV: yes'], 'an HV value outside the contract is lost evidence');
});

// ── 5. A REAL PER-VIEW BLOCK — the mixed case, end to end ────────────────────────────────────────
// Lifted verbatim from fixtures/AMZ3790/model-cassette.json (the 8 Sep interior view), with one
// malformed line spliced in. Proves the three arrays partition the block with nothing double-counted.
test('a real cassette block plus one bad line: parses, flags nothing, reports exactly the bad line', () => {
  const raw = [
    'PART: AIRBAG | iv:true | sev:SEVERE | z:interior',
    'PART: WINDSCREEN | iv:false | sev:- | z:interior',
    'PART: SIDE_GLASS | iv:false | sev:- | z:interior',
    'PART: FRONT_DOOR | iv:na | sev:- | z:interior',
    'Looks like the cabin took a hit.',
    'HV: na',
  ].join('\n');
  const r = parsePartVerdicts(raw);
  assert.equal(r.costedParts.length, 4, 'all four contract-form PART lines parse');
  assert.deepEqual(r.costedParts.map(c => c.panelId),
    ['AIRBAG', 'WINDSCREEN', 'SIDE_GLASS', 'FRONT_DOOR']);
  assert.deepEqual(r.unmatched, ['Looks like the cabin took a hit.'],
    'the prose line is the only thing reported — HV: na is handled, the PART lines parsed');
});

test('sev:- parses to null severity, not to the literal dash', () => {
  const r = parsePartVerdicts('PART: WINDSCREEN | iv:false | sev:- | z:interior');
  assert.equal(r.costedParts[0].severity, null);
});

// ── 6. FLAG: LINES — the second grammar, and it must not leak into unmatched either ──────────────
test('a FLAG: line parses to flaggedParts and is not reported unmatched', () => {
  const r = parsePartVerdicts('FLAG: FRONT_STRUCTURE | z:front | weight:high :: chassis leg deformed');
  assert.equal(r.flaggedParts.length, 1);
  assert.equal(r.flaggedParts[0].panelId, 'FRONT_STRUCTURE');
  assert.equal(r.flaggedParts[0].reason, 'chassis leg deformed');
  assert.deepEqual(r.costedParts, []);
  assert.deepEqual(r.unmatched, []);
});

test('a malformed FLAG: line is refused and reported', () => {
  const line = 'FLAG: FRONT_STRUCTURE | z:front | weight:enormous :: chassis leg deformed';
  const r = parsePartVerdicts(line);
  assert.deepEqual(r.flaggedParts, []);
  assert.deepEqual(r.unmatched, [line]);
});

// ── 7. EMPTY / DEGENERATE INPUT — all three arrays empty, never undefined ────────────────────────
// The absent-block case matters: a 529-exhausted or max_tokens view returns '' and the caller
// destructures `unmatched` immediately. If it were undefined the logging line would throw.
for (const [name, input] of [['empty string', ''], ['null', null], ['undefined', undefined]]) {
  test(`empty block (${name}) → all three arrays [], none undefined`, () => {
    const r = parsePartVerdicts(input);
    assert.deepEqual(r.costedParts, []);
    assert.deepEqual(r.flaggedParts, []);
    assert.deepEqual(r.unmatched, [], 'must be an array — the caller destructures and reads .length');
  });
}

test('a block of only blank lines reports nothing — padding is not lost evidence', () => {
  const r = parsePartVerdicts('\n\n   \n\t\n');
  assert.deepEqual(r.unmatched, []);
});

test('unmatched lines are reported TRIMMED, matching what the caller prints', () => {
  const r = parsePartVerdicts('      not a part line      ');
  assert.deepEqual(r.unmatched, ['not a part line']);
});
