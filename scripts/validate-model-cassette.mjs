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

// ── batch 120 — FILL mode: live ONLY for misses ─────────────────────────────────────────────────────
{
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { costOfResponse } = await import('./lib/modelCassette.mjs');
  const d2 = mkdtempSync(join(tmpdir(), 'cassette-fill-'));
  const cp = join(d2, 'cassette.json');
  const usageResp = (tag) => JSON.stringify({ model: 'claude-opus-4-8', echo: tag, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  let live = 0;
  const mockUsage = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/anthropic/.test(url)) { live++; return new Response(usageResp(JSON.parse(init.body).messages[0].content), { status: 200 }); }
    return new Response('passthrough-target', { status: 200 });
  };
  const quiet = () => {};
  const bodyC = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'imageC' }] });
  const bodyD = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'imageD' }] });
  try {
    writeFileSync(cp, JSON.stringify({}));
    // seed a recording of A and B through capture
    globalThis.fetch = mockUsage;
    const cap = installCassette({ mode: 'capture', cassettePath: cp });
    await globalThis.fetch(AURL, { method: 'POST', body: bodyA });
    await globalThis.fetch(AURL, { method: 'POST', body: bodyB });
    cap.uninstall();
    // Re-serialise PRETTY so that any rewrite at all (the engine writes compact) changes the bytes —
    // "byte-identical" must mean "never rewritten", not "rewritten to the same text".
    writeFileSync(cp, JSON.stringify(JSON.parse(readFileSync(cp, 'utf8')), null, 2));
    const before = readFileSync(cp);

    // 1. zero misses → zero network calls, cassette byte-identical
    live = 0; globalThis.fetch = mockUsage;
    const f0 = installCassette({ mode: 'fill', cassettePath: cp, maxFills: 3, capUsd: 1, log: quiet });
    const rA = await (await globalThis.fetch(AURL, { method: 'POST', body: bodyA })).json();
    const s0 = f0.uninstall();
    ok('FILL, zero misses: served from the cassette', rA.echo === 'imageA' && s0.served === 1);
    ok('FILL, zero misses: ZERO network calls', live === 0 && s0.filled === 0);
    ok('FILL, zero misses: cassette left BYTE-IDENTICAL', Buffer.compare(before, readFileSync(cp)) === 0);

    // 2. dry run → the miss is listed and NOTHING fires; file untouched
    live = 0; globalThis.fetch = mockUsage;
    const fd = installCassette({ mode: 'fill', cassettePath: cp, dryRun: true, log: quiet });
    let dryThrew = false;
    try { await globalThis.fetch(AURL, { method: 'POST', body: bodyC }); } catch { dryThrew = true; }
    await globalThis.fetch(AURL, { method: 'POST', body: bodyA });
    const sd = fd.uninstall();
    ok('FILL-DRY: a miss throws like replay and fires NOTHING', dryThrew && live === 0 && sd.filled === 0);
    ok('FILL-DRY: the miss is listed with its reason', sd.misses.length === 1 && /not in the cassette/.test(sd.misses[0].why));
    ok('FILL-DRY: recorded-but-unserved responses are reported with their own cost (the quote basis)', sd.unserved.length === 1 && Math.abs(sd.unserved[0].usd - costOfResponse(usageResp('imageB')).usd) < 1e-12);
    ok('FILL-DRY: cassette untouched', Buffer.compare(before, readFileSync(cp)) === 0);

    // 3. live fill → fires ONLY the miss, appends it, never re-fires a recorded call
    live = 0; globalThis.fetch = mockUsage;
    const f1 = installCassette({ mode: 'fill', cassettePath: cp, maxFills: 1, capUsd: 1, log: quiet });
    await globalThis.fetch(AURL, { method: 'POST', body: bodyA });                       // recorded
    const rC = await (await globalThis.fetch(AURL, { method: 'POST', body: bodyC })).json();   // miss → live
    await globalThis.fetch(AURL, { method: 'POST', body: bodyB });                       // recorded
    let capThrew = false;
    try { await globalThis.fetch(AURL, { method: 'POST', body: bodyD }); } catch { capThrew = true; }   // 2nd miss > max-fills
    const s1 = f1.uninstall();
    ok('FILL: exactly ONE live call — the miss; recorded calls were served, never re-fired', live === 1 && s1.served === 2 && s1.filled === 1 && rC.echo === 'imageC');
    ok('FILL: a miss beyond --max-fills is REFUSED, not fired', capThrew && live === 1);
    ok('FILL: the fill\'s cost is taken from the response\'s own usage', Math.abs(s1.fillUsd - costOfResponse(usageResp('imageC')).usd) < 1e-12);
    const after = JSON.parse(readFileSync(cp, 'utf8'));
    ok('FILL: the new recording is appended; every earlier recording kept', Object.keys(after).length === 3);
    live = 0; globalThis.fetch = mockUsage;
    const rep = installCassette({ mode: 'replay', cassettePath: cp });
    await globalThis.fetch(AURL, { method: 'POST', body: bodyC });
    rep.uninstall();
    ok('FILL: afterwards the filled call replays at £0', live === 0);

    // 4. the dollar cap
    live = 0; globalThis.fetch = mockUsage;
    const fc = installCassette({ mode: 'fill', cassettePath: cp, maxFills: 5, capUsd: 0.0001, log: quiet });
    await globalThis.fetch(AURL, { method: 'POST', body: bodyD });                 // fires (running $0 < cap), costs more than the cap
    let dollarThrew = false;
    try { await globalThis.fetch(AURL, { method: 'POST', body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'imageE' }] }) }); } catch { dollarThrew = true; }
    fc.uninstall();
    ok('FILL: once the cap is spent, the next miss is REFUSED', dollarThrew && live === 1);

    // 5. it can never become a full re-capture
    let noCas = false, noLimits = false;
    try { installCassette({ mode: 'fill', cassettePath: join(d2, 'missing.json'), maxFills: 3, capUsd: 1 }); } catch { noCas = true; }
    try { installCassette({ mode: 'fill', cassettePath: cp }); } catch { noLimits = true; }
    ok('FILL: refuses to start without an existing cassette', noCas && !existsSync(join(d2, 'missing.json')));
    ok('FILL: a LIVE fill refuses without explicit --max-fills and --fill-cap-usd', noLimits);
    const src = readFileSync(new URL('./replay.mjs', import.meta.url), 'utf8');
    ok('replay.mjs: --fill-misses cannot be combined with --capture / --vision-live / --vision-fixture', src.includes("['--capture', '--vision-live', '--vision-fixture'].some(f => process.argv.includes(f))"));
  } finally {
    globalThis.fetch = origFetch;
    rmSync(d2, { recursive: true, force: true });
  }
}

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
