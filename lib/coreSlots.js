// Shared CORE slot data shape — consumed identically by the assess route (producer),
// success/page.js (web renderer) and pdf/route.js (PDF renderer). Generalises the existing
// code-owned-value pattern (_exitValue / _marginScenarios / _reconciledParts): code assembles
// a structured object once, both surfaces render from it without re-parsing prose.
//
// Canonical slot `id`s are STABLE — never renamed. They are the keys two-pass comparison and
// the `allClear` list match against. `label` is the display string and may change freely.

export const CORE_GROUPS = {
  IDENTITY: { id: 'identity', label: 'Identity & Provenance' },
  MILEAGE:  { id: 'mileage',  label: 'Mileage & History' },
  RUNNING:  { id: 'running',  label: 'Running & Drivetrain' },
  PHYSICAL: { id: 'physical', label: 'Physical' },
};

// Verdict vocabularies, one per slot `kind`. CORE confirmation-type slots are
// confirmed/unconfirmed/discrepancy (design notes: "CORE verdict shape is often confirmed/
// unconfirmed/DISCREPANCY"; "corroborated/uncorroborated" wording is normalised into this same
// vocabulary — one shape per kind keeps two-pass comparison from treating synonyms as distinct).
// Wheel and tyre get their OWN richer vocabularies rather than the generic damaged/undamaged —
// the design notes spell these out explicitly (intact/kerbed/damaged/not-shown for wheels,
// intact/damaged/destroyed/not-shown for tyres) because "kerbed" vs "damaged" and "damaged" vs
// "destroyed" are real trade distinctions that a generic 3-value enum would flatten away.
export const VERDICT_VOCAB = {
  confirmation: ['confirmed', 'unconfirmed', 'discrepancy'],
  damage:       ['damaged', 'undamaged', 'not-visible'],
  wheel:        ['intact', 'kerbed', 'damaged', 'not-shown'],
  tyre:         ['intact', 'damaged', 'destroyed', 'not-shown'],
};

// Verdicts that collapse a slot into the "Verified clear" confirmation block.
// Deliberately narrow: not-visible/not-shown/unconfirmed are information ("photos didn't show
// this — check on inspection"), never silently folded into all-clear alongside genuine clean reads.
export const ALL_CLEAR_VERDICTS = {
  confirmation: ['confirmed'],
  damage:       ['undamaged'],
  wheel:        ['intact'],
  tyre:         ['intact'],
};

export const CONFIDENCE_VALUES = ['visible', 'inferred', 'hidden', 'corroborated'];
export const ACTION_VALUES     = ['replace', 'repair', 'inspect', 'none'];
export const SOURCE_VALUES     = ['code', 'model', 'code+model'];
export const SEVERITY_VALUES   = ['info', 'caution', 'red'];
export const TIER_VALUES       = [1, 2];

// Code-owned suffix → vendor-type mapping (Vincent's trade knowledge, confirmed 06 Jun).
// The model reads the LETTER off the windscreen-sticker photo (vision); code owns what the
// letter MEANS — same discipline as category driving exit-band without the model narrating it.
export const VENDOR_SUFFIX_MAP = {
  X: { vendorType: 'Insurance company — low value',  insurerEntered: true },
  P: { vendorType: 'Insurance company — high value', insurerEntered: true },
  C: { vendorType: 'Private or trade entry',         insurerEntered: false },
  Q: { vendorType: 'Copart or webuyanycar entry',    insurerEntered: false },
};

export const WHEEL_CORNERS = ['front-left', 'front-right', 'rear-left', 'rear-right'];
export const CORNER_LABELS = {
  'front-left':  'Front Left',
  'front-right': 'Front Right',
  'rear-left':   'Rear Left',
  'rear-right':  'Rear Right',
};

export function wheelSlotId(corner) { return `wheel-${corner}`; }
export function tyreSlotId(corner)  { return `tyre-${corner}`; }

