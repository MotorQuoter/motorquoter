// batch 252 A2 — THE ONE OWNER OF `_runFacts`: what a run actually did, stamped on the stored assessment so it survives the
// Vercel 256-line log cap. Shown nowhere to the buyer (the route strips it from every JSON it returns).
//
// One run = one store, carried by AsyncLocalStorage, so concurrent runs in one fluid-compute instance never mix:
//   runWithFacts(store, fn)     — runAssessment's body runs inside it
//   markPhase(name, {stamp})    — a phase boundary (T1.1 phases); stamp:true also calls store.onPhase (the route's
//                                 _runProgress writer). No store (a validator, a stub) → no-op.
//   recordCall(tag, res, ms)    — every Anthropic reply, from with529Retry (the one wrapper every call goes through): reads
//                                 a CLONE of the reply, so the caller's body and every request byte are untouched.
//   noteMismatch()              — from checkServedModel, once per [MODEL MISMATCH].
//   summariseRunFacts(store)    — the stamp: sha, runMs, per-phase ms, served models per call class, mismatch count,
//                                 stop reasons (refusal / max_tokens counted), HTTP errors, tokens and USD by model.
// Every function swallows its own errors: telemetry never fails a run.
import { AsyncLocalStorage } from 'node:async_hooks';
import { priceOfModel } from '../config/models.js';

const als = new AsyncLocalStorage();

export function newRunFacts({ sha = 'n/a', onPhase = null, now = Date.now } = {}) {
  return { sha, onPhase, now, t0: now(), phases: [], calls: [], mismatch: 0, httpErrors: 0, exhausted: 0 };
}
export function runWithFacts(store, fn) { return als.run(store, fn); }
export function currentRunFacts() { return als.getStore() ?? null; }

export function markPhase(name, { stamp = false } = {}) {
  const s = als.getStore(); if (!s) return;
  try {
    const ms = s.now() - s.t0;
    s.phases.push({ phase: name, atMs: ms });
    if (stamp && typeof s.onPhase === 'function') s.onPhase(name, ms);
  } catch { /* telemetry never fails a run */ }
}

// per-view-12 → per-view, notes-confirm-WINDSCREEN → notes-confirm, notes-opened-bonnet → notes-opened
export function callClass(tag) {
  const t = String(tag || 'unknown');
  if (/^per-view-\d+$/.test(t)) return 'per-view';
  const m = t.match(/^(notes-confirm|notes-opened)-/); if (m) return m[1];
  return t;
}

export async function recordCall(tag, res, ms = null, { exhausted = false } = {}) {
  const s = als.getStore(); if (!s) return;
  try {
    if (exhausted) s.exhausted++;
    if (!res) { s.calls.push({ cls: callClass(tag), status: 'network', ms }); s.httpErrors++; return; }
    if (!res.ok) { s.calls.push({ cls: callClass(tag), status: res.status, ms }); s.httpErrors++; return; }
    if (typeof res.clone !== 'function') { s.calls.push({ cls: callClass(tag), status: res.status, ms }); return; }
    const j = await res.clone().json();
    s.calls.push({ cls: callClass(tag), status: res.status, ms, model: j?.model ?? null, stop: j?.stop_reason ?? null, usage: j?.usage ?? null });
  } catch { /* unreadable body: counted nowhere, never thrown */ }
}

export function noteMismatch() { const s = als.getStore(); if (s) s.mismatch++; }

const r4 = (x) => Math.round(x * 10000) / 10000;
export function summariseRunFacts(store, extra = {}) {
  try {
    const s = store; const end = s.now() - s.t0;
    // per-phase ms: each boundary minus the previous one (the phase that ENDED at that boundary)
    const phases = {}; let prev = 0;
    for (const p of s.phases) { phases[p.phase] = (phases[p.phase] || 0) + (p.atMs - prev); prev = p.atMs; }
    const models = {}, stops = {}, tokens = {}, usd = {}; let total = 0;
    for (const c of s.calls) {
      if (c.model) (models[c.cls] ||= new Set()).add(c.model);
      if (c.stop) stops[c.stop] = (stops[c.stop] || 0) + 1;
      if (!c.usage || !c.model) continue;
      const u = c.usage, t = (tokens[c.model] ||= { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
      const w5 = u.cache_creation?.ephemeral_5m_input_tokens, w1 = u.cache_creation?.ephemeral_1h_input_tokens;
      const write = u.cache_creation_input_tokens || 0;
      t.calls++; t.input += u.input_tokens || 0; t.output += u.output_tokens || 0; t.cacheWrite += write; t.cacheRead += u.cache_read_input_tokens || 0;
      const [pin, pout, pw5, pw1, pr] = priceOfModel(c.model).price;
      // 1h-cache writes are priced as such when the reply says so; any write the reply does not split is priced as 5m
      const w1n = Number.isFinite(w1) ? w1 : 0, w5n = Number.isFinite(w5) ? w5 : write - w1n;
      const cost = ((u.input_tokens || 0) * pin + (u.output_tokens || 0) * pout + w5n * pw5 + w1n * pw1 + (u.cache_read_input_tokens || 0) * pr) / 1e6;
      usd[c.model] = r4((usd[c.model] || 0) + cost); total += cost;
    }
    return {
      sha: s.sha, runMs: end, phasesMs: phases,
      servedModels: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, [...v]])),
      calls: s.calls.length, mismatchCount: s.mismatch,
      stopReasons: stops, refusals: stops.refusal || 0, maxTokens: stops.max_tokens || 0,
      httpErrors: s.httpErrors, exhausted529: s.exhausted,
      tokens, usd: { ...usd, total: r4(total) },
      ...extra,
    };
  } catch (err) {
    return { error: `runFacts summary failed: ${err?.message || err}` };
  }
}

// batch 252 A2 / 253 A2: _runFacts is stored on the row but never sent to the buyer's browser — the assess GET and the status
// GET both send the assessment through this.
export function forBuyer(assessment) {
  if (!assessment || typeof assessment !== 'object') return assessment;
  const { _runFacts, ...rest } = assessment;
  return rest;
}
