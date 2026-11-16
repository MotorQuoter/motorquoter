// batch 247 B4 (Vincent, 16 Nov: option (b)) — A DISPUTED PANEL NEXT TO A COSTED PANEL IS COSTED AS A REPAIR.
//
// Batch 156 made a disputed panel (the photographs disagree: some views damaged, some clean) a £0 inspection
// flag. RV26YLN showed the cost of that: its front wing and rear quarter, both damaged and both sitting
// against the costed doors, were left off the bill as "photos disagree". Batch 156 is superseded FOR THIS
// CASE ONLY:
//   • the panel's pooled verdict is the disagree branch (a G-split instance key PANEL#n is not pooled — skipped);
//   • it is uncosted on the final ledger;
//   • it is a BODY panel — a repair there is panel work inside Labour & paint (batch 116), which is what was
//     ruled. A grille, lamp, wheel or mirror has no panel-work repair: a "repair" row would charge the part,
//     i.e. a replace. Those stay flagged at £0 and are reported (not folded in — CLAUDE.md working rule 1.4);
//   • it neighbours a panel CHARGED on the final ledger (isChargedRow — CLAUDE.md rule 7), read BEFORE any
//     promotion here, so one promoted panel never promotes the next one along.
// Neighbour test: where the per-view zone tags put both panels in the same zone (the same struck end or the
// damaged flank) that is the path ('zone'); where they cannot say (no tag, or different zones — a corner wing
// is 'front' while its door is 'flank-damaged-side'), the fixed map below decides ('map'). The model is never
// asked for nearside/offside.
// Cost: a REPAIR row priced from the parts grid exactly as the Q4 quarter is (lib/labour.mjs promoteFlaggedQuarter);
// applyGradeOwnsAction then makes it "repair, £0 part, cost in panel work". No replace, no new price.
// Wording: ONE owner (disputedNeighbourReason) — the flag, the checklist line and the damage card print it; the
// PDF prints the flag. The panel stays on the inspection list. The row is an ordinary ledger row, so the buyer
// edit layer strikes it by its _rowKey like any other.

import { isChargedRow } from './ledgerEdits.mjs';
import { isBodyPanel } from './labour.mjs';

// The neighbour map (Part A, batch 247 A3), side-blind. Only BODY panels are promoted; the three non-body entries
// (mirror, wheel, grille) are here so a disputed one next to a charged panel is REPORTED as skipped, not lost silently.
export const PANEL_NEIGHBOURS = Object.freeze({
  DOOR_MIRROR:  ['FRONT_DOOR', 'FRONT_WING'],
  WHEEL:        ['TYRE', 'FRONT_WING', 'REAR_QUARTER'],
  GRILLE:       ['FRONT_BUMPER', 'BONNET', 'HEADLAMP'],
  FRONT_WING:   ['FRONT_DOOR', 'FRONT_BUMPER', 'HEADLAMP', 'BONNET', 'DOOR_MIRROR'],
  REAR_QUARTER: ['REAR_DOOR', 'REAR_BUMPER', 'REAR_LAMP', 'BOOT_LID', 'SILL'],
  FRONT_DOOR:   ['FRONT_WING', 'REAR_DOOR', 'DOOR_MIRROR', 'SILL', 'SIDE_GLASS'],
  REAR_DOOR:    ['FRONT_DOOR', 'REAR_QUARTER', 'SILL', 'SIDE_GLASS'],
  BONNET:       ['FRONT_WING', 'FRONT_BUMPER', 'GRILLE', 'HEADLAMP', 'WINDSCREEN'],
  FRONT_BUMPER: ['GRILLE', 'HEADLAMP', 'FRONT_WING', 'FOG_LAMP', 'BONNET'],
  REAR_BUMPER:  ['REAR_QUARTER', 'REAR_LAMP', 'BOOT_LID'],
  SILL:         ['FRONT_DOOR', 'REAR_DOOR', 'SIDE_SKIRT'],
  SIDE_SKIRT:   ['SILL', 'FRONT_DOOR', 'REAR_DOOR'],
  ROOF:         ['WINDSCREEN', 'REAR_GLASS'],
  BOOT_LID:     ['REAR_BUMPER', 'REAR_LAMP', 'REAR_QUARTER', 'REAR_GLASS'],
});

