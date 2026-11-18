// batch 248 B1 (Vincent, 18 Nov) — "unable to open" notes are access, not damage; when a listing photo shows that panel
// open, the line says the note may be out of date. Three parts:
//   1. the notes reader prompt: an access line names NO damage panel (so no notes-confirm question, line reads "Not costed");
//   2. batch 248 C2: the frame-zone read carries no `opened` field (option (b) discarded). The photo-side check (option (c),
//      its own Haiku call) is HELD — it called a shut boot (SD75YGC) and a shut bonnet (URZ7545) open — so nothing feeds
//      `openedPanels` yet and the line reads "Not costed";
//   3. lib/copartNotes.mjs owns the wording; the note is matched to bonnet / boot by CODE on the note text.
// £0: global fetch is stubbed (no network). Synthetic inputs + the LC72NZV stored row (gitignored fixtures/b248/, skips without it).
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch248-opened.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';

process.env.ANTHROPIC_API_KEY = 'stub';
let anthropic = null;
let lastBody = null;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com/')) { lastBody = JSON.parse(init.body); return anthropic(); }
  throw new Error(`validate-batch248-opened: unexpected network call ${u}`);
};
const reply = (text) => () => new Response(JSON.stringify({ model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });

const { readerPrompt } = await import('@/lib/notesReader.mjs');
const { notesPanels } = await import('@/lib/notesConfirm.mjs');
const { openNoteTarget, notesConcernLines, notesOpenedText, stampCopartNotes, copartNotes } = await import('@/lib/copartNotes.mjs');
const { runFrameZoneId } = await import('@/app/api/salvage/assess/route.js');
const IMG = 'data:image/jpeg;base64,AAAA';


const BONNET_LINE = 'The auction notes say: "UNABLE TO OPEN BONNET". A listing photo shows the bonnet open, so this note may be out of date.';

test('1. the reader prompt says an access line names no damage panel; with panels [] no confirm question is asked', () => {
  const p = readerPrompt(['UNABLE TO OPEN BONNET']);
  assert.ok(p.includes('A line that says something cannot be opened, started, closed or accessed (for example "UNABLE TO OPEN BONNET") is about access, not damage: it names NO panel — it is a concern with an empty list.'));
  assert.ok(p.includes('something that will not start, open, close or charge'), 'still a concern');
  assert.deepEqual(notesPanels({ lines: [{ line: 'UNABLE TO OPEN BONNET', kind: 'concern', panels: [] }] }), []);
  // the line then reads "Not costed" (no photo shows it open)
  assert.equal(notesConcernLines({ lines: [{ line: 'UNABLE TO OPEN BONNET', kind: 'concern', panels: [] }] }, 'box')[0],
    'The auction notes say: "UNABLE TO OPEN BONNET". Not costed. Auction notes can understate the problem — check before bidding.');
});

test('2. the frame-zone read is untouched: no "opened" in its request or its output', async () => {
  anthropic = reply(JSON.stringify({ frames: [{ i: 0, zones: ['front'], windscreenLabel: false, opened: ['bonnet'] }] }));
  const fz = await runFrameZoneId([IMG]);
  assert.equal(fz.ok, true); assert.deepEqual(fz.frames[0], { i: 0, zones: ['front'], windscreenLabel: false });
  assert.ok(!/opened/.test(JSON.stringify(lastBody)));
});

test('3. code matches the note to bonnet / boot from its text; Vincent\'s wording when a photo shows it open, else the existing line', () => {
  assert.equal(openNoteTarget('UNABLE TO OPEN BONNET'), 'bonnet');
  assert.equal(openNoteTarget('UNABLE TO OPEN BONNET DUE TO DAMAGE, CANNOT GET POWER'), 'bonnet');
  assert.equal(openNoteTarget('BONNET WILL NOT OPEN'), 'bonnet');
  assert.equal(openNoteTarget('UNABLE TO OPEN THE BOOT'), 'boot');
  assert.equal(openNoteTarget('TAILGATE WONT OPEN'), 'boot');
  for (const l of ['BOOT DAMAGED', 'BONNET CREASED', 'UNABLE TO START', 'DOOR WILL NOT OPEN', 'NUMBER OF KEYS 1']) assert.equal(openNoteTarget(l), null, l);
  const read = { lines: [
    { line: 'UNABLE TO OPEN BONNET', kind: 'concern', panels: [] },
    { line: 'UNABLE TO OPEN THE BOOT', kind: 'concern', panels: [] },
  ] };
  const both = notesConcernLines(read, 'box', new Map(), new Set(), new Set(['bonnet']));
  assert.equal(both[0], BONNET_LINE);
  assert.equal(both[1], 'The auction notes say: "UNABLE TO OPEN THE BOOT". Not costed. Auction notes can understate the problem — check before bidding.', 'boot not shown open → existing line');
  assert.equal(notesConcernLines(read, 'paste', new Map(), new Set(), new Set(['boot']))[1],
    'Copart\'s notes say: "UNABLE TO OPEN THE BOOT". A listing photo shows the boot open, so this note may be out of date.');
  assert.equal(notesOpenedText('UNABLE TO OPEN BONNET', 'box', 'bonnet'), BONNET_LINE);
});

test('the route passes no opened set (the photo-side check is held) and the frame-zone read stores no opened field', () => {
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  assert.ok(!/openedPanels:/.test(src) && !/runOpenedCheck|notesOpened/.test(src));
  assert.ok(src.includes('frames.push({ i, zones, windscreenLabel: f.windscreenLabel === true });'));
});

// ── LC72NZV stored row ──
const FIX_PATH = 'fixtures/b248/lc72nzv-row.json';
const ROW = existsSync(FIX_PATH) ? JSON.parse(readFileSync(FIX_PATH, 'utf8')) : null;
const SKIP = ROW ? false : `${FIX_PATH} is not on disk (production-row data, kept out of git) — fixture test skipped`;
if (SKIP) console.log(`SKIP: ${SKIP}`);

test('LC72NZV: reader says panels [] (as now ruled) + a bonnet-open answer on photo 6 (the held check job, given by hand) → Vincent\'s line; "Costed … bonnet" is gone; the boot line stands', { skip: SKIP }, async () => {
  const a = ROW.assessment, vd = ROW.vehicle_details;
  assert.ok(a['Red Flags'].includes('"UNABLE TO OPEN BONNET". Auction notes can understate the problem — check before bidding. Costed in the repair breakdown: bonnet.'), 'stored run');
  // photo 6 is the open-bonnet bay shot (stored frame zones ["detail","front"])
  assert.deepEqual(a._frameZones.frames.find(f => f.i === 6).zones, ['detail', 'front']);
  assert.deepEqual(copartNotes(vd).lines.map(openNoteTarget).filter(Boolean), ['bonnet', 'boot']);
  const read = { ...a._notesRead, lines: a._notesRead.lines.map(l => openNoteTarget(l.line) ? { ...l, panels: [] } : l) };
  assert.deepEqual(notesPanels(read), ['AIRBAG'].filter(p => notesPanels(a._notesRead).includes(p)), 'BONNET and BOOT_LID are no longer asked about');
  const out = { 'Red Flags': '', 'WhatsApp Inspection Checklist': '' };
  stampCopartNotes(out, vd, { notesRead: read, openedPanels: new Set(['bonnet']) });
  const rf = out['Red Flags'];
  assert.ok(rf.includes(`- ${BONNET_LINE}`), rf);
  assert.ok(!/Costed in the repair breakdown: bonnet/.test(rf));
  assert.ok(rf.includes('- The auction notes say: "UNABLE TO OPEN THE BOOT". Not costed. Auction notes can understate the problem — check before bidding.'));
  assert.ok(out['WhatsApp Inspection Checklist'].includes(BONNET_LINE));
});
