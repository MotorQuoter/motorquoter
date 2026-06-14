// Validation script: compare old inline enrichedVd logic vs normaliseLot output
// for SF69YBB and BL75JAU. ZERO field changes allowed except damageDescription.
// Run: node scripts/validate-normaliser.mjs

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { normaliseLot } from '../lib/normaliseLot.js';

// Load env
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); const v = l.slice(i + 1).trim(); return [l.slice(0, i).trim(), v.replace(/^["']|["']$/g, '')]; })
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ── OLD INLINE LOGIC (exact copy from commit 1 / a9df892) ──────────────────

function cleanCopartNotes(raw) {
  if (!raw) return '';
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !/thumbnail/i.test(l))
    .filter(l => !/^https?:\/\//i.test(l))
    .filter(l => !/^VIN:/i.test(l))
    .filter(l => !/^Lot number:/i.test(l))
    .filter(l => !/^Lane\/Item:/i.test(l))
    .filter(l => !/^Sale name:/i.test(l))
    .filter(l => !/^Sale date:/i.test(l))
    .filter(l => !/^Location:/i.test(l))
    .filter(l => !/^\d+\/\d+$/.test(l))
    .filter(l => !/^Watchlist$/i.test(l))
    .filter(l => !/^HD$/i.test(l))
    .filter(l => !/VIEW FULL VEHICLE/i.test(l))
    .filter(l => !/^Estimated retail value:\s*$/i.test(l))
    .filter(l => !/^Transmission:\s*$/i.test(l))
    .filter(l => !/^2 AXLE RIGID BODY/i.test(l))
    .filter(l => !/^Drive:/i.test(l))
    .filter(l => !/^Transmission engages/i.test(l))
    .filter(l => !/^1 Speed/i.test(l))
    .filter(l => !/^2 Speed/i.test(l))
    .filter(l => !/^\d+ Speed/i.test(l))
    .filter(l => !/^Gears engage/i.test(l))
    .filter(l => !/^Physical V5/i.test(l))
    .filter(l => !/^Auction countdown/i.test(l))
    .filter(l => !/^Minimum bid/i.test(l))
    .filter(l => !/^Seller reserve/i.test(l))
    .filter(l => !/^Minor Dents/i.test(l))
    .filter(l => !/^Front End$/i.test(l))
    .filter(l => !/^Rear End$/i.test(l))
    .filter(l => !/^No V5/i.test(l))
    .filter(l => !/^N REPAIRABLE/i.test(l))
    .filter(l => !/^S REPAIRABLE/i.test(l))
    .filter(l => !/^Water\/flood/i.test(l))
    .filter(l => !/^VAT to be added/i.test(l))
    .filter(l => !/^Yes$/i.test(l))
    .filter(l => !/^No$/i.test(l))
    .filter(l => /[a-zA-Z]{4,}/.test(l))
    .join('\n')
    .trim();
}

function parseCopartListing(raw) {
  if (!raw) return {};
  const get = (pattern) => {
    const m = raw.match(pattern);
    return m ? m[1].trim() : null;
  };
  return {
    category:         get(/^Category:\s*([^\n]+)/im),
    runCondition:     get(/Run condition:\s*\n?([^\n]+)/i),
    odometer:         get(/Odometer:\s*\n?([^\n]+)/i),
    keys:             get(/Has key:\s*\n?([^\n]+)/i),
    fuel:             get(/Fuel:\s*\n?([^\n]+)/i),
    transmission:     get(/Transmission:\s*\n?([^\n]+)/i),
    bodyStyle:        get(/Body style:\s*\n?([^\n]+)/i),
    colour:           get(/Colour:\s*\n?([^\n]+)/i),
    engineSize:       get(/Engine type:\s*\n?([^\n]+)/i),
    primaryDamage:    get(/Primary damage:\s*\n?([^\n]+)/i),
    secondaryDamage:  get(/Secondary damage:\s*\n?([^\n]+)/i),
    additionalDamage: get(/Additional damage[^:]*:\s*\n?([^\n]+)/i),
    estimatedRetail:  get(/Estimated retail value:\s*\n?([^\n]+)/i),
    vatOnSale:        get(/VAT to be added[^:\n]*(?::\s*|\s*\r?\n\s*)(Yes|No)/i),
    v5Status:         get(/V5 available:\s*\n?([^\n]+)/i),
    lotNumber:        get(/Lot number:\s*\n?([^\n]+)/i),
  };
}

function oldInlineEnrichedVd(vd) {
  const cleanedVd = { ...vd, damageDescription: cleanCopartNotes(vd.damageDescription) };
  const parsed = parseCopartListing(vd.damageDescription || '');
  return {
    ...cleanedVd,
    category:         cleanedVd.category        || parsed.category,
    runCondition:     cleanedVd.runCondition     || parsed.runCondition,
    odometer:         cleanedVd.odometer         || parsed.odometer,
    keys:             cleanedVd.keys             || parsed.keys,
    fuel:             cleanedVd.fuel             || parsed.fuel,
    transmission:     cleanedVd.transmission     || parsed.transmission,
    colour:           cleanedVd.colour           || parsed.colour,
    engineSize:       cleanedVd.engineSize       || parsed.engineSize,
    primaryDamage:    cleanedVd.primaryDamage    || parsed.primaryDamage,
    secondaryDamage:  cleanedVd.secondaryDamage  || parsed.secondaryDamage,
    additionalDamage: cleanedVd.additionalDamage || parsed.additionalDamage,
    estimatedRetail:  cleanedVd.estimatedRetail  || parsed.estimatedRetail,
    vatOnSale:        cleanedVd.vatOnSale        || parsed.vatOnSale,
    v5Status:         cleanedVd.v5Status         || parsed.v5Status,
    lotNumber:        cleanedVd.lotNumber        || parsed.lotNumber || vd.lotNumber,
  };
}

// ── STRUCTURED FIELD LIST (the 15 explicit fields + damageDescription) ──────
const STRUCTURED_FIELDS = [
  'category', 'runCondition', 'odometer', 'keys', 'fuel', 'transmission',
  'colour', 'engineSize', 'primaryDamage', 'secondaryDamage', 'additionalDamage',
  'estimatedRetail', 'vatOnSale', 'v5Status', 'lotNumber', 'damageDescription',
];

// Also compare every key present in either object
function diffObjects(oldObj, newObj, label) {
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  const diffs = [];
  const structured = [];

  for (const k of [...allKeys].sort()) {
    const ov = oldObj[k];
    const nv = newObj[k];
    const same = JSON.stringify(ov) === JSON.stringify(nv);
    if (STRUCTURED_FIELDS.includes(k)) {
      structured.push({ k, ov, nv, same });
    } else if (!same) {
      // Non-structured field that differs — flag it
      diffs.push({ k, ov, nv });
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`LOT: ${label}`);
  console.log('='.repeat(60));

  console.log('\n── STRUCTURED FIELDS (16 comparison fields) ──');
  let anyStructuredDiff = false;
  for (const { k, ov, nv, same } of structured) {
    if (k === 'damageDescription') {
      // Show what changed in damageDescription.
      // PASS: only Category: lines removed, nothing added.
      // FAIL: anything added, or non-Category lines removed.
      const oldLines = (ov || '').split('\n');
      const newLines = (nv || '').split('\n');
      const removed = oldLines.filter(l => !newLines.includes(l));
      const added   = newLines.filter(l => !oldLines.includes(l));
      if (removed.length === 0 && added.length === 0) {
        console.log(`  damageDescription : IDENTICAL (${oldLines.length} lines)`);
      } else {
        const unexpectedRemoved = removed.filter(l => !/^Category:?$/i.test(l.trim()));
        const isExpected = added.length === 0 && unexpectedRemoved.length === 0;
        const marker = isExpected ? 'OK  ' : 'DIFF';
        console.log(`  ${marker} damageDescription : ${isExpected ? 'expected Category: strip only' : 'UNEXPECTED CHANGE'}`);
        removed.forEach(l => console.log(`    REMOVED: ${JSON.stringify(l)}`));
        added.forEach(l =>   console.log(`    ADDED:   ${JSON.stringify(l)}`));
        if (!isExpected) anyStructuredDiff = true;
      }
    } else {
      const marker = same ? 'OK  ' : 'DIFF';
      console.log(`  ${marker} ${k.padEnd(20)} OLD=${JSON.stringify(ov)} NEW=${JSON.stringify(nv)}`);
      if (!same) anyStructuredDiff = true;
    }
  }

  if (diffs.length > 0) {
    console.log('\n── NON-STRUCTURED FIELDS WITH DIFFS ──');
    for (const { k, ov, nv } of diffs) {
      // Skip large blobs (images, assessment JSON, salvageHistory)
      const oStr = JSON.stringify(ov);
      const nStr = JSON.stringify(nv);
      if (oStr.length > 200 || nStr.length > 200) {
        console.log(`  DIFF ${k} : (large blob, lengths old=${oStr.length} new=${nStr.length})`);
      } else {
        console.log(`  DIFF ${k} : OLD=${oStr} NEW=${nStr}`);
      }
    }
  } else {
    console.log('\n── NON-STRUCTURED FIELDS: no diffs ──');
  }

  const verdict = !anyStructuredDiff && diffs.length === 0 ? 'PASS' : 'FAIL';
  console.log(`\nVERDICT: ${verdict}`);
  return verdict;
}

// ── FETCH AND RUN ────────────────────────────────────────────────────────────
async function run() {
  const VRMS = ['SF69YBB', 'BL75JAU'];
  let allPass = true;

  for (const vrm of VRMS) {
    // Find most recent assessed session for this VRM
    const { data: rows, error } = await supabase
      .from('salvage_sessions')
      .select('id, vehicle_details, created_at')
      .eq('status', 'assessed')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) { console.error(`Supabase error: ${error.message}`); process.exit(1); }

    const session = rows?.find(r => {
      const v = r.vehicle_details?.vrm || '';
      return v.replace(/\s+/g, '').toUpperCase() === vrm;
    });

    if (!session) {
      console.log(`\nWARN: No assessed session found for ${vrm} — skipping`);
      continue;
    }

    console.log(`\nFound session ${session.id} for ${vrm} (created ${session.created_at})`);
    const vd = session.vehicle_details || {};

    const oldOut = oldInlineEnrichedVd(vd);
    const newOut = normaliseLot(vd);

    const verdict = diffObjects(oldOut, newOut, vrm);
    if (verdict !== 'PASS') allPass = false;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`OVERALL: ${allPass ? 'PASS — safe to commit 2' : 'FAIL — DO NOT COMMIT 2'}`);
  console.log('='.repeat(60));
}

run().catch(e => { console.error(e); process.exit(1); });
