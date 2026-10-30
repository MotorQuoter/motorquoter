// batch 242 C — the narrow photo question (rulings R2/R3 + Part 1 rulings 1-5, Vincent 30 Oct 2026).
//
// For each panel the notes reader (lib/notesReader.mjs) names on a concern line, ONE code-owned question goes to the
// photos: does any photo show it damaged (single-instance panel), or how many are damaged (multi-instance panel)?
// The note text never goes in this call. A confirmed panel is FINAL (ruling 1): it is added to the ledger after the
// Option G inject loop and skips the vote, G split, paired-flank logic, attribution probe, R1/R2, the model-row gate
// and sticky. It still passes stripBodyIneligible, applyGradeOwnsAction, labour, the ledger surfaces and the edit layer.
//
// ONE owner of: which panels can be confirmed, the action each is costed at (ruling 2), which are counted (ruling 3),
// and the "cost the difference" rule (ruling 4).
import { PANEL, PANEL_DISPLAY } from './panelEnum.mjs';
import { BODY_PANEL_LABOUR } from './labour.mjs';
import { MODELS } from '../config/models.js';

// ── Ruling 2: the action is fixed per panel. Glass, lamps and the door mirror are replaced; body panels are repaired.
// A panel NOT in this table is never asked about and never costed from the notes — its concern line stays a flag.
const REPLACE_PANELS = [
  PANEL.SIDE_GLASS, PANEL.WINDSCREEN, PANEL.REAR_GLASS,                         // glass
  PANEL.CREW_WINDOW, PANEL.BODY_SIDE_GLAZING, PANEL.CAB_REAR_GLASS,             // the other glazing panels
  PANEL.HEADLAMP, PANEL.REAR_LAMP, PANEL.FOG_LAMP,                              // lamps
  PANEL.DOOR_MIRROR,
];
const REPAIR_PANELS = Object.values(PANEL).filter(id => BODY_PANEL_LABOUR.has(id));   // body panels (lib/labour.mjs owner)
export const CONFIRM_ACTION = Object.freeze(Object.fromEntries([
  ...REPLACE_PANELS.map(id => [id, 'replace']),
  ...REPAIR_PANELS.map(id => [id, 'repair']),
]));

// ── Ruling 3: panels with more than one instance are COUNTED, never sided. The value is the most a car can have; a
// larger answer is capped to it. Every other confirmable panel takes the yes/no form.
export const MULTI_INSTANCE_MAX = Object.freeze({
  [PANEL.FRONT_DOOR]: 2, [PANEL.REAR_DOOR]: 2, [PANEL.FRONT_WING]: 2, [PANEL.REAR_QUARTER]: 2,
  [PANEL.SILL]: 2, [PANEL.SIDE_SKIRT]: 2, [PANEL.DOOR_MIRROR]: 2, [PANEL.SIDE_GLASS]: 4,
  [PANEL.HEADLAMP]: 2, [PANEL.REAR_LAMP]: 2, [PANEL.FOG_LAMP]: 2,
});
export const COUNT_PANELS = new Set(Object.keys(MULTI_INSTANCE_MAX));
export const isCountPanel = (id) => COUNT_PANELS.has(id);

// Plural for the count question. Display label + "s" unless it reads wrong.
const PLURAL = { [PANEL.SIDE_GLASS]: 'side glass panels (door or side windows)' };
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
export const pluralOf = (id) => PLURAL[id] || `${lower(PANEL_DISPLAY[id])}s`;

// The code-owned question. No note text, ever.
export function confirmQuestion(panelId) {
  if (isCountPanel(panelId)) {
    return `How many ${pluralOf(panelId)} are damaged in these photos? Answer only from what you can see. Reply 0 if none.
Return a raw JSON object only, no other text:
{ "count": <whole number, or "cannot-tell">, "photos": [<the photo numbers that show the damage>] }`;
  }
  return `Is the ${lower(PANEL_DISPLAY[panelId])} damaged in any of these photos? Answer only from what you can see in the photos.
Return a raw JSON object only, no other text:
{ "verdict": "yes" | "no" | "cannot-tell", "photos": [<the photo numbers that show the damage>] }`;
}

export const CONFIRM_SYSTEM = 'You are a vehicle damage assessor looking at auction photographs of one vehicle. Respond ONLY with a raw JSON object. No markdown, no explanation, no surrounding text.';

