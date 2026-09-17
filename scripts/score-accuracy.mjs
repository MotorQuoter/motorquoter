// score-accuracy.mjs — batch 153 S3. THE ACCURACY SCORECARD. £0.
//
// For every lot with a working cassette AND a ground-truth file (fixtures/<LOT>/ground-truth.json — Vincent's
// labels only; this script never writes one), replay the lot at £0 and compare the ledger with the labels.
//
//   costed   = a panel in _reconciledParts with money > 0 or _repairNoPart
//   damaged + costed = HIT      damaged + not costed = MISS (and whether it is at least flagged)
//   clean   + costed = PHANTOM  clean   + not costed = OK      cannot-tell = not scored
//   pairs (HEADLAMP, FOG_LAMP): costed rows vs `count`
//   £ per PHANTOM = the part figure + its labour share (lib/ledgerEdits.applyEdits striking the row — the same
//                   recompute a buyer's strike runs). A structure floor the strike drops is reported apart.
//   £ per MISS    = the band figure (S/H) + the labour share of adding it (lib/labour.computeLabour, grade
//                   MODERATE — the labour block's default for an ungraded panel).
//   Structure floors (FRONT/REAR/SIDE_STRUCTURE) and the SRS row are NOT panel-scored: reported apart
//   against the structure / AIRBAG labels. A floor under a NON-structure panel's name (pre-batch-150 spare
//   wheel) is money under that panel, so it IS scored as that panel's cost.
//
// REPORT ONLY — not a pass/fail gate yet (brief, batch 153). Every engine batch reports the delta.
//
// Usage (the alias loader is required):
//   node --loader ./scripts/lib/alias-loader.mjs scripts/score-accuracy.mjs [--tree <path>] [--out <file>]
//     --tree  a checkout whose engine is replayed (default: this repo). Its fixtures/ must be this repo's
//             (a junction), so the labels and cassettes are the same for both trees.
//   node scripts/score-accuracy.mjs --diff <a.json> <b.json>     — print the delta between two scorecards
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, execFileSync } from 'child_process';
import { tmpdir } from 'os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : undefined; };
const gbp = (n) => `£${(Math.round(n) || 0).toLocaleString("en-GB")}`;

// ── --diff mode (no loader needed) ────────────────────────────────────────────────────────────────────
if (process.argv.includes('--diff')) {
  const i = process.argv.indexOf('--diff');
  const [a, b] = [process.argv[i + 1], process.argv[i + 2]].map((f) => JSON.parse(readFileSync(f, 'utf8')));
  printDiff(a, b);
  process.exit(0);
}

const { PANEL, PANEL_DISPLAY } = await import('../lib/panelEnum.mjs');
const { PANEL_PRICE_TABLE } = await import('../lib/priceBand.mjs');
const { applyEdits, rowKeyFor, ledgerHash, figureOf } = await import('../lib/ledgerEdits.mjs');
const { computeLabour, isBodyPanel } = await import('../lib/labour.mjs');
const { isStructureFloorPanel, STRUCT_FLOOR_ZONE } = await import('../lib/structureFloor.mjs');
const { PAIRS, listLots, lotInfo } = await import('./lib/labelVocabulary.mjs');

