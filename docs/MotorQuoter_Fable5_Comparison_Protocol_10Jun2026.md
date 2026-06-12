# MotorQuoter — Fable 5 Comparison Protocol
*10 June 2026 — pre-committed before any probe run.*

> **PROVENANCE NOTE (added 12 Jun 2026):** This document was composed in the 10 Jun 2026 chat session and presented for download, but was never committed to the repo — the 10 Jun session summary recorded it at `docs/` in error ("recorded as saved" ≠ "verified present"). It is reconstructed here verbatim from the chat record, retrieved 12 Jun 2026 *before* the verdict was drafted. Sections 0–7 below are the retrieved text; the only non-verbatim element is this note and the section-0 heading line. All §-references in `VERDICT-NOTES.md` and the run dispositions point at this text.

---

## 0. STEP ZERO — VERIFICATION BEFORE ANY RUN
1. **Pricing.** Look up `claude-fable-5` per-token pricing (input + output + image token accounting) at docs.anthropic.com. Compute estimated cost of the full run matrix (§3) BEFORE committing to it. Abort/shrink the matrix if cost is disproportionate.
2. **Image handling.** Verify Fable 5's documented image size / token guidance. The 1568px / 0.82 setting was tuned for Opus behaviour. **Run 1 keeps it unchanged anyway** — the first comparison must isolate ONE variable (the model). Resolution re-tuning, if warranted, is a separate later experiment.
3. **Model string.** `claude-fable-5` (confirm exact string against current docs at run time).
4. **Haiku odometer call: UNTOUCHED.** Its 1024px resize and token ceiling are independent of this test.

## 1. BRANCH AND CHANGE SCOPE
- New throwaway branch off `core-slots`: `fable5-probe`. Never merges. Exists to be diffed and deleted.
- **Single change:** model string in the assessment call. The lamp-detect vision call moves to Fable 5 in the same commit (it is part of "reading the photos") — but log it as a second change line so its effect is attributable.
- Everything else frozen: prompt, tool schema, resolution, gate, render. Any drift in behaviour is then attributable to the model.
- Validate against the deployed commit hash on the Vercel preview before reading any results (standing rule).

## 2. RUNTIME AUTHORITY ON EVERY RUN
- `apiData.model` in the Vercel token log is the only authority on which model served the request. Check it **per run** — Fable 5's published behaviour includes classifier-based rerouting of certain request categories to Opus 4.8. Vehicle assessment should never trip it, but a run whose log shows `opus-4-8` served is NOT a Fable 5 data point. Discard and note it.
- `stop_reason=tool_use` must be confirmed per run. If Fable 5 does not obey the tool schema identically, that is itself a finding (substrate incompatibility) and halts the comparison until understood.

## 3. RUN MATRIX
Run-to-run variance is established (SF69 bonnet £220–260 across Opus runs), so single runs cannot distinguish model difference from noise.

| Lot | Fable 5 runs | Opus 4.8 baseline |
|---|---|---|
| SF69YBB (perception probe) | 3 | Existing Phase 1–2 raw run logs IF retained; else 3 fresh runs |
| BL75JAU (regression anchor) | 3 | Existing Phase 2 raw run logs IF retained; else 3 fresh runs |

- Baseline reuse condition: the retained data must be the **raw arrays** (costedParts, flaggedParts, Part Verdicts, prose fields), not rendered PDFs. If only PDFs survive, re-run Opus fresh. Read raw evidence, not rendered output.
- SR16GOT is retired/sold. If the full photo set was saved locally, an optional thermal-axis run pair is worth one Fable 5 run; if not, drop it without regret.

## 4. WHAT TO DIFF (raw arrays only)

### 4a. The headline binary — SF69YBB rear quarter
- Is the rear quarter panel present in `costedParts`?
- What is its `independentlyVisible` value?
- **Per run.** Frequency matters: 0/3 fabricated is a different finding from 1/3.
This is the single most valuable probe. It is the perception fabrication the visibility gate cannot touch by design and the sole justification for the banked two-pass build.

### 4b. Stability axes (per run, across the 3 runs)
- SF69 bonnet: action (repair vs replace) and cost. Opus band is £220–260. Is Fable 5's band tighter, wider, or shifted?
- Lamp-detect verdict: consistent across 3 runs or flipping? (`LAMP_DETECTION_CONFIDENT_WORDING` stays OFF permanently regardless of outcome — a 3-run sample does not relicense it.)
- Repair total and exit-side arithmetic vs anchors (BL75 exit ~£14,682 current; SF69 £7,181).

### 4c. Substrate and discipline compatibility
- `stop_reason=tool_use` on every run; `costedParts` and `flaggedParts` populated.
- Gate behaviour unchanged: BL75 park-assist sensor still arrives `iv=false` → stripped → gate-generated flag renders. (If Fable 5 reports it `iv=true`, that is a MODEL-LEVEL change in visibility self-report — log it as a finding, not a gate failure.)
- Prose-discipline rule obedience: grep Red Flags prose for cost-status claims (costed / included / priced / factored in / equivalents). The rule was validated on-lot against Opus; obedience does NOT transfer between models. Validate it fresh.
- Machine-tag leak check: grep rendered output for `iv:` `ph:` `PART:` `FLAG:` `[GATE]` `_gateGenerated` `Part Verdicts` — zero hits required (Proof 3 repeat, abbreviated).

### 4d. Parts-table accuracy vs ground truth
- BL75 full parts table against locked ground truth: any parts gained, lost, or re-actioned?
- New fabrications anywhere count double — a model that fixes the rear quarter but invents a new panel elsewhere is not better, it is differently wrong.

## 5. VERDICT CRITERIA
- **BETTER:** SF69 rear quarter fabrication gone or reduced in frequency, AND no regressions on BL75 (no new fabrications, no parts lost, totals within established variance), AND substrate compatibility clean.
- **WORSE:** any new fabrication, any genuine part dropped, substrate breakage (tool schema disobedience), or wider cost variance.
- **UNCHANGED:** same fabrication at similar frequency, similar variance bands. Also a valuable result — it confirms the residual is architectural and the two-pass build keeps its priority.
- Mixed results get written up honestly as mixed. No averaging a fabrication fix against a regression.

## 6. DECISION RULES (pre-committed, so the outcome doesn't get argued after the fact)
1. **Verdict BETTER →** does NOT mean swap immediately. It means: schedule the model swap as its own phase on `core-slots`, with full re-run of the Phase 2 proofs (gate fail-direction, INOPERATIVE fail-loud, flag render, tag-leak, prose rule on-lot) against Fable 5. If the fabrication is reliably gone, RE-PRIORITISE the two-pass build (possibly demote it) — but only after the swap is validated end-to-end. Pricing delta from Step Zero feeds this decision.
2. **Verdict UNCHANGED →** stay on Opus 4.8, two-pass keeps its banked-last slot, branch deleted, finding logged.
3. **Verdict WORSE →** stay on Opus 4.8, finding logged, revisit at next model generation.
4. In ALL cases: Phase 3 (floor framing) remains the gate to production and is not blocked by, or sequenced behind, this probe. The probe is parallel work, not the critical path.

## 7. WHAT THIS PROBE DOES NOT DECIDE
- Resolution re-tuning for Fable 5 (separate experiment, only if swap is scheduled).
- Re-licensing the lamp wording toggle (stays OFF).
- Haiku odometer model (untouched).
- Any merge or production question.

---
*MotorQuoter — Confidential — © Vincent Marmion 2026*
