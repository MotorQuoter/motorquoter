// lib/labour.mjs — CODE-OWNED labour model (batch 92/95).
// Authority: docs/LABOUR_SPEC_v1.md. Replaces the model-authored labour figure + the
// severity-ratio scaling (computeLabourRatio). Labour is a LOOKUP on severity + panel class + action —
// the same shape as HEADLAMP_BANDS. The £50/hr rate is DISPLAY ONLY; these figures are already all-in
// (labour + paint + materials). No rate×hours, no size multiplier, no repair/replace multiplier.
//
// SHAPE: labour = PANEL WORK + STRUCTURAL ALLOWANCE (two stacked pieces, not one scaled).

// ── §1 PANEL-WORK base table — bolt-on, all-in, by severity grade ─────────────────────────────
// MINOR surface scuff (metal not moved) · MODERATE genuine dent/crease repaired · SEVERE torn/crushed,
// replace + repaint (PART cost separate). One table for EVERY bolt-on panel whatever the size.
export const PANEL_WORK = { MINOR: 200, MODERATE: 700, SEVERE: 600 };

// ── §1+ WELDED/BONDED override — all-in INCLUDING the structure behind the panel ──────────────
// The set is EXACTLY these three; everything else is bolt-on. Keyed on panel class × action.
// Direction INVERTS vs bolt-on: for welded/bonded, REPLACE ≥ repair (cutting out + welding/bonding a
// new panel is the major job), whereas bolt-on has MODERATE(repair)£700 > SEVERE(replace)£600.
// Roof skin is BONDED (glue-on) on modern cars → £1,500 replace. Vincent ruled all three separately;
// do NOT normalise to one rule. MINOR on a welded panel stays base-table £200 (override is MOD/SEV only).
export const WELDED_LABOUR = {
  QUARTER: { replace: 800, repair: 800 },   // "repair or replace, not much difference"
  SILL:    { replace: 800, repair: 700 },   // replace > repair
  ROOF:    { replace: 1500, repair: 1000 }, // bonded; replace > repair
};

// panelId → welded class, or null (bolt-on). The welded set is exactly quarter / sill / roof.
export function weldedClass(panelId) {
  switch (panelId) {
    case 'REAR_QUARTER': return 'QUARTER';
    case 'SILL':         return 'SILL';
    case 'ROOF':         return 'ROOF';
    default:             return null;
  }
}

// Per-panel labour £ BEFORE flattening. severity ∈ MINOR|MODERATE|SEVERE; action ∈ repair|replace.
export function panelLabour({ panelId, severity, action } = {}) {
  const grade = String(severity || 'MODERATE').toUpperCase();
  const wc = weldedClass(panelId);
  if (wc && (grade === 'MODERATE' || grade === 'SEVERE')) {
    const act = String(action || 'replace').toLowerCase() === 'repair' ? 'repair' : 'replace';
    return WELDED_LABOUR[wc][act];
  }
  return PANEL_WORK[grade] ?? PANEL_WORK.MODERATE;   // bolt-on, or MINOR-welded (base table)
}

// ── §3 MULTI-PANEL flattening — per ZONE, dearest (by labour £) full, every extra at HALF ──────
// The car is in the booth once, masked once — the setup is shared. Each ZONE runs its OWN curve with
// its own full-price first panel (Vincent: "take the higher number") → flatten within zone, SUM zones.
// "Dearest" = by the labour-lookup £ (NOT part price) — so a MODERATE £700 outranks a SEVERE £600.
// panels: [{ zone, labour }]. Returns the flattened panel-work total (£, rounded).
export function flattenPanelWork(panels = []) {
  const byZone = new Map();
  for (const p of panels) {
    const z = p.zone || 'default';
    if (!byZone.has(z)) byZone.set(z, []);
    byZone.get(z).push(Number(p.labour) || 0);
  }
  let total = 0;
  for (const arr of byZone.values()) {
    arr.sort((a, b) => b - a);                         // dearest first
    arr.forEach((v, i) => { total += i === 0 ? v : v / 2; });
  }
  return Math.round(total);
}