const lc = (s) => String(s || '').toLowerCase();
export function disputedNeighbourReason(partName, neighbourName) {
  return `Photos disagree on the ${lc(partName)} — costed as a repair because it sits next to the damaged ${lc(neighbourName)}. Strike it if it is sound on inspection.`;
}

const isDisagreeFlag = (f) => f?._amalgDisagree === true || f?._splitVoteUncosted === true;

/**
 * Mutates gatedParts (pushes rows), sevByPanel (sets the disagree grade if absent) and every flag for a promoted panel.
 * @returns {{ promoted: object[], skipped: object[] }} for the log and the report
 */
// notConfirmed: panels the notes-confirm step (lib/notesConfirm.mjs, batch 242) ASKED about with a targeted photo question
// and got "not there" (count 0 / verdict no). That answer is final (batch 242 ruling 1), so it is not overridden here.
export function notesNotConfirmed(notesConfirm) {
  return new Set((notesConfirm?.answers || [])
    .filter((a) => a?.panelId && (a.count === 0 || String(a.verdict || '').toLowerCase() === 'no'))
    .map((a) => a.panelId));
}

export function costDisputedNeighbours({ gatedParts, pvVotes, flagLists = [], zoneByPanel = new Map(), sevByPanel = new Map(),
  priceEntry = () => null, display = {}, notConfirmed = new Set() } = {}) {
  const out = { promoted: [], skipped: [] };
  const charged = new Set((gatedParts || []).filter(isChargedRow).map((r) => r.panelId).filter(Boolean));
  const flags = flagLists.filter(Array.isArray).flat();
  for (const [key, v] of Object.entries(pvVotes || {})) {
    if (v?.branch !== 'disagree') continue;
    const pid = key;
    if (pid.includes('#')) { out.skipped.push({ panelId: pid, why: 'instance key (not pooled)' }); continue; }
    if (charged.has(pid)) continue;
    const nbs = (PANEL_NEIGHBOURS[pid] || []).filter((n) => charged.has(n));
    const panelFlags = flags.filter((f) => f?.panelId === pid && isDisagreeFlag(f));
    if (!isBodyPanel(pid)) { if (nbs.length) out.skipped.push({ panelId: pid, why: 'not a body panel (no panel-work repair)', neighbours: nbs }); continue; }
    if (!nbs.length) continue;
    if (notConfirmed.has(pid)) { out.skipped.push({ panelId: pid, why: 'notes-confirm asked and the photos did not confirm it (final, batch 242)', neighbours: nbs }); continue; }
    if (!panelFlags.length) { out.skipped.push({ panelId: pid, why: 'no surviving disagree flag (stripped)', neighbours: nbs }); continue; }
    const entry = priceEntry(pid);
    if (!entry) { out.skipped.push({ panelId: pid, why: 'no price-grid entry', neighbours: nbs }); continue; }
    const z = zoneByPanel.get(pid);
    const zoneMate = z ? nbs.find((n) => zoneByPanel.get(n) === z) : null;
    const neighbour = zoneMate || nbs[0];
    const path = zoneMate ? 'zone' : 'map';
    const name = display[pid] || pid;
    const neighbourName = display[neighbour] || neighbour;
    const reason = disputedNeighbourReason(name, neighbourName);
    const row = { panelId: pid, name, action: 'repair', oem: entry.oem ?? null, used: entry.used ?? null,
      _tableMandated: true, _disputedNeighbour: { neighbour, neighbourName, path } };
    gatedParts.push(row);
    if (!sevByPanel.has(pid)) sevByPanel.set(pid, 'MODERATE');
    for (const f of panelFlags) {
      f.reason = reason;
      f.weight = 'medium';
      f._disputedNeighbourCosted = true;
      f._splitVoteUncosted = false;   // it is costed now — the uncosted line must not seed as well
    }
    out.promoted.push({ panelId: pid, neighbour, path, zone: z ?? null, neighbourZone: zoneByPanel.get(neighbour) ?? null,
      grade: sevByPanel.get(pid), votes: { damaged: v.damaged, clean: v.clean, severe: v.severeVotes } });
  }
  return out;
}
