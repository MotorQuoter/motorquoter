// ─────────────────────────────────────────────────────────────────────────────
// Aperture Rescue Gate (Stage 1) — confidence-gated crop PROMOTE path.
// ─────────────────────────────────────────────────────────────────────────────
// Recovers a genuinely-deformed panel that 8c097fa's aperture floor demoted with a
// `torn` verdict, WITHOUT re-opening the SF69YBB fabrication. The demote stays the
// default; this gate can only PROMOTE a floored `torn` panel back to costed on high
// confidence, and otherwise leaves it floored (today's behaviour).
//
// Ported verbatim from the validated probe run_autocrop_gated.mjs (Stage-0/1: clean vs
// deformed separated 5/5; gated pipeline promoted only genuinely-destroyed panels).
//
// SAFE-BY-CONSTRUCTION. The PROMOTE rule is the STRICT aggregation ratified by Vincent
// (28 Jul), chosen so a clean panel can never be promoted:
//     PROMOTE iff  (>=1 frame returns a UNANIMOUS face-deformed decision)
//              AND (NO frame returns ANY face-clean read).
//     `cannot-determine` abstains (never promotes, never blocks another frame's promote).
// A clean panel reads face-clean on at least one well-exposed frame -> FLOOR. A genuinely
// deformed panel reads deformed-or-cannot-determine (never clean) -> promotes when any
// frame is legible. Every residual error is a SAFE under-cost (floor), never a fabricated cost.
//
// Decision-only + injected deps (call / imaging) so the engine route and the validation
// harness (scripts/validate-aperture-rescue.mjs) exercise byte-identical logic.

// Box-inset knobs — env-tunable for validation sweeps; adaptive floor stops a narrow box
// (e.g. Kia) being starved into ambiguity while still trimming a wide box (BMW engine-bay leak).
export const RESCUE_INSET_SIDE   = Number(process.env.APERTURE_RESCUE_INSET_SIDE   ?? 0.11);
export const RESCUE_INSET_TOP    = Number(process.env.APERTURE_RESCUE_INSET_TOP    ?? 0.08);
export const RESCUE_INSET_BOTTOM = Number(process.env.APERTURE_RESCUE_INSET_BOTTOM ?? 0.22);
export const RESCUE_MIN_W        = Number(process.env.APERTURE_RESCUE_MIN_W ?? 200);
export const RESCUE_MIN_H        = Number(process.env.APERTURE_RESCUE_MIN_H ?? 140);
export const RESCUE_REPEATS      = Number(process.env.APERTURE_RESCUE_REPEATS ?? 3);

// Only these two panel kinds are ever aperture-flagged (front-corner wing / rear-corner quarter).
export const RESCUE_PANEL_DESC = {
  FRONT_WING:   'front wing / front fender (painted panel above the FRONT wheel, behind the headlamp)',
  REAR_QUARTER: 'rear quarter panel (painted panel above the REAR wheel, behind the rear door)',
};

const READ_ENUM = ['face-deformed', 'face-clean', 'cannot-determine'];

// The challenge read — judges ONLY the panel's own painted face and explicitly discounts
// exposed structure. Verbatim from the probe (Q_CHALLENGE); its abstain-to-inspection
// (`cannot-determine`) behaviour is a FEATURE and must be preserved.
export const RESCUE_CHALLENGE = `You are judging one vehicle body panel from a salvage photo. Exposure created by component removal — whether torn off by impact or stripped for assessment — is NOT evidence of damage to the parts now visible. Newly exposed substrate, mounting points, brackets, recesses and locating edges are the normal appearance of a stripped or opened zone. Judge ONLY the panel's own outer painted face: does it show deformation or damage (creasing, folding, buckling, cracked paint on the face itself) INDEPENDENT of the fact that adjacent structure is now visible?\n\nRespond with ONLY raw JSON:\n{ "verdict": "face-deformed" | "face-clean" | "cannot-determine", "evidence": "<one short sentence>" }`;

// Localise prompt — tight box on the panel's own painted face + the panel it's actually on
// (the panel-name check below rejects a box that drifted to the wrong panel, e.g. Civic boot).
export function rescueLocalisePrompt(desc, w, h) {
  return `This is a salvage vehicle photo, ${w}x${h} px, with crash damage and some parts removed. Find the ${desc}. Return a tight bounding box around ONLY that panel's own outer PAINTED face — EXCLUDE bumper, wheel, wheel-arch and its lip, exposed structure, brackets, engine bay, headlamp, glass — AND state which panel your box is actually on.\n\nRESPOND ONLY raw JSON (integers):\n{ "x":<left>,"y":<top>,"w":<width>,"h":<height>,"panel_on":"<what panel the box sits on>" }`;
}

// Does the model's stated panel match the flagged panel type? Rejects boot/hood/door/etc drift.
export function rescuePanelMatches(kind, name) {
  const s = (name || '').toLowerCase();
  const bad = ['bumper', 'hood', 'bonnet', 'door', 'trunk', 'boot', 'headlamp', 'grille', 'sill', 'roof', 'glass', 'windscreen'];
  if (bad.some(b => s.includes(b))) {
    // allow only if it ALSO names the wing/fender (a compound label like "front wing / fender")
    if (!(kind === 'FRONT_WING' && (s.includes('wing') || s.includes('fender')))) return false;
  }
  if (kind === 'FRONT_WING')   return s.includes('wing') || s.includes('fender');
  if (kind === 'REAR_QUARTER') return s.includes('quarter');
  return false;
}

