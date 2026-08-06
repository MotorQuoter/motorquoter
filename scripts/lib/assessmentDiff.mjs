// assessmentDiff — pure diff of two salvage assessments (baseline vs replay) into a human table.
// No I/O. Used by the replay harness to show what an engine change moved, and to FLAG any value
// that changed direction (severity drop, action flip, ceiling move, parts_sum change). (Cowork §7.)

const SEV_RANK = { SEVERE: 3, MODERATE: 2, MINOR: 1, '': 0, null: 0, undefined: 0 };
const norm = s => String(s ?? '').trim();
const sevRank = s => SEV_RANK[norm(s).toUpperCase()] ?? 0;

// Per-part view keyed by part name: severity + action + cost, drawn from _damageCards (carries
// severity) with a fallback to _reconciledParts (name/action/used|oem) when cards are absent.
function partIndex(a) {
  const idx = new Map();
  for (const c of (a?._damageCards || [])) {
    if (!c?.part) continue;
    idx.set(c.part.toLowerCase(), { part: c.part, severity: norm(c.severity), action: norm(c.action), cost: c.cost ?? null, origin: c.origin });
  }
  if (idx.size === 0) {
    for (const p of (a?._reconciledParts || [])) {
      if (!p?.name) continue;
      idx.set(p.name.toLowerCase(), { part: p.name, severity: '', action: norm(p.action), cost: p.used ?? p.oem ?? null, origin: 'costed' });
    }
  }
  return idx;
}

const partsSum = a => a?._partsReconciliation?.parts_sum ?? null;
const ceilings = a => {
  const c = a?._investmentBlock?.bidCeilings || {};
  return { rebuild: c.rebuild?.value ?? null, flip: c.flip?.value ?? null, partsOut: c.partsOut?.value ?? null };
};
const prose = a => ({
  'Key Cost Drivers': norm(a?.['Key Cost Drivers']),
  'Red Flags': norm(a?.['Red Flags']),
  'Visible Damage Summary': norm(a?.['Visible Damage Summary']),
});

export function diffAssessments(before, after) {
  const bi = partIndex(before), ai = partIndex(after);
  const parts = [];
  for (const key of new Set([...bi.keys(), ...ai.keys()])) {
    const b = bi.get(key), a = ai.get(key);
    const sevB = b?.severity ?? '', sevA = a?.severity ?? '';
    const actB = b?.action ?? '', actA = a?.action ?? '';
    const costB = b?.cost ?? null, costA = a?.cost ?? null;
    const flags = [];
    if (sevRank(sevA) < sevRank(sevB)) flags.push(`severity ↓ ${sevB || '—'}→${sevA || '—'}`);
    if (sevRank(sevA) > sevRank(sevB)) flags.push(`severity ↑ ${sevB || '—'}→${sevA || '—'}`);
    if (actB && actA && actB !== actA) flags.push(`action ${actB}→${actA}`);
    if (!b) flags.push('added'); if (!a) flags.push('removed');
    if ((costB ?? '') !== (costA ?? '')) flags.push(`£ ${costB ?? '—'}→${costA ?? '—'}`);
    if (flags.length) parts.push({ part: (a || b).part, sevB, sevA, actB, actA, costB, costA, flags });
  }

  const cB = ceilings(before), cA = ceilings(after);
  const ceilRows = ['rebuild', 'flip', 'partsOut'].map(k => ({ k, b: cB[k], a: cA[k], changed: (cB[k] ?? null) !== (cA[k] ?? null) }));

  const pB = prose(before), pA = prose(after);
  const proseRows = Object.keys(pB).map(k => ({ field: k, changed: pB[k] !== pA[k], before: pB[k], after: pA[k] }));

  const psB = partsSum(before), psA = partsSum(after);

  return {
    parts,
    partsSum: { before: psB, after: psA, changed: (psB ?? null) !== (psA ?? null), delta: (psA ?? 0) - (psB ?? 0) },
    ceilings: ceilRows,
    prose: proseRows,
    anyDirectionChange: parts.some(p => p.flags.some(f => /↓|↑|action/.test(f))) || ceilRows.some(r => r.changed) || (psB ?? null) !== (psA ?? null),
  };
}

export function renderDiffTable(diff, label = 'baseline → replay') {
  const L = [];
  L.push(`\n===== Assessment diff (${label}) =====`);
  L.push(`\nRepair total (parts_sum): £${diff.partsSum.before ?? '—'} → £${diff.partsSum.after ?? '—'}` +
    (diff.partsSum.changed ? `   ⚑ Δ £${diff.partsSum.delta >= 0 ? '+' : ''}${diff.partsSum.delta}` : '  (unchanged)'));

  L.push('\nPer-part changes:');
  if (!diff.parts.length) L.push('  (none — every part identical)');
  for (const p of diff.parts) {
    L.push(`  ${p.part.padEnd(22)} sev ${(p.sevB || '—').padEnd(8)}→ ${(p.sevA || '—').padEnd(8)} act ${(p.actB || '—').padEnd(8)}→ ${(p.actA || '—').padEnd(8)}  ⚑ ${p.flags.join(', ')}`);
  }

  L.push('\nBid ceilings:');
  for (const r of diff.ceilings) {
    L.push(`  ${r.k.padEnd(10)} £${r.b ?? '—'} → £${r.a ?? '—'}${r.changed ? '   ⚑ changed' : ''}`);
  }

  L.push('\nProse fields:');
  for (const r of diff.prose) L.push(`  ${r.field.padEnd(24)} ${r.changed ? '⚑ CHANGED' : 'unchanged'}`);

  L.push(`\n${diff.anyDirectionChange ? '⚑ DIRECTION CHANGES PRESENT — review above.' : '✓ No direction changes (severity/action/ceiling/parts_sum all stable).'}`);
  return L.join('\n');
}