// ── §5 STRUCTURAL ALLOWANCE — DEFAULT HIGH, no classifier ─────────────────────────────────────
// Covers engine-out, jigging for alignment, chassis repair. Vincent ruled: there is NO reliable body-type
// signal (descriptor labels SUVs "ESTATE"; revenueWeight and engine size both fail as size proxies), so
// ALWAYS use the HIGH band and flag it — the buyer adjusts down. Triggered by the photo TELLS (radiator
// support pushed back / wheel at an angle / A-pillar gap / bonnet not lining up). Its OWN range; the money
// takes ITS OWN top and is NOT re-ranged by §6's −15/+25 (that would double-count).
export const STRUCTURAL_BAND_HIGH = { low: 2300, high: 2500 };
export function structuralAllowance(tellsPresent) {
  if (!tellsPresent) return null;
  return { low: STRUCTURAL_BAND_HIGH.low, high: STRUCTURAL_BAND_HIGH.high, money: STRUCTURAL_BAND_HIGH.high };
}

// ── §5 SUPERSEDED — THE JIG FLOOR STATES ITS CEILING IN WORDS (batch 117 task 6) ────────────────
// Vincent, 11 Sep: "Jigging costs are nearly impossible to predict. I said from £500 up to 2 or 3k
// depending on the vehicle and the extent of the damage." So the batch-106 £500 floor STAYS in the money
// (a floor, never a hole) and the sentence carries the ceiling. The range lives in WORDS, not in a band
// the engine picks, because the 31 Aug no-classifier ruling stands: nothing in the data separates a
// larger vehicle (the descriptor calls SUVs "ESTATE"; revenueWeight fails as a size proxy).
// SINGLE OWNER of the sentence — the inspection flag (route.js) and the damage card (damageCards.mjs)
// both read it; validate-labour asserts the literal appears exactly once in source. Latin-1 only: the
// PDF's flag renderer drops en/em dashes, so the range is written "£2,000 or £3,000".
export const STRUCT_FLOOR_GBP = 500;
export const STRUCT_FLOOR_NOTE = `A floor of £${STRUCT_FLOOR_GBP} for jig/geometry work is included in the repair total. The true figure cannot be scoped from photographs: depending on the vehicle and the extent of the damage it runs from £${STRUCT_FLOOR_GBP} up to £2,000 or £3,000 on a heavier hit or a larger vehicle, and can only be quoted after inspection.`;

// ── §6 RANGE — PANEL WORK ONLY, −15% / +25%, SCALES; money takes the TOP ──────────────────────
// The spread is a PERCENTAGE of the panel-work total (not a flat sum). Money (margin, profit window,
// every bid ceiling) computes off the +25% top → effective labour = computed × 1.25. §4: the structural
// allowance is ALREADY a range as Vincent gave it — do NOT apply −15/+25 on top of it.
export const RANGE_LOW_PCT = 0.85;
export const RANGE_HIGH_PCT = 1.25;
export function panelWorkRange(panelWorkTotal) {
  const t = Number(panelWorkTotal) || 0;
  return { low: Math.round(t * RANGE_LOW_PCT), high: Math.round(t * RANGE_HIGH_PCT), money: Math.round(t * RANGE_HIGH_PCT) };
}

// Combined labour money = panel-work TOP (+25%) + structural TOP. Both already at their tops (§4/§6).
// Floor stays elsewhere (zero surviving costed parts ⟹ zero panel work — the caller passes no panels).
export function labourMoney({ panelWorkTop = 0, structuralTop = 0 } = {}) {
  return Math.round((Number(panelWorkTop) || 0) + (Number(structuralTop) || 0));
}

// ── Q1/column ruling (Vincent 31 Aug) — TWO COLUMNS, money always takes NEW+PAINTED ───────────
// The report shows the buyer both sourcing routes for PANEL WORK; the money (margin/profit/ceilings)
// ALWAYS computes from the NEW+PAINTED total (the higher) — the buyer's choice never moves the bid.
//   NEW+PAINTED : every panel painted → flatten per zone across ALL panels (bolt-on base + welded).
//   SECOND-HAND : bolt-ons sourced colour-matched, ADDITIVE ~£170 each, NO flatten (unpainted);
//                 welded panels have NO s/h price → carry their welded figure, painted, and flatten
//                 AMONG WELDED ONLY (nothing unpainted joins that set). Part cost + structural allowance
//                 sit OUTSIDE both columns and are added once. −15/+25 applies to each column's panel work.
// panels: [{ panelId, zone, severity, action }]. Returns both columns' ranges + raw panel-work totals.
export function assembleColumns(panels = []) {
  const meta = panels.map((p) => ({ zone: p.zone, welded: !!weldedClass(p.panelId), labour: panelLabour(p) }));
  const newPaintedPW = flattenPanelWork(meta.map((p) => ({ zone: p.zone, labour: p.labour })));            // all painted, flattened together
  const welded = meta.filter((p) => p.welded);
  const boltOn = meta.filter((p) => !p.welded);
  const secondHandPW = flattenPanelWork(welded.map((p) => ({ zone: p.zone, labour: p.labour })))           // welded flatten among themselves
                     + boltOn.length * SOURCED_FINISHED_FIT;                                                // bolt-ons additive, no flatten
  return {
    newPainted: panelWorkRange(newPaintedPW),   // money drives the bid off THIS column's top
    secondHand: panelWorkRange(secondHandPW),    // display only
    panelWorkNewPainted: newPaintedPW,
    panelWorkSecondHand: secondHandPW,
  };
}

