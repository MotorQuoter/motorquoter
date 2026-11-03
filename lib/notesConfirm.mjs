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
import { isLampMoneyRow, LAMP_ALLOWANCE_FLAG_LEAD } from './parts.mjs';
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

// batch 242 Part 4 — glass is asked "broken, shattered or missing": smashed side glass is usually gone (empty frame,
// fragments in the cabin), and a "damaged" question found none on 73052816. Every other panel: "damaged or missing".
export const GLASS_PANELS = new Set([
  PANEL.SIDE_GLASS, PANEL.WINDSCREEN, PANEL.REAR_GLASS, PANEL.CREW_WINDOW, PANEL.BODY_SIDE_GLAZING, PANEL.CAB_REAR_GLASS,
]);

// Code-owned plural per counted panel — never a generated "+s". SIDE_GLASS has its own fixed question.
const PLURAL = Object.freeze({
  [PANEL.FRONT_DOOR]: 'front doors', [PANEL.REAR_DOOR]: 'rear doors', [PANEL.FRONT_WING]: 'front wings',
  [PANEL.REAR_QUARTER]: 'rear quarter panels', [PANEL.SILL]: 'sills', [PANEL.SIDE_SKIRT]: 'side skirts',
  [PANEL.DOOR_MIRROR]: 'door mirrors', [PANEL.HEADLAMP]: 'headlamps', [PANEL.REAR_LAMP]: 'rear lamps',
  [PANEL.FOG_LAMP]: 'fog lamps',
});
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
export const pluralOf = (id) => PLURAL[id] || null;

const COUNT_JSON = `Return a raw JSON object only, no other text:
{ "count": <whole number, or "cannot-tell">, "photos": [<the photo numbers that show the damage>] }`;
const YESNO_JSON = `Return a raw JSON object only, no other text:
{ "verdict": "yes" | "no" | "cannot-tell", "photos": [<the photo numbers that show the damage>] }`;

