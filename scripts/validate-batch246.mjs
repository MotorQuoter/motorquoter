// Validator — batch 246 (swap phase, Part B). £0: no network, no model call. Every fetch is stubbed.
// Run: node --loader ./scripts/lib/alias-loader.mjs scripts/validate-batch246.mjs
//
//   1. One owner of request shape (config/models.js): MODEL_CAPS rows, outputBudgetFor, toolChoiceFor. Non-thinking
//      models (Opus 4.8, Haiku) get a body byte-identical to the pre-246 literal; Fable 5.2 gets +16000 and no effort.
//   2. notes-confirm body: hash of buildConfirmBody vs the same function at 1cdce1c (git show) — identical when the
//      configured assessPrimary does not think; exactly +16000 max_tokens (nothing else) when it does.
//   3. [MODEL MISMATCH]: silent on a match / dated snapshot / missing model; loud on a mismatch, ONE alert per run.
//   4. Cassette pricer (scripts/lib/modelCassette.mjs costOfResponse) = the batch 245 guard ledger to the cent, on 3 lots.
//   5. Canary (/api/health/models) checks exactly MODEL_IDS, incl. MODELS.assessPrimary — fetch stubbed, no live call.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = 'C:/users/vincy/motorquoter-real';
let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } };
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const M = await import('@/config/models');
const { MODELS, MODEL_IDS, MODEL_CAPS, THINKING_HEADROOM, outputBudgetFor, toolChoiceFor, thinksByDefault, priceOfModel, MODEL_PRICES } = M;

// ── 1. one owner ──────────────────────────────────────────────────────────────────────────────────
console.log('\n1. One owner of request shape');
check('THINKING_HEADROOM is the BATCH 245 tested value, 16000', THINKING_HEADROOM === 16000);
check('fable-5-2 row: rejects forcing, thinks by default, accepts effort (honest row; no site sends effort)',
  MODEL_CAPS['claude-fable-5-2']?.forcedToolChoice === false && MODEL_CAPS['claude-fable-5-2']?.thinksByDefault === true && MODEL_CAPS['claude-fable-5-2']?.effort === true);
