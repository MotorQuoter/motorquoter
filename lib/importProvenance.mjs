// ─────────────────────────────────────────────────────────────────────────────
// Jurisdiction timeline → import provenance evidence. DETERMINISTIC, no model.
// ─────────────────────────────────────────────────────────────────────────────
// DVSA MOT history covers GB and NI. Each test carries a `dataSource` discriminator:
//   "DVSA"  → Great Britain    "DVA NI" (or any NI marker) → Northern Ireland
// (`lib/dvsa.js` spreads every test field, so dataSource survives the parse and reaches
// result.motHistory — no parser change needed.)
//
// The test jurisdictions across the 1 Jan 2021 Brexit cut-off EVIDENCE whether the pre-2021
// NI import route can apply. This module turns them into code-computed flags + an evidence
// block. It NEVER authors a monetary figure and NEVER overrules the buyer:
//   • The buyer's affirmative NI-qualifying confirmation drives the CALCULATION (NI removes
//     VAT + customs — a four-figure swing — and legally needs V5C / service evidence the buyer
//     must physically hold; MOT jurisdiction alone is necessary, not sufficient).
//   • This timeline SUGGESTS a default, EVIDENCES the claim, and WARNS on contradiction. It does
//     not silently lower the figure. Understating a "guide only" product is the dangerous error.
//
// HARD LIMITS (surface in-product, never invert):
//   • NI test records begin in 2017 (GB from 2005) — earlier NI presence is unknowable.
//   • Jurisdiction is shown; test location/centre is not.
//   • DVA NI tests carry no defect/advisory detail.
//   • ABSENCE of NI tests is NOT proof the car was never in NI.

// ─────────────────────────────────────────────────────────────────────────────
// SOURCES OF RECORD (checked 2026-08-16) — RE-CHECK QUARTERLY, and any time a cited URL 404s.
// This area is in flux; Revenue is renaming/removing pages. Do NOT substitute a plausible-looking
// replacement — if a cited URL 404s, stop and report.
//   • dataSource discriminator ("DVSA" GB / "DVA NI") + 2017 NI test-data floor — DVSA MOT History
//     API (trade), observed field; NI/DVA records begin 2017, GB from 2005.
//   • Pre-2021 EU-goods route (no customs formalities if in NI before 1 Jan 2021) — Revenue,
//     Tax and Duty Manual "Import of Motor Vehicles from the UK" (March 2024).
//   • Private-ownership "a reasonable period of time" test (no published duration) — same TDM,
//     https://www.revenue.ie/en/tax-professionals/tdm/customs/import-export-policy/import-of-motor-vehicles-from-the-UK-20240315075758.pdf
//   • Dealer/trade route: UKIMS + Internal Market Movement Information / MRN (Windsor Framework,
//     from 1 May 2025); private GB→NI = HMRC "declaration by conduct", no MRN — gov.uk.
//   ⚠ Revenue's "Registering vehicles without proof of declaration to customs in NI" page 404s at
//     both known URLs as of 2026-08-16 (removed/renamed) — flagged, not substituted.
// ─────────────────────────────────────────────────────────────────────────────

export const NI_DATA_FLOOR_YEAR = 2017;
const BREXIT_CUTOFF_YEAR = 2020; // "after 2020" == 2021+; "pre-2021" == 2020 and earlier

// Year out of "DD/MM/YYYY" (lib/dvsa formatDate output) or ISO "YYYY-MM-DD…". null if unparseable.
export function yearOf(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const iso = dateStr.match(/^(\d{4})-\d{2}/);
  if (iso) return parseInt(iso[1], 10);
  const dmy = dateStr.match(/\b(\d{4})\b/); // last segment of DD/MM/YYYY, or any 4-digit year
  return dmy ? parseInt(dmy[1], 10) : null;
}

const isNiTest = (t) => /\bNI\b|\bDVA\b/i.test(t?.dataSource || '');
const isGbTest = (t) => /DVSA/i.test(t?.dataSource || '');

