// capture-fixture — freeze a stored salvage lot's replay inputs to fixtures/<VRM>/ so the engine
// can be re-run against it forever, with the paid providers mocked. READ-ONLY: reads the DB row +
// downloads photos from the lot-images bucket; writes only local files. NEVER writes the prod DB,
// never hits Stripe, never re-charges a paid provider. (Cowork §7 replay harness — step 1.)
//
// Usage:
//   node scripts/capture-fixture.mjs <VRM|sessionId> [--session <id>]
//   e.g.  node scripts/capture-fixture.mjs DMZ4614
//
// Feasibility (verified 5 Aug): lot-images photos are retained well beyond the 48h reg_lookup_cache
// TTL (oldest sampled lot ~7 weeks, still downloadable), and the paid-provider outputs
// (bregoValuation, salvageGuide, motHistory, salvageHistory) plus rawCopartPaste are stored on the
// row — so past lots are replayable from stored data with NO paid re-charge.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');

function loadEnv() {
  const txt = readFileSync(resolve(ROOT, '.env.local'), 'utf8');
  return Object.fromEntries(txt.split('\n').filter(l => l.includes('=')).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
  }));
}

// The paid-provider outputs that must be replayed as fixtures (never re-fetched). These live on
// vehicle_details in the stored row; the harness's fixture provider returns them for the matching
// withOneAutoCache(callType, vrm) call.
const PAID_FIXTURE_KEYS = ['bregoValuation', 'salvageGuide', 'motHistory', 'salvageHistory', 'estimatedRetail'];

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('Usage: node scripts/capture-fixture.mjs <VRM|sessionId>'); process.exit(2); }
  const sessionFlagIdx = process.argv.indexOf('--session');
  const sessionId = sessionFlagIdx > -1 ? process.argv[sessionFlagIdx + 1] : null;

  const env = loadEnv();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  // Locate the most recent assessed session for this VRM (or by explicit id).
  let q = sb.from('salvage_sessions').select('*').not('assessment', 'is', null).order('created_at', { ascending: false }).limit(1);
  q = sessionId ? q.eq('id', sessionId) : (/^[0-9a-f-]{36}$/i.test(arg) ? q.eq('id', arg) : q.ilike('vehicle_details->>vrm', arg));
  const { data, error } = await q;
  if (error) { console.error('DB error:', error.message); process.exit(1); }
  const row = data?.[0];
  if (!row) { console.error(`No assessed session found for "${arg}".`); process.exit(1); }

  const vd = row.vehicle_details || {};
  const vrm = (vd.vrm || arg).toUpperCase();
  const paths = Array.isArray(row.image_paths) ? row.image_paths : [];
  console.log(`Capturing ${vrm}  session=${row.id}  created=${row.created_at}  photos=${paths.length}`);

  const outDir = resolve(ROOT, 'fixtures', vrm);
  const imgDir = resolve(outDir, 'images');
  mkdirSync(imgDir, { recursive: true });

  // Download each photo from lot-images → local fixture (retained-storage read; no re-charge).
  const savedImages = [];
  for (let i = 0; i < paths.length; i++) {
    const { data: blob, error: dlErr } = await sb.storage.from('lot-images').download(paths[i]);
    if (dlErr) { console.warn(`  photo ${i} (${paths[i]}) → SKIP: ${dlErr.message}`); continue; }
    const buf = Buffer.from(await blob.arrayBuffer());
    const name = `${String(i).padStart(2, '0')}.jpg`;
    writeFileSync(resolve(imgDir, name), buf);
    savedImages.push(name);
  }
  console.log(`  saved ${savedImages.length}/${paths.length} photos → fixtures/${vrm}/images/`);

  // Paid-provider fixtures (what the mocked provider must return in replay).
  const paidFixtures = {};
  for (const k of PAID_FIXTURE_KEYS) if (vd[k] !== undefined) paidFixtures[k] = vd[k];

  // fixture.json — everything needed to replay, minus the baseline assessment (separate file).
  const fixture = {
    vrm,
    sessionId: row.id,
    capturedAt: new Date().toISOString(),
    sourceCreatedAt: row.created_at,
    market: row.market ?? 'GB',
    auctionSource: vd.auctionSource ?? 'copart',
    rawCopartPaste: vd.rawCopartPaste ?? null,
    damageDescription: vd.damageDescription ?? null,
    // The full vehicle_details (paid outputs already embedded) — the fixture provider reads from here.
    vehicleDetails: vd,
    paidFixtures,
    images: savedImages,
  };
  writeFileSync(resolve(outDir, 'fixture.json'), JSON.stringify(fixture, null, 2));

  // baseline-assessment.json — the stored assessment, the "before" side of every replay diff.
  writeFileSync(resolve(outDir, 'baseline-assessment.json'), JSON.stringify(row.assessment, null, 2));

  console.log(`  paid fixtures: ${Object.keys(paidFixtures).join(', ') || '(none)'}`);
  console.log(`  wrote fixtures/${vrm}/{fixture.json, baseline-assessment.json}`);
  console.log(`\n✅ ${vrm} captured — replayable offline (photos + paste + paid fixtures + baseline).`);
}

main().catch(e => { console.error(e); process.exit(1); });
