// SINGLE SOURCE OF TRUTH for every Claude model the app calls.
// Every model: literal in the route files imports from here — nothing hard-codes a model
// string anywhere else. The canary (app/api/health/models) verifies exactly MODEL_IDS are
// still live, so this file IS the app's declared model-dependency set. When Anthropic retires
// a model, swap the value here (one place) and the canary + every call site follow.
export const MODELS = {
  plateScan:        'claude-haiku-4-5',            // platescan/route.js — number-plate OCR
  assessPrimary:    'claude-opus-4-8',             // salvage/assess/route.js — 11 Opus call sites
  assessLight:      'claude-haiku-4-5',            // salvage/assess/route.js — lighter Haiku vision reads
  assessLightDated: 'claude-haiku-4-5-20251001',   // salvage/assess/route.js:2936 — Haiku dated snapshot pin
};

// Distinct set (dedup by value) — the canary's live-check list. Currently 3 strings.
export const MODEL_IDS = [...new Set(Object.values(MODELS))];
