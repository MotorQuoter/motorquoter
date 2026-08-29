// Validator — model cassette (batch 83). £0: no network, no vision. Proves the capture→replay mechanism
// is deterministic and gate-clean (fetch-interception only) BEFORE any paid sweep.
// Run: node scripts/validate-model-cassette.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCassette } from './lib/modelCassette.mjs';

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }

const dir = mkdtempSync(join(tmpdir(), 'cassette-'));
const cassettePath = join(dir, 'cassette.json');
const AURL = 'https://api.anthropic.com/v1/messages';
const bodyA = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'imageA' }] });
const bodyB = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'imageB' }] });

// A mock "real" fetch: returns a per-body canned Anthropic response, and counts real calls.
let realCalls = 0;
const mockReal = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (/anthropic/.test(url)) { realCalls++; return new Response(JSON.stringify({ echo: JSON.parse(init.body).messages[0].content }), { status: 200 }); }
  return new Response('passthrough-target', { status: 200 });
};

const origFetch = globalThis.fetch;
try {
  // ── CAPTURE ──
  globalThis.fetch = mockReal;
  const cap = installCassette({ mode: 'capture', cassettePath });
  const rA = await (await globalThis.fetch(AURL, { method: 'POST', body: bodyA })).json();
  const rB = await (await globalThis.fetch(AURL, { method: 'POST', body: bodyB })).json();
  await globalThis.fetch('https://example.com/other', { method: 'GET' });   // non-Anthropic → passthrough
  const capStats = cap.uninstall();
  ok('capture: real API hit for each distinct Anthropic call', realCalls === 2);
  ok('capture: response bodies pass through unchanged (A/B distinct)', rA.echo === 'imageA' && rB.echo === 'imageB');
  ok('capture: non-Anthropic request passed through, not recorded', capStats.captured === 2 && capStats.passthrough === 1);
  ok('capture: fetch restored on uninstall', globalThis.fetch === mockReal);

  // ── REPLAY (deterministic, £0, no real calls) ──
  realCalls = 0;
  globalThis.fetch = mockReal;
  const rep = installCassette({ mode: 'replay', cassettePath });
  const rA2 = await (await globalThis.fetch(AURL, { method: 'POST', body: bodyA })).json();
  const rB2 = await (await globalThis.fetch(AURL, { method: 'POST', body: bodyB })).json();
  ok('replay: served the frozen responses (same as captured)', rA2.echo === 'imageA' && rB2.echo === 'imageB');
  ok('replay: NOT one real Anthropic call was made', realCalls === 0);
  // deterministic: same body → same frozen response, again (fresh cursor via re-install)
  rep.uninstall();
  const rep2 = installCassette({ mode: 'replay', cassettePath });
  const rA3 = await (await globalThis.fetch(AURL, { method: 'POST', body: bodyA })).json();
  ok('replay: deterministic across re-runs (same input → same output)', rA3.echo === 'imageA');
  // a body never captured → loud MISS, never a silent wrong answer
  let missed = false;
  try { await globalThis.fetch(AURL, { method: 'POST', body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'imageZ' }] }) }); }
  catch { missed = true; }
  ok('replay: an uncaptured request throws a loud MISS (never a silent wrong answer)', missed === true);
  ok('replay: non-Anthropic still passes through', (await (await globalThis.fetch('https://example.com/x')).text()) === 'passthrough-target');
  rep2.uninstall();
} finally {
  globalThis.fetch = origFetch;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
