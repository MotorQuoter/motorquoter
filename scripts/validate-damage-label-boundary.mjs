// Validator — Copart damage-label boundary (batch 73: 3b withhold + §7 show-to-buyer). £0, structural.
//
// The Copart damage LABEL FAMILY (primaryDamage / secondaryDamage / additionalDamage /
// damageDescription) is auction staff's CLASSIFICATION of the damage, not an observation. Run 1 vs
// run 4 (EN23NJX) proved the model treats the label as evidence and fabricates damage to match it.
// So the label must be pinned to EXACTLY ONE side of the model boundary:
//   ❌ absent from the Call-1 perception context
//   ❌ absent from the Call-2 extraction input
//   ✅ present in the rendered OUTPUT payload (shown to the buyer, code-side, after both calls)
// Any future refactor that leaks it back into a prompt turns this gate red.
//
// Run: node scripts/validate-damage-label-boundary.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log(`  PASS — ${label}`); pass++; } else { console.log(`  FAIL — ${label}`); fail++; } }

const route = readFileSync(join(ROOT, 'app/api/salvage/assess/route.js'), 'utf8');

// ── ❌ ABSENT FROM THE CALL-1 PERCEPTION CONTEXT ──────────────────────────────────────────────────
console.log('\n(1) the damage-label family is absent from the Call-1 context');
ok('no "Primary Damage: ${enrichedVd.primaryDamage}" context line',        !route.includes('Primary Damage: ${enrichedVd.primaryDamage}'));
ok('no "Secondary Damage: ${enrichedVd.secondaryDamage}" context line',    !route.includes('Secondary Damage: ${enrichedVd.secondaryDamage}'));
ok('no "Additional Damage: ${enrichedVd.additionalDamage}" context line',  !route.includes('Additional Damage: ${enrichedVd.additionalDamage}'));
ok('no "Seller/Copart Damage Description: ${enrichedVd.damageDescription}" context line', !route.includes('Seller/Copart Damage Description: ${enrichedVd.damageDescription}'));

// ── ⛔ TOOL-FORCING PRESERVED — enrichedVd damage fields still steer frontStruck/rearStruck ─────────
console.log('\n(2) tool-forcing is preserved (nulling the fields at source is NOT the fix)');
ok('frontStruck still reads enrichedVd.primaryDamage', /const frontStruck\s*=\s*\/front\/i\.test\(enrichedVd\.primaryDamage/.test(route));
ok('rearStruck still reads enrichedVd.primaryDamage',  /const rearStruck\s*=\s*\/rear\/i\.test\(enrichedVd\.primaryDamage/.test(route));
// §2a (batch 80): the salvage-history record's OWN damage descriptors are now ALSO withheld from
// perception. On a self-reference lot the register record IS the current lot, so its "event" damage is
// the same Copart staff label re-entering (DL72FVX). Lot date + mileage stay; the buyer keeps the label
// code-side (§7). This supersedes the batch-73 "record damage is an event, keep it" rule.
ok('salvage-history no longer emits "Primary Damage: ${rec.primary_damage_desc}"',     !route.includes('Primary Damage: ${rec.primary_damage_desc}'));
ok('salvage-history no longer emits "Secondary Damage: ${rec.secondary_damage_desc}"', !route.includes('Secondary Damage: ${rec.secondary_damage_desc}'));
ok('salvage-history still emits Lot Date + Mileage at Sale', route.includes('Lot Date: ${rec.salvage_auction_lot_date}') && route.includes('Mileage at Sale:'));
// §2b (batch 80): the salvage-history heading is NEUTRAL — it does not pre-judge the register record as
// a PRIOR event (the DL72FVX falsehood), nor assert it is the lot's own entry (unproven). It names only
// what the register returned. NB the source comment references the old wording in prose, so assert the
// old TEMPLATE (with its `(${records.length}` interpolation), not the bare phrase.
ok('no pre-judging "Previous Salvage Auction History (${records.length}" heading template', !route.includes('Previous Salvage Auction History (${records.length}'));
ok('neutral "Salvage auction register records for this vehicle" heading present', route.includes('Salvage auction register records for this vehicle'));

// ── ❌ ABSENT FROM THE CALL-2 EXTRACTION INPUT ────────────────────────────────────────────────────
console.log('\n(3) the damage-label family is absent from the Call-2 input');
// Call-2 user content is the Call-1 prose (${rawText}) plus a fixed instruction — isolate that block.
const call2Block = (route.match(/with529Retry\('call2'[\s\S]*?with529Retry\(/) || [route])[0];
ok("Call-2 content is built from Call-1 prose (${rawText})", call2Block.includes('${rawText}'));
ok('Call-2 does not interpolate enrichedVd.primaryDamage',     !call2Block.includes('enrichedVd.primaryDamage'));
ok('Call-2 does not interpolate enrichedVd.secondaryDamage',   !call2Block.includes('enrichedVd.secondaryDamage'));
ok('Call-2 does not interpolate enrichedVd.damageDescription', !call2Block.includes('enrichedVd.damageDescription'));

// ── ✅ PRESENT IN THE OUTPUT PAYLOAD — injected AFTER both calls ────────────────────────────────────
console.log('\n(4) the label is present in the output payload, injected after both calls');
ok('assessment._copartDamageLabel is set', /assessment\._copartDamageLabel\s*=\s*\{/.test(route));
ok('composed from the withheld family fields', /\[enrichedVd\.primaryDamage, enrichedVd\.secondaryDamage, enrichedVd\.additionalDamage\]/.test(route));
ok('carries the verbatim line 1 ("Copart record this lot as: …")', route.includes('Copart record this lot as: ${_label}.'));
ok('carries the verbatim line 2 ("This assessment is from the photographs only.")', route.includes("'This assessment is from the photographs only.'"));
// AFTER both calls: the injection must sit downstream of the Call-2 fetch in the source.
ok('injection is AFTER the Call-2 block (never re-enters a prompt)',
  route.indexOf("assessment._copartDamageLabel = {") > route.indexOf("with529Retry('call2'"));
// No prompt asks the model to comment on / reconcile the label (line-253's mistake in a new costume).
ok('the label wording is not inside ASSESSMENT_ENGINE_PROMPT', !readFileSync(join(ROOT, 'config/assessmentEngine.js'), 'utf8').includes('Copart record this lot as'));

// ── ✅ RENDERED TO THE BUYER on both salvage surfaces (parity) ─────────────────────────────────────
console.log('\n(5) the label is rendered to the buyer on both salvage surfaces');
ok('salvage success page renders _copartDamageLabel', readFileSync(join(ROOT, 'app/salvage/success/page.js'), 'utf8').includes('_copartDamageLabel'));
ok('salvage PDF renders _copartDamageLabel',          readFileSync(join(ROOT, 'app/api/salvage/pdf/route.js'), 'utf8').includes('_copartDamageLabel'));

console.log(`\n── Result: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