// The code-owned question. No note text, ever.
export function confirmQuestion(panelId) {
  if (panelId === PANEL.SIDE_GLASS) {
    return `How many door or side windows are broken, shattered or missing in these photos? Count a window as broken if its frame is empty or glass fragments are visible inside the car. Answer only from what you can see in the photos. Reply 0 if none.
${COUNT_JSON}`;
  }
  if (isCountPanel(panelId)) {
    const plural = pluralOf(panelId);
    if (!plural) throw new Error(`notesConfirm: no code-owned plural for counted panel ${panelId}`);
    return `How many ${plural} are damaged or missing in these photos? Answer only from what you can see. Reply 0 if none.
${COUNT_JSON}`;
  }
  const label = lower(PANEL_DISPLAY[panelId]);
  if (GLASS_PANELS.has(panelId)) {
    return `Is the ${label} broken, shattered or missing in any of these photos? Count it as broken if the frame is empty or glass fragments are visible. Answer only from what you can see in the photos.
${YESNO_JSON}`;
  }
  return `Is the ${label} damaged or missing in any of these photos? Answer only from what you can see in the photos.
${YESNO_JSON}`;
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

// ── batch 242 Part 9 (Vincent, 3 Nov: "notes") — THE NOTE SETS THE MINIMUM COUNT, THE PHOTOS CONFIRM ──────────────
// The photo question decides WHETHER a counted panel is costed (count 0 / cannot-tell / error → nothing). Once the photos
// confirm (≥ 1), the costed count = max(photo count, the note's stated minimum), then the cap. The minimum is read by
// CODE from the note line — never a model, and the note still never enters the photo call.
//
// Keyword table per counted panel: `one` = singular forms, `many` = plural forms. Longest phrase first within a panel.
// Doors: "DOORS" alone is SHARED by front and rear ("NSF AND NSR DOORS" = one of each), so it is neither panel's plural;
// only "FRONT DOOR(S)" / "REAR DOOR(S)" count.
export const NOTE_KEYWORDS = Object.freeze({
  [PANEL.SIDE_GLASS]:   { one: ['SIDE WINDOW', 'DOOR WINDOW', 'SIDE GLASS', 'DOOR GLASS', 'WINDOW', 'GLASS'], many: ['SIDE WINDOWS', 'DOOR WINDOWS', 'WINDOWS'] },
  [PANEL.FRONT_DOOR]:   { one: ['FRONT DOOR'], many: ['FRONT DOORS'] },
  [PANEL.REAR_DOOR]:    { one: ['REAR DOOR'], many: ['REAR DOORS'] },
  [PANEL.FRONT_WING]:   { one: ['FRONT WING', 'WING'], many: ['FRONT WINGS', 'WINGS'] },
  [PANEL.REAR_QUARTER]: { one: ['REAR QUARTER', 'QUARTER PANEL', 'QUARTER'], many: ['REAR QUARTERS', 'QUARTER PANELS', 'QUARTERS'] },
  [PANEL.SILL]:         { one: ['SILL'], many: ['SILLS'] },
  [PANEL.SIDE_SKIRT]:   { one: ['SIDE SKIRT', 'SKIRT'], many: ['SIDE SKIRTS', 'SKIRTS'] },
  [PANEL.DOOR_MIRROR]:  { one: ['DOOR MIRROR', 'WING MIRROR', 'MIRROR'], many: ['DOOR MIRRORS', 'WING MIRRORS', 'MIRRORS'] },
  [PANEL.HEADLAMP]:     { one: ['HEADLAMP', 'HEADLIGHT', 'HEAD LAMP', 'HEAD LIGHT'], many: ['HEADLAMPS', 'HEADLIGHTS', 'HEAD LAMPS', 'HEAD LIGHTS'] },
  [PANEL.REAR_LAMP]:    { one: ['REAR LAMP', 'REAR LIGHT', 'TAIL LAMP', 'TAIL LIGHT', 'TAILLIGHT'], many: ['REAR LAMPS', 'REAR LIGHTS', 'TAIL LAMPS', 'TAIL LIGHTS', 'TAILLIGHTS'] },
  [PANEL.FOG_LAMP]:     { one: ['FOG LAMP', 'FOG LIGHT'], many: ['FOG LAMPS', 'FOG LIGHTS'] },
});
const NUMBER_WORDS = { TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9 };
// "ALL" before SIDE_GLASS's plural = all four door windows (Vincent, 3 Nov: "4 doors and front and back screens").
const ALL_MIN = Object.freeze({ [PANEL.SIDE_GLASS]: 4 });
// …and on that line code adds side glass + the screens (Part 10, Vincent 3 Nov), each costed only on its own photo yes.
const ALL_WINDOWS_ADDS = Object.freeze([PANEL.SIDE_GLASS, PANEL.WINDSCREEN, PANEL.REAR_GLASS]);
const ALL_WINDOWS_RE = /(?:^|[^A-Z0-9])ALL\s+(?:(?:SIDE|DOOR)\s+)?WINDOWS(?![A-Z0-9])/;

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Part 10 (Vincent, 3 Nov) — Copart corner codes COUNT the panels a shared plural names. Code only; read to count,
// never to side: no side reaches a row, a label or a code-written sentence, and the model never sees them.
// NSF / OSF / NSR / OSR, also N/S/F etc. with or without spaces (after norm(), "N S F").
const CORNER_RE = /(?<= )([NO]) ?S ?([FR])(?= )/g;
// The plural word → which panel each end's codes count. WINDOWS counts every code (any door window).
const CORNER_RULES = Object.freeze([
  { word: /(?<= )DOORS(?= )/, front: PANEL.FRONT_DOOR, rear: PANEL.REAR_DOOR },
  { word: /(?<= )WINGS(?= )/, front: PANEL.FRONT_WING, rear: PANEL.REAR_QUARTER },   // a rear wing is the quarter panel
  { word: /(?<= )WINDOWS(?= )/, all: PANEL.SIDE_GLASS },                               // also SIDE/DOOR WINDOWS
]);
// line → Map panelId → minimum (≥ 1 only; a position with no code sets nothing). Any other panel word: codes ignored.
export function cornerMinimums(line) {
  const text = ` ${norm(line)} `;
  const codes = new Set([...text.matchAll(CORNER_RE)].map(m => `${m[1]}S${m[2]}`));
  const out = new Map();
  if (!codes.size) return out;
  const front = [...codes].filter(c => c.endsWith('F')).length;
  const rear = [...codes].filter(c => c.endsWith('R')).length;
  for (const r of CORNER_RULES) {
    if (!r.word.test(text)) continue;
    if (r.all) out.set(r.all, codes.size);
    if (r.front && front) out.set(r.front, front);
    if (r.rear && rear) out.set(r.rear, rear);
  }
  return out;
}

// → whole number ≥ 1. A number (2-9 / TWO-NINE) directly before the panel's keyword → that number; "ALL" before
// SIDE_GLASS's plural → 4; a plural keyword with no number → 2; a singular keyword or no match → 1. Several matches
// on one line → the largest. Copart corner codes can only RAISE it (cornerMinimums). Not capped here (the cap is applied
// with the photo count).
export function noteMinimum(line, panelId) {
  const kw = NOTE_KEYWORDS[panelId];
  if (!kw) return 1;
  const text = ` ${norm(line)} `;
  let min = cornerMinimums(line).get(panelId) || 1;
  for (const [forms, plural] of [[kw.many, true], [kw.one, false]]) {
    for (const k of forms) {
      const re = new RegExp(`(?<= )(?:(\\d+|${Object.keys(NUMBER_WORDS).join('|')}|ALL) )?${esc(k)}(?= )`, 'g');
      for (const m of text.matchAll(re)) {
        const q = m[1];
        let n = plural ? 2 : 1;
        if (q === 'ALL') n = plural && ALL_MIN[panelId] ? ALL_MIN[panelId] : n;
        else if (q && NUMBER_WORDS[q]) n = NUMBER_WORDS[q];
        else if (q && /^[2-9]$/.test(q)) n = Number(q);
        min = Math.max(min, n);
      }
    }
  }
  return min;
}

// panelId → the largest minimum any concern line naming that panel states (counted panels only).
export function noteMinimums(notesRead) {
  const out = new Map();
  for (const l of notesRead?.lines || []) {
    if (l.kind === 'spec') continue;
    for (const p of l.panels || []) if (isCountPanel(p)) out.set(p, Math.max(out.get(p) || 1, noteMinimum(l.line, p)));
  }
  return out;
}

// The reader's read with code's additions (whichever the reader did not name): an "ALL WINDOWS" concern line names
// SIDE_GLASS, WINDSCREEN and REAR_GLASS; a corner code that gives a position a minimum names that panel. Added panels
// are listed in `codePanels`; each is still asked and costed only on its own photo confirmation. A fallback read is
// returned unchanged (nothing is asked).
export function withNoteAdditions(notesRead) {
  if (!notesRead || notesRead.fallback) return notesRead;
  return { ...notesRead, lines: (notesRead.lines || []).map(l => {
    if (l.kind === 'spec') return l;
    const want = [...(ALL_WINDOWS_RE.test(norm(l.line)) ? ALL_WINDOWS_ADDS : []), ...cornerMinimums(l.line).keys()];
    const add = [...new Set(want)].filter(p => !(l.panels || []).includes(p));
    return add.length ? { ...l, panels: [...(l.panels || []), ...add], codePanels: add } : l;
  }) };
}

// Apply the note minimum to the photo answers. Counted panel, photos ≥ 1 → count = min(cap, max(photos, noteMin));
// photos 0 / cannot-tell / error → 0, flag stays. Single-instance answers pass through unchanged. Each counted answer
// keeps `photoCount` (what the photos said) and `noteMin` (internal; nothing renders them).
export function applyNoteMinimum(answers, notesRead, { log = console.log } = {}) {
  const mins = noteMinimums(notesRead);
  return (answers || []).map(a => {
    if (!isCountPanel(a?.panelId)) return a;
    const noteMin = mins.get(a.panelId) || 1;
    const photoCount = a.count || 0;
    const count = photoCount >= 1 ? Math.min(MULTI_INSTANCE_MAX[a.panelId], Math.max(photoCount, noteMin)) : 0;
    log(`[NOTES CONFIRM] ${a.panelId} photos=${photoCount} noteMin=${noteMin} → costed count ${count}${photoCount ? '' : ' (photos did not confirm; flag stays)'}`);
    return { ...a, photoCount, noteMin, count };
  });
}

// ── Part 11 (Vincent, 3 Nov: "fix first") — a confirmed HEADLAMP is costed through the lot's EXISTING lamp band. The
// headlamp is not in PANEL_PRICE_TABLE: its money is owned by lib/lampBands.mjs and resolved once per lot in route.js
// (resolveLampBand / computeLampResult — photo type → spec type → LED default, batch 113). The route passes that
// resolved result in as `lamp` = { type, band, assumed, tier2 }; nothing here re-resolves it or holds a figure. The
// row is the same shape as an engine-inserted headlamp (lib/parts.mjs reconcileParts insertedRow / orphan clamp):
// _lampMandated + _band, so the gate's lamp rules, the "type assumed" disclosure and the buyer's lamp-type correction
// (lib/ledgerEdits.mjs applyEdits) treat it as any other headlamp row. Lamps carry no labour.
export function confirmedLampRow(lamp) {
  if (!lamp || !(lamp.band > 0)) return null;
  // No `_inserted` (Part 13, Vincent 3 Nov): on an engine row it means "absent from the photos", and the damage card
  // prints "Not present in the listing photos" from it — false here, where the photos confirmed the lamp.
  return { panelId: PANEL.HEADLAMP, name: 'Headlamp', action: 'replace', oem: null, used: lamp.band,
    _lampMandated: true, _band: lamp.band, _modelLampCost: null, _lampOrdinal: null,
    // the orphan (non-tier-2) path marks an assumed type on the row; tier 2 discloses from lampResult (route.js)
    ...(lamp.assumed && !lamp.tier2 ? { _orphanAssumedDisclosure: true } : {}),
    _notesConfirmed: true };
}
// ── Part 13 (Vincent, 3 Nov: "do it first then merge") — a notes-confirmed headlamp SETTLES the engine's set-aside lamp.
// When the confirm step has added ≥ 1 HEADLAMP row, the engine's £0 headlamp inspection-allowance rows (A1 gate shelve,
// or a second orphan lamp line) and the gate's A1 allowance flag that exists only because of them are removed: the
// notes and the photos have settled it. Mutates both arrays in place; returns what it removed. Nothing else changes.
export function settleLampAllowance({ added, allowanceParts, flaggedParts, log = console.log }) {
  const out = { allowance: [], flags: [] };
  if (!(added || []).some(r => r?.panelId === PANEL.HEADLAMP)) return out;
  for (let i = (allowanceParts || []).length - 1; i >= 0; i--) {
    const a = allowanceParts[i];
    if (a?._allowance && isLampMoneyRow({ name: a.name })) out.allowance.unshift(...allowanceParts.splice(i, 1));
  }
  for (let i = (flaggedParts || []).length - 1; i >= 0; i--) {
    const f = flaggedParts[i];
    if (f?._gateGenerated && String(f.reason || '').startsWith(LAMP_ALLOWANCE_FLAG_LEAD)) out.flags.unshift(...flaggedParts.splice(i, 1));
  }
  if (out.allowance.length || out.flags.length) {
    log(`[NOTES CONFIRM] HEADLAMP settled by the notes + photos — removed ${out.allowance.length} headlamp inspection-allowance row(s) and ${out.flags.length} allowance flag(s)`);
  }
  return out;
}

// ONE owner of "which panel a charged row counts as" — the confirm step (cost the difference) and the concern-line
// stamp (route.js `_chargedCounts`) both use it, so the line counts what the money counts (Part 12). A headlamp counts
// with the engine's own lamp-row test (lib/parts.mjs isLampMoneyRow): an engine-INSERTED headlamp carries no panelId,
// so a panelId match alone would miss it (a double charge here, "headlamp × 1" with 2 in the money on the line).
// Every other row counts by its panelId. A row counts once.
export const countedPanelOf = (r) => (isLampMoneyRow(r) ? PANEL.HEADLAMP : r?.panelId) || null;
// panelId → number of charged rows, by countedPanelOf. `isCharged` is isChargedRow (lib/ledgerEdits.mjs, rule 7).
export function chargedCounts(rows, isCharged) {
  const m = new Map();
  for (const r of rows || []) {
    const p = isCharged(r) ? countedPanelOf(r) : null;
    if (p) m.set(p, (m.get(p) || 0) + 1);
  }
  return m;
}
const chargedOf = (panelId, rows, isCharged) => chargedCounts(rows, isCharged).get(panelId) || 0;

// Ruling 4: n charged rows of the panel already present, c confirmed → add max(0, c − n) rows at the band, action
// from CONFIRM_ACTION, no side. No band / no table entry → nothing added (the flag stays). Mutates gatedParts.
// A HEADLAMP is priced from `lamp` (Part 11) instead of the table.
export function applyConfirmations({ gatedParts, answers, bandKey, priceTable, isCharged, lamp = null, log = console.log }) {
  const added = [];
  for (const a of answers || []) {
    if (!(a?.count > 0) || !CONFIRM_ACTION[a.panelId]) continue;
    const n = chargedOf(a.panelId, gatedParts, isCharged);
    const add = Math.max(0, a.count - n);
    if (!add) { log(`[NOTES CONFIRM] ${a.panelId} confirmed ${a.count}, already charged ${n} → nothing added`); continue; }
    if (a.panelId === PANEL.HEADLAMP) {
      const proto = confirmedLampRow(lamp);
      if (!proto) { log(`[NOTES CONFIRM] HEADLAMP confirmed ${a.count} but NOT costed — no resolved lamp band; flag stays`); continue; }
      for (let i = 0; i < add; i++) { const row = { ...proto }; gatedParts.push(row); added.push(row); }
      log(`[NOTES CONFIRM] HEADLAMP confirmed ${a.count}, already charged ${n} → added ${add} × replace at the lamp band £${proto.used} (type=${lamp.type}${lamp.assumed ? ', assumed' : ''}${lamp.tier2 ? ', tier 2' : ''})`);
      continue;
    }
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
