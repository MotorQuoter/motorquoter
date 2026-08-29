// replay — re-run the assessment engine against a captured fixture, with the paid providers mocked,
// and diff the result against the stored baseline. This is the runner behind the A3 severity table
// and the A2-residual check (Cowork §7/§8).
//
// Usage (note the loader flag — it resolves the app's "@/" alias + stubs next/server for Node):
//   node --loader ./scripts/lib/alias-loader.mjs scripts/replay.mjs <VRM> [--vision-live|--vision-fixture]
//   e.g.  node --loader ./scripts/lib/alias-loader.mjs scripts/replay.mjs DMZ4614 --vision-live
//
// Guarantees (the replay contract): ZERO prod DB writes, ZERO Stripe, ZERO paid One-Auto calls.
//   - One Auto: intercepted at the withOneAutoCache seam via __setOneAutoReplayProvider → fixtures.
//   - Persistence/Stripe: runAssessment is the PURE pipeline; the route's envelope (which does the
//     DB write + Stripe) is never entered — replay calls runAssessment directly.
//   - --vision-live re-runs the Anthropic vision calls (few pence, the app's own model, not a paid
//     provider re-charge) — required for A2 prose / A3 severity, which are Vision-judged.
//   - --vision-fixture would replay frozen per-view verdicts at zero cost; those aren't persisted on
//     historical rows, so it needs a capture add-on (flagged, not yet built).
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { diffAssessments, renderDiffTable } from './lib/assessmentDiff.mjs';
import { installCassette } from './lib/modelCassette.mjs';
// NOTE: runAssessment / oneautoCache are imported DYNAMICALLY inside main(), AFTER env is set —
// PER_VIEW_PROMPT reads REPLAY_A3_OFF at module-load, so --a3-off must be in process.env first.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const txt = readFileSync(resolve(ROOT, '.env.local'), 'utf8');
  for (const line of txt.split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

// Map a One Auto callType to the stored fixture it should replay. GB/NI lots use the SALVAGE*/
// BREGO_GB seams; ROI-only seams (MARKETDEMAND/PRICEGUIDE/HPICHECK) return null (= "no data",
// handled identically to a live empty response). null fixtures also return null.
function makeFixtureProvider(paid) {
  const map = {
    BREGO_GB: paid.bregoValuation, BREGO_ROI: paid.bregoValuation,
    SALVAGEGUIDE: paid.salvageGuide, SALVAGEHISTORY: paid.salvageHistory,
    MARKETDEMAND: null, PRICEGUIDE: null, HPICHECK: null,
  };
  return (callType /*, normReg */) => {
    const hit = map[callType] ?? null;
    console.log(`[REPLAY ONEAUTO] ${callType} → ${hit ? 'fixture' : 'null'}`);
    return hit;
  };
}

async function main() {
  const vrm = (process.argv[2] || '').toUpperCase();
  const mode = process.argv.includes('--vision-fixture') ? 'vision-fixture' : 'vision-live';
  // batch 83: --capture runs live vision AND freezes every model response into the lot's cassette, so a
  // later --vision-fixture run replays the full assess path deterministically at £0.
  const capture = process.argv.includes('--capture');
  const a3off = process.argv.includes('--a3-off');   // A3 SEVERE-DISCIPLINE clause removed (A/B off-arm)
  if (!vrm) { console.error('Usage: node --loader ./scripts/lib/alias-loader.mjs scripts/replay.mjs <VRM> [--vision-live|--vision-fixture|--capture] [--a3-off] [--dump <path>]'); process.exit(2); }

  loadEnv();
  // Set the A3 toggle BEFORE importing the route module — PER_VIEW_PROMPT reads REPLAY_A3_OFF at
  // module-load. Then import runAssessment + the One-Auto seam dynamically so they see the env.
  if (a3off) process.env.REPLAY_A3_OFF = 'true';
  const { runAssessment } = await import('@/app/api/salvage/assess/route.js');
  const { __setOneAutoReplayProvider } = await import('@/lib/oneautoCache.js');

  const dir = resolve(ROOT, 'fixtures', vrm);
  let fixture, baseline;
  try {
    fixture = JSON.parse(readFileSync(resolve(dir, 'fixture.json'), 'utf8'));
    baseline = JSON.parse(readFileSync(resolve(dir, 'baseline-assessment.json'), 'utf8'));
  } catch {
    console.error(`No fixture at fixtures/${vrm}/. Capture it first:\n  node scripts/capture-fixture.mjs ${vrm}`);
    process.exit(1);
  }

  // Rebuild the images array in the exact shape the pipeline consumes: data:image/jpeg;base64 strings.
  const imgDir = resolve(dir, 'images');
  const imgFiles = readdirSync(imgDir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
  const images = imgFiles.map(f => `data:image/jpeg;base64,${readFileSync(resolve(imgDir, f)).toString('base64')}`);
  console.log(`Replaying ${vrm} — ${images.length} photos, mode=${mode}, A3=${a3off ? 'OFF' : 'ON'}, market=${fixture.market}`);

  // Install the fixture provider (One Auto seam) — after this, NO paid One Auto call can fire.
  __setOneAutoReplayProvider(makeFixtureProvider(fixture.paidFixtures || {}));

  // batch 83 model cassette — freeze/replay every Anthropic vision call (fetch interception; no engine
  // change). --capture: live vision + record. --vision-fixture: serve from the cassette, £0, deterministic.
  const cassettePath = resolve(dir, 'model-cassette.json');
  let cassette = null;
  if (mode === 'vision-fixture') {
    if (!existsSync(cassettePath)) {
      console.error(`--vision-fixture needs a cassette. Capture it once:\n  node --loader ./scripts/lib/alias-loader.mjs scripts/replay.mjs ${vrm} --capture`);
      process.exit(3);
    }
    cassette = installCassette({ mode: 'replay', cassettePath });
    console.log(`[CASSETTE] replaying model calls from ${vrm}/model-cassette.json — £0, deterministic`);
  } else if (capture) {
    cassette = installCassette({ mode: 'capture', cassettePath });
    console.log(`[CASSETTE] capturing model calls → ${vrm}/model-cassette.json (LIVE VISION — paid)`);
  }

  const vd = fixture.vehicleDetails || {};
  const t0 = Date.now();
  let assessment;
  try {
    ({ assessment } = await runAssessment({
      images,
      vd,
      market: fixture.market || 'GB',
      roiTier: vd.roiTier || 'roi_free',
    }));
  } finally {
    if (cassette) {
      const s = cassette.uninstall();
      console.log(`[CASSETTE] ${mode === 'vision-fixture' ? 'served' : 'captured'} ${s.served || s.captured} call(s), missed ${s.missed}, passthrough ${s.passthrough}`);
    }
  }
  console.log(`runAssessment completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Optional: dump the freshly-computed assessment (for run-to-run variance checks / A/B diffs).
  const dumpIdx = process.argv.indexOf('--dump');
  if (dumpIdx > -1 && process.argv[dumpIdx + 1]) {
    const { writeFileSync } = await import('fs');
    writeFileSync(resolve(process.argv[dumpIdx + 1]), JSON.stringify(assessment, null, 2));
    console.log(`dumped assessment → ${process.argv[dumpIdx + 1]}`);
  }

  const diff = diffAssessments(baseline, assessment);
  console.log(renderDiffTable(diff, `${vrm}: stored baseline → replay (${mode})`));
  process.exit(0);
}

main().catch(e => { console.error('REPLAY FAILED:', e); process.exit(1); });
