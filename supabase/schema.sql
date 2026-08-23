-- MotorQuoter — Supabase PostgreSQL schema
-- Sufficient to rebuild the entire database from scratch.
-- All writes go through the service role key (server-side only), which bypasses RLS.
-- RLS is enabled on every table to block anon/authenticated direct access.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. reg_lookup_cache
--    Caches API responses (DVLA + OneAuto) per registration + tier combination.
--    TTL enforced in application code (48 hours); rows older than 48 h are
--    ignored on read but not automatically deleted — run the cleanup query below
--    periodically if storage becomes a concern.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reg_lookup_cache (
  -- GB/IE registration plate, normalised to uppercase with no spaces (e.g. "AB12CDE")
  reg_plate  text        NOT NULL,

  -- Cache key encodes tier + market, e.g.:
  --   'free_GB'                        free GB lookup
  --   'free_IE'                        free IE (Cartell) lookup
  --   'checks:market_demand,valuation_GB'   paid GB checks (sorted, underscore-joined)
  --   'roi:roi_standard'               paid ROI tier lookup
  tier       text        NOT NULL,

  -- Full JSON payload returned to the client, stored verbatim.
  -- Shape varies by tier — see /api/vehicle/route.js for field definitions.
  payload    jsonb       NOT NULL,

  -- When this row was written. Used for TTL filtering (>= now() - 48h).
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (reg_plate, tier)
);

-- Index on created_at to support periodic cleanup of expired rows:
--   DELETE FROM reg_lookup_cache WHERE created_at < now() - INTERVAL '48 hours';
CREATE INDEX IF NOT EXISTS reg_lookup_cache_created_at_idx
  ON reg_lookup_cache (created_at DESC);

ALTER TABLE reg_lookup_cache ENABLE ROW LEVEL SECURITY;
-- No permissive policies — all access is via the service role key, which bypasses RLS.

