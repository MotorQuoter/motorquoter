// batch 242 A — the notes reader (rulings R2/R3, Vincent 30 Oct 2026).
//
// A separate, small model call that reads ONLY the auction's notes lines (copartNotes(vd).lines, box or paste) and
// says, for each line, whether it is a buyer concern or just spec — and, for a concern, which visible-damage panels it
// names. There is no phrase list and no fault taxonomy: the model judges, and when in doubt a line is a concern.
//
// Hard limits:
//   - Input is the notes lines and the code-supplied panel list. Never photos, never the listing, never the assessment.
//   - Panels come ONLY from the PANEL enum (lib/panelEnum.mjs). Anything else the model writes is dropped. No side.
//   - The reader writes no buyer-facing word and no figure. lib/copartNotes.mjs owns the wording; the photos own money.
//   - Failure (error, timeout, refusal, unparseable output) → EVERY line is a concern with no panels. Missed damage is
//     the worse error.
// The notes text appears in this call and in no other prompt (validate-notes-reader D1).
import { PANEL, PANEL_DISPLAY } from './panelEnum.mjs';
import { MODELS } from '../config/models.js';

// The panels the reader may name: the whole enum bar the OTHER escape hatch (which names nothing).
export const READER_PANELS = Object.freeze(Object.values(PANEL).filter(id => id !== PANEL.OTHER));

export const NOTES_READER_SYSTEM = 'You read the seller notes from a UK salvage vehicle auction listing. Respond ONLY with a raw JSON object. No markdown, no explanation, no surrounding text.';

export function readerPrompt(lines) {
  const panelList = READER_PANELS.map(id => `${id} (${PANEL_DISPLAY[id]})`).join('\n');
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  return `These are the seller's notes from a salvage auction listing, one per numbered line:

${numbered}

For EACH numbered line decide:
- "kind": "concern" if it is anything a buyer should worry about: condition, damage, faults, missing parts, something that will not start, open, close or charge, warning lights, history doubts. "spec" if it only describes trim, options, equipment, key counts or admin. When in doubt, "concern".
- "panels": for a concern line only, the visible body or glass panels the line says are damaged, chosen ONLY from the list below (use the ID before the brackets). Leave it empty when the line is mechanical, electrical, about history, or does not name a visible panel. Never add a side (left, right, nearside, offside) — the IDs have no side. A spec line always has an empty list.

Allowed panel IDs:
${panelList}

Return exactly this shape, one entry per numbered line:
{ "lines": [ { "n": 1, "kind": "concern" | "spec", "panels": ["PANEL_ID", ...] } ] }`;
}

export function buildReaderBody(lines) {
  return {
    model: MODELS.assessLight,
    max_tokens: 4096,   // a 50-line list answers in ~750 compact tokens; pretty JSON can double it. Billed on use only.
    system: NOTES_READER_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: readerPrompt(lines) }] }],
  };
}

// The fallback: every line a concern, no panels. Also the shape every caller reads.
export function fallbackRead(lines, why = 'fallback') {
  return { fallback: true, why, lines: (lines || []).map(line => ({ line, kind: 'concern', panels: [] })) };
}

// Strict parse. Returns null when the output is not usable at all (→ fallback). A line the model skipped or garbled is a
// concern with no panels (when in doubt, concern); an unknown kind is a concern; panels outside the enum are dropped.
export function parseReaderOutput(text, lines) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  if (!parsed || !Array.isArray(parsed.lines)) return null;
  const byN = new Map();
  for (const e of parsed.lines) {
    const n = Number(e?.n);
    if (Number.isInteger(n) && n >= 1 && n <= lines.length && !byN.has(n)) byN.set(n, e);
  }
  const allowed = new Set(READER_PANELS);
  return {
    fallback: false,
    why: null,
    lines: lines.map((line, i) => {
      const e = byN.get(i + 1);
      const kind = e?.kind === 'spec' ? 'spec' : 'concern';
      const panels = kind === 'concern' && Array.isArray(e?.panels)
        ? [...new Set(e.panels.map(p => String(p).trim().toUpperCase()).filter(p => allowed.has(p)))]
        : [];
      return { line, kind, panels };
    }),
  };
}

// The call. fetchImpl / retry are injected: the route passes globalThis.fetch and its with529Retry, the validator
// passes stubs. Never throws — every failure path returns fallbackRead.
export async function readNotes(lines, { fetchImpl = globalThis.fetch, retry, apiKey = process.env.ANTHROPIC_API_KEY,
  timeoutMs = 45000, log = console.log } = {}) {
  if (!lines?.length) return { fallback: false, why: null, lines: [] };   // no notes → no call
  const run = retry || (async (_name, thunk) => ({ res: await thunk(), exhausted: false }));
  try {
    const body = JSON.stringify(buildReaderBody(lines));
    const { res, exhausted } = await run('notes-reader', () => fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    }));
    if (exhausted) { log(`[NOTES READER] fallback — 529 exhausted`); return fallbackRead(lines, '529 exhausted'); }
    if (!res?.ok) { log(`[NOTES READER] fallback — API error ${res?.status}`); return fallbackRead(lines, `api ${res?.status}`); }
    const apiData = await res.json();
    const u = apiData.usage || {};
    log(`[TOKEN LOG] notes-reader Input: ${u.input_tokens} | Output: ${u.output_tokens} | Stop: ${apiData.stop_reason} | Model: ${apiData.model || 'unknown'}`);
    if (apiData.stop_reason === 'max_tokens' || apiData.stop_reason === 'refusal') {
      log(`[NOTES READER] fallback — stop ${apiData.stop_reason}`);
      return fallbackRead(lines, apiData.stop_reason);
    }
    const raw = ((apiData.content || []).find(b => b.type === 'text')?.text || '').trim();
    const read = parseReaderOutput(raw, lines);
    if (!read) { log(`[NOTES READER] fallback — unparseable output`); return fallbackRead(lines, 'unparseable'); }
    for (const l of read.lines) log(`[NOTES READER] ${l.kind}${l.panels.length ? ` panels=[${l.panels.join(',')}]` : ''} "${l.line}"`);
    return read;
  } catch (err) {
    log(`[NOTES READER] fallback — ${err?.message || err}`);
    return fallbackRead(lines, 'error');
  }
}
