// Validator — branch C auth gaps (§1 rerun-submit ownership, §2 assess session bind, §3 oneauto
// proxy). £0: structural assertions against the real route sources — these gaps are HTTP-boundary
// checks with no pure core to unit-test, so the guard is "the check is present and ordered right".
//
// Run: node scripts/validate-auth-gaps.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── §1. rerun-submit now proves ownership and is not an unbounded loop ────────────────────────────
console.log('\n§1. rerun-submit ownership + loop bound');
{
  const src = read('app/api/salvage/rerun-submit/route.js');
  ok('accepts session_id / promo_token credentials', src.includes('session_id, promo_token'));
  ok('checks ownership via Stripe session id', src.includes('session.stripe_session_id === session_id'));
  ok('checks ownership via promo token', src.includes('session.vehicle_details.promoToken === promo_token'));
  ok('rejects a caller with no matching credential (403)', /if \(!ownsViaStripe && !ownsViaPromo\)[\s\S]{0,120}403/.test(src));
  ok('bounds the re-assessment loop on status !== pending', src.includes("session.status !== 'pending'"));
  // The ownership gate must run BEFORE the row is overwritten.
  const iOwn = src.indexOf('ownsViaStripe');
  const iUpdate = src.indexOf('.update({');
  ok('ownership is checked before the update', iOwn > 0 && iUpdate > 0 && iOwn < iUpdate);

  // Client carries the credential through: success page → salvage form → route.
  const succ = read('app/salvage/success/page.js');
  ok('success page carries the credential into the re-run URL', succ.includes('promo_token=') && succ.includes('session_id='));
  const form = read('app/salvage/page.js');
  ok('the re-run form reads the credential from the URL', form.includes("params.get('session_id')") && form.includes("params.get('promo_token')"));
  ok('the re-run form sends the credential to rerun-submit', form.includes('rerunPromoToken ? { promo_token: rerunPromoToken } : { session_id: rerunSessionId }'));
}

// ── §2. assess binds the paid Stripe session to THIS salvage session ──────────────────────────────
console.log('\n§2. assess salvage_id bind');
{
  const src = read('app/api/salvage/assess/route.js');
  ok('compares metadata.salvage_id to salvageId', src.includes('stripeSession.metadata?.salvage_id !== salvageId'));
  ok('rejects a mismatch with 403', /metadata\?\.salvage_id !== salvageId\)[\s\S]{0,140}403/.test(src));
  // Must gate before chargeAmount is trusted (the auto-refund path reads it).
  const iBind   = src.indexOf('metadata?.salvage_id !== salvageId');
  const iCharge = src.indexOf('chargeAmount    = stripeSession.amount_total');
  ok('the bind runs before chargeAmount is read (refund path reads the right charge)', iBind > 0 && iCharge > 0 && iBind < iCharge);
}

// ── §3. the unauthenticated /api/oneauto proxy is gone ────────────────────────────────────────────
console.log('\n§3. /api/oneauto proxy deleted');
{
  ok('app/api/oneauto/route.js no longer exists', !existsSync(join(ROOT, 'app/api/oneauto/route.js')));
  // And nothing references it (the doc line in CLAUDE.md is removed too).
  ok('CLAUDE.md no longer documents the deleted proxy', !read('CLAUDE.md').includes('/api/oneauto'));
}

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