// ── BODY-PANEL set — which COST parts get panel-work labour ───────────────────────────────────
// The spec's base table + sourced-finished list + welded list are all about BODY PANELS. The engine's
// COST class also holds lamps, glass, grille, rad pack, slam panel, wheels, mirrors — parts with their
// OWN price whose fitting is clip-in/mechanical, not panel work. Panel-work labour applies ONLY to the
// body panels below; every other COST part carries its part cost and no panel-work labour.
// ⚠️ ASSUMPTION (flagged for Vincent): non-panel fitting labour is absorbed, not separately costed — the
// old model's single labour figure covered all fitting; this drops that portion (minor vs the structural
// allowance, which now dominates the movement). The replay per-lot table shows the net effect.
export const BODY_PANEL_LABOUR = new Set([
  'FRONT_BUMPER', 'REAR_BUMPER', 'FRONT_WING', 'REAR_QUARTER', 'FRONT_DOOR', 'REAR_DOOR',
  'BONNET', 'BOOT_LID', 'SILL', 'ROOF', 'SIDE_SKIRT',
  'BED_SIDE_L', 'BED_SIDE_R', 'DROP_TAILGATE', 'LOAD_BED',   // van / pickup body
]);
export function isBodyPanel(panelId) { return BODY_PANEL_LABOUR.has(panelId); }

// ── ONE OWNER: "is this row a labour / allowance line, not a purchasable part?" (batch 117) ────────────
// Vincent's AMZ3790 preview showed "SRS fitting" (a £300 FITTING OPERATION, batch-95 §10 rider) sold as a part
// on four surfaces — Visible Damage Summary, Key Cost Drivers, a Visible damage card, and an eBay "Find on
// eBay" link — because six places decided "labour?" by testing the row NAME against /labour|paint|prep/ and
// "SRS fitting" matches none of those words. Code-owned rows carry MARKERS; test those, so the next rider can't
// slip through the same way. The NAME test survives only for a MODEL-written labour line, which carries no
// marker ("Labour & paint", "Paint & materials", "Prep") — reconcile-time rows, before the code rows exist.
//   _codeLabour          — the code-owned panel-work line ("Labour & paint (new & painted)")
//   _srsFitting          — the SRS airbag fitting rider (spec §10)
//   _structuralAllowance — the structural allowance line (spec §5; dormant while withdrawn)
//   _structFloor         — the £500 jig/geometry FLOOR (batch 106): costed, but not a part anyone can buy
// NOT for the money: every one of these rows stays in the Parts Breakdown and parts_sum.
export const MODEL_LABOUR_NAME_RX = /labour|paint|prep/i;
export function isNonPartRow(row) {
  if (!row) return false;
  if (row._codeLabour || row._srsFitting || row._structuralAllowance || row._structFloor) return true;
  return MODEL_LABOUR_NAME_RX.test(row.name || row.partName || '');
}

