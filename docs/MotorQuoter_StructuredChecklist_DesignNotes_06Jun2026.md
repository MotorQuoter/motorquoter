# MotorQuoter — Structured Checklist Redesign · Design Notes
*Started 06 June 2026 · the slot schema for the watertight + two-pass tool · NOT YET BUILT — design in progress*

## INPUT ARCHITECTURE (Vincent 06 Jun — the SalvageIQ-competitive UX, recalled)
Goal: reduce user actions vs SalvageIQ. User uploads the Copart DESCRIPTION (paste) + a ZIP of photos; MQ PARSES the description to auto-populate the boxes — "user uploads, MQ does the rest". (Client-side only, no scraper, zero Copart-side footprint — the locked architecture.)
- **VRM:** starred on Copart; user double-clicks to reveal, pastes it; MQ fetches DVLA identity off the VRM.
- **VIN:** DROPPED — no MQ VIN check. DVLA doesn't return it; Copart stars it behind login and does NOT photograph the plate (confirmed across 4–5 lots), so there is no physical VIN to compare against. The only VIN signal kept = Copart's OWN disclosure of an obscured/missing/replaced VIN on theft-recovered lots, read from listing text (no user action).

## THE CORE STRUCTURE
A parts list is NOT a flat list — it is a set of **slots tied to damage zones**, each forced to a verdict.

**Two layers:**
1. **Universal CORE slots** — checked on EVERY lot regardless of damage (always-relevant or commonly-missed). Forced verdict on each. Includes: identity/VIN, mileage/dash, run-drive, airbags (per seat/curtain), **EACH wheel + EACH tyre individually** (the tyre-drop fix), glass (screen/each window/lamps-as-glass), interior/seats, **dash warning lights**, fluid leaks. "No damage to X" is itself information — forcing the verdict stops silent omission.
2. **Damage-zone MODULES** — triggered by primary/secondary damage descriptor + photos. Each zone is its own slot checklist (frontal / rear / side / multi-corner-rollover / underside; water/flood / fire / vandal / theft-recovered / mechanical-electrical). Lots can combine several. **HAIL: DE-SCOPED (Vincent 06 Jun) — very rare in the UK, not worth a module unless one ever turns up.**

**THEFT-RECOVERED / INTERRUPTED-STRIP MODULE (Vincent 06 Jun — outline):** triggered by theft-recovered descriptor OR theft-strip evidence flag in CORE. NON-collision pattern — often no impact/body damage at all. Slots (each forced verdict, CUT-vs-unclipped is the through-line):
- Engine / transmission — present / disturbed / part-removed (cut mounts, disconnected)
- Wiring looms / plugs — intact / CUT / snipped (THE signature)
- Hoses / pipes — intact / cut
- ECU / immobiliser / fuse box — present / tampered
- Airbags / steering wheel / dash modules — present / removed (common theft targets)
- Catalytic converter — present / cut out (very common)
- Wheels / seats / infotainment — present / removed
- Battery — present; on EV, HV components (a part-stripped EV is especially nasty)
Diagnostic principle: CUT/violent disconnection = theft fingerprint → infer harness damage throughout, not just visible point.

## SLOT GRANULARITY — DECIDED: COMPONENT-LEVEL
Each component is its own slot (slam panel, crash beam, cooling pack — separate), NOT grouped assemblies. Rationale:
- **Accuracy** — each component forced to its own verdict; nothing hides inside an assembly.
- **Two-pass** — component disagreements are sharp and LOCATABLE ("crash beam: P1 replace vs P2 undamaged" → flag THAT part). Assembly disagreements are mushy.
- **Forced completeness** — each component is a mandatory roll-call slot; can't collapse three parts into one vague line and drop two.
- **Cost accepted:** more slots/verdicts — the right trade for a watertight tool.
- **Refinement:** component-level UNDER THE HOOD (granular slots, granular two-pass), but GROUP for display readability ("Front carrier area: slam panel (replace), crash beam (replace), cooling pack (inspect)"). Granular rigour, clean presentation.

## SLOT SCHEMA (each component slot)
```
Slot:    [canonical part name — SAME string every time, both passes]
Verdict: damaged / undamaged / not-visible        (FORCED — must answer)
Action:  replace / repair / inspect / none         (forced if damaged)
Confidence: visible / inferred / hidden / CORROBORATED
Corroborating light: [linked warning light, if any]
```
Canonical slot names (not free text) are what let the two passes compare — "Headlamp LH" always "Headlamp LH", never "driver's side light" on one pass.

