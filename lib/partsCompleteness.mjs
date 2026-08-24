// Parts-completeness helpers — pure, deterministic. Consumed by the salvage assess route.
//
// REWRITE against engine v2.0 (batch 61, Vincent-authorised). The original module (branch
// fix/salvage-parts-completeness, 31 Jul) was written against the pre-v2.0 shapes and is NOT merged —
// the PURE logic (Fix A / Fix B) is sound and ported verbatim; only the wiring is adapted to v2.0:
//   • the costed money array `gatedParts` carries `name` (NOT `partName`) and has NO `zone`
//     (zone lives on the per-view `costedParts`), so Fix B's front/rear split falls back to the fog
//     row's `name`;
//   • the survivors lookup uses `buildBuyerFlags(assessment)` (lib/parts.mjs), injected to avoid a cycle.
//
// Two fixes, kept SEPARATE from the HEADLAMP band reconciler (lib/parts.reconcileParts), which owns
// HEADLAMP exclusively and runs BEFORE the gate. HEADLAMP is deliberately outside PANEL_PRICE_TABLE;
// FOG_LAMP IS in it — different panelId, different price source, so these cannot collide. Fix B counts
// existing fog rows and only tops up to two, so it never doubles a model-emitted fog either.
//   Fix A  reconcileNamedComponents — flag-only completeness net (never costs).
//   Fix B  applyFogBumperRule        — fogs follow the bumper (the ONLY parts_sum-affecting add).
// Kept pure + here so they can be unit-tested (scripts/validate-parts-completeness.mjs) without the
// assess route.
import { PANEL, PANEL_DISPLAY } from './panelEnum.mjs';

// Components a model names in the Visible Damage Summary that must resolve to a costed OR flagged part.
// Authoritative list (Vincent-approved, 31 Jul) — ported verbatim from the original module.
export const VDS_COMPONENTS = [
  { panelId: PANEL.DOOR_MIRROR,  rx: /\b(?:door|wing|side)\s+mirror\b/i,          label: 'Door mirror' },
  { panelId: PANEL.FOG_LAMP,     rx: /\bfog\s*(?:lamp|light)s?\b/i,                label: 'Fog lamp' },
  { panelId: PANEL.HEADLAMP,     rx: /\bhead(?:lamp|light)s?\b/i,                  label: 'Headlamp' },
  { panelId: PANEL.FRONT_WING,   rx: /\bfront\s+(?:wing|fender)\b/i,               label: 'Front wing' },
  { panelId: PANEL.REAR_QUARTER, rx: /\b(?:rear\s+quarter|quarter\s+panel)\b/i,    label: 'Rear quarter panel' },
  { panelId: PANEL.FRONT_DOOR,   rx: /\bfront\s+door\b/i,                          label: 'Front door' },
  { panelId: PANEL.REAR_DOOR,    rx: /\brear\s+door\b/i,                           label: 'Rear door' },
  { panelId: PANEL.SILL,         rx: /\bsill\b/i,                                  label: 'Sill' },
  { panelId: PANEL.BONNET,       rx: /\b(?:bonnet|hood)\b/i,                       label: 'Bonnet' },
  { panelId: PANEL.GRILLE,       rx: /\bgrille\b/i,                                label: 'Grille' },
];

const asSet = (v) => (v instanceof Set ? v : new Set(v || []));

/**
 * Fix A — completeness net. Every component NAMED in the Visible Damage Summary must be either
 * costed OR flagged; anything in NEITHER is returned as an inspection flag. FLAG-ONLY — the return
 * is always flags, never a costed part, so it can never touch parts_sum. Conservative: a component
 * is skipped if its panelId is costed/flagged OR its name appears in the costed/flag text.
 * @returns {Array} flag objects to append to _flaggedParts.
 */
export function reconcileNamedComponents(vdsText, costedPanelIds, flaggedPanelIds, costedText = '', flaggedText = '') {
  const text = String(vdsText || '');
  if (!text.trim()) return [];
  const costed  = asSet(costedPanelIds);
  const flagged = asSet(flaggedPanelIds);
  const costedTxt  = String(costedText || '');
  const flaggedTxt = String(flaggedText || '');
  const out = [];
  const emitted = new Set();
  for (const c of VDS_COMPONENTS) {
    if (emitted.has(c.panelId)) continue;
    if (!c.rx.test(text)) continue;                                  // not named in the summary
    if (costed.has(c.panelId) || flagged.has(c.panelId)) continue;   // already costed / flagged (by panel)
    if (c.rx.test(costedTxt) || c.rx.test(flaggedTxt)) continue;     // …or by name (free-text rows)
    emitted.add(c.panelId);
    out.push({
      panelId: c.panelId,
      partName: PANEL_DISPLAY[c.panelId] || c.label,
      zone: 'unknown',
      weight: 'medium',
      reason: `${c.label} — named in the damage summary but not costed; verify on inspection.`,
      _completenessNet: true,
    });
  }
  return out;
}

