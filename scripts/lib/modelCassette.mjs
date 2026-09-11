// Model cassette (batch 83) — a VCR for the salvage engine's Anthropic vision calls, implemented
// ENTIRELY in the harness by intercepting globalThis.fetch. NO engine change: runAssessment /
// runPerViewAssess make their model fetches unchanged; this wraps fetch around them.
//
// WHY: batch 81 is the largest change to the money in the engine's history. A before/after table built
// from LIVE runs measures the code change PLUS the model's run-to-run variance, mixed (proven: DL72FVX
// FRONT_BUMPER graded MINOR one run, disagree another — £240 of swing on the same photos). Freezing every
// model response makes replay DETERMINISTIC: identical inputs → identical per-view verdicts every time,
// so any movement in the table is the code and only the code. £0 on replay (no vision, no supplier).
//
// KEY: the SHA-256 of the request body (model + system + messages + images). Deterministic given the same
// fixture, so the same call keys to the same cassette entry across runs and across engine branches
// (main vs the batch-81 branch), which is exactly what makes a before/after comparison valid. Identical
// bodies (should not happen — each per-view carries a distinct image) are stored as a FIFO list and
// served in order, so even a collision replays faithfully.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const ANTHROPIC_RE = /api\.anthropic\.com\/v1\/messages/;

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;   // Request object
  try { return String(input); } catch { return ''; }
}

function keyOf(bodyStr) {
  return createHash('sha256').update(bodyStr || '').digest('hex').slice(0, 32);
}

// ── batch 120 — cost of one recorded response, from its OWN usage block ───────────────────────────
// $/MTok at list: Opus $5 in / $25 out, Haiku $1 / $5. Cache read 0.1×, 5-minute write 1.25×, 1-hour
// write 2× (the per-view system prompt is cached with ttl:'1h'). Re-derive, never quote a table.
const PRICE = (model) => (/haiku/.test(model || '') ? [1, 5] : /sonnet/.test(model || '') ? [3, 15] : [5, 25]);
export function costOfResponse(responseText) {
  let j; try { j = JSON.parse(responseText); } catch { return { usd: 0, model: '?', usage: {} }; }
  const u = j.usage || {}; const [pi, po] = PRICE(j.model);
  const cw5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const cw1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cwOther = Math.max(0, (u.cache_creation_input_tokens || 0) - cw5 - cw1);
  const usd = ((u.input_tokens || 0) * pi + (cw5 + cwOther) * pi * 1.25 + cw1 * pi * 2
    + (u.cache_read_input_tokens || 0) * pi * 0.1 + (u.output_tokens || 0) * po) / 1e6;
  return { usd, model: j.model || '?', usage: u };
}
// A short, human label for a request body — what the fill fired, in the log. Never the images.
export function labelOfRequest(bodyStr) {
  try {
    const b = JSON.parse(bodyStr);
    const sys = Array.isArray(b.system) ? (b.system[0]?.text || '') : (b.system || '');
    const content = (b.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }]));
    const images = content.filter((c) => c.type === 'image').length;
    const lastText = [...content].reverse().find((c) => c.type === 'text')?.text || '';
    return `model=${b.model} images=${images} turns=${(b.messages || []).length}${b.tools ? ' tools' : ''} system="${sys.slice(0, 50).replace(/\s+/g, ' ')}…" text="${lastText.slice(0, 70).replace(/\s+/g, ' ')}…"`;
  } catch { return '(unparseable body)'; }
}

/**
 * Install the cassette. Returns { uninstall, stats }.
 * @param mode 'capture' — passes calls through to the real API and RECORDS each response.
 *             'replay'  — serves every Anthropic call from the cassette; throws on a miss.
 *             'fill'    — batch 120: serves every RECORDED call from the cassette (never re-fired) and goes
 *                         LIVE ONLY for a miss, appending the new recording. Refuses to start without an
 *                         existing cassette (so it can never become a full re-capture), stops firing after
 *                         `maxFills` live calls or once `capUsd` is spent, and with `dryRun` fires NOTHING —
 *                         it lists each miss and throws exactly as replay does. A run with zero misses
 *                         leaves the cassette byte-identical (it is never rewritten).
 * @param cassettePath  JSON file: { [key]: [responseBodyString, ...] }.
 */
