# CC BRIEF — CORE Slot Engine (Phase 1 of the structured-checklist redesign)
# (paste to Claude Code, or save to repo and point CC at it)

Design reference: MotorQuoter_StructuredChecklist_DesignNotes_06Jun2026.md (read it first).
This is PHASE 1: the CORE slot ENGINE + CORE slots ONLY. NOT the damage modules.
Goal: a working end-to-end pipeline on EVERY lot, validated, before frontal goes on top.

## DECISIONS ON THE GAPS YOU FLAGGED (confirmed)

1. **VIN — DROPPED, no VIN check.** Confirmed empirically: Copart stars the VIN behind login
   and does NOT photograph the plate (checked across multiple real lots), so there's no
   physical VIN to compare against. No VIN slot. KEEP ONLY: Copart's OWN disclosure of an
   obscured/missing/replaced VIN on theft-recovered lots, read from listing text (no user
   action, no paste) → surface as a provenance flag.

2. **Vendor suffix — code-extract, not vision.** The suffix is the LAST CHAR of the lot
   number (X/P/C/Q), and parseCopartListing already extracts the lot number. Code-extract
   the suffix → map X=insurer-low / P=insurer-high / C=private-trade / Q=Copart-or-webuyanycar
   → feed as a code-owned value. CONFIRM FIRST: does the lot number reliably carry the suffix
   in the listing data? (If not, flag it.)

3. **Salvage count — generalise tagSelfReference to N records.** Currently only handles the
   single-record case. Generalise: exclude the record matching the current lot
   (date / mileage ±50 / category / damage-text) and report "N prior events" (N excluding
   self). The 05 Jun fix; the Juke (2 records, 1 was self) proved it's needed.

4. **Body-style — feed enrichedVd.bodyStyle into contextLines.** Currently parsed but never
   reaches the model. Feed it so the model's body-style vision read can be corroborated
   against the listing (closes the 3-door/5-door wander).

## INPUT ARCHITECTURE — SEPARATE PHASE QUESTION
The planned SalvageIQ-competitive UX (recalled): user pastes the Copart DESCRIPTION + uploads
a ZIP of photos; MQ parses the description to auto-populate the boxes (client-side, no scraper,
zero Copart footprint). This is an INPUT/UX-layer change, arguably separate from the slot
engine (front-end/parsing vs assessment-logic). TELL ME: do you agree input-architecture
should be its OWN build phase, separate from the CORE slot engine? (Lean: yes — don't mix
input-parsing with assessment-logic in one build; muddies validation.)

## ARCHITECTURE — GENERALISE WHAT ALREADY WORKS
Don't invent new machinery. Extend the two existing patterns:
- The code-owned-value injection (_reconciledParts / _exitValue / _marginScenarios) — model
  forbidden from stating the value, code computes & merges. This is the slot-output pattern.
- The recordLampObservation flow (forced structured tool call → prose grounded in it). This
  is the forced-slot pattern. Generalise it to every CORE slot.

## RENDER — SHARED SLOT DATA SHAPE
Web (success/page.js) and PDF (pdf/route.js) currently re-parse independently — no shared
render component. Define a SHARED slot data shape (structured object) that BOTH consume, so
forced-verdict slots + all-clear grouping render consistently and don't drift. This is the
main Phase-1 work. The Salvage History block already collapses verdict states into different
display shapes — that's the precedent for all-clear grouping, but it's bespoke; make it generic.

## CORE SLOTS TO BUILD (per the design doc, group D + A/B/C)
Identity (VRM/make/model/year/lot#, body-style corroboration, vendor suffix, category,
provenance-contradiction) · Mileage (odometer, corroboration vs MOT/listing/salvage,
MOT-history correlation, salvage-count-excl-self) · Running (run/drive, keys, dash warning
lights) · Physical (each wheel + each tyre individually, glass +ADAS, airbags, interior,
spare wheel, theft-strip evidence, fluid-contamination-on-components NOT puddles). Plus the
Cat A/B branch (non-repairable → no repair assessment). Service history = NOT a slot (already
a live app feature). EV battery SoH = mention only, not a slot.

## BUILD INCREMENTALLY — EACH PIECE BUILT TO KEEP (NOT throwaway stages)
CRITICAL FRAMING: build each piece CORRECTLY and COMPLETELY the first time — every increment
is the FINAL version of that piece, kept and built upon, NEVER a provisional/interim version
to be torn up and rebuilt later. No stopgaps. The increments are VALIDATION CHECKPOINTS, not
throwaway stages: CORE is built right and KEPT; frontal EXTENDS it (doesn't rebuild it); input
FEEDS the same slots (doesn't force a CORE rewrite); two-pass WRAPS what exists. Nothing gets
redone — the product accretes properly, validated at each layer.

Within Phase 1: build the slot ENGINE + 2-3 CORE slots first (suggest: identity +
mileage-corroboration + each-wheel/tyre) — built as the REAL versions — prove they render
(web + PDF) and run end-to-end on BL75JAU and the Juke, THEN add the rest of the CORE slots
(also real, also kept). Small commits, validate each. The increment is a checkpoint, not a draft.

## FULL BUILD SEQUENCE (back-to-back, each validated, each KEPT — driving to finished product)
1. CORE slot engine + CORE slots (this brief) — built right, validated, kept.
2. Frontal module — EXTENDS CORE (doesn't rebuild it), validated, kept.
3. Input UX — Copart description-parse + zip-upload + auto-populate boxes. SEPARATE STREAM
   (front-end/parsing, distinct from assessment-logic) but built once CORE's shape is known;
   feeds the same slots, no CORE rewrite. Validated, kept.
4. Two-pass — wraps the structured pipeline (compares slot outputs across two full Opus passes,
   resolves conservatively, launders disagreements into inspection items). Last, because it
   needs the slots to exist. Validated, kept.
No artificial gaps between stages — go back-to-back. Pace is set by VALIDATION, not by speed.
This IS building the finished product — just in the order that lets each layer be proven before
the next sits on it, so nothing is ever built twice.

## BEFORE WRITING ANY SLOT, SHOW ME:
- Confirmation the lot-number suffix is reliable (decision 2)
- Your proposed SHARED slot data shape (web + PDF)
- Your view on input-architecture as a separate phase
Then I confirm, and you build the engine + first 2-3 slots.
