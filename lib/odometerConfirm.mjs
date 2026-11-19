// batch 254 item 3 (Vincent R4, 19 Nov) — A FABLE CHECK BEFORE ANY DASH-VS-LISTING DISCREPANCY.
//
// KT73YAJ: the listing says 8,915; Haiku read 1,201 (the clock) and the report raised "discrepancy of 7,714 miles". When the
// Haiku read disagrees with the listing by more than DASH_LISTING_DIVERGENCE_MILES and it is NOT a digit slip / listing-agrees-
// with-MOT case (lib/mileageCheck.mjs photoOdometerMisread, which runs first), Fable is asked ONCE, on the same cached photo
// prefix the notes-confirm questions use, to read the main odometer. Fail closed: a failure, refusal, bad stop, an unparseable
// reply or "unreadable" is no reading. The outcome is code-owned (odometerConfirmOutcome):
//   • Fable within tolerance of the LISTING  → the photo read is replaced by Fable's figure: no flag, no discrepancy;
//   • Fable within tolerance of HAIKU's read → the existing discrepancy flag stands, unchanged;
//   • no reading / neither                   → the batch 252 misread line (misreadText); no discrepancy.
// The route runs it before the valuation mileage and before Call 1 is built (the flag feeds Call 1's prompt).
import { PANEL } from './panelEnum.mjs';
import { buildConfirmBody } from './notesConfirm.mjs';
import { checkServedModel } from './servedModel.mjs';
import { DASH_LISTING_DIVERGENCE_MILES, misreadText } from './mileageCheck.mjs';

// The answer is a few tokens; 4,000 leaves Fable room to think (observed 0–600 thinking tokens on these photo questions)
// and bounds the cost of one question. Running out is a bad stop → no reading (fail closed).
export const ODO_CONFIRM_MAX_TOKENS = 4000;

export const ODO_CONFIRM_QUESTION = `Read the vehicle's main odometer (the total distance the vehicle has travelled) from the instrument display in these photos.
Do NOT read the trip meter, the clock, the range, the temperature or the speed.
Give the digits exactly as shown, and the number of the photo you read them from. If no main odometer is clearly readable, answer "unreadable".
Return a raw JSON object only, no other text:
{ "odometer": "<the digits exactly as shown>" | "unreadable", "photo": <the photo number, or null> }`;

export function buildOdometerConfirmBody(images) {
  const body = buildConfirmBody(images, PANEL.BONNET);   // the shared, cached photo prefix (system + numbered photos)
  body.messages[0].content[body.messages[0].content.length - 1] = { type: 'text', text: ODO_CONFIRM_QUESTION };
  body.max_tokens = ODO_CONFIRM_MAX_TOKENS;
  return body;
}

// → { reading: number | null, photo: 0-based | null, verdict }. Digits only (grouping commas / spaces allowed, one tenths
// digit after a point dropped); anything else, or no valid photo number, is no reading.
export function parseOdometerConfirm(text, n) {
  const none = (verdict) => ({ reading: null, photo: null, verdict });
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return none('unparseable');
  let p; try { p = JSON.parse(m[0]); } catch { return none('unparseable'); }
  const raw = String(p?.odometer ?? '').trim();
  if (!raw || /^unreadable$/i.test(raw)) return none('unreadable');
  const mm = raw.match(/^(\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d)?$/);
  if (!mm) return none(`not a reading: ${raw.slice(0, 20)}`);
  const reading = parseInt(mm[1].replace(/[, ]/g, ''), 10);
  if (!(reading >= 1 && reading <= 999999)) return none('out of range');
  const ph = Number(p?.photo);
  if (!Number.isInteger(ph) || ph < 1 || ph > n) return none('reading without a valid photo');
  return { reading, photo: ph - 1, verdict: 'read' };
}

// One question. Never throws: any failure is no reading.
export async function askOdometer(images, { fetchImpl = globalThis.fetch, retry, apiKey = process.env.ANTHROPIC_API_KEY,
  timeoutMs = 90000, log = console.log } = {}) {
  const run = retry || (async (_name, thunk) => ({ res: await thunk(), exhausted: false }));
  const fail = (why) => { log(`[ODO CONFIRM] no reading (${why})`); return { reading: null, photo: null, verdict: `error: ${why}` }; };
  try {
    const n = Math.min(images.length, 35);
    const { res, exhausted } = await run('odometer-confirm', () => fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(buildOdometerConfirmBody(images)),
      signal: AbortSignal.timeout(timeoutMs),
    }));
    if (exhausted) return fail('529 exhausted');
    if (!res?.ok) return fail(`api ${res?.status}`);
    const apiData = await res.json();
    const u = apiData.usage || {};
    log(`[TOKEN LOG] odometer-confirm Input: ${u.input_tokens} | Output: ${u.output_tokens} | CacheWrite: ${u.cache_creation_input_tokens ?? 0} | CacheRead: ${u.cache_read_input_tokens ?? 0} | Stop: ${apiData.stop_reason} | Model: ${apiData.model || 'unknown'}`);
    await checkServedModel('odometer-confirm', apiData, { log });
    if (apiData.stop_reason !== 'end_turn') return fail(`stop ${apiData.stop_reason}`);
    const out = parseOdometerConfirm(((apiData.content || []).find(b => b.type === 'text')?.text || '').trim(), n);
    log(`[ODO CONFIRM] ${out.reading != null ? `reads ${out.reading} (photo ${out.photo + 1})` : `no reading (${out.verdict})`}`);
    return out;
  } catch (err) {
    return fail(err?.message || String(err));
  }
}

// The trigger. `haiku` = the Haiku figure(s) still standing after the sanity and misread rules; `listing` = the listing
// figure (number). True when a discrepancy would otherwise be raised: no Haiku figure within tolerance of the listing.
export function needsOdometerConfirm(haiku, listing, tol = DASH_LISTING_DIVERGENCE_MILES) {
  const H = (Array.isArray(haiku) ? haiku : [haiku]).filter(n => Number.isFinite(n) && n >= 1);
  if (!H.length || !(Number.isFinite(listing) && listing >= 1)) return false;
  return H.every(h => Math.abs(h - listing) > tol);
}

// → { branch: 'listing' | 'haiku' | 'unreadable' | 'neither', value (the photo odometer to use, or null), text (the misread
// line, or null) }. Listing is tested first: a Fable read near both keeps no discrepancy.
export function odometerConfirmOutcome({ fable, haiku, listing, tol = DASH_LISTING_DIVERGENCE_MILES }) {
  const H = (Array.isArray(haiku) ? haiku : [haiku]).filter(n => Number.isFinite(n) && n >= 1);
  const shownHaiku = H[0] ?? null;
  const misread = () => (shownHaiku != null && Number.isFinite(listing) ? misreadText(shownHaiku, listing) : null);
  if (!(Number.isFinite(fable) && fable >= 1)) return { branch: 'unreadable', value: null, text: misread() };
  if (Number.isFinite(listing) && Math.abs(fable - listing) <= tol) return { branch: 'listing', value: fable, text: null };
  if (H.some(h => Math.abs(fable - h) <= tol)) return { branch: 'haiku', value: null, text: null };
  return { branch: 'neither', value: null, text: misread() };
}