## WARNING LIGHTS AS CORROBORATION (Vincent's design — key)
Dash warning lights are NOT a separate report section — they are EVIDENCE that resolves/upgrades the component slots.
- **Light SEEN + matching damage zone → upgrades slot to CORROBORATED, hardens verdict.** E.g. coolant/temp light + frontal → cooling pack damage CONFIRMED not just inferred. Airbag light + frontal → restraint system implicated. ABS/brake light + corner → wheel-speed sensor/hub that corner. EV battery/charge warning + frontal → HV/charging flag (big-money). Power steering light + frontal → rack/pump/sensor.
- **Light SEEN but UNEXPLAINED by visible damage → flags HIDDEN damage beyond the photos.** The high-value catch: the dash telling you what the panels aren't. Drivetrain/battery warning with no visible cause → "damage the photos don't show — inspect/budget."
- **CRITICAL ASYMMETRY:** light SEEN = strong corroboration; light NOT seen ≠ proof of absence (car may be "ignition on" not "engine running", cluster not booted). An absent light NEVER downgrades a slot or rules damage out — only ADDS confidence or RAISES flags, never subtracts. Keeps it watertight: never talk a buyer OUT of caution because a light happened not to be lit.
- **UNCORROBORATED light → WHATSAPP QUESTION (Vincent — closes the loop).** A warning-light analysis feeds TWO outputs: slot confidence AND the inspection checklist. Three cases:
  1. Light SEEN + EXPLAINED by visible damage → corroborate slot, harden verdict. No question needed (explained).
  2. Light SEEN + UNEXPLAINED by visible damage → red flag AND a TARGETED WhatsApp question ("cluster shows [X] warning with no visible cause — ask handler to confirm cause and check for [system] fault codes"). The high-value catch: tool spotted it, can't see why, sends the inspector after it.
  3. Light SEEN + cluster partially readable/ambiguous → WhatsApp question for a clear full-cluster photo in READY/running state.
  This makes the light analysis ACTIONABLE not just descriptive: see it → try to explain it → if explained harden the verdict, if not send the inspector. A light one pass saw and the other didn't = uncorroborated → auto-generates the "get a clear cluster photo" question (two-pass disagreement becomes an inspection item, exactly as intended).