for (const id of ['claude-opus-4-8', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
  for (const n of [64, 200, 256, 512, 1024, 2048, 3072, 16000]) {
    const before = JSON.stringify({ model: id, max_tokens: n, system: 's', messages: [] });
    const after = JSON.stringify({ model: id, ...outputBudgetFor(id, n), system: 's', messages: [] });
    if (before !== after) { check(`${id} max_tokens ${n} byte-identical`, false); }
  }
  check(`${id}: body byte-identical at every pre-246 max_tokens (64…16000), same key position`, true);
  const any = { type: 'any' }, tool = { type: 'tool', name: 'recordCoreObservations' };
  check(`${id}: toolChoiceFor returns the SAME forced object (any / tool)`, toolChoiceFor(id, any) === any && toolChoiceFor(id, tool) === tool);
}
const fb = outputBudgetFor('claude-fable-5-2', 256);
check('fable-5-2: 256 → { max_tokens: 16256 } and nothing else (no effort, no thinking field)', JSON.stringify(fb) === '{"max_tokens":16256}');
check('fable-5-2: forced shapes → { type: "auto" }', JSON.stringify(toolChoiceFor('claude-fable-5-2', { type: 'any' })) === '{"type":"auto"}');
check('an unknown id is assumed to think (headroom) and not to accept forcing', thinksByDefault('claude-x-9') && toolChoiceFor('claude-x-9', { type: 'any' }).type === 'auto');
console.log(`  configured assessPrimary = ${MODELS.assessPrimary} (thinks: ${thinksByDefault(MODELS.assessPrimary)})`);

// The route's call sites: every assessPrimary max_tokens goes through the owner; no literal survives; no effort anywhere.
const route = readFileSync(`${ROOT}/app/api/salvage/assess/route.js`, 'utf8');
const nc = readFileSync(`${ROOT}/lib/notesConfirm.mjs`, 'utf8');
const primarySites = [...route.matchAll(/model: MODELS\.assessPrimary,\s*\n\s*([^\n]*)/g)].map((m) => m[1]);
check(`route.js: ${primarySites.length} assessPrimary bodies, every one sized by outputBudgetFor (expect 10)`,
  primarySites.length === 10 && primarySites.every((l) => l.startsWith('...outputBudgetFor(MODELS.assessPrimary, ')));
check('notesConfirm.mjs: the assessPrimary body is sized by outputBudgetFor', /model: MODELS\.assessPrimary, \.\.\.outputBudgetFor\(MODELS\.assessPrimary, 256\)/.test(nc));
check('no effort / output_config / thinking field is sent anywhere (route, notesConfirm, notesReader, platescan)',
  ![route, nc, readFileSync(`${ROOT}/lib/notesReader.mjs`, 'utf8'), readFileSync(`${ROOT}/app/api/platescan/route.js`, 'utf8')]
    .some((s) => /output_config|\beffort:|thinking:\s*\{/.test(s)));
check('no forced tool_choice literal survives in route.js (all 3 go through toolChoiceFor)',
  !/tool_choice: \{ type: '(any|tool)'/.test(route) && (route.match(/toolChoiceFor\(MODELS\./g) || []).length === 3);

// ── 2. notes-confirm body hash vs 1cdce1c ────────────────────────────────────────────────────────
console.log('\n2. notes-confirm request body vs 1cdce1c');
const tmp = `${ROOT}/lib/.b246-notesConfirm-1cdce1c.mjs`;
writeFileSync(tmp, execFileSync('git', ['-C', ROOT, 'show', '1cdce1c:lib/notesConfirm.mjs'], { encoding: 'utf8' }));
try {
  const OLD = await import(`file:///${tmp}`);
  const NEW = await import('@/lib/notesConfirm.mjs');
  const imgs = ['data:image/jpeg;base64,AAAA', 'data:image/png;base64,BBBB', 'CCCC'];
  for (const panel of ['HEADLAMP', 'SIDE_GLASS', 'FRONT_DOOR']) {
    const o = OLD.buildConfirmBody(imgs, panel), n = NEW.buildConfirmBody(imgs, panel);
    if (thinksByDefault(MODELS.assessPrimary)) {
      const { max_tokens: om, ...orest } = o; const { max_tokens: nm, ...nrest } = n;
      check(`${panel}: ${MODELS.assessPrimary} thinks → max_tokens ${om} → ${nm} (+${THINKING_HEADROOM}), every other byte identical`,
        nm === om + THINKING_HEADROOM && JSON.stringify(orest) === JSON.stringify(nrest));
    } else {
      check(`${panel}: body hash identical to 1cdce1c (${sha(JSON.stringify(o))})`, sha(JSON.stringify(o)) === sha(JSON.stringify(n)));
    }
  }
} finally { if (existsSync(tmp)) unlinkSync(tmp); }

// ── 3. [MODEL MISMATCH] ──────────────────────────────────────────────────────────────────────────
console.log('\n3. [MODEL MISMATCH]');
const SM = await import('@/lib/servedModel.mjs');
const logs = []; const alerts = [];
const opts = { configured: 'claude-fable-5-2', log: (l) => logs.push(l), alert: async (...a) => { alerts.push(a); } };
SM.beginRun();
check('match → true, silent', (await SM.checkServedModel('t', { model: 'claude-fable-5-2' }, opts)) === true && logs.length === 0);
check('dated snapshot of the configured id → true, silent', (await SM.checkServedModel('t', { model: 'claude-fable-5-2-20261109' }, opts)) === true && logs.length === 0);
check('no model field (a stub) → true, silent', (await SM.checkServedModel('t', {}, opts)) === true && logs.length === 0);
check('a cousin id is NOT a match (claude-fable-5-2x)', SM.servedModelMatches('claude-fable-5-2', 'claude-fable-5-2x') === false);
await SM.checkServedModel('per-view-3', { model: 'claude-opus-4-8' }, opts);
await SM.checkServedModel('call1-iter0', { model: 'claude-opus-4-8' }, opts);
check('mismatch → [MODEL MISMATCH] line on EVERY occurrence (2)', logs.length === 2 && logs[0] === '[MODEL MISMATCH] call=per-view-3 configured=claude-fable-5-2 served=claude-opus-4-8');
check('mismatch → ONE ops alert for the run (kind model-mismatch)', alerts.length === 1 && alerts[0][0] === 'model-mismatch');
SM.beginRun(); await SM.checkServedModel('lamp-detect', { model: 'claude-opus-4-8' }, opts);
check('a new run alerts again (once)', alerts.length === 2);
SM.beginRun();
let threw = false, called = false;
try { await SM.checkServedModel('x', { model: 'y' }, { ...opts, alert: async () => { called = true; throw new Error('boom'); } }); } catch { threw = true; }
check('an alert that throws never breaks the run (alert called, nothing thrown)', called && !threw);

// ── 4. cassette pricer vs the batch 245 guard ledger ─────────────────────────────────────────────
console.log('\n4. Cassette pricer vs the BATCH 245 guard ledger');
const { costOfResponse } = await import('./lib/modelCassette.mjs');
check('fable-5-2 priced from the one table: 8 / 40 / 10 / 16 / 0.20', JSON.stringify(priceOfModel('claude-fable-5-2').price) === '[8,40,10,16,0.2]');
check('opus-4-8 unchanged: 5 / 25 / 6.25 / 10 / 0.50; haiku dated id → the haiku row', JSON.stringify(priceOfModel('claude-opus-4-8').price) === '[5,25,6.25,10,0.5]' && priceOfModel('claude-haiku-4-5-20251001').key === 'claude-haiku-4-5');
const dearest = Object.values(MODEL_PRICES).reduce((m, p) => (p[1] > m[1] ? p : m));
check('an unknown id → the dearest row, flagged unpriced', priceOfModel('claude-x-9').price === dearest && costOfResponse(JSON.stringify({ model: 'claude-x-9', usage: { output_tokens: 1 } })).unpriced === true);
const LEDGER = `${ROOT}/_cc/scratch/b245/spend.jsonl`;
if (!existsSync(LEDGER)) {
  console.log('  SKIP — _cc/scratch/b245/spend.jsonl absent (scratch, untracked)');
} else {
  const lines = readFileSync(LEDGER, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const lot of ['SA26KVT', 'AMZ3790', 'SD75YGC']) {
    const L = lines.filter((l) => l.lot === lot && l.status === 200 && l.usage);
    const guard = L.reduce((s, l) => s + l.usd, 0);
    const ours = L.reduce((s, l) => s + costOfResponse(JSON.stringify({ model: l.model, usage: l.usage })).usd, 0);
    check(`${lot}: ${L.length} calls — pricer $${ours.toFixed(4)} = guard ledger $${guard.toFixed(4)} to the cent`, Math.round(ours * 100) === Math.round(guard * 100));
  }
}

// ── 5. canary ────────────────────────────────────────────────────────────────────────────────────
console.log('\n5. Canary (/api/health/models) — fetch stubbed');
const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { seen.push(decodeURIComponent(String(url).split('/v1/models/')[1] || '')); return { ok: true, status: 200, json: async () => ({}) }; };
process.env.CRON_SECRET = 'b246-test';
try {
  const { GET } = await import('@/app/api/health/models/route.js');
  await GET({ headers: { get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer b246-test' : null) } });
} finally { globalThis.fetch = realFetch; }
check(`canary checked exactly MODEL_IDS (${MODEL_IDS.join(', ')})`, seen.length === MODEL_IDS.length && MODEL_IDS.every((id) => seen.includes(id)));
check(`MODEL_IDS includes MODELS.assessPrimary (${MODELS.assessPrimary})`, MODEL_IDS.includes(MODELS.assessPrimary) && seen.includes(MODELS.assessPrimary));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
