// batch 250 ruling 2 (Vincent, 18 Nov) — the "shown open" question: a Fable notes-confirm question, fired ONLY on an
// "unable to open bonnet / boot" note, fail closed. Its answer reaches only that note's wording:
//   shown open → 'The auction notes say: "UNABLE TO OPEN BONNET". A listing photo shows the bonnet open, so this note may be out of date.'
//   otherwise  → the existing "Not costed" line.
// £0: global fetch is stubbed. The five known cases are the batch 249 Part C recordings (run 1; run 2 gave the same verdicts),
// replayed from their reply texts — truth checked by eye on the photos.
//   node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch250-opened.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

process.env.ANTHROPIC_API_KEY = 'stub';
let reply = null, calls = 0, lastBody = null;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://api.anthropic.com/')) throw new Error(`unexpected network call ${url}`);
  calls++; lastBody = JSON.parse(init.body); return reply();
};
const answer = (text, stop_reason = 'end_turn') => () => new Response(JSON.stringify({ model: 'claude-fable-5-2', content: [{ type: 'text', text }], stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });

const { askOpened, openedQuestion, buildOpenedBody, buildConfirmBody } = await import('@/lib/notesConfirm.mjs');
const { stampCopartNotes, notesConcernLines } = await import('@/lib/copartNotes.mjs');
const quiet = () => {};
const imgs = (n) => Array.from({ length: n }, () => 'data:image/jpeg;base64,AAAA');

// batch 249 Part C recordings (reply text) — photo numbers are 1-based in the reply, 0-based in the result.
const CASES = [
  { lot: 'LC72NZV', target: 'bonnet', n: 14, truth: { open: true, photo: 6 }, text: '{"verdict":"yes","photo":7,"shows":"Bonnet raised on hinges, underside visible, engine bay exposed"}' },
  { lot: 'LC72NZV', target: 'boot', n: 14, truth: { open: false }, text: '{"verdict":"no","photo":null,"shows":"Tailgate is shut in both rear exterior views; photo 12 is only a close-up of the load area floor, with no raised tailgate visible"}' },
  { lot: 'URZ7545', target: 'bonnet', n: 23, truth: { open: false }, text: '{"verdict":"no","photo":null,"shows":"Bonnet crumpled but down in all photos; engine bay visible only through missing grille/bumper"}' },
  { lot: 'URZ7545', target: 'boot', n: 23, truth: { open: false }, text: '{"verdict":"no","photo":null,"shows":"Tailgate closed in all rear views; photo 19 is an interior view of load area"}' },
  { lot: 'SD75YGC', target: 'boot', n: 26, truth: { open: false }, text: '{"verdict":"no","photo":null,"shows":"Tailgate is shut in all exterior rear views; load area seen only from inside cabin"}' },
];

test('the five known cases (249 Part C recordings) read as the truth', async () => {
  for (const c of CASES) {
    reply = answer(c.text);
    const out = await askOpened(imgs(c.n), c.target, { log: quiet });
    assert.equal(out.open, c.truth.open, `${c.lot} ${c.target}`);
    if (c.truth.open) assert.equal(out.photo, c.truth.photo, `${c.lot} ${c.target} photo`);
  }
});

test('the question: Fable, the shared cached photo prefix, the high bar, no note text', () => {
  const b = buildOpenedBody(imgs(3), 'bonnet');
  const c = buildConfirmBody(imgs(3), 'BONNET');
  assert.equal(b.model, c.model); assert.equal(b.system, c.system);
  assert.deepEqual(b.messages[0].content.slice(0, -1), c.messages[0].content.slice(0, -1), 'same photo prefix as the other questions → same cache');
  assert.equal(b.messages[0].content.at(-2).cache_control?.type, 'ephemeral');
  const q = openedQuestion('bonnet');
  for (const s of ['plainly standing OPEN', 'An open door is NOT the bonnet or the boot.', 'through a missing bumper or grille is NOT the bonnet open', 'crumpled, buckled or creased but still down is shut', 'If you are not sure, answer "no".']) assert.ok(q.includes(s), s);
  assert.ok(openedQuestion('boot').includes('boot lid or tailgate') && openedQuestion('boot').includes('from inside the cabin'));
  assert.ok(!/UNABLE|CANNOT GET POWER/.test(JSON.stringify(b)), 'no note text in the request');
});

test('fail closed: API error, refusal, max_tokens, unreadable, yes without a valid photo, a throw → not shown open', async () => {
  const cases = [() => new Response('{}', { status: 500 }), answer('{"verdict":"yes","photo":1}', 'refusal'), answer('{"verdict":"yes","photo":1}', 'max_tokens'),
    answer('photo 1 shows it'), answer('{"verdict":"yes","photo":null}'), answer('{"verdict":"yes","photo":9}'), answer('{"verdict":"maybe","photo":1}'), () => { throw new Error('network'); }];
  for (const [i, c] of cases.entries()) { reply = c; assert.equal((await askOpened(imgs(3), 'bonnet', { log: quiet })).open, false, `case ${i}`); }
});

test('the route: fired only on an openNoteTarget() note, after the count questions; the open set reaches only the notes stamp', () => {
  const src = readFileSync('app/api/salvage/assess/route.js', 'utf8');
  assert.ok(src.includes('const notesOpenedPromise = notesCountAskPromise.then(() => Promise.all('));
  assert.ok(src.includes('[...new Set(copartNotes(enrichedVd).lines.map(openNoteTarget).filter(Boolean))].map(t => askOpened(images, t, { retry: with529Retry }))'));
  assert.ok(src.includes('openedPanels: new Set((await notesOpenedPromise).filter(o => o.open).map(o => o.target)) });'));
  assert.equal(src.split('notesOpenedPromise').length - 1, 2, 'declared once, read once (the stamp)');
});

test('the wording: shown open → Vincent\'s line; not shown → "Not costed"', () => {
  const read = { lines: [{ line: 'UNABLE TO OPEN BONNET', kind: 'concern', panels: [] }, { line: 'UNABLE TO OPEN THE BOOT', kind: 'concern', panels: [] }] };
  const lines = notesConcernLines(read, 'box', new Map(), new Set(), new Set(['bonnet']));
  assert.equal(lines[0], 'The auction notes say: "UNABLE TO OPEN BONNET". A listing photo shows the bonnet open, so this note may be out of date.');
  assert.equal(lines[1], 'The auction notes say: "UNABLE TO OPEN THE BOOT". Not costed. Auction notes can understate the problem — check before bidding.');
  const out = { 'Red Flags': '', 'WhatsApp Inspection Checklist': '' };
  stampCopartNotes(out, { additionalNotes: 'UNABLE TO OPEN BONNET' }, { notesRead: { lines: [read.lines[0]] }, openedPanels: new Set() });
  assert.ok(!/may be out of date/.test(out['Red Flags']), 'nothing shown open → no "out of date" line');
});
