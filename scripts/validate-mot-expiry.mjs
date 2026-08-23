// Guard for the FAILED-MOT expiry sentinel fix in lib/dvsa.js.
// DVSA returns a 1900-01-01 sentinel in expiryDate for FAILED / abandoned tests;
// formatExpiry() must map that (and blanks) to null so no render surface prints
// "Expires 01/01/1900". This mirrors the helper in lib/dvsa.js verbatim — that
// module is CommonJS-typed and can't be imported by a node .mjs test, so if you
// edit formatDate/formatExpiry there, mirror the change here.
// Run: node --test scripts/validate-mot-expiry.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { motStatusPresentation, MOT_EXEMPT_NOTE } from '../lib/motTone.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const AUG_2026 = Date.UTC(2026, 7, 15);  // 2026/27 VED year → 40-year cutoff 1986
const MAY_2027 = Date.UTC(2027, 4, 15);  // 2027/28 VED year → cutoff rolls to 1987

function formatDate(str) {
  if (!str) return str;
  const [y, m, d] = str.split(/[ T]/)[0].split('-');
  return d ? `${d}/${m}/${y}` : str;
}

function formatExpiry(str) {
  if (!str) return null;
  if (str.split(/[ T]/)[0] === '1900-01-01') return null;
  return formatDate(str);
}

test('1900-01-01 sentinel → null (date-only)', () => {
  assert.equal(formatExpiry('1900-01-01'), null);
});

test('1900-01-01 sentinel with time component → null', () => {
  assert.equal(formatExpiry('1900-01-01 00:00:00'), null);
  assert.equal(formatExpiry('1900-01-01T00:00:00.000Z'), null);
});

test('blank / missing → null', () => {
  assert.equal(formatExpiry(''), null);
  assert.equal(formatExpiry(null), null);
  assert.equal(formatExpiry(undefined), null);
});

test('genuine PASS expiry formats normally', () => {
  assert.equal(formatExpiry('2024-06-13'), '13/06/2024');
  assert.equal(formatExpiry('2024-06-13T00:00:00.000Z'), '13/06/2024');
});

// ─── MOT-exemption tone (batch 47) — age-eligible + no current MOT = NEUTRAL, never red/green ───────

test('age-eligible + non-Valid → neutral (exempt) with the exemption wording', () => {
  const p = motStatusPresentation({ motStatus: 'Not valid', yearOfManufacture: 1980, market: 'GB', nowMs: AUG_2026 });
  assert.equal(p.tone, 'exempt');
  assert.equal(p.exempt, true);
  assert.equal(p.note, MOT_EXEMPT_NOTE);
  assert.equal(p.label, 'Not valid');          // raw status shown as-is, no inference
});

test('age-eligible + ABSENT status → still speaks (never a hidden row), neutral + wording', () => {
  for (const s of [null, undefined, '']) {
    const p = motStatusPresentation({ motStatus: s, yearOfManufacture: 1972, market: 'GB', nowMs: AUG_2026 });
    assert.equal(p.tone, 'exempt');
    assert.equal(p.label, 'No current MOT');     // a spoken label so the surface renders something
    assert.equal(p.note, MOT_EXEMPT_NOTE);
  }
});

test('age-eligible + Valid → UNCHANGED (ok/green, no exemption note)', () => {
  const p = motStatusPresentation({ motStatus: 'Valid', yearOfManufacture: 1970, market: 'GB', nowMs: AUG_2026 });
  assert.equal(p.tone, 'ok');
  assert.equal(p.exempt, false);
  assert.equal(p.note, null);
});

test('NOT age-eligible + non-Valid → still flagged as today (alert), no exemption', () => {
  const p = motStatusPresentation({ motStatus: 'Not valid', yearOfManufacture: 2015, market: 'GB', nowMs: AUG_2026 });
  assert.equal(p.tone, 'alert');
  assert.equal(p.exempt, false);
  assert.equal(p.note, null);
});

