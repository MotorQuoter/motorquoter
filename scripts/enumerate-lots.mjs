// enumerate-lots — list assessed salvage lots that can be replayed offline, so Vincent can tick his
// validated set for the A3 severity table. READ-ONLY: selects rows, probes one photo per lot for
// retrievability. NEVER writes the DB / Stripe / re-charges. (Cowork §8 request.)
//
// Usage:
//   node scripts/enumerate-lots.mjs            # markdown table, newest-first
//   node scripts/enumerate-lots.mjs --diag     # dump field locations for the newest row (schema probe)
//   node scripts/enumerate-lots.mjs --limit 40 # cap rows (default 60)
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
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

// Pull a value from the first path that resolves (vehicle_details nests differ across lot ages).
const pick = (obj, paths) => {
  for (const p of paths) {
    let cur = obj, ok = true;
    for (const k of p.split('.')) { if (cur && k in cur) cur = cur[k]; else { ok = false; break; } }
    if (ok && cur != null && cur !== '') return cur;
  }
  return null;
};

const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Normalise the stored write-off category ("S — Repairable Salvage", "N Repairable"…) to "Cat S/N/A/B/U".
const catNorm = c => { const m = String(c ?? '').trim().match(/^([ABSNU])\b/i); return m ? `Cat ${m[1].toUpperCase()}` : (c ? short(c, 8) : '—'); };
// Score a session so --distinct keeps the richest one per VRM: most paid fixtures, then most photos, then newest.
const paidScore = r => (r.hasBrego ? 1 : 0) + (r.hasGuide ? 1 : 0) + (r.hasMot ? 1 : 0);

async function main() {
  const diag = process.argv.includes('--diag');
  const distinct = process.argv.includes('--distinct');   // one richest session per VRM
  const limIdx = process.argv.indexOf('--limit');
  const limit = limIdx > -1 ? Number(process.argv[limIdx + 1]) : 60;

  const env = loadEnv();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await sb
    .from('salvage_sessions')
    .select('id, created_at, market, image_paths, vehicle_details')
    .not('assessment', 'is', null)                 // completed proxy (same as capture-fixture)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('DB error:', error.message); process.exit(1); }
  if (!data?.length) { console.error('No assessed sessions found.'); process.exit(1); }

  if (diag) {
    const vd = data[0].vehicle_details || {};
    console.log('Newest assessed row — top-level vehicle_details keys:');
    console.log('  ' + Object.keys(vd).join(', '));
    console.log('\nNested probe candidates:');
    for (const k of ['dvla', 'dvsa', 'brego', 'bregoValuation', 'salvageGuide', 'autoCheck']) {
      if (vd[k] && typeof vd[k] === 'object') console.log(`  ${k}: ${Object.keys(vd[k]).slice(0, 20).join(', ')}`);
    }
    process.exit(0);
  }

  // Build the candidate list (no photo probe yet — probe only what we print).
  let cands = data.map(r => {
    const vd = r.vehicle_details || {};
    const paths = Array.isArray(r.image_paths) ? r.image_paths : [];
    return {
      id: r.id, created: String(r.created_at).slice(0, 10), market: r.market ?? 'GB',
      vrm: (pick(vd, ['vrm', 'dvla.registrationNumber', 'registration']) || '—').trim(),
      make: pick(vd, ['make', 'dvla.make', 'bregoValuation.make']),
      model: pick(vd, ['model', 'dvla.model', 'bregoValuation.model']),
      category: catNorm(pick(vd, ['category', 'salvageCategory', 'writeOffCategory'])),
      damage: pick(vd, ['damageDescription', 'primaryDamage']),
      firstPath: paths[0] || null,
      photos: paths.length,
      hasBrego: vd.bregoValuation != null, hasGuide: vd.salvageGuide != null, hasMot: vd.motHistory != null,
    };
  });

  if (distinct) {
    // Keep the richest session per VRM: paid-fixture count, then photo count, then newest.
    const best = new Map();
    for (const c of cands) {
      const prev = best.get(c.vrm);
      const better = !prev || paidScore(c) > paidScore(prev) ||
        (paidScore(c) === paidScore(prev) && (c.photos > prev.photos ||
          (c.photos === prev.photos && c.created > prev.created)));
      if (better) best.set(c.vrm, c);
    }
    cands = [...best.values()].sort((a, b) => (b.created).localeCompare(a.created));
  }

  const rows = [];
  for (const c of cands) {
    // Probe ONE photo (createSignedUrl — no download) to confirm the bucket still holds it.
    let live = 'n/a';
    if (c.firstPath) {
      const { data: sig, error: sErr } = await sb.storage.from('lot-images').createSignedUrl(c.firstPath, 60);
      live = (!sErr && sig?.signedUrl) ? 'yes' : 'GONE';
    }
    rows.push({
      id: c.id, vrm: c.vrm, created: c.created, market: c.market,
      vehicle: short([c.make, c.model].filter(Boolean).join(' ') || '—', 26),
      category: c.category,
      damage: c.damage ? short(c.damage, 22) : '—',
      photos: c.photos,
      paid: `${c.hasBrego ? 'B' : '·'}${c.hasGuide ? 'S' : '·'}${c.hasMot ? 'M' : '·'}`,
      live,
    });
  }

  // Markdown table for handoff.md.
  const H = ['session id (short)', 'VRM', 'created', 'mkt', 'vehicle', 'category', 'damage', 'photos', 'paid(BSM)', 'photos live'];
  console.log('\n| ' + H.join(' | ') + ' |');
  console.log('|' + H.map(() => '---').join('|') + '|');
  for (const r of rows) {
    console.log('| ' + [r.id.slice(0, 8), r.vrm, r.created, r.market, r.vehicle, r.category, r.damage, r.photos, r.paid, r.live].join(' | ') + ' |');
  }
  console.log(`\n${rows.length} assessed lots. paid(BSM) = Brego / Salvage-guide / Mot fixtures present. photos live = first photo signed-URL OK.`);
}

main().catch(e => { console.error(e); process.exit(1); });
