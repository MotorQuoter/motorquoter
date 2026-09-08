// Prints the live URL of every stored salvage report that has a buyer edit layer on it.
// Read-only. No paid provider calls, no vision calls, no writes. Cowork, 8 Sep 2026 (EO-04).
import fs from 'node:fs';

const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const pick = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1] || '').trim().replace(/^["']|["']$/g, '');

const URL_ = pick('NEXT_PUBLIC_SUPABASE_URL');
const KEY = pick('SUPABASE_SERVICE_ROLE_KEY');
if (!URL_ || !KEY) { console.error('Could not read Supabase settings from .env.local'); process.exit(1); }

const q = `${URL_}/rest/v1/salvage_sessions`
  + `?edit_layer=not.is.null`
  + `&select=id,created_at,status,stripe_session_id,vehicle_details,edit_layer`
  + `&order=created_at.desc&limit=20`;

const res = await fetch(q, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
if (!res.ok) { console.error('Supabase said:', res.status, (await res.text()).slice(0, 300)); process.exit(1); }
const rows = await res.json();

if (!rows.length) {
  console.log('\nNo stored report currently carries an edit layer.');
  console.log('That is itself worth knowing — the 4 Sep AMZ3790 edits should be on one.\n');
  process.exit(0);
}

console.log(`\n${rows.length} report(s) with a buyer edit layer, newest first:\n`);
for (const r of rows) {
  const vd = r.vehicle_details || {};
  const reg = vd.vrm || vd.registration || vd.Vrm || '(reg unknown)';
  // The real shape written by lib/ledgerEdits.mjs is { stamp, strikes, adds, updatedAt, rerunStamp }.
  // Reading el.rows/el.edits reported "0 edit(s)" on every populated layer — a false all-clear on the
  // exact question this script was written to answer. (Cowork's bug, found by CC, 8 Sep.)
  const el = r.edit_layer || {};
  const strikes = Array.isArray(el.strikes) ? el.strikes : [];
  const adds = Array.isArray(el.adds) ? el.adds : [];
  const n = strikes.length + adds.length;
  console.log(`  ${reg}  ·  ${String(r.created_at).slice(0, 16).replace('T', ' ')}  ·  status ${r.status}  ·  ${n} edit(s): ${strikes.length} struck, ${adds.length} added`);
  for (const k of strikes) console.log(`      struck: ${k}`);
  for (const a of adds) console.log(`      added : ${a.text}  +£${a.amount}`);
  if (el.stamp) console.log(`      layer stamp: ${el.stamp}  (if this no longer matches the report's current ledger, the edits are stored but NOT applied)`);
  const cred = r.stripe_session_id
    ? `session_id=${encodeURIComponent(r.stripe_session_id)}`
    : 'promo_token=PASTE_YOUR_TOKEN';
  console.log(`  https://www.motorquoter.app/salvage/success?salvage_id=${r.id}&${cred}`);
  console.log('');
}
console.log('Open the AMZ3790 one, scroll to the ledger, then use the PDF download on that page.\n');