export function installCassette({ mode, cassettePath, maxFills = 0, capUsd = 0, dryRun = false, log = console.log }) {
  const original = globalThis.fetch;
  if (typeof original !== 'function') throw new Error('globalThis.fetch is not available (need Node 18+)');
  if (mode === 'fill' && !existsSync(cassettePath)) {
    throw new Error(`[CASSETTE][FILL] refusing: no cassette at ${cassettePath}. Fill only tops up an existing recording; a first capture is --capture.`);
  }
  if (mode === 'fill' && !dryRun && !(Number.isInteger(maxFills) && maxFills > 0 && capUsd > 0)) {
    throw new Error('[CASSETTE][FILL] refusing: a live fill needs an explicit --max-fills N (> 0) and --fill-cap-usd X (> 0).');
  }

  const store = ((mode === 'replay' || mode === 'fill') && existsSync(cassettePath))
    ? JSON.parse(readFileSync(cassettePath, 'utf8'))
    : {};
  const cursors = {};              // replay FIFO cursor per key
  const stats = { captured: 0, served: 0, missed: 0, passthrough: 0, filled: 0, fillUsd: 0, misses: [], fills: [] };

  globalThis.fetch = async (input, init = {}) => {
    const url = urlOf(input);
    if (!ANTHROPIC_RE.test(url)) { stats.passthrough++; return original(input, init); }

    // The body is on init (route.js always passes { method, headers, body } as init).
    const bodyStr = typeof init.body === 'string' ? init.body : (init.body ? JSON.stringify(init.body) : '');
    const key = keyOf(bodyStr);

    if (mode === 'replay') {
      const list = store[key];
      const i = cursors[key] ?? 0;
      if (!list || i >= list.length) {
        stats.missed++;
        throw new Error(`[CASSETTE][MISS] no frozen response for request key ${key} (cursor ${i}). Cassette is incomplete — re-capture this lot.`);
      }
      cursors[key] = i + 1;
      stats.served++;
      return new Response(list[i], { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (mode === 'fill') {
      const list = store[key];
      const i = cursors[key] ?? 0;
      if (list && i < list.length) {                          // RECORDED → served, never re-fired
        cursors[key] = i + 1;
        stats.served++;
        return new Response(list[i], { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const why = !list ? 'request key not in the cassette (the request body changed)' : `cursor ${i} is past the ${list.length} recorded response(s) for this key`;
      const label = labelOfRequest(bodyStr);
      stats.missed++;
      stats.misses.push({ key, why, label });
      if (dryRun) {
        log(`[CASSETTE][FILL-DRY] MISS #${stats.missed} key=${key} — ${why}. Would fire: ${label}. NOT fired (dry run).`);
        throw new Error(`[CASSETTE][FILL-DRY] miss not fired (dry run): ${key}`);
      }
      if (stats.filled >= maxFills) {
        log(`[CASSETTE][FILL] STOP — miss #${stats.missed} (${label}) would exceed --max-fills ${maxFills}. NOT fired.`);
        throw new Error(`[CASSETTE][FILL] max-fills ${maxFills} reached — refusing to fire ${key}`);
      }
      if (stats.fillUsd >= capUsd) {
        log(`[CASSETTE][FILL] STOP — $${stats.fillUsd.toFixed(3)} already spent ≥ cap $${capUsd}. Miss #${stats.missed} (${label}) NOT fired.`);
        throw new Error(`[CASSETTE][FILL] cap $${capUsd} reached — refusing to fire ${key}`);
      }
      const res = await original(input, init);
      const text = await res.clone().text();
      (store[key] ||= []).push(text);
      cursors[key] = (cursors[key] ?? 0) + 1;
      const c = costOfResponse(text);
      stats.filled++;
      stats.fillUsd += c.usd;
      stats.fills.push({ key, why, label, status: res.status, usd: c.usd, usage: c.usage });
      const u = c.usage;
      log(`[CASSETTE][FILL] LIVE #${stats.filled} key=${key} — ${why}. Fired: ${label}. status=${res.status} model=${c.model} in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cacheWrite=${u.cache_creation_input_tokens ?? 0} cacheRead=${u.cache_read_input_tokens ?? 0} cost=$${c.usd.toFixed(4)} (running $${stats.fillUsd.toFixed(4)} of cap $${capUsd})`);
      return new Response(text, { status: res.status, headers: res.headers });
    }

    // capture: real call, record the response text, hand back a fresh Response with the same text.
    const res = await original(input, init);
    const text = await res.clone().text();
    (store[key] ||= []).push(text);
    stats.captured++;
    return new Response(text, { status: res.status, headers: res.headers });
  };

  const uninstall = () => {
    globalThis.fetch = original;
    if (mode === 'capture') {
      mkdirSync(dirname(cassettePath), { recursive: true });
      writeFileSync(cassettePath, JSON.stringify(store, null, 0));
    }
    // fill: write ONLY when something was actually recorded — zero misses (or a dry run) leaves the file
    // byte-identical. Recorded entries are appended to their key's list; nothing recorded is dropped.
    if (mode === 'fill' && !dryRun && stats.filled > 0) {
      writeFileSync(cassettePath, JSON.stringify(store, null, 0));
    }
    // Recorded responses this run never served — in a dry run these are the calls the misses REPLACE,
    // so their own usage is the measured quote for the fill.
    if (mode === 'fill') {
      stats.unserved = Object.entries(store).flatMap(([k, arr]) => arr.slice(cursors[k] ?? 0).map((text) => ({ key: k, ...costOfResponse(text), text })));
    }
    return stats;
  };

  return { uninstall, stats };
}
