# MotorQuoter Session Summary — 15 May 2026

## What Was Built Today

### Step 7 — Salvage Assessment Tool (complete)
- `config/assessmentEngine.js` — Assessment Engine v1.1 (Sections 1–4) extracted from docx and exported as `ASSESSMENT_ENGINE_PROMPT` system prompt
- `app/salvage/page.js` — Client-side upload page: multi-photo upload (1–20), drag & drop, canvas compression (1024px / JPEG 0.75), optional vehicle fields (VRM, make, model, year, lot number, damage description), GB/IE market selector, £6.99 price, Stripe redirect
- `app/api/salvage/checkout/route.js` — Creates Supabase `salvage_sessions` row (stores base64 images + vehicle details), creates Stripe checkout session at £6.99, returns redirect URL
- `app/api/salvage/assess/route.js` — Verifies Stripe payment, checks Supabase cache, calls Claude API (`claude-sonnet-4-6`) with Assessment Engine v1.1 as system prompt and vehicle photos as user content, parses structured output, stores result; `maxDuration = 120`
- `app/api/salvage/pdf/route.js` — Server-side jsPDF report: branded header (MotorQuoter orange/dark), vehicle details, repair range banner, damage assessment section, valuation & bidding section, WhatsApp inspection checklist, disclaimer footer
- `app/salvage/success/page.js` — Post-payment results page: animated loading (8-message cycle), structured assessment display, PDF download button, retry support

### Step 8 — Market cache key isolation
Confirmed already implemented from a prior session. Cache keys: `'free_GB'` (free tier) and `` `checks:${sortedKey}_${market}` `` (paid — includes market, preventing GB/IE cache collisions).

### Step 9 — IE market considerations
- Confirmed Cartell identity call wired into all paid IE flows (`/cartell/vehicleidentity/v1`)
- Added Garda stolen data disclaimer to `app/payment-success/page.js` StolenSection for IE market: *"Irish stolen data is based on a private register. An Garda Síochána do not share stolen vehicle data with third parties."*
- Added same disclaimer to `app/api/generate-pdf/route.js` vehicle PDF for IE market
- Confirmed GB endpoints (DVLA, AutoCheck, BREGO, Percayso, DVSA) are never called for IE market

### PDF fixes (mid-session)
Four issues reported and resolved in `app/api/salvage/pdf/route.js`:
1. **Assessment sections missing** — Root cause: regex lookahead parser failed on blank lines between fields. Fix: position-based parser (`parseFromRaw`) that strips markdown first, then finds field label positions and slices content between them. `resolveFields()` added as fallback for cached sessions with empty parsed fields.
2. **Checklist items numbered per line** — Fix: `parseChecklistItems()` splits on `\n(?=\d+[.)]\s)` instead of every newline, keeping description lines attached to their numbered item.
3. **Markdown asterisks rendering literally** — Fix: `stripMd()` function applied to all text via `str(v)` helper before rendering.
4. **Valuation & Bidding section empty** — Resolved by the same parser fix (fields were not being extracted from `_raw`).

### Margin fix
- `MARGIN` in `app/api/salvage/pdf/route.js` increased from 14mm to 20mm. All separator lines, text blocks, banners, and content width (`CONTENT_W = PAGE_W - MARGIN * 2`) scale from this single constant.

---

## What Was Confirmed Working

- Salvage assessment tool end-to-end: photo upload → Stripe payment → Claude assessment → structured results page (confirmed by user after Step 7 deploy)
- PDF download: file generates and downloads correctly (confirmed before format issues were reported)
- Assessment Engine v1.1 integrated and producing structured output
- Model ID fix: `claude-sonnet-4-6` (was `claude-sonnet-4-20250514` which does not exist)
- IE market: Garda note rendering correctly in both UI and PDF
- Supabase `salvage_sessions` table: service role key bypasses RLS, no policies required

---

## Outstanding / Not Yet Confirmed

- **Salvage PDF format fixes** — Deployed at end of session; user has not yet re-tested. Four issues (missing sections, checklist numbering, asterisks, empty Valuation section) fixed in code but not visually verified by user.
- **PDF right margin (20mm)** — Deployed at end of session; not yet confirmed by user.
- **IE market end-to-end test** — No live IE vehicle tested through the full paid flow this session.

---

## Next Session Priorities

1. **Confirm PDF fixes** — Run a new salvage assessment and download the PDF. Verify all sections render, checklist is correctly numbered, no asterisks, right margin clean.
2. **Step 10 onwards** — Review original brief for any remaining steps not yet addressed.
3. **IE market live test** — Test a paid IE registration lookup end-to-end to confirm Cartell identity, HPI, and NCT all return correctly.
4. **Salvage tool UX review** — Consider: loading state polish, error messaging clarity, mobile layout of photo grid.
5. **Assessment Engine prompt tuning** — If assessment quality needs adjustment, `config/assessmentEngine.js` is the single source of truth for the system prompt.

---

## One Auto API Balance

**Unknown** — not checked or reported during this session. Check directly in the OneAuto dashboard or by inspecting response headers/usage endpoint.

---

## Key File Reference

| File | Purpose |
|------|---------|
| `config/assessmentEngine.js` | Assessment Engine v1.1 system prompt (Sections 1–4) |
| `app/salvage/page.js` | Salvage upload + payment page |
| `app/salvage/success/page.js` | Post-payment results + PDF download |
| `app/api/salvage/checkout/route.js` | Stripe checkout + Supabase session creation |
| `app/api/salvage/assess/route.js` | Payment verification + Claude API call + parsing |
| `app/api/salvage/pdf/route.js` | jsPDF report generation |
| `app/payment-success/page.js` | Standard/Pro vehicle report UI |
| `app/api/generate-pdf/route.js` | Standard/Pro vehicle report PDF |
| `app/api/vehicle/route.js` | Main data aggregator (GB + IE, all tiers) |
| `config/pricing.js` | Centralised pricing (salvage: £6.99) |
