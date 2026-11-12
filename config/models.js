// SINGLE SOURCE OF TRUTH for every Claude model the app calls.
// Every model: literal in the route files imports from here — nothing hard-codes a model
// string anywhere else. The canary (app/api/health/models) verifies exactly MODEL_IDS are
// still live, so this file IS the app's declared model-dependency set. When Anthropic retires
// a model, swap the value here (one place) and the canary + every call site follow.
export const MODELS = {
  plateScan:        'claude-sonnet-5',             // platescan/route.js — number-plate OCR
  assessPrimary:    'claude-opus-4-8',             // salvage/assess/route.js — 11 Opus call sites
  assessLight:      'claude-haiku-4-5',            // salvage/assess/route.js — lighter Haiku vision reads
  assessLightDated: 'claude-haiku-4-5-20251001',   // salvage/assess/route.js readPhotoOdometer — Haiku dated snapshot pin
};

// Distinct set (dedup by value) — the canary's live-check list. Currently 4 strings.
export const MODEL_IDS = [...new Set(Object.values(MODELS))];

// ── batch 246 — ONE OWNER of each model's request shape (re-implemented fresh on main from the batch 195/197
// design, c1c3b6e; Cowork ruling 12 Nov). What each model accepts, one honest row per id:
//   forcedToolChoice — accepts tool_choice {type:'any'} / {type:'tool'}. Opus 5.5, Fable 5.1 and Fable 5.2 reject it
//                      with HTTP 400 "tool_choice: type "tool" and "any" are not supported for this model." (measured
//                      batch 194/195; Fable 5.2 per Cowork 12 Nov, platform docs). Opus 4.8, Haiku 4.5, Sonnet 5 accept it.
//   thinksByDefault  — thinks when the request sends no `thinking` field (none is ever sent here). Opus 4.8 and Haiku 4.5
//                      do not; Opus 5.5 / Fable 5.1 / Fable 5.2 always do (thinking counts against max_tokens); Sonnet 5
//                      runs adaptive when omitted (batch 197 table).
//   effort           — accepts output_config.effort. TRUE for Fable 5.2 (and Opus 4.8 / 5.5, Fable 5.1, Sonnet 5);
//                      Haiku 4.5 rejects it (HTTP 400, measured batch 197). Recorded for honesty only: NO call site in
//                      this phase sends an effort (BATCH 245 tested Fable 5.2 at its default effort; the shipped shape is
//                      the tested shape). Effort is a later, separate change.
// An id not listed: assumed to think (gets headroom) and NOT to accept forcing.
export const MODEL_CAPS = Object.freeze({
  'claude-opus-4-8':           Object.freeze({ forcedToolChoice: true,  thinksByDefault: false, effort: true }),
  'claude-haiku-4-5':          Object.freeze({ forcedToolChoice: true,  thinksByDefault: false, effort: false }),
  'claude-haiku-4-5-20251001': Object.freeze({ forcedToolChoice: true,  thinksByDefault: false, effort: false }),
  'claude-sonnet-5':           Object.freeze({ forcedToolChoice: true,  thinksByDefault: true,  effort: true }),
  'claude-opus-5-5':           Object.freeze({ forcedToolChoice: false, thinksByDefault: true,  effort: true }),
  'claude-fable-5-1':          Object.freeze({ forcedToolChoice: false, thinksByDefault: true,  effort: true }),
  'claude-fable-5-2':          Object.freeze({ forcedToolChoice: false, thinksByDefault: true,  effort: true }),
});
// Thinking room added to a thinking model's answer budget — BATCH 245's tested value (old max_tokens + 16000 on every
// assessPrimary call). max_tokens is a ceiling, not a charge: unused room costs nothing.
export const THINKING_HEADROOM = 16000;
export function thinksByDefault(model) {
  return MODEL_CAPS[model] ? MODEL_CAPS[model].thinksByDefault === true : true;
}
export function supportsForcedToolChoice(model) {
  return MODEL_CAPS[model]?.forcedToolChoice === true;
}
// The one owner of a call's output sizing. `answerTokens` = what the answer needs (the site's pre-batch-246 max_tokens).
// A model that does not think by default → { max_tokens: answerTokens }, spread in the same position, so the request
// body is byte-identical to before. A thinking model → answerTokens + THINKING_HEADROOM. Never an effort.
export function outputBudgetFor(model, answerTokens) {
  return { max_tokens: thinksByDefault(model) ? answerTokens + THINKING_HEADROOM : answerTokens };
}
// The tool_choice a call site sends. A model that accepts forcing gets `forcedShape` itself (same object → byte-identical);
// one that does not gets {type:'auto'}. On 'auto' the model may answer without the tool — every caller already has a
// "no tool block" path, and that path is what then runs.
export function toolChoiceFor(model, forcedShape) {
  return supportsForcedToolChoice(model) ? forcedShape : { type: 'auto' };
}

// ── batch 246 — THE ONE PRICE TABLE ($ per MTok), by model id: input / output / cache write 5m / cache write 1h /
// cache read. Carried from c1c3b6e's MODEL_PRICES (Anthropic list, read 25 Sep 2026) plus Fable 5.2 from the BATCH 246
// brief (Cowork, 12 Nov, platform.claude.com): $8 in / $40 out, 5m write 1.25×, 1h write 2×, cache read 0.025× ($0.20).
// output_tokens include thinking tokens. A model not in the table is priced at the DEAREST row (never under-counts a cap).
// Dev tooling only (scripts/lib/modelCassette.mjs) — nothing on the production path prices a call.
export const MODEL_PRICES = Object.freeze({
  'claude-opus-4-8':  Object.freeze([5, 25, 6.25, 10, 0.50]),
  'claude-opus-5-5':  Object.freeze([4, 20, 5, 8, 0.20]),
  'claude-fable-5-1': Object.freeze([10, 50, 12.5, 20, 0.25]),
  'claude-fable-5-2': Object.freeze([8, 40, 10, 16, 0.20]),
  'claude-sonnet-5':  Object.freeze([2, 10, 2.5, 4, 0.20]),
  'claude-haiku-4-5': Object.freeze([1, 5, 1.25, 2, 0.10]),   // also prices the dated id claude-haiku-4-5-20251001
});
const DEAREST_PRICE = Object.values(MODEL_PRICES).reduce((m, p) => (p[1] > m[1] ? p : m));
// Exact id, or the id's dated snapshot ("<id>-YYYYMMDD"). Longest key first, so no id is priced by a shorter cousin.
export function priceOfModel(model) {
  const id = String(model || '');
  const key = Object.keys(MODEL_PRICES).sort((x, y) => y.length - x.length)
    .find((k) => id === k || (id.startsWith(`${k}-`) && /^\d{8}$/.test(id.slice(k.length + 1))));
  return key ? { price: MODEL_PRICES[key], key } : { price: DEAREST_PRICE, key: null };
}
