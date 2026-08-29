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

/**
 * Install the cassette. Returns { uninstall, stats }.
 * @param mode 'capture' — passes calls through to the real API and RECORDS each response.
 *             'replay'  — serves every Anthropic call from the cassette; throws on a miss.
 * @param cassettePath  JSON file: { [key]: [responseBodyString, ...] }.
 */
export function installCassette({ mode, cassettePath }) {
  const original = globalThis.fetch;
  if (typeof original !== 'function') throw new Error('globalThis.fetch is not available (need Node 18+)');

  const store = (mode === 'replay' && existsSync(cassettePath))
    ? JSON.parse(readFileSync(cassettePath, 'utf8'))
    : {};
  const cursors = {};              // replay FIFO cursor per key
  const stats = { captured: 0, served: 0, missed: 0, passthrough: 0 };

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
    return stats;
  };

  return { uninstall, stats };
}