// ── §1 + §2 — THE GRADE OWNS REPAIR-VS-REPLACE, AND A REPAIR CARRIES NO PANEL (batch 116) ─────────
// Vincent, 11 Sep, from a live paid report (SD72HXH: two doors creased, graded MODERATE, charged a new door
// each ON TOP of the panel work): "Fix this duplication of parts and repair." Spec §1: MODERATE = "genuine
// dent or crease, repairable", £700 ALL-IN (labour + paint + materials); "On SEVERE the PART cost is
// separate" — on SEVERE only. Spec §2 / EO-12: "the severity grade already encodes it: MODERATE = repair,
// SEVERE = replace". So for a BOLT-ON body panel that earns panel-work labour:
//   MINOR / MODERATE → action 'repair', NO part cost (the all-in panel work IS the cost of that panel);
//   SEVERE           → action 'replace', part cost kept (as now).
// The model's action word no longer decides money — one owner, the grade.
// batch 127 — THE WELDED THREE (quarter / sill / roof) FOLLOW THE SAME OWNER. Vincent, 14 Sep: "Very rarely would
// someone use a s/h weld on part so no s/h column needed and new weld in needs a cost." · "Repair = labour
// only, no panel — yes." · "Same treatment for welded — yes." (spec §1 + §2). For a welded panel:
//   MINOR / MODERATE → action 'repair', NO part (labour only — the panel already on the car is beaten and filled);
//   SEVERE           → action 'replace', the part priced at NEW: money reads `oem`, never `used` (there is no
//                      second-hand weld-in panel). `used` is cleared so every `used ?? oem` reader (parts_sum,
//                      VDS, KCD, damage cards, sourcing) takes the new figure; the used figure stays for audit
//                      in _weldedAtNew. A welded row with NO `oem` keeps its figure (_weldedNoNewPrice) — the
//                      ruling reads the new column; an absent new column is not a ruling to price the part at £0.
// ⛔ NOT £0-rule rows (_zeroRule): they earn no panel-work labour, so their band figure is their only cost —
// there is no duplication to remove, and removing it would make them £0 (batch 106 forbids).
// ⛔ Rows with no ledger grade are left alone (the grade is the owner; no grade, no ruling). Since batch 127 the
// one path that produced an ungraded body panel — the Q4 quarter promotion — sets a grade (promoteFlaggedQuarter).
// Mutates `gatedParts` IN PLACE (element replacement — the route's gatedParts is a const array). Returns the
// list of changes for the log. `sevByPanel`: panelId → MINOR|MODERATE|SEVERE (the same map labour uses).
export const REPAIR_NO_PART_NOTE = 'Repaired, not replaced — no new panel is bought; the repair is costed in the Labour & paint line.';
export function applyGradeOwnsAction(gatedParts, sevByPanel) {
  const changes = [];
  for (let i = 0; i < (gatedParts || []).length; i++) {
    const r = gatedParts[i];
    if (!r?.panelId || r._zeroRule || isNonPartRow(r)) continue;
    if (!isBodyPanel(r.panelId)) continue;
    const welded = !!weldedClass(r.panelId);
    const grade = String(sevByPanel?.get?.(r.panelId) || '').toUpperCase();
    if (grade === 'MINOR' || grade === 'MODERATE') {
      gatedParts[i] = { ...r, action: 'repair', oem: null, used: null, _repairNoPart: true,
        _modelPart: { action: r.action ?? null, oem: r.oem ?? null, used: r.used ?? null } };
      changes.push({ panelId: r.panelId, grade, from: `${r.action} £${r.used ?? r.oem ?? 0}`,
        to: welded ? 'repair £0 part (welded: labour only)' : 'repair £0 part (panel work carries it)' });
    } else if (grade === 'SEVERE' && welded) {
      const next = { ...r, action: 'replace' };
      if (r.action !== 'replace') next._modelAction = r.action ?? null;
      if (r.oem != null) {
        if (r.used != null) { next.used = null; next._weldedAtNew = { used: r.used }; }
      } else {
        next._weldedNoNewPrice = true;
      }
      if (next.action === r.action && next.used === r.used && !next._weldedNoNewPrice) continue;   // already replace at new
      gatedParts[i] = next;
      changes.push({ panelId: r.panelId, grade, from: `${r.action} £${r.used ?? r.oem ?? 0}`,
        to: r.oem != null ? `replace at NEW £${r.oem} (welded)` : `replace £${r.used ?? 0} — no new price on the row, figure kept (welded)` });
    } else if (grade === 'SEVERE' && r.action !== 'replace') {
      gatedParts[i] = { ...r, action: 'replace', _modelAction: r.action ?? null };
      changes.push({ panelId: r.panelId, grade, from: `${r.action}`, to: 'replace (part kept)' });
    }
  }
  return changes;
}