- **Two-pass on lights:** the light read is itself a slot both passes fill ("coolant light: present/absent/cluster-not-readable"). Both agree light on → high-confidence corroboration. Passes disagree on a light → flag the cluster for a clear inspection photo (a light you can't reliably read is worth confirming).

## TWO INPUTS NEEDED FROM VINCENT (his trade knowledge) — per damage zone
1. **Component slots** — impact-path order (outside-in), every component that CAN be implicated, each tagged: ALWAYS implicated (mandatory-verdict slot) vs SOMETIMES (conditional, with trigger note), + typical action (replace/repair/varies). No pricing — that's a separate layer.
2. **Warning-light → component map** — which lights corroborate which component slots; which lights (if unexplained) signal hidden damage. Runs both directions: component→its corroborating light, AND light→likely components given zone.

## BUILD ORDER
Frontal module FIRST (most common ~50% of salvage; where the engine already wandered on BL75JAU). Produce frontal completely (both inputs) → build slots + two-pass + forced completeness end-to-end on frontal → PROVE the whole pipeline → then other zones against the proven template. Do NOT spec all 11 zones before building one.

## STATUS
- Schema: component-level, forced verdicts, warning-light corroboration — DECIDED.
- Awaiting: Vincent's FRONTAL component list (impact-path order, always/sometimes, typical action) + frontal warning-light map.


## WHATSAPP LIST — OPERATIONAL CONSTRAINTS & ORDERING (Vincent — 06 Jun)
Operational reality: ~10-minute slot, operator may be reluctant to crawl under the vehicle (wet day etc.). So the WhatsApp list is NOT a dump of every forced-inspect slot. EVERY inspect slot still gets a verdict IN THE REPORT; the WhatsApp list is a CURATED, RANKED subset — only the questions that change the bid decision.

**Ordering: TWO-TIER, not a single sort** (resolves the tension between "most-decisive-first" and "easy-first"):
- **Tier 1 — standing/ground-level checks, importance-ranked within tier.** Done on feet, no crawling: cluster/warning lights, engine start, panel gaps/shut lines, struck-corner wheel position in arch (standing), visible HV cabling, lamp apertures. FIRST because they'll actually get done.
- **Tier 2 — under-car/awkward checks, importance-ranked within tier, CLEARLY MARKED as the decisive-but-awkward ones.** Chassis legs from below, subframe, suspension arm from underneath. LAST because they may not happen — but on the list and flagged as priority-among-the-hard so a willing operator (or dry day, or high value) knows what to push for.
- **No hard cap** — the two-tier structure self-manages length by front-loading what gets done.

**KEY PRINCIPLE — standing proxy for an under-car check (Vincent's trade knowledge):** where a standing check can SUBSTITUTE for an under-car one, lead with the standing proxy. THE example: **a struck front wheel pushed back / not sitting square in the arch is pretty much a DEFINITE for chassis/structural damage** — so the operator does NOT need to go under the car for the single most valuable structural signal; he photographs the wheel position in the arch from standing. Lead the list with "photograph the struck wheel square-on in the arch — pushed back or central?" as a Tier-1 proxy that answers the Tier-2 chassis-leg question the operator might otherwise skip.

## CORE vs FRONTAL — TWO RESOLVED ITEMS (06 Jun)
- **Airbags:** covered by the CORE airbag slot (presence/deployment per seat/curtain). The frontal module just flags "frontal of this severity — confirm no deployment / no pending deployment cost." Not duplicated as a frontal slot.
- **Front suspension/steering, struck corner:** a CONDITIONAL frontal slot, triggered by wheel/tyre damage on that corner (shredded tyre / loaded wheel). Verdict forced when triggered. Linked to the displaced-wheel rule above: displaced/pushed-back wheel = near-definite structural → hardens the chassis-leg inspect slot AND generates the Tier-1 wheel-in-arch WhatsApp proxy.

## FRONTAL MODULE — COMPONENT SLOTS (Input 1, Vincent 06 Jun — DRAFT, locking)
Impact-path order, outside-in. Side-dependent = struck side on single-corner, BOTH on full-width (drive off damageSpan, same as existing lamp geometry).

*Outer / bolt-on (visible):*
- Front bumper cover — ALWAYS — replace
- Bumper carrier / brackets — ALWAYS — replace
- Grille — Sometimes (bumper area pushed in) — replace
- Fog lamps — Side-dependent (if bumper involved) — replace
- Parking sensors / ADAS camera/radar — ALWAYS if bumper goes (recal cost) — replace + recalibrate
- Headlamp(s) — Side-dependent — replace
- Front wing(s) — Side-dependent — repair/replace
- Bonnet — NEARLY ALWAYS — REPLACE (default). Trade logic: big flat panels are hard to repair to a satisfactory standard and a bad repair is easily noticed. GENERALISES → large flat panels (bonnet, tailgate, doors, roof) default REPLACE; repair only if damage genuinely minor/edge.
- Windscreen — Sometimes (impact transmits up / bonnet lifts into it) — replace
- Front undertray / splash guard — Sometimes (displaced on most frontals) — replace

*Cooling:*
- Radiator / cooling pack — Sometimes; ALWAYS on full-width — replace
- A/C condenser — Sometimes (ahead of rad, often goes with pack) — replace
- EV cooling / HV circuit flag — if EV + frontal (front cooling serves battery) — inspect

*Structural — FORCED INSPECT SLOTS (verdict forced every time, usually inspect):*
- Crash beam / bumper reinforcement bar — ALWAYS-CHECK — inspect (replace if bent)
- Slam panel / front carrier (rad support panel) — ALWAYS-CHECK — inspect (replace if deformed)
- Bonnet slam panel / upper tie bar — ALWAYS-CHECK — inspect
- Chassis legs / front rails — ALWAYS-CHECK (the Cat S trigger, the value-killer) — inspect (jig if any doubt); displaced-wheel proxy via WhatsApp Tier 1
- Engine / powertrain alignment — ALWAYS-CHECK on a hard frontal — inspect. Verdict: engine/drive unit seated & square, OR disturbed/pushed-back/misaligned. Disturbed = energy carried PAST the crash structure into the drivetrain → HARDENS the chassis-leg/subframe inspect slots (they're tied together) AND on an EV flags the HV drive unit/inverter (HV-money). Engine mounts roll INTO this slot (the mechanism, not a separate slot). Corroborated by drivetrain/EPC/EV-powertrain-fault lights.

STILL TO CONFIRM with Vincent: bonnet typical action (repair vs replace default); then Input 2 = frontal warning-light map.


## TWO DESIGN PRINCIPLES (Vincent 06 Jun)
- **Large flat panels default to REPLACE.** Bonnet/tailgate/doors/roof — hard to repair invisibly, bad repair shows. Model should carry this reasoning (not just the default) so it reasons correctly across all big flat panels. Repair only flagged when damage is genuinely minor/edge.
- **Granularity line — slots stop at "meaningful independent cost or structural/safety verdict".** Below that line (bonnet hinges, wiper arms, scuttle trim, washer jets, clips, small brackets) → rolls into labour/sundries allowance, NOT its own slot. Forcing verdicts on trivia bloats the list and fails the £8.99 test. THIS IS THE ANTIDOTE to the over-granular leak seen 05 Jun (model minting a "headlamp washer/brackets/clips" line and attaching a bogus £350): trivia gets no slot, no figure, lives in sundries.


## PROVENANCE CONTRADICTION DETECTION (Vincent 06 Jun — cross-cutting, not zone-specific)
Origin: Vincent walked away from a 2025 low-mileage Renault Clio EV, Cat U, "runs and drives", NO visible damage, but an illuminated dash warning (a car-outline-with-vertical-red-line = Renault electrical/vehicle master fault; on an EV ambiguous between trivial 12V/comms and major HV). The light was the thread — but the REAL reason to walk was the CONTRADICTION: a warranty-age, undamaged, low-mileage car should be fixed under warranty, not salvaged. Its mere PRESENCE in the auction means something doesn't add up.

**Principle:** when the STORY doesn't hold together — a car too new / too clean / too low-mileage to plausibly be in salvage — that incongruity is ITSELF a red flag, independent of any single light. The tool has the data to detect it (year, mileage, category, damage descriptor, visible damage, warranty-age).

**Trigger cases:**
- Cat U / Cat N / "runs and drives" + very low mileage + warranty-age + no/minimal visible damage → FLAG: "Why is this in salvage? An undamaged warranty-age car being salvaged suggests a fault the warranty wouldn't cover or that the owner/insurer chose not to pursue — most often an expensive electrical/HV/water-ingress issue. The absence of visible damage is NOT reassurance — it is a question. Interrogate hardest."
- Especially on an EV: the expensive, warranty-disputed, photo-invisible failure modes (HV pack, water ingress to HV, charging system) are exactly what make an otherwise-perfect car uneconomic to repair → pushed to salvage.
- Cat U specifically: the category where "why is it here?" bites hardest (no obvious damage story to explain the write-off). The category is itself a clue.

**Why high £8.99-value:** it's the INVERSE of itemising damage — spotting that the LACK of damage is the warning. Novice sees "2025, low miles, runs/drives, no damage — bargain!" and bids. The 40-yr eye sees the trap. The tool must carry that instinct: **a salvage car that looks too good is the one to interrogate hardest.** Pairs with an unexplained warning light → strong walk-away signal.

(Note: exact Renault tell-tale symbol meaning not confirmed from memory — if precise wording wanted, look up against Renault's tell-tale glossary. Functionally: ambiguous EV electrical/master fault → flag + send for fault codes, do not resolve remotely.)


## WINDSCREEN STICKER SUFFIX → PROVENANCE SIGNAL (Vincent 06 Jun — feeds contradiction detection)
The Copart windscreen sticker lot-number SUFFIX encodes vendor type and sharpens the "why is it here?" provenance flag.

**CONFIRMED (used consistently across all this session's reports):**
- **X suffix = insurance company vendor** (low-value category). Treated as a POSITIVE for mileage trust (insurer-entered, no clocking concern) — the "normal" salvage route.

**CONFIRMED (Vincent's trade knowledge — authoritative):**
- **X** = insurance company, LOW value
- **P** = insurance company, HIGH value
- **C** = private or trade entry
- **Q** = Copart or webuyanycar entry

**How they feed contradiction detection:**
- **X / P = explained provenance** (insurer write-off — the normal salvage path). A car here because an insurer wrote it off is EXPLAINED.
- **C / Q on a too-clean / low-mileage / warranty-age car = SHARPEN the flag HARD.**
  - C (private/trade): why did a private owner/trader put a faultless newish car into salvage rather than sell normally or claim warranty? Suggests a problem blocking normal sale.
  - Q (Copart/webuyanycar): the LOUDEST "why is it here?" — bypasses BOTH the insurer route AND normal resale. A clean low-mileage car on the Q-route = someone took the quick-cash exit on an expensive problem. **Q on a clean EV + warning light = the Clio pattern = strong walk-away.**

**The PRINCIPLE (sound regardless of exact letters):** certain suffixes indicate NON-insurer origin (trade-in, finance return, manufacturer buyback, etc.). A clean, low-mileage, warranty-age car carrying a NON-insurer suffix is MORE suspicious, not less — it bypassed the normal insurer write-off route, sharpening "why is it here?". A manufacturer buyback or finance return on a faultless-looking car especially signals "a problem someone chose not to own". Combined with an unexplained warning light + warranty-age + no visible damage → strong walk-away.

Origin example: the walked-away Renault Clio EV — Vincent recalls it mattered whether the suffix was C or Q (exact suffix not remembered). Confirm the Copart suffix glossary and map each to insurer / trade / finance / manufacturer / other, then wire the non-insurer suffixes into the provenance-contradiction flag.


## WHATSAPP OPERATOR CAPABILITY CONSTRAINT (Vincent 06 Jun — reshapes the warning-light design)
The WhatsApp inspection operator:
1. Has **NO code-reading equipment** — only what shows on the dash itself.
2. Some **won't / can't be bothered to press buttons** to cycle menus/sub-readouts to surface codes.

**Implications — the warning-light WhatsApp questions must ask ONLY for what's obtainable:**
- **CAN reliably get:** a photo of the cluster AS IT SITS — whatever lights are illuminated on power-up/READY without touching anything. Realistically that's it for the unequipped/unwilling case.
- **MIGHT get if willing:** ignition cycle, engage drive, trip-computer scroll — NOT reliable.
- **CANNOT get:** OBD fault codes, module diagnostics — anything needing a reader.

**So:** rewrite all warning-light questions to "photograph the full cluster on power-up showing all illuminated lights" (achievable) — NEVER "retrieve the fault codes" (not achievable). The report must be HONEST that **codes cannot be read at WhatsApp inspection** — if codes are needed to resolve a flag, that is a POST-PURCHASE diagnostic risk the buyer carries, not something the £10 inspection clears. Material for the bid: a fault that CANNOT be diagnosed before sale is a bigger risk than one that can.

**Reinforces provenance logic:** if the operator can't read codes, an ambiguous EV warning (the Clio's) CANNOT be resolved before bidding → the only safe response to "clean car + unexplained light + Q/C suffix" is walk away OR bid as if the worst is true, because there is no way to find out which in time. The tool should say this plainly.


## CORE SLOT SPEC (every lot, every slot forces a verdict — Vincent 06 Jun)
DECISION: every CORE slot forces an explicit verdict on every lot (fully watertight). Rationale: forced verdict makes two-pass comparison valid on CORE too — a slot that can silently collapse means one pass might omit it and you can't tell "checked & agreed" from "didn't check". Internal = every verdict forced (audit trail + two-pass). Display = all-clear slots GROUP into a confirmation block ("Verified clear: glass, leaks, interior, airbags") — forced under the hood, readable on the surface.

CORE differs from a damage module: a module fires only when its zone is hit and asks "what's damaged?". CORE fires on EVERY lot and establishes the BASELINE TRUTH of the car (identity, mileage honesty, what runs, what's intact) BEFORE any damage reasoning. CORE verdict shape is often confirmed / unconfirmed / DISCREPANCY (corroboration + contradiction flagging), not damaged/undamaged.

### A. IDENTITY & PROVENANCE
- **VRM / plate match** — plate vs listing/V5. Verdict: confirmed / mismatch-flag.
- **VIN — DROPPED ENTIRELY (Vincent 06 Jun, empirically confirmed).** The comparison check (Copart documented VIN vs physical photo plate) is DEAD because one side doesn't exist: Vincent checked 4–5 real Copart lots — there is NO photo of the VIN plate on any of them. Copart stars the VIN behind login (it's sensitive — enables cloning/HPI); they would not then publish it in a public photo. So there is no physical VIN to compare against → no check possible. Removed entirely (no-stopgaps: don't keep a half-feature that can't fire). NO VIN slot.
  WHAT SURVIVES = **Copart's OWN VIN disclosure** (read from LISTING TEXT, no photo/paste needed): on theft-recovered lots Copart states if the VIN is obscured/missing/replaced (ethically/legally bound). That is the real VIN-related provenance signal — surface it as a provenance flag. User does nothing; tool reads Copart's disclosure.
- **Make/model/derivative/body-style** — confirmed from photos. Includes the 3-door vs 5-door check (has wandered). Forced explicit body-style verdict.
- **Vendor suffix** — X=insurer low / P=insurer high / C=private-trade / Q=Copart/webuyanycar. Feeds provenance-contradiction.
- **Category** — S/N/U etc. from salvage data. Drives exit band. (Code-owned, not model-narrated.)
- **Provenance-contradiction check** — "why is it here?" flag: too-clean + low-mileage + warranty-age + C/Q suffix → interrogate. (See cross-cutting principle.)

### B. MILEAGE & HISTORY
- **Odometer reading** — dash photo (Haiku pre-pass).
- **Mileage corroboration** — dash vs listing vs MOT ladder vs salvage record. Verdict: corroborated / discrepancy / uncorroborated. Clocking flag in NO-ACCUSATION language (factual: "mileage X on dash does not match MOT record Y — verify").
- **MOT history** — DVSA integration (worked on the Juke: advisories/fails correlated to current damage; same-day fail/pass caught; front-item-vs-rear-impact distinction). Forced summary + correlation verdict.
- **Salvage history count** — code-derived, EXCLUDING the lot's own record (the 05 Jun fix). Verdict: N prior events (N excluding self).
- **Service history — NOT a model slot. ALREADY LIVE as an app data feature (confirmed 06 Jun).** The app has a Service History field/checkbox driven by One Auto API's OE Service History endpoint (returns date/mileage/dealer/type records; shows "No digital service history on record" when none). Gated to full-coverage makes via SERVICE_HISTORY_COVERAGE map; user-selected add-on (~£5) in the build-your-own menu. So: model NEVER infers service history (no reliable photo source → would be guessing); the USER obtains it via the existing live checkbox, sourced from One Auto. Discipline holds: data feature owns it, model doesn't touch it. (Cambelt-due surfacing would depend on whether the OE records expose it — a per-make data question, not a model task.)

### C. RUNNING & DRIVETRAIN
- **Run/drive status** — Copart descriptor + dash corroboration (READY/started/D engaged).
- **Keys present** — yes/no (affects inspection feasibility + value).
- **Dash warning lights** — full corroboration system, EVERY lot (see warning-light section). Operator-capability constraint applies (cluster photo only, no codes).

### D. PHYSICAL — COMMONLY-MISSED FORCED SLOTS
- **Each wheel + each tyre INDIVIDUALLY** — the tyre-drop fix. Copart NORMALLY photographs each wheel, so the model usually HAS a per-wheel image → per-corner verdicts are ACHIEVABLE from the standard photo set (granularity question resolved: separate per-corner verdicts, driven by the per-wheel photo). Per corner: wheel (intact/kerbed/damaged/not-shown) + tyre (intact/damaged/destroyed/not-shown). **If a wheel photo is INCOMPLETE or MISSING → verdict "not shown — confirm on inspection", NEVER a guess** (a missing wheel photo is INFORMATION = "Copart didn't show this corner, check it", not an absence to paper over). Anti-guessing spine: say what photos show, flag what they don't, never invent.
- **Glass** — windscreen + each side window + rear screen + sunroof. Forced (cracks missed otherwise). NOTE: on ADAS-equipped cars the windscreen carries the forward camera → screen replacement triggers ADAS RECALIBRATION cost (a real cost novices miss). Glass slot flags this when screen is replace.
- **Airbags** — deployed / not-deployed / not-visible, per front + curtain + seat. Frontal & other modules REFERENCE this slot (not duplicated).
- **Interior / seats** — condition; water-line / flood signals; fire/smoke signals; trim damage.
- **Spare wheel (Vincent: slot it)** — verdict: full-size / space-saver / none / NOT-CONFIRMED-in-photos. CRITICAL: under boot floor, rarely photographed → not-visible ≠ missing; honest default "not confirmed, check on inspection", NEVER a false "no spare" flag. Feeds WhatsApp as a Tier-1 STANDING check (lift boot floor — easy).
- **EV battery state-of-health (Vincent: MENTION ONLY, not a slot)** — the dominant EV value factor BUT unreadable from photos/WhatsApp (needs BMS diagnostic). A forced slot would be false precision. Mention: "battery SoH is the biggest EV value determinant and CANNOT be assessed pre-purchase — material unknown; on any EV with front/underside impact or flood/fire exposure assume potential HV degradation in the bid." Ties to the surface-deceptive spine (unquantifiable-pre-purchase risk).
- **Theft-strip evidence (Vincent 06 Jun)** — verdict: present / absent / suspected. The theft-recovered signature: CUT wiring plugs/looms, cut hoses, partially-removed major components (engine/trans, ECU, airbags, cat, wheels, infotainment). KEY DIAGNOSTIC = CUT vs UNCLIPPED: factory/repair disconnection is clean (unclipped/unbolted); theft disconnection is VIOLENT (cut/snapped/snipped). Cut wiring = fingerprint of an interrupted theft → signals loom/harness damage THROUGHOUT (thieves work fast & rough), not just at the visible point. HIGH-VALUE + invisible to a novice: a hacked main loom or part-pulled harness is four-figure on its own; ECU/immobiliser theft damage makes recommissioning a nightmare. Ties to "looks too good" — theft-recovered cars often have NO collision damage, run, look clean → the cut-loom evidence explains why it's in salvage. If present/suspected → activate the Theft-Recovered MODULE.
- **Fluid / contamination — RECAST (Vincent: do NOT read puddles).** Salvage vehicles have been in an incident some time ago, recovered, transported, sat in a yard for weeks — ANY active leaking has long since completed. Puddles/dark spots under the car are UNRELIABLE (rainwater, AdBlue, screenwash, AC condensate, recovery coolant, or a stain the previous car left on the bay) → reading them as "leak/mechanical concern" is a FALSE-POSITIVE generator and erodes report credibility with knowledgeable buyers. RULE: never infer leaks from ground puddles/spots on a recovered salvage lot. What IS informative = fluid ON COMPONENTS in the bay (coolant/oil thrown across the bay by impact) and visibly damaged fluid sources (cracked coolant tank, split rad, damaged oil pan) — but those are DAMAGE EVIDENCE belonging to the relevant module (e.g. cooling pack → frontal), not a CORE "leak" verdict. So: CORE slot recast to "visible fluid contamination on components" (corroborates impact severity + points to damaged component), OR removed entirely. Ground-puddle inference is OUT.

### CORE → WHATSAPP & TWO-PASS
- High-value CORE discrepancies (mileage mismatch, VIN concern, provenance contradiction, unexplained warning light) feed the WhatsApp list under the same two-tier ordering (standing checks first).
- Every CORE slot is a comparable value across the two passes; CORE discrepancies that the passes DISAGREE on auto-flag for inspection.

STATUS: CORE spec drafted to frontal-level depth. Awaiting Vincent review/correction, then CORE is the FIRST build (slot engine + CORE slots), validated, THEN frontal as module one.


## ★ THE SURFACE-DECEPTIVE PRINCIPLE (Vincent 06 Jun — the SPINE of the tool's value)
The worst salvage buys are those where SURFACE CONDITION and TRUE COST are INVERSELY related — the car looks great/near-undamaged outside and is a nightmare underneath. A novice prices on what he sees; the money is destroyed by what he can't. The tool's HIGHEST value is NOT itemising a smashed bumper (the buyer can see the bumper) — it's flagging the cars where "EASY FIX" IS THE TRAP. That is what 40 years tells you and a photo does not.

**The surface-deceptive class (share a signature):** rodent damage, water/flood, theft-strip (partly), provenance-fault (Clio-type). All share:
- Surface-deceptive (looks easy/clean)
- DIFFUSE, non-localised damage — can't scope from photos OR fully at WhatsApp inspection
- Loom + MODULE damage → **the reprogramming/coding cost multiplier**: a s/h module must be SPECIALIST-reprogrammed/coded to THAT vehicle (VIN-matched, immobiliser-paired) — the part may be cheap, the coding is not, sometimes dealer-only. NOVICES NEVER PRICE THIS.
- Often gets WORSE after purchase (corrosion progresses; full extent unknown until you dig in).

**Correct OUTPUT for surface-deceptive lots = a WARNING, not a repair estimate.** The tool CANNOT scope these from photos and NEITHER CAN the WhatsApp inspection (operator can't pull looms or test modules). So: "this is a surface-deceptive category — visible condition is NOT the cost; loom/module/reprogramming exposure is high and UNQUANTIFIABLE pre-purchase; treat as high-risk, bid only with deep contingency or walk away." HONEST > false precision. Pairs with provenance "why is it here?" and the aged-incident/not-live-fault principle.

### RODENT-DAMAGE MODULE (Vincent 06 Jun — genuine write-off category)
- Surface: pristine, runs, looks a bargain. Underneath: chewed looms, gnawed insulation, severed sensor wires, nests (bulkhead / airbox / under-dash). Damage is wherever the rodent travelled → DIFFUSE, unscopeable from a photo.
- Cost: complete loom replacement (enormous on a modern car) + module damage → module replacement + SPECIALIST REPROGRAMMING (the hidden killer).
- Verdict: cannot scope from photos/inspection → high-risk warning, deep contingency or walk.

### WATER / FLOOD MODULE (cousin of rodent — same shape)
- Looks recoverable; water into modules, connectors corrode over MONTHS (gets worse after purchase) → same module-replacement + reprogramming nightmare. Water-line in interior = CORE signal; full extent unquantifiable pre-purchase. Same high-risk warning output.


## ★ THE "RUNS AND DRIVES" TRAP (Vincent 06 Jun — the psychology under the surface-deceptive class)
The reasoning error that catches buyers (and could catch the MODEL if not told otherwise): *"It runs and drives, dash shows READY, it started — how bad can it be?"* Answer: VERY bad. On a surface-deceptive lot "runs and drives" is WORTHLESS as reassurance, because the damage in those categories does NOT stop the car running:
- Rodent-chewed loom: still starts/moves until the unseen chewed circuit (ABS/airbag/body module) surfaces or damaged insulation shorts later.
- Flood: runs fine the day recovered — corrosion kills modules over MONTHS.
- Theft-strip (incomplete): runs — but hacked harness + tampered immobiliser remain.
- Electrical/provenance fault (the Clio): ran and drove perfectly WITH a warning light hiding an unknown EV fault.

"Runs and drives" = a POINT-IN-TIME, SURFACE check that says nothing about DIFFUSE or PROGRESSIVE damage. It is ACTIVELY DANGEROUS as a signal because it gives false comfort on the exact car the buyer should most suspect.

**Encode two ways:**
1. **Do NOT weight "runs and drives" as reassurance on surface-deceptive categories.** On a COLLISION lot it's a mild positive (drivetrain probably OK). On rodent/water/theft/electrical lots the tool must COUNTER the instinct explicitly: *"'Runs and drives' does NOT reassure here — this category's damage (loom/module/corrosion) doesn't prevent running and will surface or worsen after purchase. Do not let running status lower your risk assessment."*
2. **It COMPOUNDS the provenance flag.** runs+drives + clean surface + warranty-age + C/Q suffix = the FULL trap. Every surface signal says bargain → that is exactly when "why is it in salvage, then?" should scream LOUDEST. Running status doesn't resolve the contradiction, it DEEPENS it (less obvious reason to be in salvage → more likely the reason is an expensive invisible one).

(NOTE — Vincent 06 Jun: do NOT add a "runs/drives is aged/stale" caveat for COLLISION cars. If it ran a month ago, nothing material changes sitting in a yard except a flat 12V battery / surface disc rust — the drivetrain doesn't degrade static. A month-old yard run/drive IS a reasonable signal on a normal collision car. The "runs/drives means nothing" point applies ONLY to surface-deceptive lots, where the hidden loom/module damage was never about whether it runs — different issue.)


## FIRE-DAMAGE MODULE (Vincent 06 Jun — surface-deceptive, but LOW FREQUENCY now)
**Technical (worst of the surface-deceptive class — "ALWAYS worse than they look"):** even a contained engine-bay fire sends heat + smoke everywhere:
- HEAT degrades wiring insulation, melts connectors, warps plastics/seals well beyond the visible burn — and heat-damaged wiring fails LATER, intermittently (nightmare to diagnose).
- SMOKE permeates the whole interior, HVAC, every soft surface — smell never fully leaves → kills resale on its own.
- SUPPRESSION (water/foam) layers the water/corrosion problem on top.
→ "one scorched panel" in photos can mean a car electrically + aromatically destroyed throughout. Same honest output: unscopeable, high-risk warning, deep contingency or walk.

**Market / build-priority signal (Vincent):** seeing FEWER fire cars in REPAIRABLE (S/N) auctions — more are going **Cat A (scrap, no parts) / Cat B (break for parts, shell crushed)** because once heat's through the loom/electronics the economic repair case collapses, so the honest category is A/B not S/N. CONSEQUENCE: the fire module is LOW-FREQUENCY in the lots buyers actually bid (Copart UK S/N). Keep it in the module list + the surface-deceptive warning MUST fire if a repairable one appears — but it is WELL DOWN the build queue. **Build order follows FREQUENCY in the actual lot stream: frontal (~50%) > rear > side > ... > fire (rare).**

## CORE — CATEGORY A/B BRANCH (Vincent 06 Jun)
If category is **Cat A** (scrap only, no salvage) or **Cat B** (parts only, shell destroyed/crushed), the tool's job CHANGES: there is NO repair prospect. Do NOT attempt a repair-cost / exit-value analysis on an A/B car (it legally can't be returned to road). CORE branch: S/N → full assessment; A/B → "non-repairable category — parts/scrap only, no repair assessment applies." (Buyers bid S/N, but guard against an A/B being pasted/searched so the tool doesn't earnestly cost a repair on a non-repairable shell.)


## WHATSAPP — GLOVEBOX / DOCUMENTS STANDING CHECK (Vincent 06 Jun)
Add a Tier-1 STANDING check: operator opens glovebox + does a quick cabin sweep and PHOTOGRAPHS the contents (no interpretation — operator-capability constraint: he shows, the assessment reads). Scope it broader than just service books:
- Service book / stamps (PHYSICAL history)
- V5 if present (ties to CORE V5-status)
- Receipts / repair invoices (repair-documentation raises salvage resale value — Vincent's earlier point)
- Locking wheel-nut key (small, but buyers value it; missing one is a real faff)
- Spare key

**Value is highest where it does NOT overlap the live digital feature:**
- NON-coverage makes — One Auto OE Service History returns nothing, so the physical book is the ONLY history → high value here.
- CONFIRMS the digital record — book matching digital = trust; book CONTRADICTING digital = flag.
- For full-coverage makes the digital record is the better (structured/verifiable) source; the book is confirmatory.
Tier-1 (easy, no crawling). "Photograph glovebox contents + any service book/paperwork" — never "summarise the history".
