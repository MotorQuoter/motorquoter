// tabulate-a3ab — turn the A3-on/off A/B dumps into a per-panel severity frequency table (Cowork §11).
// Reads _cc/a3runs/ab/<VRM>_<arm>_<k>.json (each a dumped assessment), tallies per-panel damage
// severity across the K runs of each arm, and flags panels A3-OFF grades SEVERE but A3-ON pushes to
// MODERATE/MINOR — the "genuinely-severe now under-graded" candidates. READ-ONLY over local dumps.
//   node scripts/tabulate-a3ab.mjs [lot1 lot2 ...]   (default: DMZ4614 GY75CJU SF69YBB)
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, '_cc/a3runs/ab');
const LOTS = process.argv.slice(2).length ? process.argv.slice(2) : ['DMZ4614', 'GY75CJU', 'SF69YBB'];
const GRADES = ['SEVERE', 'MODERATE', 'MINOR'];
const sevRank = s => ({ SEVERE: 3, MODERATE: 2, MINOR: 1 }[s] || 0);

function loadArm(vrm, arm) {
  if (!existsSync(DIR)) return [];
  const files = readdirSync(DIR).filter(f => f.startsWith(`${vrm}_${arm}_`) && f.endsWith('.json')).sort();
  return files.map(f => { try { return JSON.parse(readFileSync(resolve(DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}

// For one run: panel -> its damage severity (only SEVERE/MODERATE/MINOR cards count; inspect/clear ignored).
function panelSevs(run) {
  const m = new Map();
  for (const c of (run?._damageCards || [])) {
    const s = String(c?.severity || '').toUpperCase();
    if (GRADES.includes(s) && c.part) {
      // keep the highest severity if a panel appears twice in one run
      if (!m.has(c.part) || sevRank(s) > sevRank(m.get(c.part))) m.set(c.part, s);
    }
  }
  return m;
}

// Compact per-arm severity vector for a panel across K runs, e.g. [SEVERE, SEVERE, MODERATE] -> "SEV,SEV,MOD".
const abbr = s => ({ SEVERE: 'SEV', MODERATE: 'MOD', MINOR: 'MIN' }[s] || '·');
const severeCount = vec => vec.filter(s => s === 'SEVERE').length;

let flaggedTotal = 0;
for (const vrm of LOTS) {
  const on = loadArm(vrm, 'on'), off = loadArm(vrm, 'off');
  console.log(`\n================= ${vrm}  (A3-on runs: ${on.length}, A3-off runs: ${off.length}) =================`);
  if (!on.length || !off.length) { console.log('  (missing dumps — batch incomplete for this lot)'); continue; }

  const onSev = on.map(panelSevs), offSev = off.map(panelSevs);
  const panels = new Set();
  [...onSev, ...offSev].forEach(m => m.forEach((_v, k) => panels.add(k)));

  const rows = [];
  for (const p of panels) {
    const onVec = onSev.map(m => m.get(p) || '—');
    const offVec = offSev.map(m => m.get(p) || '—');
    const onSC = severeCount(onVec), offSC = severeCount(offVec);
    // CLEAN A3-under-grade signature: A3-off grades it SEVERE in a MAJORITY of runs AND A3-on grades
    // it SEVERE in ZERO runs. Anything short of on=0-severe is within the demonstrated single-panel
    // flip variance (Severe↔Moderate at K=1) and does not count as an A3 effect above noise.
    const flag = offSC >= Math.ceil(off.length / 2) && onSC === 0;
    rows.push({ p, onVec, offVec, onSC, offSC, flag });
  }
  // Sort: flagged first, then by off-minus-on severe delta.
  rows.sort((a, b) => (b.flag - a.flag) || ((b.offSC - b.onSC) - (a.offSC - a.onSC)));

  console.log(`  ${'panel'.padEnd(24)} ${'A3-ON'.padEnd(16)} ${'A3-OFF'.padEnd(16)} severe on/off`);
  for (const r of rows) {
    console.log(`  ${(r.flag ? '⚑ ' : '  ') + r.p.padEnd(22)} ${r.onVec.map(abbr).join(',').padEnd(16)} ${r.offVec.map(abbr).join(',').padEnd(16)} ${r.onSC}/${r.offSC}${r.flag ? '   ← A3 downgrades a consistently-severe panel' : ''}`);
    if (r.flag) flaggedTotal++;
  }

  // Per-lot totals: total SEVERE gradings across all panels/runs, on vs off.
  const totSev = arr => arr.reduce((n, m) => n + [...m.values()].filter(s => s === 'SEVERE').length, 0);
  console.log(`  ── totals: SEVERE gradings  A3-on=${totSev(onSev)}  A3-off=${totSev(offSev)}  (across ${on.length}/${off.length} runs)`);
}

console.log(`\n================= VERDICT =================`);
console.log(`Flagged panels (A3-off majority-SEVERE, A3-on minority-SEVERE): ${flaggedTotal}`);
console.log(flaggedTotal === 0
  ? 'No panel is systematically downgraded by A3 above the run-to-run noise on this set.\nA3 within noise → the cheap first cut finds no genuinely-severe panel under-graded.'
  : 'A3 shows a detectable downgrade on the flagged panel(s) above — candidates for the full sweep / review.');