// ── batch 127 — THE Q4 QUARTER PROMOTION SETS A GRADE (spec open item 6, Vincent 14 Sep) ──────────────
// A flagged-but-uncosted rear quarter is costed at the band default (31 Aug ruling 2, flag retained). It used
// to arrive with NO grade — the only ungraded body panel the engine could produce — and fell to the labour
// default (MODERATE) while keeping its part. Ruled: the promotion SETS SEVERE, which removes the ungraded
// state entirely. applyGradeOwnsAction then prices it as a welded REPLACE at NEW (oem). A grade already held
// for the quarter (e.g. from a floored twin) is overridden, and returned as gradeWas for the log.
// Mutates gatedParts / costedIds / sevByPanel / zoneByPanel in place. Returns null when nothing is promoted.
export const Q4_PROMOTED_GRADE = 'SEVERE';
export function promoteFlaggedQuarter({ gatedParts, flaggedParts = [], costedIds, sevByPanel, zoneByPanel, entry, name } = {}) {
  if (!entry) return null;
  for (const f of flaggedParts || []) {
    if (f?.panelId !== 'REAR_QUARTER' || costedIds.has('REAR_QUARTER')) continue;
    const row = { panelId: 'REAR_QUARTER', name, action: 'replace', oem: entry.oem, used: entry.used, _tableMandated: true, _q4Promoted: true };
    gatedParts.push(row);
    costedIds.add('REAR_QUARTER');
    const gradeWas = sevByPanel.get('REAR_QUARTER') ?? null;
    sevByPanel.set('REAR_QUARTER', Q4_PROMOTED_GRADE);
    if (!zoneByPanel.has('REAR_QUARTER')) zoneByPanel.set('REAR_QUARTER', f.zone || 'rear');
    return { row, gradeWas };
  }
  return null;
}

// SRS airbag fitting rider (spec §10) — the ONE row that keeps a labour rider after the aggregate is
// deleted. ON TOP of the kit price. Vincent gave all three directly and corrected an earlier £450; the
// curve accelerates (300/600/1000). ⛔ DO NOT interpolate or scale any tier (A2 — no invented constant).
export const SRS_FITTING = Object.freeze({ T1: 300, T2: 600, T3: 1000 });
export function srsFitting(tier) { return SRS_FITTING[tier] || 0; }

// Full code-owned labour computation for a lot.
//   bodyPanels          : [{ panelId, zone, severity, action }] — surviving costed BODY panels only.
//   structuralTellCount : how many of the four NAMED tells genuinely fired (chassis-leg limb NOT shipped —
//                         it cannot be isolated from FRONT_STRUCTURE; batch 95 Q2 §2). ≥2 → allowance.
//   srsTier             : 'T1'|'T2'|'T3'|null — airbag fitting rider (spec §10), added ON TOP of the kit.
// Returns the money the caller folds into parts_sum plus the display columns.
// batch 95: the structural allowance is WITHDRAWN by Vincent. A stripped-for-repair front (bumper removed,
// crash bar exposed & straight; bonnet closed & flush) trips the same tells as a crushed one — the engine
// has a rule for PANELS beside a removed bumper but NONE for the STRUCTURE, so it read a dismantled car
// (YH23NVW) as an engine-out/jig job and added £2,500 it did not need. No lot receives the allowance. The
// code is KEPT for a future perception-gated re-enable (bumper-off must not count as a structural tell).
export const STRUCTURAL_ALLOWANCE_ENABLED = false;
export function computeLabour({ bodyPanels = [], structuralTellCount = 0, srsTier = null } = {}) {
  const columns = assembleColumns(bodyPanels);
  const structural = STRUCTURAL_ALLOWANCE_ENABLED ? structuralAllowance(structuralTellCount >= 2) : null;
  const structuralMoney = structural ? structural.money : 0;
  const srs = srsFitting(srsTier);
  return {
    columns,                                          // {newPainted, secondHand, ...} for display
    panelWorkMoney:  columns.newPainted.money,        // the bid drives off the NEW+PAINTED top
    secondHandMoney: columns.secondHand.money,        // display only
    structural,                                       // {low,high,money} | null
    srsFitting:      srs,                             // £ rider (spec §10), 0 when no airbag deployment
    labourMoney:     columns.newPainted.money + structuralMoney + srs,   // total code labour into parts_sum
  };
}

// ── §4/§8 REFERENCE-ONLY, never computed from ────────────────────────────────────────────────
// §8 rate is DISPLAY ONLY (3 days ≈ £1,200 = £400/day = £50×8h; structural nearer £500/day).
export const DISPLAY_RATE_PER_HOUR = 50;
// §4 sourced-finished bolt-on fit-only (~£170/panel, no paint) — a MID figure and the buyer's CHEAPER
// option. NOT auto-applied: the engine has no colour-matched/sourced signal (only action + severity), and
// the painted base-table path is the higher, A4-safe default. Kept here for the addendum/range narrative.
export const SOURCED_FINISHED_FIT = 170;
// §7 SANITY ENVELOPE — an ASSERTION, never a calculation. A computed whole-frontal total far outside its
// band means something is wrong (log/flag). NEVER cost from these.
export const SANITY_ENVELOPE = {
  small_medium: { sh: 1200, new: 2000 },
  big_2wd:      { sh: 2500, new: 3500 },
  fourxfour:    { sh: 4000, new: 6000 },
};
