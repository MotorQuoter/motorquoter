# Phase 2 — Visibility Gate: Closed
## Handoff / Session Summary
*core-slots · 09 June 2026 · build-to-keep*

---

## Status

**Phase 1 — CLOSED** (prior session, commit `0e9c703`)
**Phase 2 — CLOSED** (this session, commits `118840f` → `5f2c290`)
**Phase 3 — PENDING** (Margin before unknowns — production gate)

core-slots does **not** go to production until Phase 3 rides with it. See standing constraint below.

---

## What Phase 1 delivered (prior — recorded here for continuity)

**Separate-block verdict carriage.** Moved per-part costing/flagging verdicts out of Call-2 (Haiku, 1024-token ceiling) into a new `Part Verdicts:` block in Call-1 (Opus) prose. Code reads it deterministically via `parsePartVerdicts()`. Call-2 reduced to five language-understanding fields; no fixed token ceiling can be hit by a heavy lot.

Key design invariant: machine tags (`PART:` / `FLAG:` lines) live in `assessment['Part Verdicts']` only — a block that no buyer-facing render file reads. Buyer-facing cleanliness does not depend on a conditional overwrite firing.

Validated: Condition A (stop_reason=tool_use, arrays populated, under ceiling), Condition B (grep — zero machine tags in buyer output), Condition C (zero-parts run — both parsers return `[]`, no tags reach Parts Breakdown string).

---

## What Phase 2 delivered

### Test 1 — Visibility Gate (`118840f`)

**Gate logic — five cases:**

| Case | Condition | Action |
|---|---|---|
| 1 | `rp._allowance === true` | PASS — lamp allowance row, code-derived |
| 2 | Block present, no matching verdict for this part | PASS + `[GATE] no-verdict-match` log |
| 3 | `verdict._labourSafe === true` | PASS — deliberate null (labour row) |
| 4 | `verdict.independentlyVisible === true` | PASS — confirmed visible |
| 5 | `iv === false` OR (`iv === null` AND NOT `_labourSafe`) | STRIP + paired flag (atomic) |

**Fail-direction split:** two failure modes separated by design.
- Whole-block absent (`costedParts.length === 0` while priced parts exist): `[GATE][INOPERATIVE]` fires loud to logs; parts pass through unfiltered. Never silent.
- Per-part ambiguous null: STRIP + paired flag. Fail-closed.

**Labour-null tagging:** `cp._labourSafe = true` set in the labour-safety cross-reference forEach. Both labour-null and verdict-null arrive as `iv === null`; `_labourSafe` is the sole fork point. Labour rows pass; ambiguous verdict rows strip.

**Three consumers updated to `gatedParts`:** `assessment['Parts Breakdown']` (string), `assessment._reconciledParts` (PDF + success page), `assessment._partsReconciliation.parts_sum` (repair banner). `assessment._preGateParts = reconciledParts` kept as audit trail.

**Test 2 (Strike-Geometry) — NOT shipped.** "Low strike → only low parts" is physically false for multi-height frontals. SF69YBB: min partHeight=low (spoiler/sill) → would strip bonnet + headlamps (genuine damage). Banked pending better formulation.

---

### Defect 1 found and fixed — Invisible gate flag

**Defect:** `coreObs.flaggedParts` (including gate-generated paired flags) had no buyer-facing render path. Gate stripped a part, repair total dropped, max bid rose — but the buyer never saw the "excluded from repair total" warning. Conservatism breach.

**Fix — Inspection Flags render section (`6e2336b`):**
- New `assessment._flaggedParts` field: `[...coreObs.flaggedParts]` sorted weight high→medium→low, written to assessment after gate loop completes.
- Rendered in both `pdf/route.js` and `success/page.js` by explicit name (`assessment._flaggedParts`). Read fields: `f.weight`, `f.partName`, `f.reason` only. `_gateGenerated` stays internal.
- Position: after Key Cost Drivers, before Red Flags. Reading order: cost picture (table → drivers) → what to physically inspect (Inspection Flags) → provenance/legal (Red Flags).
- Whole array rendered — model flags and gate-generated together. Visual distinction via `reason` field in plain English, not machine labels.
- Model fields (`assessment['Red Flags']`, `assessment['Parts Breakdown']`) untouched.

---

### Defect 2 found and fixed — Prose/gate contradiction

**Defect:** Opus narrated cost decisions in prose ("park assist sensor costed at…"). Gate stripped the sensor downstream. Prose didn't know. Red Flags said "costed"; Inspection Flags said "excluded from repair total." Same part, contradictory claims, same report.

**Fix — PARTS BREAKDOWN IS THE SOLE COST AUTHORITY prompt rule (`5f2c290`):**