// Photos are numbered from 1 for the model; indices are stored 0-based. The image prefix (system + numbered photos) is
// identical for every panel on a lot, so it is cached once and read by the other questions.
export function buildConfirmBody(images, panelId) {
  const content = [];
  images.slice(0, 35).forEach((img, i) => {
    let mediaType = 'image/jpeg', data = img;
    const mm = String(img).match(/^data:([^;]+);base64,(.+)$/);
    if (mm) { mediaType = mm[1]; data = mm[2]; }
    content.push({ type: 'text', text: `Photo ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  });
  if (content.length) content[content.length - 1].cache_control = { type: 'ephemeral' };
  content.push({ type: 'text', text: confirmQuestion(panelId) });
  return { model: MODELS.assessPrimary, max_tokens: 256, system: CONFIRM_SYSTEM, messages: [{ role: 'user', content }] };
}

// → { panelId, count, verdict, photos }. count is what gets costed: 0 for no / cannot-tell / error.
export function parseConfirmOutput(text, panelId) {
  const none = (verdict) => ({ panelId, count: 0, verdict, photos: [] });
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return none('unparseable');
  let p; try { p = JSON.parse(m[0]); } catch { return none('unparseable'); }
  const photos = Array.isArray(p?.photos)
    ? [...new Set(p.photos.map(Number).filter(n => Number.isInteger(n) && n >= 1).map(n => n - 1))] : [];
  if (isCountPanel(panelId)) {
    const n = Number(p?.count);
    if (!Number.isInteger(n) || n < 0) return { ...none('cannot-tell'), photos };
    const count = Math.min(n, MULTI_INSTANCE_MAX[panelId]);
    return { panelId, count, verdict: count > 0 ? (count < n ? `capped ${n}→${count}` : 'count') : 'none', photos };
  }
  const v = p?.verdict;
  if (v === 'yes') return { panelId, count: 1, verdict: 'yes', photos };
  return { ...none(v === 'no' ? 'no' : 'cannot-tell'), photos };
}

// One question. Never throws: any failure is count 0 (nothing costed, the flag stays).
export async function askPanel(images, panelId, { fetchImpl = globalThis.fetch, retry, apiKey = process.env.ANTHROPIC_API_KEY,
  timeoutMs = 90000, log = console.log } = {}) {
  const run = retry || (async (_name, thunk) => ({ res: await thunk(), exhausted: false }));
  try {
    const { res, exhausted } = await run(`notes-confirm-${panelId}`, () => fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(buildConfirmBody(images, panelId)),
      signal: AbortSignal.timeout(timeoutMs),
    }));
    if (exhausted) return { panelId, count: 0, verdict: 'error: 529 exhausted', photos: [] };
    if (!res?.ok) return { panelId, count: 0, verdict: `error: api ${res?.status}`, photos: [] };
    const apiData = await res.json();
    const u = apiData.usage || {};
    log(`[TOKEN LOG] notes-confirm-${panelId} Input: ${u.input_tokens} | Output: ${u.output_tokens} | CacheWrite: ${u.cache_creation_input_tokens ?? 0} | CacheRead: ${u.cache_read_input_tokens ?? 0} | Stop: ${apiData.stop_reason} | Model: ${apiData.model || 'unknown'}`);
    if (apiData.stop_reason === 'max_tokens' || apiData.stop_reason === 'refusal') {
      return { panelId, count: 0, verdict: `error: stop ${apiData.stop_reason}`, photos: [] };
    }
    return parseConfirmOutput(((apiData.content || []).find(b => b.type === 'text')?.text || '').trim(), panelId);
  } catch (err) {
    return { panelId, count: 0, verdict: `error: ${err?.message || err}`, photos: [] };
  }
}

// Several questions: the first writes the image cache, the rest read it.
export async function askPanels(images, panelIds, opts = {}) {
  const log = opts.log || console.log;
  if (!panelIds?.length || !images?.length) return [];
  const first = await askPanel(images, panelIds[0], opts);
  const rest = await Promise.all(panelIds.slice(1).map(id => askPanel(images, id, opts)));
  const out = [first, ...rest];
  for (const a of out) log(`[NOTES CONFIRM] ${a.panelId} ${isCountPanel(a.panelId) ? `count=${a.count}` : `verdict=${a.verdict}`} (${a.verdict}) photos=[${a.photos.join(',')}]`);
  return out;
}

// The distinct confirmable panels named on the reader's concern lines (a spec line names none).
export function notesPanels(notesRead) {
  const out = [];
  for (const l of notesRead?.lines || []) {
    if (l.kind === 'spec') continue;
    for (const p of l.panels || []) if (CONFIRM_ACTION[p] && !out.includes(p)) out.push(p);
  }
  return out;
}

// Ruling 4: n charged rows of the panel already present, c confirmed → add max(0, c − n) rows at the band, action
// from CONFIRM_ACTION, no side. No band / no table entry → nothing added (the flag stays). Mutates gatedParts.
export function applyConfirmations({ gatedParts, answers, bandKey, priceTable, isCharged, log = console.log }) {
  const added = [];
  for (const a of answers || []) {
    if (!(a?.count > 0) || !CONFIRM_ACTION[a.panelId]) continue;
    const n = gatedParts.filter(r => r?.panelId === a.panelId && isCharged(r)).length;
    const add = Math.max(0, a.count - n);
    if (!add) { log(`[NOTES CONFIRM] ${a.panelId} confirmed ${a.count}, already charged ${n} → nothing added`); continue; }
    const entry = bandKey ? priceTable?.[a.panelId]?.[bandKey] : null;
    if (!entry) { log(`[NOTES CONFIRM] ${a.panelId} confirmed ${a.count} but NOT costed — no ${bandKey ? `table entry for band "${bandKey}"` : 'band'}; flag stays`); continue; }
    for (let i = 0; i < add; i++) {
      const row = { panelId: a.panelId, name: PANEL_DISPLAY[a.panelId], action: CONFIRM_ACTION[a.panelId],
        oem: entry.oem, used: entry.used, _tableMandated: true, _notesConfirmed: true };
      gatedParts.push(row);
      added.push(row);
    }
    log(`[NOTES CONFIRM] ${a.panelId} confirmed ${a.count}, already charged ${n} → added ${add} × ${CONFIRM_ACTION[a.panelId]} used=£${entry.used} oem=£${entry.oem} band=${bandKey}`);
  }
  return added;
}
