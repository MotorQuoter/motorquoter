# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MotorQuoter is a Next.js 15 full-stack application that provides UK vehicle valuations and intelligence reports via registration number lookup. Users can access three tiers of information: free (DVLA only), standard (+ valuation & AutoCheck), and pro (+ full MOT history). The application integrates with Stripe for payments, Supabase for caching, and multiple vehicle data APIs.

## Quick Start

```bash
npm run dev       # Start development server at http://localhost:3000
npm run build     # Create production build
npm run start     # Run production server
npm run lint      # Run ESLint
```

## Architecture

### Frontend
- Single-page client component at `/app/page.js` with inline styled components
- Dark theme with orange accent color (#f05a1a)
- Features: VRM input, license plate photo scanning (Claude vision), mileage optional field, market selection (GB/NI/IE), three-tier pricing buttons
- Handles free tier lookups directly; redirects paid tiers to Stripe checkout

### Backend API Routes
- `/api/vehicle` - Main aggregator endpoint combining DVLA, OneAuto, and MOT data; includes caching logic and tier verification
- `/api/stripe/checkout` - Creates Stripe checkout sessions (Standard £1.99, Pro £6.99)
- `/api/stripe/verify` - Verifies payment status by session ID, returns tier for tier-gated data
- `/api/platescan` - Uses Claude vision API (claude-sonnet-4-5) to extract registration from photo
- `/api/dvla` - Direct DVLA Vehicle Enquiry API proxy (minimal use)
- `/api/oneauto` - Generic OneAuto API proxy (currently unused)

### Data Flow
1. **Free tier**: User enters VRM → Direct `/api/vehicle?vrm=...&tier=free` call → Returns DVLA data only
2. **Paid tiers**: User enters VRM → Redirects to Stripe checkout → Payment success page with session ID → `/api/stripe/verify` confirms payment → `/api/vehicle` called with `verified=true` and tier from Stripe metadata → Returns tier-appropriate data

### Database & Caching
- Supabase PostgreSQL: `reg_lookup_cache` table stores results per (registration, tier) with 48-hour TTL
- Results checked before making expensive API calls to DVLA/OneAuto
- Uses service role key (server-side only) for cache writes

### External Integrations
- **DVLA Vehicle Enquiry API**: Registration, color, engine, fuel, tax status, MOT status
- **OneAuto APIs**:
  - Experian AutoCheck: Finance records, stolen status, write-off condition
  - BREGO Valuation: Retail/trade value ranges
  - MOT History: replaced by DVSA direct integration on Pro tier (see below)
- **Stripe**: Payment processing in GBP (amounts stored as pence: 199 = £1.99)
- **DVSA MOT History API**: Pro tier MOT history via OAuth2 client credentials flow; token cached in-process in `lib/dvsa.js` with 60s expiry buffer. Response fields: `motTests[].expiryDate`, `odometerValue`, `testResult`, `rfrAndComments`
- **Claude API**: Vision model for number plate OCR from photos

## Key Implementation Details

### Tier Verification (Security)
The `/api/vehicle` route only trusts tier information when:
1. `verified=true` query parameter is present
2. The tier matches what was stored in the Stripe session metadata

This prevents clients from requesting premium data without payment. Free tier requests always return free data regardless of tier parameter.

### Caching
- TTL: 48 hours per registration + tier combination
- Checked first to avoid redundant API calls
- Results marked with `_cached: true` and `_cachedAt` timestamp

### Photo Scanning
- `/api/platescan` calls Claude vision API with base64 image
- Returns extracted VRM in uppercase with no spaces
- On failure, includes debug fields (`raw`, `error`) that should be removed after testing

### Styling Architecture
- Uses inline CSS-in-JS rather than Tailwind utilities (both configured but inline CSS dominates)
- Design tokens stored in CSS variables (--bg, --orange, --text, etc.)
- Mobile-first single-column layout (max-width: 480px)

### Result Display
- Same payload structure for both homepage (free) and payment-success page
- Tier-specific fields conditionally rendered:
  - Free/Standard: No MOT expiry or mileage
  - Pro: Full MOT history with expiry date and mileage at last test

## Environment Variables

Required for development (see `.env.local`):
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
DVLA_API_KEY
ONE_AUTO_API_KEY
ANTHROPIC_API_KEY
STRIPE_SECRET_KEY
NEXT_PUBLIC_APP_URL (defaults to https://motorquoter.app)
DVSA_CLIENT_ID
DVSA_CLIENT_SECRET
DVSA_API_KEY
DVSA_SCOPE_URL
DVSA_TOKEN_URL
```

## Known Issues & TODOs

- Styling: Tailwind CSS configured but mostly unused; inline CSS could be migrated to utilities for maintainability
- Database schema for `reg_lookup_cache` not tracked in repo (created manually in Supabase)

## Common Tasks

### Testing Tier Verification
Free lookups don't require payment; Standard/Pro redirect to Stripe. In payment-success callback, session ID is verified before running expensive lookups.

### Adding a New Data Provider
1. Add API call in `/api/vehicle` route alongside DVLA/OneAuto calls
2. Determine which tier(s) should include this data
3. Add fields to `payload` object before cache storage
4. Render conditionally in both `/app/page.js` and `/app/payment-success/page.js`

### Debugging API Calls
- Check Network tab in DevTools for request/response bodies
- API errors include `error` field with message
- Cached results include `_cached: true` to distinguish from live calls

## Known Issues — PDF
- Repair Range banner showing GBP instead of £
- Two £ signs slipping through in WhatsApp checklist items
- Vehicle Details section ordering inconsistent (Highlights/Additional Info labels appearing)
- GBP 8,120.50 estimated retail value formatting in Vehicle Details
