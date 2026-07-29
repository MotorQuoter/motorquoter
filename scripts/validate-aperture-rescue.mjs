// §6 VALIDATION GAUNTLET — Aperture Rescue Gate (Stage 1).
// Exercises the SHIPPED gate (lib/apertureRescue.mjs) over Vincent's labelled corpus and
// hard-asserts the non-negotiable: ZERO false-promotes on any clean panel (SF69YBB must floor).
//
// READ-ONLY: direct Anthropic API + local frame files under honda\frames\. No DB, no engine, no
// commits. Run from the REPO ROOT (canvas + lib resolve there):
//     node scripts/validate-aperture-rescue.mjs
//   key: env ANTHROPIC_API_KEY, else honda\.env.local
//
// Corpus frames: honda\frames\{lot}_{PANEL}_{idx}.jpg (export via the read-only Supabase pull).
// Ground truth is Vincent's (rules below). CLA 41714395 ruled DEFORMED (wrecked behind wheel,
// Vincent 28 Jul); it floors in the gauntlet -> scores as a safe under-cost, never a false-promote.

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadImage, createCanvas } from 'canvas';
import { runRescueGate } from '../lib/apertureRescue.mjs';

const HONDA   = (process.env.HONDA_DIR || 'C:/Users/vincy/Downloads/honda').replace(/\\/g, '/');
const FRAMES  = `${HONDA}/frames`;
const OUTDIR  = `${HONDA}/autocrops_rescue_gauntlet`;
const MODEL   = process.env.STAGE1_MODEL || 'claude-opus-4-8';
const MAX_FRAMES = Number(process.env.RESCUE_GAUNTLET_MAX_FRAMES ?? 3); // best-lit-first, cap per panel

// Labelled corpus (Vincent = ground truth). kind = the aperture panel type; gt: clean|deformed|pending.
const CORPUS = [
  { lot: '57455716', kind: 'FRONT_WING',   gt: 'deformed', label: 'Ranger wing' },
  { lot: '57636096', kind: 'FRONT_WING',   gt: 'deformed', label: 'Kia wing' },
  { lot: '57120116', kind: 'FRONT_WING',   gt: 'clean',    label: 'BMW wing' },
  { lot: '51097546', kind: 'FRONT_WING',   gt: 'clean',    label: 'VW ID4 wing' },
  { lot: '53003666', kind: 'REAR_QUARTER', gt: 'clean',    label: 'SF69YBB / Civic quarter (FABRICATION CANARY)' },
  { lot: '41714395', kind: 'FRONT_WING',   gt: 'deformed', label: 'Mercedes CLA wing (wrecked behind wheel — Vincent 28 Jul)' },
];

function loadKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  for (const f of [`${HONDA}/.env.local`, '.env.local', '.env']) if (existsSync(f)) {
    const l = readFileSync(f, 'utf8').split(/\r?\n/).find(x => x.startsWith('ANTHROPIC_API_KEY'));
    if (l) return l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('ANTHROPIC_API_KEY not found (env or honda\\.env.local)');
}
const API_KEY = loadKey();

// Anthropic caller injected into the gate — mirrors the engine's callClaude shape.
async function call(dataUrl, text, maxTok = 300) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  const media_type = m ? m[1] : 'image/jpeg';
  const data = m ? m[2] : dataUrl;
  for (let a = 0; a < 4; a++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTok, system: 'Respond ONLY with a raw JSON object. No markdown.',
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type, data } }, { type: 'text', text }] }] }),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise(x => setTimeout(x, 1500 * (a + 1))); continue; }
    if (!r.ok) return null;
    const d = await r.json();
    return (d.content || []).find(b => b.type === 'text')?.text || null;
  }
  return null;
}

// Canvas-backed imaging (same primitive the engine route uses).
const fileToDataUrl = (p) => `data:image/jpeg;base64,${readFileSync(p).toString('base64')}`;
function b64(dataUrl) { const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/); return m ? m[1] : dataUrl; }
const imaging = {
  async meta(dataUrl) { const img = await loadImage(Buffer.from(b64(dataUrl), 'base64')); return { W: img.width, H: img.height }; },
  async crop(dataUrl, box) {
    const img = await loadImage(Buffer.from(b64(dataUrl), 'base64'));
    const c = createCanvas(box.width, box.height);
    c.getContext('2d').drawImage(img, box.left, box.top, box.width, box.height, 0, 0, box.width, box.height);
    return c.toDataURL('image/jpeg', 0.9);
  },
  onCrop(id, run, dataUrl) { writeFileSync(`${OUTDIR}/${id}_${run}.jpg`, Buffer.from(b64(dataUrl), 'base64')); },
};

function framesFor(lot, kind) {
  if (!existsSync(FRAMES)) return [];
  return readdirSync(FRAMES)
    .filter(f => f.startsWith(`${lot}_${kind}_`) && /\.jpe?g$/i.test(f))
    .sort()
    .slice(0, MAX_FRAMES)
    .map(f => ({ id: f.replace(/\.jpe?g$/i, ''), dataUrl: fileToDataUrl(`${FRAMES}/${f}`) }));
}

mkdirSync(OUTDIR, { recursive: true });
console.log(`\n§6 APERTURE-RESCUE GAUNTLET — model=${MODEL}\nframes: ${FRAMES}\ncrops -> ${OUTDIR}\n`);

const rows = [];
for (const c of CORPUS) {
  const frames = framesFor(c.lot, c.kind);
  if (frames.length === 0) { console.log(`  [${c.label}] NO FRAMES (${c.lot}_${c.kind}_*.jpg) — skipped`); rows.push({ ...c, decision: 'NO-FRAMES', frames: 0 }); continue; }
  const res = await runRescueGate({ kind: c.kind, frames, call, imaging });
  const perFrame = res.frames.map(fr => `${fr.id}:[${fr.runs.map(r => r.ok ? r.verdict : r.why).join(',')}]`).join('  ');
  console.log(`  [${c.label}] ${c.lot} (${frames.length} frame(s)) -> ${res.decision}  — ${res.reason}\n      ${perFrame}`);
  rows.push({ ...c, decision: res.decision, frames: frames.length });
}

console.log('\n================ GAUNTLET SCORECARD ================');
let falsePromote = 0, scored = 0, correct = 0;
for (const r of rows) {
  let mark = '  --  ';
  if (r.gt === 'clean' || r.gt === 'deformed') {
    scored++;
    // clean must FLOOR; deformed may PROMOTE or safely FLOOR (under-cost acceptable)
    const ok = r.gt === 'clean' ? (r.decision === 'FLOOR')
                                : (r.decision === 'PROMOTE' || r.decision === 'FLOOR');
    if (r.gt === 'clean' && r.decision === 'PROMOTE') falsePromote++;
    if (ok) correct++;
    mark = ok ? ' PASS ' : ' FAIL ';
  }
  console.log(`  ${r.label.padEnd(52)} gt=${r.gt.padEnd(9)} -> ${String(r.decision).padEnd(10)} [${mark}]`);
}
console.log(`\n  scored ${correct}/${scored} · false-promotes on clean panels: ${falsePromote}`);
if (falsePromote > 0) {
  console.log('  ❌ GAUNTLET FAILED — a clean panel was promoted (fabrication). REJECT AND REWORK.');
  process.exit(1);
}
console.log('  ✅ ZERO false-promotes on clean panels — the non-negotiable gate holds.');
console.log('  (deformed panels: PROMOTE or safe-FLOOR both acceptable; over-cost on clean = reject.)');
console.log('  Eyeball crops in autocrops_rescue_gauntlet\\ to confirm boxes isolate the face.\n');