-- 2026-06-28: live reg_lookup_cache rebuilt by hand to match the
-- CREATE TABLE above (lines 14-33). The live table had drifted to
-- (id/reg/result/expires_at); both read and write 400'd in preview
-- AND production, so the cache stored nothing. Dropped and recreated
-- to the canonical shape via the Supabase SQL editor. Recorded here
-- so the committed schema and the live table can no longer drift
-- silently. SQL that was run (already applied — do NOT re-run blindly):
--   DROP TABLE IF EXISTS reg_lookup_cache;
--   CREATE TABLE reg_lookup_cache (
--     reg_plate  text        NOT NULL,
--     tier       text        NOT NULL,
--     payload    jsonb       NOT NULL,
--     created_at timestamptz NOT NULL DEFAULT now(),
--     PRIMARY KEY (reg_plate, tier)
--   );


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. used_sessions
--    One-use ledger for Stripe checkout session IDs on the motorquoter.app
--    paid vehicle report flow (Standard / Pro).  Prevents replay: a session ID
--    is inserted on first verified payment; subsequent requests for the same ID
--    are rejected with 403.  The unique constraint on session_id also guards
--    against race conditions (two simultaneous requests racing past the
--    pre-insert existence check).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS used_sessions (
  -- Stripe checkout session ID, e.g. "cs_live_...". Treated as the natural PK.
  session_id text        PRIMARY KEY,

  -- When the session was first redeemed.
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE used_sessions ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2b. paid_reports  (BUILD_StoredReports, 21 Aug)
--     A paid report must survive the tab closing. Keyed on the purchase, it stores the EXACT payload
--     the customer was served so a re-open is a DB read and nothing else — no supplier calls, no
--     free re-fetch. Short-lived (crash recovery only, STORED_REPORT_TTL_MINUTES = 10); the durable
--     copy reaches the customer by email at purchase.
--     ⚠️ MUST be created in Supabase before the feature works — schema.sql is not auto-applied.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS paid_reports (
  session_id  text        PRIMARY KEY,   -- Stripe cs_... OR the promo/free UUID token
  vrm         text        NOT NULL,
  checks      text        NOT NULL,      -- comma-joined, as delivered
  market      text        NOT NULL DEFAULT 'GB',
  payload     jsonb       NOT NULL,      -- the EXACT response the customer was served
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paid_reports_created_at_idx ON paid_reports (created_at);
ALTER TABLE paid_reports ENABLE ROW LEVEL SECURITY;
-- Retention: the app sweeps expired rows opportunistically on each write (see
-- lib/paidReports.sweepExpiredStoredReports — a row past the 10-minute TTL is unreadable), so no cron
-- is required. Manual belt-and-braces if writes ever stall (a row can only be served for 10 min):
--   DELETE FROM paid_reports WHERE created_at < now() - INTERVAL '10 minutes';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2c. redeemed_sessions  (DDL was missing from the repo — flagged 19 Aug, added here)
--     The FREE / promo path's single-use token record. Columns transcribed from the live usage in
--     app/api/stripe/verify/route.js (token, used, checks, vrm, market, roi_tier) — VERIFY against the
--     live table before applying; it was created manually and may carry columns not read here.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS redeemed_sessions (
  token       text        PRIMARY KEY,
  used        boolean     NOT NULL DEFAULT false,
  checks      text,
  vrm         text,
  market      text        DEFAULT 'GB',
  roi_tier    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE redeemed_sessions ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. salvage_sessions
--    Persists the full lifecycle of a salvage damage assessment:
--    image upload → Stripe payment → Claude assessment → optional re-run.
--    The row is created before payment so the salvage_id can be embedded in
--    the Stripe success URL; status advances as the session progresses.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS salvage_sessions (
  -- Auto-generated surrogate key; embedded in Stripe metadata and success URLs.
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lifecycle status:
  --   'pending_payment'  row created, Stripe checkout not yet completed
  --   'processing'       payment confirmed, Claude assessment running
  --   'assessed'         assessment written to the assessment column
  --   'pending'          reset for re-run (assessment cleared, rerun_count incremented)
  status            text        NOT NULL DEFAULT 'pending_payment',

  -- Rich JSON object submitted by the client.  Typical fields:
  --   vrm, make, model, year, colour, fuelType, engineSize
  --   damageDescription (raw Copart listing text)
  --   primaryDamage, secondaryDamage, additionalDamage
  --   category (Cat S, Cat N, etc.)
  --   runCondition, keys, transmission, odometer, fuel
  --   estimatedRetail, vatOnSale, v5Status, lotNumber
  --   auctionSource ('copart' | 'bca' | 'manheim' | 'other')
  --   dvlaVerified (bool), motStatus, taxStatus
  --   lastMotMileage, motMileageFlag
  --   motHistory (array from DVSA)
  --   salvageHistory (carguide result)
  --   roiTier (IE only: 'roi_free' | 'roi_standard' | 'roi_pro' | 'roi_history')
  --   roiData (IE paid: { valuation, marketDemand, priceGuide, historyCheck })
  --   Enriched in-place by the assess route with parsed Copart listing fields.
  vehicle_details   jsonb,

  -- Array of base64-encoded images (data URIs or raw base64 strings, up to 20).
  -- Stored as submitted; passed directly to the Claude vision API.
  images            text[],

  -- 'GB' or 'IE'
  market            text        NOT NULL DEFAULT 'GB',

  -- Parsed Claude assessment, written once the AI response is received.
  -- Keys mirror ASSESSMENT_FIELDS in the assess route:
  --   'Visible Damage Summary', 'Estimated Repair Range', 'Key Cost Drivers',
  --   'Red Flags', 'Alternative Damage Scenario', 'Airbags',
  --   'Confidence Level', 'Bidder Note', 'Recommended Action',
  --   'Realistic Exit Value', 'Margin Calculation',
  --   'WhatsApp Inspection Checklist'
  -- Also contains _raw (full Claude text), _market.
  assessment        jsonb,

  -- Stripe checkout session ID recorded when payment is confirmed.
  -- NULL until the assess route receives the paid callback.
  -- Also used as the auth token for re-run-submit (proves original payment).
  stripe_session_id text,

  -- Number of re-runs consumed (max 1). Starts at 0; incremented by /api/salvage/rerun.
  rerun_count       integer     NOT NULL DEFAULT 0,

  -- Retention keep-flag (batch 39). The 24-hour image sweep NEVER deletes a keep=true row or its
  -- storage objects, so ground-truth fixtures can outlive the window. Default false = eligible.
  keep              boolean     NOT NULL DEFAULT false,

  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The live salvage_sessions table predates the keep column — add it before arming the sweep:
--   ALTER TABLE salvage_sessions ADD COLUMN IF NOT EXISTS keep boolean NOT NULL DEFAULT false;
-- Then mark the fixture lots so the sweep skips them (the sweep ABORTS if this column is absent):
--   UPDATE salvage_sessions SET keep = true
--   WHERE vehicle_details->>'vrm' IN ('AK75RDX','DMZ4614','EA17HDN','FE68AOP','GY75CJU','KT73YAJ',
--                                     'SA26KVT','SD75YGC','SF69YBB','URZ7545','YH23NVW');

CREATE INDEX IF NOT EXISTS salvage_sessions_created_at_idx
  ON salvage_sessions (created_at DESC);

ALTER TABLE salvage_sessions ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. oneauto_cache
--    Per-call cache for One Auto API responses on the salvage assess route.
--    Keyed by CALLTYPE:REG (e.g. BREGO_GB:MK15VPZ).  TTL 30 days; expires_at
--    is the read gate (WHERE expires_at > now()).  Stale-on-error: expired rows
--    are served when a live call fails (WHERE expires_at <= now() as fallback).
--    Service role only; RLS blocks all client access.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oneauto_cache (
  -- E.g. "BREGO_GB:MK15VPZ", "SALVAGEHISTORY:AB12CDE"
  cache_key   text        PRIMARY KEY,

  -- Complete extracted API response (post .result??.raw unwrap), stored verbatim.
  payload     jsonb       NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),

  -- TTL gate: unexpired = expires_at > now(); stale fallback reads all rows for key.
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS oneauto_cache_expires_at_idx
  ON oneauto_cache (expires_at);

ALTER TABLE oneauto_cache ENABLE ROW LEVEL SECURITY;
-- No permissive policies — service role bypasses RLS; all other roles blocked.


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. oneauto_call_log  (feat/oneauto-fetch commit 2, 23 Aug)
--    One row PER REQUEST (buffered, not per call): every One Auto call the request made, with its
--    latency and ok flag. Records COUNTS, never COSTS — the rate lives in One Auto's invoice, which
--    only Vincent can pull. This is the spend-log FOUNDATION under §7 part 2 and the E costing model;
--    a count × a list price is still a list price.
--    ⚠️ MUST be created in Supabase before the log writes land — schema.sql is not auto-applied. The
--    write is wrapped and non-fatal, so a missing table degrades to no logging (the report is unaffected).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oneauto_call_log (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  text,                    -- the paid Stripe/promo session, when the request had one
  vrm         text,                    -- the vehicle the calls were for (first non-null in the batch)
  call_count  integer     NOT NULL,
  -- [{ endpoint, vrm, ok, ms, ts }] — endpoint is the path (no query), ms is per-call latency.
  calls       jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oneauto_call_log_created_at_idx ON oneauto_call_log (created_at DESC);
ALTER TABLE oneauto_call_log ENABLE ROW LEVEL SECURITY;
-- No permissive policies — service role bypasses RLS; all other roles blocked.


-- ─────────────────────────────────────────────────────────────────────────────
-- Cleanup queries (run manually or via pg_cron as needed)
-- ─────────────────────────────────────────────────────────────────────────────

-- Expire old cache entries (application TTL is 48 h; purge after 7 days for safety)
-- DELETE FROM reg_lookup_cache WHERE created_at < now() - INTERVAL '7 days';

-- Purge old Stripe session records (Stripe sessions expire after 24 h anyway)
-- DELETE FROM used_sessions WHERE created_at < now() - INTERVAL '30 days';

-- Purge old salvage sessions (images are large; trim after 90 days)
-- DELETE FROM salvage_sessions WHERE created_at < now() - INTERVAL '90 days';

-- Purge expired One Auto cache rows (TTL 30 days; keep 35 for stale-on-error safety)
-- DELETE FROM oneauto_cache WHERE expires_at < now() - INTERVAL '5 days';