> Prose fields describe damage observations only — never whether a specific part is in the repair total or what its cost status is. The Parts Breakdown is the sole authoritative record of what is costed and at what amount; the repair total is computed from it by code and may be adjusted by post-processing. Any prose claim about a part's cost membership will conflict with those adjustments and make the report self-contradictory. This applies regardless of how the claim is phrased — "costed", "included in the repair total", "priced", "carried in the figure", "factored in", "not included", and any equivalent are all banned from prose. When a part is uncertain or excluded, describe what the photos show or do not show ("not visible on its own shots — verify on inspection") — never whether it ended up in the total. The Parts Breakdown line items state the £ individually; the total is code's.

Rule structure: principle first ("prose describes damage observations only — never cost membership"), WHY stated ("may be adjusted by post-processing"), word-list as illustrative examples only ("and any equivalent" carries the load, not the list), redirect to correct behaviour.

Position in prompt: peer rule to REPORT VOICE in the output-discipline block, `config/assessmentEngine.js` line 93.

**Validated on BL75:** Red Flags now reads "budget for sensor and loom replacement and recalibration" (damage + action instruction, no cost claim). Inspection Flags still shows sensor as stripped. Contradiction gone. HV/chassis sections read as distinct lanes (Red Flags = risk observation, Inspection Flags = inspection pointer).

---

## The four proofs

**Proof 1 — Forced [GATE][INOPERATIVE]**
Method: temporary override `coreObs.costedParts = []` hardcoded in `024fce9`, pushed to preview. Run triggered by user on preview.
Validated: `[GATE][INOPERATIVE] Part Verdicts absent/empty while N costed part(s) present — gate did not run; parts pass through unfiltered` fired to Vercel logs. PDF total unchanged (pass-through, not stripped). Reverted cleanly in `c9b05ce`.

**Proof 2 — Forced iv=false strip on a part with no model flag**
Method: natural run on BL75 — park assist sensor, iv=false, no matching model flaggedParts entry.
Validated: `[GATE] stripped "Park assist sensor" zone=rear iv=false` logged. Sensor absent from rendered Parts Breakdown. `parts_sum` dropped by sensor cost. Gate-generated paired flag with neutral wording ("excluded from repair total — not independently confirmed on its own shots; verify on inspection before bidding") rendered visibly in Inspection Flags section of PDF and success page.

**Proof 3 — Structural grep (render-path)**
Source-level: `grep -E 'iv:|z:|ph:|::|PART:|FLAG:|\[GATE\]|Part Verdicts|_gateGenerated'` on `pdf/route.js` and `success/page.js`. One hit: `*::before` CSS pseudo-selector. Zero machine-tag hits.
Live half: user ran grep against actual API JSON response on both BL75 and SF69 PDFs. Zero hits. Combined: render code cannot emit machine tags; rendered output confirms none reached buyer.

**Proof 4 — Rendered reason eyeball**
Method: user read actual rendered reason strings from Inspection Flags on both lots.
Validated: reasons are damage observations and inspection instructions in plain English. No machine tags, no accusatory provenance language, no cost-membership claims.

---

## Commit log — Phase 2

| Hash | Description |
|---|---|
| `118840f` | feat: Phase 2 Test 1 — visibility gate (iv=false/null strips; labour-null passes; whole-block INOPERATIVE guard) |
| `6e2336b` | feat: Inspection Flags render section — structured per-part flags in PDF and success page |
| `024fce9` | test: TEMP forced INOPERATIVE — revert after proof 1 confirmed *(reverted)* |
| `c9b05ce` | revert: restore coreObs.costedParts after INOPERATIVE proof |
| `5f2c290` | prompt: PARTS BREAKDOWN IS THE SOLE COST AUTHORITY — prose describes damage only, never cost membership |

---

## Standing constraint — Phase 3 gate before production

**core-slots does not merge to main until Phase 3 ships with it.**

**Phase 3 brief (Margin before unknowns):** The gate strips parts that aren't independently confirmed. Those parts don't disappear — they become unknowns. A buyer seeing a £4,200 repair total and a £1,800 margin must also see that the total excludes flagged items that could add £X–£Y on inspection. Without a floor label or unknown-cost annotation, the margin figure misleads: it looks like a real floor when it's actually a best-case-with-caveats figure.

**BL75 as the worked example:** BL75 has a visible repair total after the gate strips the sensor. The HV system and chassis legs are in Inspection Flags as high-weight items — uncosted unknowns. The margin calculation runs off the gated total, which excludes those unknowns. A buyer reading the margin table without a floor label could treat it as a reliable floor and overbid. Phase 3 adds the safety mechanism: the margin (or repair total) is labelled as a floor figure, with flagged unknowns surfaced explicitly so the buyer understands the total is a minimum, not a complete picture.

**Why this is a production gate:** shipping the visibility gate without the floor label ships half the safety mechanism. The gate correctly excludes uncertain parts from the cost total — but without telling the buyer the total is therefore incomplete, the exclusion looks like a clean bill of health rather than a known unknown. Phase 3 closes that gap.

---

*End of Phase 2 handoff.*