// ── Fix B: fog lamps follow the bumper (trade rule, Vincent 30–31 Jul) ─────────
// Front fog(s) go with the FRONT bumper; rear fog(s) with the REAR bumper.
//   Bumper GONE (replace / destroyed / missing / torn-off) ⇒ "bumper gone, foglights gone"
//     (Vincent 31 Jul): BOTH fogs on that end went with the bumper and must be costed — SEEDED FROM
//     ZERO at the vehicle's fog band price if the model costed none, or topped up to two if it
//     costed one. Never a "check the second" flag on this branch — both are simply gone.
//   Bumper INTACT ⇒ do NOT assume the second; if exactly one fog is costed, raise a "check the
//     second" inspection flag (uncertain, not assumed gone).
// Bounded to the fogs: on the gone branch it adds at most two fog rows (moving parts_sum by the
// genuinely-lost fogs); on the intact branch it is flag-only. `fogSeed` = { oem, used } for the
// vehicle's band, or null (no Brego trade → no band → can't price a seed, so it flags instead).
function fogRuleForEnd(fogParts, bumperGone, endLabel, fogSeed) {
  const add = [], flags = [];
  const list = Array.isArray(fogParts) ? fogParts : [];
  const n = list.length;
  if (bumperGone) {
    if (n >= 2) return { add, flags };                       // already both costed
    // A SEED-from-zero fog (no existing fog to clone) is an INFERRED part — we never observed its OEM
    // price, so it carries NO oem (an invented OEM price would be a fabricated figure). It is priced at
    // the band's S/H (used) rate only. A TOPPED-UP fog (clone of an existing costed fog, list[0]) keeps
    // that fog's real oem/used — the model actually priced it.
    const template = list[0] || (fogSeed
      ? { panelId: PANEL.FOG_LAMP, name: 'Fog lamp', action: 'replace', oem: null, used: fogSeed.used ?? fogSeed.oem ?? null }
      : null);
    if (!template || (template.used == null && template.oem == null)) {
      // No price to seed with (no band and no existing fog) — flag so it is never silently absent.
      flags.push({
        panelId: PANEL.FOG_LAMP, partName: `${endLabel} fog lamps`, zone: endLabel, weight: 'medium',
        reason: `${endLabel} bumper is gone — both ${endLabel} fog lamps sit in it and should be costed; no price band was available, so confirm and cost on inspection.`,
        _completenessNet: true, _fogCheck: true,
      });
      return { add, flags };
    }
    for (let i = 0; i < 2 - n; i++) {
      // gatedParts rows are keyed on `name`; carry zone too so a later front/rear read still works.
      add.push({ ...template, panelId: PANEL.FOG_LAMP, name: template.name || 'Fog lamp', action: 'replace', zone: endLabel, _fogPaired: true });
    }
    return { add, flags };
  }
  if (n === 1) {
    flags.push({
      panelId: list[0].panelId ?? PANEL.FOG_LAMP, partName: `Second ${endLabel} fog lamp`, zone: endLabel, weight: 'medium',
      reason: `Second ${endLabel} fog lamp — ${endLabel} bumper intact, pairing not assumed; verify on inspection.`,
      _completenessNet: true, _fogCheck: true,
    });
  }
  return { add, flags };
}

/**
 * Fix B entry point. Splits the costed FOG_LAMP rows into front/rear and applies the rule per end.
 * v2.0: gatedParts rows have no `zone`, so front/rear is read from `zone` if present else the row
 * `name` ("rear fog…" → rear); a fog with neither is treated as FRONT (the common case). Returns the
 * parts to add (seeded/paired fogs) and the flags to add — the caller appends them (adds BEFORE parts_sum).
 * @param {{oem?:number, used?:number}|null} fogSeed  per-fog band price for seeding from zero.
 * @returns {{costedToAdd: Array, flagsToAdd: Array}}
 */
export function applyFogBumperRule({ costedParts, frontBumperGone, rearBumperGone, fogSeed = null } = {}) {
  const parts = Array.isArray(costedParts) ? costedParts : [];
  const nameOf = (p) => `${p?.zone || ''} ${p?.name || p?.partName || ''}`;
  const isFog = (p) => p && (p.panelId === PANEL.FOG_LAMP || /\bfog\b/i.test(nameOf(p)));
  const fogs = parts.filter(isFog);
  const rearFogs  = fogs.filter(p => /rear/i.test(nameOf(p)));
  const frontFogs = fogs.filter(p => !/rear/i.test(nameOf(p)));   // default → front
  const f = fogRuleForEnd(frontFogs, !!frontBumperGone, 'front', fogSeed);
  const r = fogRuleForEnd(rearFogs,  !!rearBumperGone,  'rear', fogSeed);
  return { costedToAdd: [...f.add, ...r.add], flagsToAdd: [...f.flags, ...r.flags] };
}

// ── Fix A wiring helper — dedup against the SURVIVING buyer flags ──────────────
// Fix A's "already handled?" test must use the flags the buyer actually sees — the
// buildBuyerFlags(assessment) survivors — NOT the raw pre-filter assessment._flaggedParts. An
// _amalgDisagree flag can sit in _flaggedParts yet be stripped by buildBuyerFlags (panel not in
// _preGateParts); checking the pre-filter list would let that described-but-dropped component slip
// past the net. buildBuyerFlags is INJECTED to keep this module free of a lib/parts import cycle.
// v2.0: gatedParts rows carry `name` (not `partName`).
export function completenessFlagsFor(assessment, gatedParts, buildBuyerFlags) {
  const a = assessment || {};
  const survivors = (typeof buildBuyerFlags === 'function') ? (buildBuyerFlags(a) || []) : (a._flaggedParts || []);
  const gp = Array.isArray(gatedParts) ? gatedParts : [];
  const costedPanelIds  = new Set(gp.map(p => p.panelId).filter(Boolean));
  const costedText      = gp.map(p => p.name || p.partName).filter(Boolean).join(' | ');
  const flaggedPanelIds = new Set(survivors.map(f => f.panelId).filter(Boolean));
  const flaggedText     = survivors.map(f => `${f.partName || ''} ${f.reason || ''}`).join(' | ');
  return reconcileNamedComponents(a['Visible Damage Summary'], costedPanelIds, flaggedPanelIds, costedText, flaggedText);
}