// Adaptive inset: trim sides/top (exposed structure) + bottom (wheel arch), capped so the box
// never shrinks below RESCUE_MIN_W x RESCUE_MIN_H — narrow boxes keep their width; wide boxes
// still get the full side-trim. `b` = clamped {left,top,width,height}; W,H = image dims.
export function rescueInsetBox(b, W, H) {
  let ix = Math.round(b.width * RESCUE_INSET_SIDE);
  let it = Math.round(b.height * RESCUE_INSET_TOP);
  let ib = Math.round(b.height * RESCUE_INSET_BOTTOM);
  // width floor: cap side trim so the box stays >= RESCUE_MIN_W
  ix = Math.min(ix, Math.max(0, Math.floor((b.width - RESCUE_MIN_W) / 2)));
  // height floor: scale top+bottom trim down together so the box stays >= RESCUE_MIN_H
  const maxV = Math.max(0, b.height - RESCUE_MIN_H);
  if (it + ib > maxV) { const s = (it + ib) ? maxV / (it + ib) : 0; it = Math.round(it * s); ib = Math.round(ib * s); }
  const left = Math.max(0, b.left + ix), top = Math.max(0, b.top + it);
  const width = Math.max(8, Math.min(b.width - 2 * ix, W - left));
  const height = Math.max(8, Math.min(b.height - it - ib, H - top));
  return { left, top, width, height };
}

// Pull the first JSON object out of a model text response; null on absence/parse failure.
function parseJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// DECISION — the ratified strict aggregation. `frameResults` = per-frame { verdicts: [...] }
// where verdicts are the VALID reads (face-deformed / face-clean / cannot-determine) for that
// frame; invalid runs (loc-fail / wrong-panel) are already excluded upstream.
export function decideRescue(frameResults) {
  const anyClean = frameResults.some(fr => fr.verdicts.includes('face-clean'));
  if (anyClean) return { decision: 'FLOOR', reason: 'face-clean read on a frame (clean panel — no promote)' };
  const unanimousFrame = frameResults.some(fr =>
    fr.verdicts.length >= 2 && fr.verdicts.every(v => v === 'face-deformed'));
  return unanimousFrame
    ? { decision: 'PROMOTE', reason: 'a frame unanimously face-deformed, and no frame read face-clean' }
    : { decision: 'FLOOR', reason: 'no frame reached >=2 unanimous face-deformed' };
}

// Run the gate for one candidate panel over its (best-lit-first) frames.
//   kind    : 'FRONT_WING' | 'REAR_QUARTER'
//   frames  : [{ id, dataUrl }]  — the panel's targeted frames (2-3), base64 data URLs
//   call    : async (dataUrl, promptText, maxTokens) => rawTextResponse|null   (Anthropic)
//   imaging : { meta(dataUrl) => {W,H}, crop(dataUrl, {left,top,width,height}) => dataUrl,
//               onCrop?(id, runIdx, dataUrl, box) }  — canvas-backed in both route + harness
//   repeats : reads per frame (default RESCUE_REPEATS = 3)
// Returns { decision, reason, frames: [{ id, runs: [...] }] } — never throws; any failure -> FLOOR.
export async function runRescueGate({ kind, frames, call, imaging, repeats = RESCUE_REPEATS }) {
  const desc = RESCUE_PANEL_DESC[kind];
  if (!desc || !Array.isArray(frames) || frames.length === 0) {
    return { decision: 'FLOOR', reason: 'no panel description or no frames', frames: [] };
  }
  const frameResults = [];
  const detail = [];
  for (const frame of frames) {
    const runs = [];
    const verdicts = [];
    let W, H;
    try { ({ W, H } = await imaging.meta(frame.dataUrl)); } catch { W = 0; H = 0; }
    if (!W || !H) { detail.push({ id: frame.id, runs: [{ ok: false, why: 'meta-fail' }] }); continue; }
    for (let i = 0; i < repeats; i++) {
      let loc = null;
      try { loc = parseJsonObject(await call(frame.dataUrl, rescueLocalisePrompt(desc, W, H), 200)); } catch { loc = null; }
      if (!loc || ![loc.x, loc.y, loc.w, loc.h].every(Number.isFinite)) { runs.push({ ok: false, why: 'loc-fail' }); continue; }
      if (!rescuePanelMatches(kind, loc.panel_on)) { runs.push({ ok: false, why: `wrong-panel(${loc.panel_on || ''})` }); continue; }
      const clamped = {
        left:   Math.max(0, Math.min(Math.round(loc.x), W - 2)),
        top:    Math.max(0, Math.min(Math.round(loc.y), H - 2)),
        width:  Math.max(8, Math.min(Math.round(loc.w), W)),
        height: Math.max(8, Math.min(Math.round(loc.h), H)),
      };
      const box = rescueInsetBox(clamped, W, H);
      let crop;
      try { crop = await imaging.crop(frame.dataUrl, box); } catch { runs.push({ ok: false, why: 'crop-fail' }); continue; }
      imaging.onCrop?.(frame.id, i + 1, crop, box);
      let rd = null;
      try { rd = parseJsonObject(await call(crop, RESCUE_CHALLENGE, 300)); } catch { rd = null; }
      const verdict = rd && READ_ENUM.includes(rd.verdict) ? rd.verdict : 'cannot-determine';
      runs.push({ ok: true, verdict, box, evidence: (rd && typeof rd.evidence === 'string') ? rd.evidence : '' });
      verdicts.push(verdict);
    }
    frameResults.push({ id: frame.id, verdicts });
    detail.push({ id: frame.id, runs });
  }
  const { decision, reason } = decideRescue(frameResults);
  return { decision, reason, frames: detail };
}