export function buildJurisdictionTimeline(motTests, firstUsedDate) {
  const tests = Array.isArray(motTests) ? motTests : [];
  const rows = tests
    .map((t) => ({ ni: isNiTest(t), gb: isGbTest(t), year: yearOf(t?.completedDate) }))
    .filter((r) => r.year != null && (r.ni || r.gb));

  const niPre  = rows.some((r) => r.ni && r.year <= BREXIT_CUTOFF_YEAR);
  const niPost = rows.some((r) => r.ni && r.year >  BREXIT_CUTOFF_YEAR);
  const gbAfter2020 = rows.some((r) => r.gb && r.year > BREXIT_CUTOFF_YEAR);
  const fuYear = yearOf(firstUsedDate);

  const flags = {
    GB_TEST_AFTER_2020: gbAfter2020,
    NI_TESTS_PRE_2021:  niPre,
    NI_CONTINUOUS:      niPre && niPost && !gbAfter2020,
    MIXED_HISTORY:      rows.some((r) => r.ni) && rows.some((r) => r.gb),
    NO_TEST_HISTORY:    tests.length === 0,
    PRE_2017_BLIND:     fuYear != null && fuYear < NI_DATA_FLOOR_YEAR,
  };

  // Suggested provenance DEFAULT — a hint for the render/prompt, NOT the charged figure.
  // GB stays the conservative (over-stating) default; only NI_CONTINUOUS suggests NI, and even
  // then the buyer must confirm the exemption. GB_TEST_AFTER_2020 forecloses the pre-2021 route.
  let suggestedProvenance = 'GB';
  let confidence = 'low';
  let reason;
  if (flags.GB_TEST_AFTER_2020) {
    confidence = 'high';
    reason = 'A GB (DVSA) test is recorded after 31 December 2020 — the pre-2021 NI import route cannot apply, so VAT and customs are in scope.';
  } else if (flags.NI_CONTINUOUS) {
    suggestedProvenance = 'NI';
    confidence = 'medium';
    reason = 'NI (DVA) tests are recorded on both sides of 1 January 2021 with no later GB test — consistent with continuous NI presence. If the car legally qualifies, VRT only may apply; confirm before relying on it.';
  } else if (flags.NI_TESTS_PRE_2021) {
    confidence = 'low';
    reason = 'An NI (DVA) test is recorded before 1 January 2021, but the history is not continuous across the cut-off — NI presence is possible but not evidenced end-to-end.';
  } else if (flags.NO_TEST_HISTORY) {
    confidence = 'none';
    reason = 'No test history is available — nothing about jurisdiction can be evidenced. Provenance falls back to your declaration.';
  } else {
    reason = 'No NI test evidence was found. Absence of NI tests is not proof the car was never in NI — but on the evidence available, the GB route applies.';
  }

  const canEvidenceNiTests = rows.some((r) => r.ni);
  const evidence = {
    // Revenue's three-document NI-qualification test, and which this report can actually show.
    revenueDocuments: [
      { doc: 'Original V5C with the last keeper resident in NI', canEvidence: false, source: 'buyer must obtain' },
      { doc: 'NI service history',                               canEvidence: false, source: 'buyer must obtain' },
      { doc: 'NI MOT / test history',                            canEvidence: canEvidenceNiTests, source: canEvidenceNiTests ? 'this report' : 'no NI tests found' },
    ],
    limits: [
      `NI test records begin in ${NI_DATA_FLOOR_YEAR} (GB from 2005) — earlier NI presence cannot be shown.`,
      'Test jurisdiction is shown, but not the test location or centre.',
      'NI (DVA) tests carry no defect or advisory detail.',
      'Absence of NI tests is NOT proof the car was never in NI.',
    ],
    niDataFloorYear: NI_DATA_FLOOR_YEAR,
    niTestCount: rows.filter((r) => r.ni).length,
    gbTestCount: rows.filter((r) => r.gb).length,
  };

  return { flags, suggestedProvenance, confidence, reason, evidence };
}

// Does the buyer's affirmative provenance choice contradict the hardest signal? Used to raise a
// prominent, non-blocking warning — the buyer is never overruled, only told what the data shows.
export function provenanceConflict(userProvenance, flags) {
  if ((userProvenance || '').toUpperCase() === 'NI' && flags?.GB_TEST_AFTER_2020) {
    return 'You have marked this car NI-qualifying, but a GB (DVSA) test is recorded after 31 December 2020. The pre-2021 NI route likely does not apply — the real cost is probably the GB figure, with VAT and customs. Confirm the car was legally imported into NI before relying on the VRT-only estimate.';
  }
  return null;
}