const tree = resolve(arg('--tree') || ROOT);
const sha = execFileSync('git', ['-C', tree, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const tmp = resolve(tmpdir(), `score-accuracy-${sha}-${process.pid}`);
mkdirSync(tmp, { recursive: true });

const isCosted = (r) => figureOf(r) > 0 || r._repairNoPart === true;
// A row's panel: its panelId, or — for a panelless clone such as the second row of a headlamp pair
// (batch 109C) — the enum id whose display name it carries. Labour/allowance rows match nothing.
const BY_DISPLAY = new Map(Object.entries(PANEL_DISPLAY).map(([id, name]) => [String(name).toLowerCase().trim(), id]));
const panelOf = (r) => r.panelId ?? BY_DISPLAY.get(String(r.name || '').toLowerCase().trim()) ?? null;
const endOf = (pid) => {
  for (const [z, def] of Object.entries(STRUCT_FLOOR_ZONE)) if (def.bumper === pid || def.members.includes(pid)) return z === 'FRONT_STRUCTURE' ? 'front' : 'rear';
  return 'flank-damaged-side';
};

function replay(lot) {
  const dump = resolve(tmp, `${lot}.json`);
  const r = spawnSync(process.execPath, ['--loader', './scripts/lib/alias-loader.mjs', 'scripts/replay.mjs', lot, '--vision-fixture', '--dump', dump],
    { cwd: tree, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const cas = out.match(/\[CASSETTE\] served (\d+) call\(s\), missed (\d+)/);
  const served = cas ? Number(cas[1]) : null;
  const missed = cas ? Number(cas[2]) : null;
  const band = (out.match(/band=([A-Za-z][A-Za-z-]*)/) || [])[1] || null;
  if (r.status !== 0 || missed !== 0 || !existsSync(dump)) return { ok: false, served, missed, why: r.status !== 0 ? `replay exit ${r.status}` : `missed ${missed}` };
  return { ok: true, served, missed, band, assessment: JSON.parse(readFileSync(dump, 'utf8')) };
}

// £ removed by striking these ledger rows (the buyer's own recompute): part + labour, floor apart.
function strikeValue(a, idxs) {
  const rec = a._reconciledParts;
  const keys = rowKeyFor(rec);
  const res = applyEdits(a, { stamp: ledgerHash(rec), strikes: idxs.map((i) => keys[i]), adds: [] });
  const part = idxs.reduce((s, i) => s + figureOf(rec[i]), 0);
  return { total: -res.delta, part, labour: -res.labourDelta, floor: -res.structFloorDelta };
}

// £ a missed panel would add: band S/H + the labour share of adding it at MODERATE.
function missValue(a, pid, band, units = 1) {
  const te = band ? PANEL_PRICE_TABLE[pid]?.[band] : null;
  const part = te ? te.used * units : 0;
  let labour = 0;
  if (isBodyPanel(pid) && Array.isArray(a._labourBodyPanels)) {
    const base = computeLabour({ bodyPanels: a._labourBodyPanels, structuralTellCount: a._labourTellCount ?? 0 }).panelWorkMoney;
    const added = computeLabour({ bodyPanels: [...a._labourBodyPanels, { panelId: pid, zone: endOf(pid), severity: 'MODERATE', action: 'repair' }], structuralTellCount: a._labourTellCount ?? 0 }).panelWorkMoney;
    labour = added - base;
  }
  return { total: part + labour, part, labour, priced: !!te };
}

function scoreLot(info, rp) {
  const a = rp.assessment;
  const rec = a._reconciledParts || [];
  const flagged = new Set((a._flaggedParts || []).map((f) => f.panelId).filter(Boolean));
  const labels = info.gt.panels || {};
  const rows = [];
  const t = { hits: 0, misses: 0, phantoms: 0, ok: 0, phantomGBP: 0, missedGBP: 0, labelled: 0, cannotTell: 0 };
  const idxOf = (pid) => rec.map((r, i) => [r, i]).filter(([r]) => panelOf(r) === pid && isCosted(r)
    && r.panelId !== 'SRS_AIRBAG' && !(r._structFloor && isStructureFloorPanel(pid))).map(([, i]) => i);
  const separate = [];
  for (const [pid, lab] of Object.entries(labels)) {
    if (lab.label === 'cannot-tell') { t.cannotTell++; rows.push({ panel: pid, label: lab.label, result: 'not scored' }); continue; }
    if (isStructureFloorPanel(pid) || pid === PANEL.AIRBAG) {
      const floor = pid === PANEL.AIRBAG
        ? rec.filter((r) => r.panelId === 'SRS_AIRBAG' || r._srsFloor).reduce((s, r) => s + figureOf(r), 0)
        : rec.filter((r) => r.panelId === pid && r._structFloor).reduce((s, r) => s + figureOf(r), 0);
      separate.push({ panel: pid, label: lab.label, charged: floor });
      continue;
    }
    t.labelled++;
    const idx = idxOf(pid);
    const m = idx.length;
    const n = lab.label === 'damaged' ? (PAIRS.has(pid) && Number.isFinite(lab.count) ? lab.count : 1) : 0;
    const row = { panel: pid, label: lab.label, ...(PAIRS.has(pid) ? { count: lab.count ?? null, costedRows: m } : {}), costedGBP: idx.reduce((s, i) => s + figureOf(rec[i]), 0) };
    if (lab.label === 'damaged') {
      const hit = PAIRS.has(pid) ? Math.min(m, n) : (m > 0 ? 1 : 0);
      const miss = PAIRS.has(pid) ? Math.max(0, n - m) : (m > 0 ? 0 : 1);
      const extra = PAIRS.has(pid) ? Math.max(0, m - n) : 0;
      t.hits += hit; t.misses += miss;
      if (miss) { const v = missValue(a, pid, rp.band, miss); row.missed = { units: miss, flagged: flagged.has(pid), ...v }; t.missedGBP += v.total; }
      if (extra) { const v = strikeValue(a, idx.slice(n)); row.phantom = { units: extra, ...v }; t.phantoms += extra; t.phantomGBP += v.total; }
      row.result = miss ? (hit ? 'PARTIAL MISS' : 'MISS') : extra ? 'HIT + PHANTOM' : 'HIT';
    } else {
      if (m > 0) { const v = strikeValue(a, idx); row.phantom = { units: m, ...v }; t.phantoms += m; t.phantomGBP += v.total; row.result = 'PHANTOM'; }
      else { t.ok++; row.result = 'OK'; }
    }
    rows.push(row);
  }
  // Money the labels do not speak to: costed panels nobody has labelled yet.
  const unlabelled = [...new Set(rec.filter((r) => panelOf(r) && isCosted(r) && !labels[panelOf(r)] && r.panelId !== 'SRS_AIRBAG' && !isStructureFloorPanel(panelOf(r))).map(panelOf))];
  const vocab = info.panels.length;
  return { lot: info.lot, served: rp.served, missed: rp.missed, band: rp.band, partsSum: a._partsReconciliation?.parts_sum ?? null,
    totals: { ...t, phantomGBP: Math.round(t.phantomGBP), missedGBP: Math.round(t.missedGBP), coveragePct: Math.round((t.labelled / vocab) * 100), vocabulary: vocab },
    panels: rows, floorsAndSrs: separate, unlabelledCosted: unlabelled };
}

const lots = listLots(ROOT);
const card = { sha, tree, scoredAt: new Date().toISOString(), lots: [], skipped: [] };
for (const lot of lots) {
  const info = await lotInfo(ROOT, lot);
  if (!info.gt) { card.skipped.push({ lot, why: 'no ground-truth file' }); continue; }
  if (!info.hasFixture || !info.hasCassette) { card.skipped.push({ lot, why: 'no fixture/cassette to replay' }); continue; }
  const rp = replay(lot);
  if (!rp.ok) { card.skipped.push({ lot, why: `cassette not working at ${sha} (${rp.why}, served ${rp.served})` }); continue; }
  card.lots.push(scoreLot(info, rp));
}
const sum = (k) => card.lots.reduce((s, l) => s + l.totals[k], 0);
card.totals = { lots: card.lots.length, hits: sum('hits'), misses: sum('misses'), phantoms: sum('phantoms'), ok: sum('ok'),
  phantomGBP: sum('phantomGBP'), missedGBP: sum('missedGBP'), labelled: sum('labelled'), vocabulary: sum('vocabulary'),
  coveragePct: sum('vocabulary') ? Math.round((sum('labelled') / sum('vocabulary')) * 100) : 0 };

const outFile = arg('--out') || resolve(ROOT, '_cc', 'scorecard', `${sha}.json`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(card, null, 2));
printCard(card);
console.log(`\nscorecard → ${outFile}`);

function printCard(c) {
  console.log(`\nACCURACY SCORECARD @ ${c.sha}  (report only)`);
  console.log('lot       served  repair   hit  miss  phantom  ok   phantom£  missed£  labelled/vocab');
  for (const l of c.lots) {
    const x = l.totals;
    console.log(`${l.lot.padEnd(9)} ${String(l.served).padStart(6)}  ${gbp(l.partsSum).padStart(7)}  ${String(x.hits).padStart(3)}  ${String(x.misses).padStart(4)}  ${String(x.phantoms).padStart(7)}  ${String(x.ok).padStart(2)}  ${gbp(x.phantomGBP).padStart(8)}  ${gbp(x.missedGBP).padStart(7)}  ${x.labelled}/${x.vocabulary} (${x.coveragePct}%)`);
    for (const p of l.panels) {
      if (p.result === 'OK' || p.result === 'HIT' || p.result === 'not scored') continue;
      const ph = p.phantom ? ` phantom ${gbp(p.phantom.total)} (part ${gbp(p.phantom.part)} + labour ${gbp(p.phantom.labour)}${p.phantom.floor ? ` + floor dropped ${gbp(p.phantom.floor)}` : ''})` : '';
      const mi = p.missed ? ` missed ${gbp(p.missed.total)} (band ${p.missed.priced ? gbp(p.missed.part) : 'n/a'} + labour ${gbp(p.missed.labour)})${p.missed.flagged ? ' — flagged' : ' — NOT flagged'}` : '';
      console.log(`     ${p.result.padEnd(13)} ${p.panel}${p.count != null ? ` (count ${p.count}, costed rows ${p.costedRows})` : ''}${ph}${mi}`);
    }
    for (const s of l.floorsAndSrs) console.log(`     [apart] ${s.panel} labelled ${s.label} — charged ${gbp(s.charged)}`);
    if (l.unlabelledCosted.length) console.log(`     unlabelled costed panels: ${l.unlabelledCosted.join(', ')}`);
  }
  const x = c.totals;
  console.log(`TOTAL ${x.lots} lot(s): hits ${x.hits} · misses ${x.misses} · phantoms ${x.phantoms} · ok ${x.ok} · phantom ${gbp(x.phantomGBP)} · missed ${gbp(x.missedGBP)} · coverage ${x.labelled}/${x.vocabulary} (${x.coveragePct}%)`);
  for (const s of c.skipped) console.log(`  skipped ${s.lot}: ${s.why}`);
}

function printDiff(a, b) {
  console.log(`\nSCORECARD DELTA  ${a.sha} → ${b.sha}`);
  const keys = ['hits', 'misses', 'phantoms', 'ok', 'phantomGBP', 'missedGBP'];
  const lotsAll = [...new Set([...a.lots, ...b.lots].map((l) => l.lot))].sort();
  console.log(`lot       ${keys.map((k) => k.padStart(16)).join('')}   repair`);
  for (const lot of lotsAll) {
    const la = a.lots.find((l) => l.lot === lot), lb = b.lots.find((l) => l.lot === lot);
    if (!la || !lb) { console.log(`${lot.padEnd(9)} scored in ${la ? a.sha : b.sha} only`); continue; }
    const cell = (k) => { const x = la.totals[k], y = lb.totals[k]; const f = (v) => (/GBP/.test(k) ? gbp(v) : String(v)); return `${f(x)}→${f(y)}`.padStart(16); };
    console.log(`${lot.padEnd(9)} ${keys.map(cell).join('')}   ${gbp(la.partsSum)}→${gbp(lb.partsSum)}`);
    for (const p of lb.panels) {
      const q = la.panels.find((r) => r.panel === p.panel);
      if (q && q.result !== p.result) console.log(`     ${p.panel}: ${q.result} → ${p.result}`);
    }
  }
  const cell = (k) => { const x = a.totals[k], y = b.totals[k]; return `${/GBP/.test(k) ? gbp(x) : x}→${/GBP/.test(k) ? gbp(y) : y}`.padStart(16); };
  console.log(`${'TOTAL'.padEnd(9)} ${keys.map(cell).join('')}`);
}