test('no exempt path ever maps to green — exempt tone is neither ok nor alert', () => {
  const p = motStatusPresentation({ motStatus: 'Not valid', yearOfManufacture: 1980, market: 'GB', nowMs: AUG_2026 });
  assert.notEqual(p.tone, 'ok');               // ok is the only tone any surface paints green
  assert.notEqual(p.tone, 'alert');            // and alert is the only red/amber — exempt is neither
});

test('IE (NCT) never takes the exempt branch — UK MOT law only', () => {
  const p = motStatusPresentation({ motStatus: 'Not valid', yearOfManufacture: 1970, market: 'IE', nowMs: AUG_2026 });
  assert.equal(p.tone, 'alert');
  assert.equal(p.exempt, false);
});

test('cutoff rolls with the VED year — a 1986 car becomes exempt in 2027/28', () => {
  assert.equal(motStatusPresentation({ motStatus: null, yearOfManufacture: 1986, market: 'GB', nowMs: AUG_2026 }).exempt, false);
  assert.equal(motStatusPresentation({ motStatus: null, yearOfManufacture: 1986, market: 'GB', nowMs: MAY_2027 }).exempt, true);
});

// ─── Structural — all three surfaces route through the helper and map exempt → NEUTRAL (§3.2/3.3) ───

test('PDF (generate-pdf) maps exempt → neutral (undefined tone), never bad/good, and renders the note', () => {
  const pdf = read('app/api/generate-pdf/route.js');
  assert.ok(pdf.includes('motStatusPresentation('), 'PDF calls the shared helper');
  // Only 'alert' is red; exempt AND Valid are both neutral (Valid was already neutral in the PDF —
  // the non-exempt path must stay byte-identical, so 'ok' must NOT be mapped to green here).
  assert.ok(pdf.includes("motPres.tone === 'alert' ? 'bad' : undefined"), 'PDF exempt/Valid → undefined (neutral), only alert red');
  assert.ok(!/motPres\.tone === 'ok' \? 'good'/.test(pdf), 'PDF does not turn a Valid MOT green (unchanged non-exempt path)');
  assert.ok(pdf.includes('motPres.exempt') && pdf.includes('motPres.note'), 'PDF renders the exemption note');
});

test('Web free tier (page.js) maps exempt → neutral (no class), never good/warn, and renders the note', () => {
  const web = read('app/page.js');
  assert.ok(web.includes('motStatusPresentation('), 'page.js calls the shared helper');
  assert.ok(web.includes("motPres.tone === 'ok' ? 'good' : motPres.tone === 'alert' ? 'warn' : ''"), 'page.js exempt → no class (neutral)');
  assert.ok(web.includes('motPres.note'), 'page.js renders the exemption note');
});

test('payment-success maps exempt → neutral colour, never green/amber, and renders the note', () => {
  const ps = read('app/payment-success/page.js');
  assert.ok(ps.includes('motStatusPresentation('), 'payment-success calls the shared helper');
  assert.ok(ps.includes("motPres.tone === 'ok' ? '#4ade80' : motPres.tone === 'alert' ? '#f5c842' : 'var(--text-dim)'"), 'payment-success exempt → neutral colour');
  assert.ok(ps.includes('motPres.note'), 'payment-success renders the exemption note');
});

test('exactly one age test in the codebase — surfaces reuse historicEligibility via motTone, no second test', () => {
  const mot = read('lib/motTone.mjs');
  assert.ok(mot.includes("import { historicEligibility } from './roadTax.mjs'"), 'motTone imports the one age test');
  // No surface computes its own 40-year / cutoff arithmetic — they only call the helper.
  for (const f of ['app/page.js', 'app/payment-success/page.js', 'app/api/generate-pdf/route.js']) {
    assert.ok(!/historicEligibility|<\s*1986|-\s*40\b/.test(read(f)), `${f} does not re-implement the age test`);
  }
});