function assertOneOf(value, allowed, what, slotId) {
  if (value != null && !allowed.includes(value)) {
    throw new Error(`[coreSlots] invalid ${what} "${value}" for slot "${slotId}" — expected one of: ${allowed.join(', ')}`);
  }
}

// Builds one canonical slot record. Throws on shape violations — this is the boundary between
// "whatever the model/code produced" and the structure both renderers trust; a slot that doesn't
// fit its kind's vocabulary would silently break two-pass comparison and all-clear grouping later.
export function buildSlot({ id, label, kind, verdict, detail = null, confidence = null, action = null, corroboration = null, source, flag = null }) {
  if (!id || !label) throw new Error('[coreSlots] slot requires id and label');
  if (!VERDICT_VOCAB[kind]) throw new Error(`[coreSlots] unknown kind "${kind}" for slot "${id}"`);
  if (!VERDICT_VOCAB[kind].includes(verdict)) {
    throw new Error(`[coreSlots] verdict "${verdict}" invalid for kind "${kind}" (slot "${id}") — expected one of: ${VERDICT_VOCAB[kind].join(', ')}`);
  }
  assertOneOf(confidence, CONFIDENCE_VALUES, 'confidence', id);
  assertOneOf(action, ACTION_VALUES, 'action', id);
  if (!SOURCE_VALUES.includes(source)) {
    throw new Error(`[coreSlots] invalid source "${source}" for slot "${id}" — expected one of: ${SOURCE_VALUES.join(', ')}`);
  }
  if (corroboration != null) {
    assertOneOf(corroboration.relation, ['matches', 'unexplained', 'absent'], 'corroboration.relation', id);
  }
  if (flag != null) {
    assertOneOf(flag.severity, SEVERITY_VALUES, 'flag.severity', id);
    assertOneOf(flag.tier, TIER_VALUES, 'flag.tier', id);
  }
  return { id, label, kind, verdict, detail, confidence, action, corroboration, source, flag };
}

export function buildGroup({ id, label, slots }) {
  if (!Array.isArray(slots)) throw new Error(`[coreSlots] group "${id}" requires a slots array`);
  return { id, label, slots };
}

export function isAllClear(slot) {
  return !slot.flag && (ALL_CLEAR_VERDICTS[slot.kind] || []).includes(slot.verdict);
}

// Slot ids that collapsed into the "Verified clear: ..." confirmation block — collected in
// group/slot order so both renderers print the same list in the same sequence.
export function deriveAllClear(groups) {
  const ids = [];
  for (const group of groups) {
    for (const slot of group.slots) {
      if (isAllClear(slot)) ids.push(slot.id);
    }
  }
  return ids;
}

// Hoists every flagged slot for top-of-report placement and WhatsApp curation. Each entry
// carries enough slot context (id/label/groupId) plus the flag's own severity/whatsapp/tier/
// proxyFor so the WhatsApp two-tier ordering can sort without re-walking the slot tree.
export function deriveFlags(groups) {
  const flags = [];
  for (const group of groups) {
    for (const slot of group.slots) {
      if (slot.flag) {
        flags.push({
          slotId: slot.id,
          slotLabel: slot.label,
          groupId: group.id,
          severity: slot.flag.severity,
          whatsapp: slot.flag.whatsapp ?? null,
          tier: slot.flag.tier ?? null,
          proxyFor: slot.flag.proxyFor ?? null,
        });
      }
    }
  }
  return flags;
}

// Assembles the full _slots payload from a list of groups. Single entry point so the assess
// route does `assessment._slots = assembleCoreSlots([identityGroup, mileageGroup, physicalGroup])`
// and both derived arrays stay consistent with the group/slot data they're derived from.
export function assembleCoreSlots(groups) {
  return {
    groups,
    allClear: deriveAllClear(groups),
    flags: deriveFlags(groups),
  };
}
