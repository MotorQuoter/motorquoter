import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { createCanvas, loadImage } from 'canvas';
import { ASSESSMENT_ENGINE_PROMPT } from '@/config/assessmentEngine';
import { feeStack } from '@/lib/copartFees';
import { logEvent } from '@/lib/analytics';
import { getMileageForValuation } from '@/lib/getMileageForValuation';
import { withOneAutoCache } from '@/lib/oneautoCache';

export const maxDuration = 300;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

const HEADLAMP_BANDS = {
  halogen: 150, // S/H unit + fitted, GBP
  hid:     250, // HID / projector unit + fitted
  led:     350, // LED / adaptive / matrix unit + fitted
};
const HEADLAMP_BAND_DEFAULT = 'led'; // conservative high — indeterminate spec always defaults here

const ASSESSMENT_FIELDS = [
  'Visible Damage Summary',
  'Parts Breakdown',
  'Key Cost Drivers',
  'Red Flags',
  'Alternative Damage Scenario',
  'Airbags',
  'Confidence Level',
  'Bidder Note',
  'Recommended Action',
  'Realistic Exit Value',
  'Margin Calculation',
  'WhatsApp Inspection Checklist',
];

function parseAssessment(text) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const clean = text
    .replace(/\*{1,3}/g, '')
    .replace(/^\s*[-=_]{3,}\s*$/gm, '');

  const positions = [];
  for (const field of ASSESSMENT_FIELDS) {
    const patterns = [
      new RegExp('^#{1,6}\\s*' + esc(field) + '\\s*$', 'im'),
      new RegExp('^\\s*' + esc(field) + '\\s*:', 'im'),
    ];
    for (const rx of patterns) {
      const m = clean.match(rx);
      if (m !== null) {
        positions.push({ field, start: m.index, afterColon: m.index + m[0].length });
        break;
      }
    }
  }
  positions.sort((a, b) => a.start - b.start);

  const result = {};
  for (let i = 0; i < positions.length; i++) {
    const { field, afterColon } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : clean.length;
    result[field] = clean.slice(afterColon, end).trim();
  }
  return result;
}

function catLetter(s) {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  let m = t.match(/^cat(?:egory)?\s+([snabcd])\b/);
  if (m) return m[1];
  m = t.match(/^([snabcd])\s+repairable/);
  if (m) return m[1];
  m = t.match(/^([snabcd])$/);
  if (m) return m[1];
  return null;
}

function tagSelfReference(shResult, vd) {
  if (!shResult) return;
  const records = shResult.salvage_auction_records || [];
  if (records.length !== 1) { shResult.isSelfReferenceFirstWriteOff = false; return; }
  const rec = records[0];
  let currentMileage = null;
  if (vd.copartListedMileage != null) {
    currentMileage = Number(vd.copartListedMileage);
  } else if (vd.odometer != null) {
    const n = parseInt(String(vd.odometer).replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n)) currentMileage = n;
  }
  const mileageMatch = currentMileage != null && rec.mileage != null
    ? Math.abs(rec.mileage - currentMileage) <= 50
    : null;
  const recCat = catLetter(rec.salvage_auction_lot_desc);
  const curCat = catLetter(vd.category);
  const categoryMatch = recCat != null && curCat != null && recCat === curCat;
  const damageMatch = vd.primaryDamage != null && rec.primary_damage_desc != null
    && rec.primary_damage_desc.toLowerCase().trim() === vd.primaryDamage.toLowerCase().trim();
  shResult.isSelfReferenceFirstWriteOff =
    (mileageMatch === true && categoryMatch && damageMatch) ||
    (mileageMatch === null && categoryMatch && damageMatch);
}

const LAMP_DETECTION_CONFIDENT_WORDING = false; // flip to true after false-positive guard passes (present-but-bumper-off lot)

// Fetch all lot images from Supabase Storage as base64 data URLs.
// Throws if any image cannot be retrieved — partial image sets are the unsafe failure mode.
async function fetchImagesFromStorage(supabase, imagePaths) {
  return Promise.all(imagePaths.map(async (path, i) => {
    const { data: blob, error } = await supabase.storage.from('lot-images').download(path);
    if (error || !blob) {
      throw new Error(`Storage fetch failed for image ${i + 1} of ${imagePaths.length}: ${error?.message || 'file not found'}`);
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }));
}

// Resize a stored base64 image to max 1024px longest edge for Haiku odo call only.
// Haiku's ceiling is 1568 TOKENS (not pixels); a 1568px image (~2,458 tokens) exceeds
// it, triggering API-side downsampling + double-JPEG that smears digits. 1024px keeps
// every image under the token ceiling with a single clean encode.
async function resizeToHaikuSafe(img) {
  const MAX = 1024;
  let mediaType = 'image/jpeg';
  let src = img;
  const m = img.match(/^data:([^;]+);base64,(.+)$/);
  if (m) { mediaType = m[1]; src = m[2]; }
  try {
    const loaded = await loadImage(Buffer.from(src, 'base64'));
    const { width, height } = loaded;
    if (width <= MAX && height <= MAX) {
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: src } };
    }
    const scale = MAX / Math.max(width, height);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const canvas = createCanvas(w, h);
    canvas.getContext('2d').drawImage(loaded, 0, 0, w, h);
    const data = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
  } catch {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: src } };
  }
}

async function runLampDetection(images) {
  try {
    const imageBlocks = images.slice(0, 20).map(img => {
      let mediaType = 'image/jpeg';
      let data = img;
      const m = img.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mediaType = m[1]; data = m[2]; }
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    });
    const userText = `Examine ALL images carefully before forming any verdict — survey every photo to locate the front corners before deciding.

For EACH front headlamp position (both corners), determine whether a headlamp unit is physically present in the aperture or the mount is empty. A displaced bumper can expose an empty recess that looks occupied — judge whether an actual lens/reflector/lamp body is present, not just that the recess is visible. Report per corner. Describe each corner by its relation to the body damage (e.g. 'the corner with the major impact damage' / 'the undamaged corner') or as left/right as viewed — do NOT use offside/nearside. Also state the lamp TYPE if determinable (halogen / HID / LED-adaptive).

Respond with a JSON array only — no markdown, no explanation, nothing else:
[
  {
    "corner_descriptor": "brief description identifying the corner",
    "verdict": "present" | "missing" | "cannot_determine",
    "lamp_type": "halogen" | "hid" | "led" | "indeterminate",
    "evidence": "one sentence describing what you can see"
  }
]`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 600,
        system: 'You are a vehicle damage assessor. Respond ONLY with a valid JSON array. No markdown, no explanation, no surrounding text.',
        messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: userText }] }],
      }),
    });
    if (!res.ok) { console.warn('[LAMP DETECT] API error:', res.status); return null; }
    const data = await res.json();
    console.log('[TOKEN LOG] lamp-detect Input:', data.usage?.input_tokens, '| Output:', data.usage?.output_tokens, '| Model:', data.model || 'unknown');
    const raw = (data.content?.[0]?.text || '').trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) { console.warn('[LAMP DETECT] no JSON array in response:', raw.slice(0, 200)); return null; }
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.warn('[LAMP DETECT] error:', err.message);
    return null;
  }
}

function selectStruckCornerVerdict(corners) {
  if (!Array.isArray(corners) || corners.length === 0) return null;
  // A 'missing' verdict is the strongest signal — prefer it
  const missingCorner = corners.find(c => c.verdict === 'missing');
  if (missingCorner) return missingCorner;
  // Look for damage keywords in descriptor or evidence
  const DAMAGE_MARKERS = /damage|struck|impact|deformed|crushed|displaced bumper|exposed recess|major/i;
  const damagedCorner = corners.find(c =>
    DAMAGE_MARKERS.test(c.corner_descriptor || '') ||
    DAMAGE_MARKERS.test(c.evidence || '')
  );
  if (damagedCorner) return damagedCorner;
  // Single corner reported — use it
  if (corners.length === 1) return corners[0];
  return null; // ambiguous — fall back to cannot_determine
}

function deriveLampType(vd) {
  const make     = (vd.make  || '').toLowerCase().replace(/[-\s]/g, '');
  const model    = (vd.model || '').toLowerCase();
  const year     = parseInt(vd.year, 10) || 0;
  const specText = [vd.model, vd.engineSize, vd.bodyStyle, vd.damageDescription]
    .filter(Boolean).join(' ').toLowerCase();

  // Explicit lamp-type markers in spec text override derivation
  if (/\b(full[\s-]?led|matrix[\s-]?led|adaptive[\s-]?led|laser[\s-]?headlamp)\b/.test(specText)) return 'led';
  if (/\bxenon\b|\bbi[\s-]?xenon\b|\bhid\b/.test(specText)) return 'hid';

  // Tesla — always LED
  if (make === 'tesla') return 'led';

  // Lexus — LED standard on recent models
  if (make === 'lexus' && year >= 2016) return 'led';

  // Toyota
  if (make === 'toyota') {
    // Yaris Gen3 (2011-2019) — halogen across all trims; GR Yaris starts 2020
    if (model.includes('yaris') && year >= 2011 && year <= 2019) return 'halogen';
    // Aygo (2014-2021) — halogen
    if (model.includes('aygo') && year >= 2014 && year <= 2021) return 'halogen';
    // GT86 (2012-2021) — halogen
    if ((model.includes('gt86') || model.includes('gt 86')) && year >= 2012 && year <= 2021) return 'halogen';
  }

  // Ford
  if (make === 'ford') {
    // Fiesta Mk7/7.5/8 (2012-2022) — halogen standard; LED optional pack, not pinnable without trim
    if (model.includes('fiesta') && year >= 2012 && year <= 2022) return 'halogen';
    // Focus Mk3 (2011-2018) — halogen standard
    if (model.includes('focus') && year >= 2011 && year <= 2018) return 'halogen';
    // Ka/Ka+ (2008-2021) — halogen
    if (model.includes('ka') && year >= 2008 && year <= 2021) return 'halogen';
  }

  // Vauxhall / Opel
  if (make === 'vauxhall' || make === 'opel') {
    // Corsa D (2006-2014) and E (2014-2019) — halogen
    if (model.includes('corsa') && year >= 2006 && year <= 2019) return 'halogen';
    // Astra K (2015-2021) — halogen standard
    if (model.includes('astra') && year >= 2015 && year <= 2021) return 'halogen';
    // Adam — halogen
    if (model.includes('adam') && year >= 2012 && year <= 2019) return 'halogen';
  }

  // Volkswagen
  if (make === 'volkswagen' || make === 'vw') {
    // Polo (6R 2009-2017 / AW 2018-2022) — halogen standard across trims
    if (model.includes('polo') && year >= 2009 && year <= 2022) return 'halogen';
    // Up! (2012-2019) — halogen
    if (model.includes('up') && year >= 2012 && year <= 2019) return 'halogen';
  }

  // Renault
  if (make === 'renault') {
    // Clio III/IV (2012-2019) — halogen standard
    if (model.includes('clio') && year >= 2012 && year <= 2019) return 'halogen';
    // Megane IV (2016-2022) — halogen standard on most trims
    if ((model.includes('megane') || model.includes('mégane')) && year >= 2016 && year <= 2022) return 'halogen';
    // Twingo III (2014-2022) — halogen
    if (model.includes('twingo') && year >= 2014 && year <= 2022) return 'halogen';
  }

  // Nissan
  if (make === 'nissan') {
    // Micra K13 (2010-2016) — halogen
    if (model.includes('micra') && year >= 2010 && year <= 2016) return 'halogen';
    // Juke Mk1 (2010-2019) — halogen standard
    if (model.includes('juke') && year >= 2010 && year <= 2019) return 'halogen';
    // Note (2012-2016) — halogen
    if (model.includes('note') && year >= 2012 && year <= 2016) return 'halogen';
  }

  // Seat
  if (make === 'seat') {
    // Ibiza 5th gen (2017-2021) — halogen standard
    if (model.includes('ibiza') && year >= 2017 && year <= 2021) return 'halogen';
    // Mii (2012-2019) — halogen
    if (model.includes('mii') && year >= 2012 && year <= 2019) return 'halogen';
  }

  // Skoda
  if (make === 'skoda') {
    // Fabia (2014-2021) — halogen standard
    if (model.includes('fabia') && year >= 2014 && year <= 2021) return 'halogen';
    // Citigo (2012-2019) — halogen
    if (model.includes('citigo') && year >= 2012 && year <= 2019) return 'halogen';
  }

  // Kia / Hyundai — halogen standard on city/supermini models pre-2020
  if (make === 'kia') {
    if ((model.includes('rio') || model.includes('picanto') || model.includes('stonic')) && year >= 2011 && year <= 2019) return 'halogen';
  }
  if (make === 'hyundai') {
    if ((model.includes('i10') || model.includes('i20')) && year >= 2013 && year <= 2019) return 'halogen';
  }

  // Honda
  if (make === 'honda') {
    // Jazz Mk3 (2015-2020) — halogen standard
    if (model.includes('jazz') && year >= 2015 && year <= 2020) return 'halogen';
    // Civic Mk10 (2017-2022) — halogen standard on entry trims
    if (model.includes('civic') && year >= 2017 && year <= 2019) return 'halogen';
  }

  // Fiat
  if (make === 'fiat') {
    // 500 (2007-2023) — halogen standard
    if (model.includes('500') && year >= 2007 && year <= 2022) return 'halogen';
    // Panda (2012-2021) — halogen
    if (model.includes('panda') && year >= 2012 && year <= 2021) return 'halogen';
  }

  // Universal floor: pre-2011 vehicles are essentially all halogen
  if (year > 0 && year <= 2010) return 'halogen';

  return 'indeterminate';
}

function computeLampResult(struckSide, apertureExposed, lampType, detectionVerdict = null, detectionLampType = null, damageSpan = 'single_corner') {
  // struckSide kept as internal field for logging only — never interpolated into rendered strings
  const side = (struckSide === 'offside' || struckSide === 'nearside') ? struckSide : 'central';

  // Band selection: take the HIGHER of spec-derived and detection-reported (never under-budget)
  const LAMP_RANK    = { halogen: 1, hid: 2, led: 3 };
  const specAssumed      = !HEADLAMP_BANDS[lampType];
  const resolvedSpecType = specAssumed ? HEADLAMP_BAND_DEFAULT : lampType;
  const resolvedDetType  = (detectionLampType && HEADLAMP_BANDS[detectionLampType]) ? detectionLampType : null;
  const resolvedType     = (resolvedDetType && (LAMP_RANK[resolvedDetType] ?? 0) > (LAMP_RANK[resolvedSpecType] ?? 0))
    ? resolvedDetType : resolvedSpecType;
  const bandValue       = HEADLAMP_BANDS[resolvedType];
  const lampTypeAssumed = specAssumed && !resolvedDetType;

  // Lamp count from geometry: full-width frontal implies both lamps implicated
  const lampCount = (apertureExposed && damageSpan === 'full_width') ? 2 : 1;

  const assumedDisclosure = ' Lamp type could not be confirmed from the vehicle spec, so the higher LED/adaptive band has been used to avoid under-budgeting — confirm the actual lamp type and unit cost on inspection; a halogen unit would be materially cheaper.';
  const tier1Line = 'Struck front corner — confirm a serviceable headlamp on inspection.';

  if (!apertureExposed) {
    return { tier: 1, tier2Fired: false, struckSide: side, tier1Line, lampType: resolvedType, lampTypeAssumed, lampAllowance: 0, lampCount: 1 };
  }

  // Verdict branch: toggle gates confident 'missing' wording; detection is authoritative otherwise
  const effectiveVerdict = (detectionVerdict === 'missing' && !LAMP_DETECTION_CONFIDENT_WORDING)
    ? 'cannot_determine'
    : (detectionVerdict || 'cannot_determine');

  const checklistEntry = 'Show the struck-side front headlamp aperture with the bumper pulled clear — confirm the actual headlamp type and that a serviceable unit is fitted, not just an exposed recess.';

  if (effectiveVerdict === 'present') {
    // Cost always applies on apertureExposed — a displaced-bumper aperture makes photo evidence
    // unreliable regardless of what appears present. Verdict controls wording only.
    let verdictLine = `Struck front corner headlamp — the front headlamp on the damaged corner appears present; however, on a displaced-bumper impact the aperture is unreliable and serviceability cannot be confirmed from photos. Replacement costed at £${bandValue} (${resolvedType}) as a precautionary allowance.`;
    verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
    const costDriverEntry = lampTypeAssumed
      ? `Struck front corner headlamp — appears present but serviceability unconfirmed; precautionary replacement costed at £${bandValue} (${resolvedType}, assumed).`
      : `Struck front corner headlamp — appears present but serviceability unconfirmed; precautionary replacement costed at £${bandValue} (${resolvedType}).`;
    return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, lampCount, detectionVerdict, effectiveVerdict };
  }

  if (effectiveVerdict === 'missing') {
    let verdictLine = `Struck front corner headlamp — the front headlamp on the damaged corner is missing. Replacement costed at £${bandValue} (${resolvedType}).`;
    verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
    const costDriverEntry = lampTypeAssumed
      ? `Struck front corner headlamp — missing; replacement costed at £${bandValue} (${resolvedType}, assumed).`
      : `Struck front corner headlamp — missing; replacement costed at £${bandValue} (${resolvedType}).`;
    return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, lampCount, detectionVerdict, effectiveVerdict };
  }

  // cannot_determine — default path and toggle-OFF 'missing'
  let verdictLine = `Struck front corner headlamp — on a displaced-bumper front-corner impact the headlamp is treated as a replacement; presence and serviceability cannot be confirmed from the photos. Replacement costed at £${bandValue} (${resolvedType}).`;
  verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
  const costDriverEntry = lampTypeAssumed
    ? `Struck front corner headlamp — replacement costed at £${bandValue} (${resolvedType}, assumed).`
    : `Struck front corner headlamp — replacement costed at £${bandValue} (${resolvedType}).`;
  return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, lampCount, detectionVerdict, effectiveVerdict };
}

// ── Parts Breakdown helpers ──────────────────────────────────────────────────

function parsePrice(s) {
  if (!s || /^[—\-–]+$|n\/a|nil|none/i.test(s.trim())) return null;
  const m = s.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
  return m ? Math.round(parseFloat(m[0])) : null;
}

function parseParts(text) {
  if (!text) return [];
  const result = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(?:\d+[.)]\s*)?(.+?)\s*\|\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*$/);
    if (!m) continue;
    const [, name, action, col3, col4] = m;
    result.push({ name: name.trim(), action: action.trim(), oem: parsePrice(col3), used: parsePrice(col4) });
  }
  return result;
}

function isLampLine(name) {
  return /\bhead[\s-]?lamp\b|\bheadlight\b|\bfront\s+lamp\b/i.test(name);
}

function reconcileParts(parts, lampResult) {
  if (!lampResult?.tier2Fired || !lampResult.lampAllowance) {
    return { parts, lamp_delta: 0, lamp_inserted: false, lamp_count: 0 };
  }
  const band      = lampResult.lampAllowance;
  const lampCount = lampResult.lampCount ?? 1;

  // Collect all lamp lines the model already priced
  const lampIndices = [];
  parts.forEach((p, i) => { if (isLampLine(p.name)) lampIndices.push(i); });

  let lamp_delta = 0;
  let workParts  = [...parts];

  // Reconcile existing lamp lines up to lampCount: raise to band if below, leave if at/above
  const toReconcile = Math.min(lampCount, lampIndices.length);
  for (let n = 0; n < toReconcile; n++) {
    const idx        = lampIndices[n];
    const modelCost  = workParts[idx].used ?? workParts[idx].oem ?? 0;
    const effective  = Math.max(modelCost, band);
    lamp_delta      += effective - modelCost;
    workParts        = workParts.map((item, i) => i === idx ? { ...item, oem: null, used: effective } : item);
  }

  // Insert additional lamp lines for any the model under-counted
  const toInsert = lampCount - lampIndices.length;
  for (let n = 0; n < Math.max(toInsert, 0); n++) {
    lamp_delta += band;
    const labourIdx = workParts.findIndex(p => /labour|paint|prep/i.test(p.name));
    const at = labourIdx >= 0 ? labourIdx : workParts.length;
    workParts = [
      ...workParts.slice(0, at),
      { name: 'Front headlamp', action: 'replace', oem: null, used: band, _inserted: true },
      ...workParts.slice(at),
    ];
  }

  // lamp_inserted = true whenever the code-owned floor was activated (tier2Fired + lampAllowance)
  return { parts: workParts, lamp_delta, lamp_inserted: true, lamp_count: lampCount };
}

function sumPartsRealistic(parts) {
  return parts.reduce((acc, p) => acc + (p.used ?? p.oem ?? 0), 0);
}

function renderParts(parts) {
  return parts.map((p, i) => {
    const oem  = p.oem  != null ? `£${p.oem}`  : '—';
    const used = p.used != null ? `£${p.used}` : '—';
    return `${i + 1}. ${p.name} | ${p.action} | ${oem} | ${used}`;
  }).join('\n');
}

function parseExitValue(text) {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/£(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const stripeSessionId = searchParams.get('session_id');
  const salvageId = searchParams.get('salvage_id');
  const promoToken = searchParams.get('promo_token');

  if (!salvageId || (!stripeSessionId && !promoToken)) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  const supabase = getSupabase();

  try {
    if (promoToken) {
      const { data: tokenCheck } = await supabase
        .from('salvage_sessions')
        .select('vehicle_details')
        .eq('id', salvageId)
        .single();
      if (!tokenCheck || tokenCheck.vehicle_details?.promoToken !== promoToken) {
        return NextResponse.json({ error: 'Invalid promo token' }, { status: 403 });
      }
    } else {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const stripeSession = await stripe.checkout.sessions.retrieve(stripeSessionId);
      if (stripeSession.payment_status !== 'paid') {
        return NextResponse.json({ error: 'Payment not confirmed' }, { status: 402 });
      }
    }

    if (promoToken) {
      const { data: claimed } = await supabase
        .from('salvage_sessions')
        .update({ status: 'processing' })
        .eq('id', salvageId)
        .eq('status', 'promo_redeemed')
        .select('id');

      if (!claimed?.length) {
        const { data: current } = await supabase
          .from('salvage_sessions')
          .select('status, assessment, vehicle_details, market, rerun_count')
          .eq('id', salvageId)
          .single();
        if (current?.assessment) {
          const vd = current.vehicle_details || {};
          return NextResponse.json({
            assessment: current.assessment,
            vehicleDetails: vd,
            market: current.market,
            rerunCount: current.rerun_count ?? 0,
            bregoData: vd.bregoValuation ?? null,
          });
        }
        return NextResponse.json({ error: 'Assessment already in progress' }, { status: 409 });
      }
    }

    // Check for cached assessment first (without fetching images)
    // NOTE: zero One Auto calls here — salvageHistory is stored in vehicle_details
    // on the initial assess run and read back verbatim.
    const { data: check } = await supabase
      .from('salvage_sessions')
      .select('status, vehicle_details, market, assessment, rerun_count')
      .eq('id', salvageId)
      .single();

    if (check?.assessment) {
      const vd = check.vehicle_details || {};
      return NextResponse.json({
        assessment: check.assessment,
        vehicleDetails: vd,
        market: check.market,
        rerunCount: check.rerun_count ?? 0,
        bregoData: vd.bregoValuation ?? null,
      });
    }

    // Need to run assessment — fetch full session including images
    const { data: session, error: fetchError } = await supabase
      .from('salvage_sessions')
      .select('*')
      .eq('id', salvageId)
      .single();

    if (fetchError || !session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    if (!promoToken) {
      const sessionUpdate = { status: 'processing' };
      if (stripeSessionId) sessionUpdate.stripe_session_id = stripeSessionId;
      await supabase.from('salvage_sessions').update(sessionUpdate).eq('id', salvageId);
    }

    const vd = session.vehicle_details || {};
    const market = session.market || 'GB';
    const roiTier = vd.roiTier || 'roi_free';

    // Fetch images once; feed Haiku, Opus, and lamp detection from the same array.
    // Fails loudly if any image is missing — a partial set degrades the assessment invisibly.
    let images;
    if (session.image_paths?.length) {
      images = await fetchImagesFromStorage(supabase, session.image_paths);
    } else if (session.images?.length) {
      images = session.images; // legacy sessions stored base64 directly
    } else {
      return NextResponse.json({ error: 'No images found for this session' }, { status: 400 });
    }

    function cleanCopartNotes(raw) {
      if (!raw) return '';
      return raw
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .filter(l => !/thumbnail/i.test(l))
        .filter(l => !/^https?:\/\//i.test(l))
        .filter(l => !/^VIN:/i.test(l))
        .filter(l => !/^Lot number:/i.test(l))
        .filter(l => !/^Lane\/Item:/i.test(l))
        .filter(l => !/^Sale name:/i.test(l))
        .filter(l => !/^Sale date:/i.test(l))
        .filter(l => !/^Location:/i.test(l))
        .filter(l => !/^\d+\/\d+$/.test(l))
        .filter(l => !/^Watchlist$/i.test(l))
        .filter(l => !/^HD$/i.test(l))
        .filter(l => !/VIEW FULL VEHICLE/i.test(l))
        .filter(l => !/^Estimated retail value:\s*$/i.test(l))
        .filter(l => !/^Transmission:\s*$/i.test(l))
        .filter(l => !/^2 AXLE RIGID BODY/i.test(l))
        .filter(l => !/^Drive:/i.test(l))
        .filter(l => !/^Transmission engages/i.test(l))
        .filter(l => !/^1 Speed/i.test(l))
        .filter(l => !/^2 Speed/i.test(l))
        .filter(l => !/^\d+ Speed/i.test(l))
        .filter(l => !/^Gears engage/i.test(l))
        .filter(l => !/^Physical V5/i.test(l))
        .filter(l => !/^Auction countdown/i.test(l))
        .filter(l => !/^Minimum bid/i.test(l))
        .filter(l => !/^Seller reserve/i.test(l))
        .filter(l => !/^Minor Dents/i.test(l))
        .filter(l => !/^Front End$/i.test(l))
        .filter(l => !/^Rear End$/i.test(l))
        .filter(l => !/^No V5/i.test(l))
        .filter(l => !/^N REPAIRABLE/i.test(l))
        .filter(l => !/^S REPAIRABLE/i.test(l))
        .filter(l => !/^Water\/flood/i.test(l))
        .filter(l => !/^VAT to be added/i.test(l))
        .filter(l => !/^Yes$/i.test(l))
        .filter(l => !/^No$/i.test(l))
        .filter(l => /[a-zA-Z]{4,}/.test(l))
        .join('\n')
        .trim();
    }

    const cleanedVd = { ...vd, damageDescription: cleanCopartNotes(vd.damageDescription) };

    function parseCopartListing(raw) {
      if (!raw) return {};
      const get = (pattern) => {
        const m = raw.match(pattern);
        return m ? m[1].trim() : null;
      };
      return {
        category:         get(/^Category:\s*([^\n]+)/im),
        runCondition:     get(/Run condition:\s*\n?([^\n]+)/i),
        odometer:         get(/Odometer:\s*\n?([^\n]+)/i),
        keys:             get(/Has key:\s*\n?([^\n]+)/i),
        fuel:             get(/Fuel:\s*\n?([^\n]+)/i),
        transmission:     get(/Transmission:\s*\n?([^\n]+)/i),
        bodyStyle:        get(/Body style:\s*\n?([^\n]+)/i),
        colour:           get(/Colour:\s*\n?([^\n]+)/i),
        engineSize:       get(/Engine type:\s*\n?([^\n]+)/i),
        primaryDamage:    get(/Primary damage:\s*\n?([^\n]+)/i),
        secondaryDamage:  get(/Secondary damage:\s*\n?([^\n]+)/i),
        additionalDamage: get(/Additional damage[^:]*:\s*\n?([^\n]+)/i),
        estimatedRetail:  get(/Estimated retail value:\s*\n?([^\n]+)/i),
        vatOnSale:        get(/VAT to be added[^:\n]*(?::\s*|\s*\r?\n\s*)(Yes|No)/i),
        v5Status:         get(/V5 available:\s*\n?([^\n]+)/i),
        lotNumber:        get(/Lot number:\s*\n?([^\n]+)/i),
      };
    }

    const parsed = parseCopartListing(vd.damageDescription || '');
    const enrichedVd = {
      ...cleanedVd,
      category:         cleanedVd.category        || parsed.category,
      runCondition:     cleanedVd.runCondition     || parsed.runCondition,
      odometer:         cleanedVd.odometer         || parsed.odometer,
      keys:             cleanedVd.keys             || parsed.keys,
      fuel:             cleanedVd.fuel             || parsed.fuel,
      transmission:     cleanedVd.transmission     || parsed.transmission,
      colour:           cleanedVd.colour           || parsed.colour,
      engineSize:       cleanedVd.engineSize       || parsed.engineSize,
      primaryDamage:    cleanedVd.primaryDamage    || parsed.primaryDamage,
      secondaryDamage:  cleanedVd.secondaryDamage  || parsed.secondaryDamage,
      additionalDamage: cleanedVd.additionalDamage || parsed.additionalDamage,
      estimatedRetail:  cleanedVd.estimatedRetail  || parsed.estimatedRetail,
      vatOnSale:        cleanedVd.vatOnSale        || parsed.vatOnSale,
      v5Status:         cleanedVd.v5Status         || parsed.v5Status,
      lotNumber:        cleanedVd.lotNumber        || parsed.lotNumber || vd.lotNumber,
    };

    if (!enrichedVd.vatOnSale && /VAT\s+to\s+be\s+added/i.test(vd.damageDescription || '')) {
      console.warn('[VAT PARSE] possible missed VAT flag: "VAT to be added" found in listing but vatOnSale parsed as null');
    }

    // Fetch ROI vehicle data for paid tiers
    let roiData = null;
    if (market === 'IE' && roiTier !== 'roi_free' && enrichedVd.vrm) {
      const oneAutoBase = process.env.ONE_AUTO_BASE_URL || 'https://api.oneautoapi.com';
      const oneAutoKey = process.env.ONE_AUTO_API_KEY;
      const cleanVrm = enrichedVd.vrm.replace(/\s+/g, '').toUpperCase();

      roiData = {};
      const isPro = ['roi_pro', 'roi_history'].includes(roiTier);
      const isHistory = roiTier === 'roi_history';

      const [bregoResult, demandResult, cpgResult, hpiResult] = await Promise.all([
        withOneAutoCache('BREGO_ROI', cleanVrm, async () => {
          const r = await fetch(`${oneAutoBase}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}`, { headers: { 'x-api-key': oneAutoKey } });
          const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
          if (!raw) return null;
          const result = raw?.success === true ? (raw.result ?? raw) : (raw?.result ?? null);
          return (result && !result.error) ? result : null;
        }),
        withOneAutoCache('MARKETDEMAND', cleanVrm, async () => {
          const r = await fetch(`${oneAutoBase}/percayso/marketdemandfromvrm/?vrm=${cleanVrm}`, { headers: { 'x-api-key': oneAutoKey } });
          const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
          const result = raw?.result ?? (raw?.success ? raw : null);
          return (result && !result.error) ? result : null;
        }),
        isPro
          ? withOneAutoCache('PRICEGUIDE', cleanVrm, async () => {
              const r = await fetch(`${oneAutoBase}/cartell/priceguide/?vehicle_registration_mark=${cleanVrm}`, { headers: { 'x-api-key': oneAutoKey } });
              const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
              const result = raw?.result ?? raw;
              return (result && !result.error) ? result : null;
            })
          : Promise.resolve(null),
        isHistory
          ? withOneAutoCache('HPICHECK', cleanVrm, async () => {
              const r = await fetch(`${oneAutoBase}/cartell/hpicheck/v1?vehicle_registration_mark=${cleanVrm}`, { headers: { 'x-api-key': oneAutoKey } });
              const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
              const result = raw?.result ?? raw;
              return (result && !result.error) ? result : null;
            })
          : Promise.resolve(null),
      ]);

      if (bregoResult) roiData.valuation = bregoResult;
      if (demandResult) roiData.marketDemand = demandResult;
      if (isPro && cpgResult) roiData.priceGuide = cpgResult;
      if (isHistory && hpiResult) roiData.historyCheck = hpiResult;
    }

    if (roiData) enrichedVd.roiData = roiData;

    // Pre-extraction pass (#62): Haiku reads dashboard odometer before Brego valuation
    let photoOdometer = null;
    try {
      const preExtractBlocks = await Promise.all(images.map(resizeToHaikuSafe));
      const haikuRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          system: 'Read the vehicle\'s dashboard/odometer from these auction photos. Respond with ONLY the total mileage as a bare integer — no words, no markdown, no explanation, no units. Example valid responses: 131828 or 87450. If no odometer is clearly readable in any photo, respond with exactly one word: null. Do not write anything else.',
          messages: [{ role: 'user', content: preExtractBlocks }],
        }),
      });
      if (haikuRes.ok) {
        const haikuData = await haikuRes.json();
        const raw = (haikuData.content?.[0]?.text || '').trim();
        const nums = (raw.replace(/,/g, '').match(/\d+/g) || [])
          .map(n => parseInt(n, 10))
          .filter(n => n >= 1 && n <= 999999);
        const uniq = [...new Set(nums)];
        const parsed = uniq.length === 1 ? uniq[0] : NaN;
        if (!isNaN(parsed)) photoOdometer = parsed;
      } else {
        // non-2xx from Haiku — photoOdometer stays null, downstream hierarchy takes over
      }
    } catch { /* Haiku threw — photoOdometer stays null */ }

    // Sanity-check photo read against last DVSA MOT mileage (valuation hygiene only).
    // Must run before photoMileageFlag so a nulled-out read doesn't produce a misleading flag.
    if (photoOdometer !== null) {
      const lastMot = parseInt(String(enrichedVd.lastMotMileage || '').replace(/,/g, ''), 10);
      if (lastMot >= 1 && photoOdometer < lastMot) {
        const gap = lastMot - photoOdometer;
        console.log(`[HAIKU ODO SANITY] photo ${photoOdometer} < last MOT ${lastMot}, gap ${gap}, falling back`);
        photoOdometer = null;
      }
      // If lastMot is missing/0/unparseable: no baseline — keep photoOdometer as-is
    }

    if (photoOdometer !== null) {
      const listedRaw = enrichedVd.copartListedMileage ?? enrichedVd.odometer;
      const listedMileage = listedRaw != null
        ? (() => { const m = String(listedRaw).replace(/,/g, '').match(/\d+/); return m ? parseInt(m[0], 10) : NaN; })()
        : NaN;
      if (!isNaN(listedMileage) && listedMileage >= 1) {
        const diff = Math.abs(photoOdometer - listedMileage);
        if (diff > 500) {
          enrichedVd.photoMileageFlag = `Photo odometer reads ${photoOdometer.toLocaleString()} miles; listing shows ${listedMileage.toLocaleString()} miles — discrepancy of ${diff.toLocaleString()} miles. Verify before bidding.`;
        }
      }
    }

    // Determine mileage for Brego valuation
    const { mileage: brMileage, source: brMileageSource, ageYears: brAgeYears } = getMileageForValuation({
      photoOdometer,
      formMileage: enrichedVd.copartListedMileage ?? null,
      listingOdometer: enrichedVd.odometer ?? null,
      dvsaMileage: enrichedVd.lastMotMileage ?? null,
      vehicleYear: enrichedVd.year ?? null,
    });
    if (brMileageSource === 'age_anomaly') {
      console.log(`[MILEAGE ANOMALY] vrm=${enrichedVd.vrm || 'unknown'} year=${enrichedVd.year || '?'} age=${brAgeYears ?? '?'}yr no listing/photo/DVSA mileage available, estimating ${brMileage} miles from age`);
    }

    // Fetch salvage history + Brego valuation in parallel (GB/NI only)
    let bregoData = null;
    if (market !== 'IE' && enrichedVd.vrm) {
      const oneAutoBase = process.env.ONE_AUTO_BASE_URL || 'https://api.oneautoapi.com';
      const cleanVrmB = enrichedVd.vrm.replace(/\s+/g, '').toUpperCase();
      const hdrs = { 'x-api-key': process.env.ONE_AUTO_API_KEY };

      const [shResult, brResult] = await Promise.all([
        withOneAutoCache('SALVAGEHISTORY', cleanVrmB, async () => {
          const r = await fetch(`${oneAutoBase}/carguide/salvagecheck/v2?vehicle_registration_mark=${cleanVrmB}`, { headers: hdrs });
          const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
          const result = raw?.result ?? raw;
          return (result && !result.error) ? result : null;
        }),
        withOneAutoCache('BREGO_GB', cleanVrmB, async () => {
          const r = await fetch(`${oneAutoBase}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrmB}&current_mileage=${brMileage}`, { headers: hdrs });
          const raw = r.ok ? JSON.parse(await r.text() || 'null') : null;
          const result = raw?.result ?? raw;
          return (result && !result.error) ? result : null;
        }),
      ]);

      if (shResult) {
        tagSelfReference(shResult, enrichedVd);
        enrichedVd.salvageHistory = shResult;
      }

      if (brResult) {
        bregoData = { ...brResult, _mileageSource: brMileageSource, _mileageUsed: brMileage };
        enrichedVd.bregoValuation = bregoData;
      }
    }

    const AUCTION_SOURCE_LABELS = {
      copart: 'Copart UK',
      bca: 'BCA',
      manheim: 'Manheim',
      other: 'Other / Private',
    };

    const auctionSource = enrichedVd.auctionSource || 'copart';

    const feeRef = null; // fees/margins are code-computed; model no longer calls computeCopartFees

    const contextLines = [
      enrichedVd.vrm && `Registration: ${enrichedVd.vrm}`,
      enrichedVd.make && `Make: ${enrichedVd.make}`,
      enrichedVd.model && `Model: ${enrichedVd.model}`,
      enrichedVd.year && `Year: ${enrichedVd.year}`,
      enrichedVd.lotNumber && `Copart Lot Number: ${enrichedVd.lotNumber}`,
      enrichedVd.damageDescription && `Seller/Copart Damage Description: ${enrichedVd.damageDescription}`,
      enrichedVd.dvlaVerified && `DVLA Verified: Yes — vehicle identity confirmed against DVLA database`,
      enrichedVd.colour && `DVLA Colour: ${enrichedVd.colour}`,
      enrichedVd.fuelType && `DVLA Fuel Type: ${enrichedVd.fuelType}`,
      enrichedVd.taxStatus && `Tax Status: ${enrichedVd.taxStatus}`,
      enrichedVd.motStatus && `MOT Status: ${enrichedVd.motStatus}`,
      enrichedVd.lastMotMileage && `Last MOT Recorded Mileage: ${enrichedVd.lastMotMileage} miles`,
      (() => {
        const mh = enrichedVd.motHistory;
        if (!Array.isArray(mh) || mh.length === 0) return null;
        const lines = mh.slice(0, 15).map(t => {
          const result  = (t.testResult || '').toUpperCase() === 'PASSED' ? 'PASS' : 'FAIL';
          const odo     = t.odometerValue != null ? `${Number(t.odometerValue).toLocaleString('en-GB')}mi` : '';
          const remarks = (t.defects || [])
            .slice(0, 4)
            .map(d => `${(d.type || 'ADVISORY').toUpperCase()}: ${(d.text || '').slice(0, 60)}`)
            .join('; ');
          return [t.completedDate, result, odo, remarks ? `[${remarks}]` : ''].filter(Boolean).join(' ');
        });
        return `DVSA MOT History (most recent first):\n${lines.join('\n')}`;
      })(),
      enrichedVd.motMileageFlag && `MILEAGE DISCREPANCY FLAG: ${enrichedVd.motMileageFlag}`,
      enrichedVd.photoMileageFlag && `PHOTO MILEAGE DISCREPANCY: ${enrichedVd.photoMileageFlag}`,
      `Market: ${market}`,
      market === 'IE' && enrichedVd.motStatus && `NCT Status: ${enrichedVd.motStatus}`,
      market === 'IE' && enrichedVd.motExpiryDate && `NCT Expiry: ${enrichedVd.motExpiryDate}`,
      market === 'IE' && enrichedVd.monthOfFirstRegistration && `First Registered in Ireland: ${enrichedVd.monthOfFirstRegistration}`,
      market === 'IE' && roiData?.valuation?.current?.retail && `Current Retail Valuation (IE): €${roiData.valuation.current.retail}`,
      market === 'IE' && roiData?.valuation?.future?.retail && `Future Retail Valuation (IE): €${roiData.valuation.future.retail}`,
      auctionSource !== 'copart' && `Auction Source: ${AUCTION_SOURCE_LABELS[auctionSource] || auctionSource}`,
      feeRef,
      enrichedVd.vatOnSale && `VAT on Sale: ${enrichedVd.vatOnSale}`,
      enrichedVd.category && `Category: ${enrichedVd.category}`,
      enrichedVd.runCondition && `Run Condition: ${enrichedVd.runCondition}`,
      enrichedVd.keys && `Keys: ${enrichedVd.keys}`,
      enrichedVd.transmission && `Transmission: ${enrichedVd.transmission}`,
      enrichedVd.primaryDamage && `Primary Damage: ${enrichedVd.primaryDamage}`,
      enrichedVd.secondaryDamage && `Secondary Damage: ${enrichedVd.secondaryDamage}`,
      enrichedVd.additionalDamage && `Additional Damage: ${enrichedVd.additionalDamage}`,
      enrichedVd.v5Status && `V5 Status: ${enrichedVd.v5Status}`,
      (() => {
        const sh = enrichedVd.salvageHistory;
        if (!sh) return null;
        const found = sh.salvage_auction_record_found === true;
        const records = sh.salvage_auction_records || [];
        if (!found) return 'Previous Salvage Auction History: No previous salvage auction history found.';
        const lines = records.map((rec, i) => [
          `Record ${i + 1}:`,
          rec.salvage_auction_lot_date && `  Lot Date: ${rec.salvage_auction_lot_date}`,
          rec.salvage_auction_lot_desc && `  Category: ${rec.salvage_auction_lot_desc}`,
          rec.mileage != null          && `  Mileage at Sale: ${Number(rec.mileage).toLocaleString()} miles`,
          rec.primary_damage_desc      && `  Primary Damage: ${rec.primary_damage_desc}`,
          rec.secondary_damage_desc    && `  Secondary Damage: ${rec.secondary_damage_desc}`,
        ].filter(Boolean).join('\n')).join('\n');
        return `Previous Salvage Auction History (${records.length} record${records.length !== 1 ? 's' : ''} found):\n${lines}`;
      })(),
      (() => {
        if (!bregoData) return 'Live market valuation data: UNAVAILABLE — proceed with assessment but flag exit value as low confidence.';
        const fmt = (v) => v != null ? `£${Number(v).toLocaleString('en-GB')}` : 'N/A';
        const monthYear = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });
        // Map new source codes to strings the engine's mileage-source rules already know
        const engineSrc = brMileageSource === 'listing_odometer' ? 'copart_listed'
          : (brMileageSource === 'age_estimate' || brMileageSource === 'age_anomaly') ? 'default_fallback'
          : brMileageSource;
        const lines = [
          `Live market valuation data (${monthYear}):`,
          `- Retail low (poor condition): ${fmt(bregoData.retail_low_valuation)}`,
          `- Retail average (average condition): ${fmt(bregoData.retail_average_valuation)}`,
          `- Retail high (excellent condition): ${fmt(bregoData.retail_high_valuation)}`,
          `- Trade low (poor condition): ${fmt(bregoData.trade_low_valuation)}`,
          `- Trade average (average condition): ${fmt(bregoData.trade_average_valuation)}`,
          `- Trade high (excellent condition): ${fmt(bregoData.trade_high_valuation)}`,
          bregoData.vehicle_desc ? `- Vehicle: ${bregoData.vehicle_desc}` : null,
          `- Mileage used for valuation: ${bregoData._mileageUsed} miles`,
          `- Mileage source: ${engineSrc}`,
        ];
        if (brMileageSource === 'age_estimate') {
          lines.push(`⚠️ MILEAGE ESTIMATE — MUST FLAG IN REPORT: No actual mileage was available from the listing, dashboard photos, or DVSA. The valuation mileage of ${Number(bregoData._mileageUsed).toLocaleString()} miles is estimated from vehicle age only. Label it as "ESTIMATED from age — actual mileage NOT confirmed". State that the valuation, exit value, and margin all depend on this unverified figure. Add a "Confirm actual mileage before bidding" item to the WhatsApp checklist. Reduce Confidence Level by one tier.`);
        }
        if (brMileageSource === 'age_anomaly') {
          lines.push(`⚠️ MILEAGE ANOMALY — MUST FLAG IN REPORT: The vehicle is over 4 years old but no mileage data could be retrieved from the listing, dashboard photos, or DVSA. The figure of ${Number(bregoData._mileageUsed).toLocaleString()} miles is a rough age-based estimate and is highly uncertain. State explicitly in the report that no mileage data was available, the valuation is unreliable without confirmed mileage, and the buyer MUST verify actual mileage before bidding. Set Confidence Level: Low.`);
        }
        return lines.filter(Boolean).join('\n');
      })(),
    ].filter(Boolean).join('\n');

    const imageBlocks = images
      .map((img) => {
        let mediaType = 'image/jpeg';
        let data = img;
        const match = img.match(/^data:([^;]+);base64,(.+)$/);
        if (match) { mediaType = match[1]; data = match[2]; }
        return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
      });

    const userContent = [
      ...imageBlocks,
      {
        type: 'text',
        text: `Please assess this vehicle for auction bidding purposes.\n\nVehicle Details:\n${contextLines}\n\nAnalyse all provided photos and give a complete assessment using the required output format. After the Margin Calculation field, include a "WhatsApp Inspection Checklist:" section with at minimum 5 specific items tailored to this vehicle's damage profile, selected and expanded from the standard checklist items in your knowledge base.`,
      },
    ];

    const LAMP_OBS_TOOL = {
      name: 'recordLampObservation',
      description: 'Call exactly once on any front-struck lot, before writing your assessment. Pass your plate-anchor side determination, bumper displacement observation, and damage span. After calling, include each implicated front headlamp as a separate Parts Breakdown line. The engine reconciles costs to the authoritative band — do NOT pre-adjust your repair figure. Do not write lamp commentary outside the Parts Breakdown lines.',
      input_schema: {
        type: 'object',
        properties: {
          struckSide: {
            type: 'string',
            enum: ['offside', 'nearside', 'central'],
            description: 'Struck side from plate-relative-to-lights internal reasoning. Use "central" if side is not confidently determinable.',
          },
          apertureExposed: {
            type: 'boolean',
            description: 'True if the front bumper is visibly displaced or removed on the struck corner, exposing the lamp mounting recess.',
          },
          damageSpan: {
            type: 'string',
            enum: ['single_corner', 'full_width'],
            description: 'Structural extent of damage across the front. single_corner: damage confined to one side (one wing, one bumper corner). full_width: damage spans the full front width — bonnet crumpled, slam panel or front panel affected, both front corners involved. Judge from structural damage footprint (bonnet, slam panel, wing, bumper reach), NOT from lamp absence or presence.',
          },
        },
        required: ['struckSide', 'apertureExposed', 'damageSpan'],
      },
    };

    const frontStruck = /front/i.test(enrichedVd.primaryDamage || '') || /front/i.test(enrichedVd.secondaryDamage || '');

    // Fire lamp detection in parallel with the Claude assess call — joins after
    const lampDetectionPromise = frontStruck ? runLampDetection(images) : Promise.resolve(null);

    const claudeTools = frontStruck ? [LAMP_OBS_TOOL] : [];
    const messages = [{ role: 'user', content: userContent }];
    let lampObs = null;
    let rawText = '';

    // First Claude call — lamp observation tool fires here on front-struck lots
    {
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: 8000,
          system: ASSESSMENT_ENGINE_PROMPT,
          messages,
          ...(claudeTools.length ? { tools: claudeTools } : {}),
        }),
      });
      const apiData = await apiRes.json();
      console.log('[TOKEN LOG] iter=0 Input:', apiData.usage?.input_tokens, '| Output:', apiData.usage?.output_tokens, '| Stop:', apiData.stop_reason, '| Model:', apiData.model || 'unknown');
      if (!apiRes.ok) throw new Error(apiData.error?.message || 'Claude API error');

      const content = apiData.content || [];

      if (apiData.stop_reason === 'end_turn') {
        rawText = content.filter(c => c.type === 'text').map(c => c.text).join('');
      } else if (apiData.stop_reason === 'tool_use') {
        // Only recordLampObservation is available — handle it, then get final text
        const toolResults = content
          .filter(c => c.type === 'tool_use')
          .map(block => {
            if (block.name === 'recordLampObservation') {
              lampObs = {
                struckSide:     block.input?.struckSide     || 'central',
                apertureExposed: Boolean(block.input?.apertureExposed),
                damageSpan:     block.input?.damageSpan     || 'single_corner',
              };
              console.log(`[LAMP] recordLampObservation: struckSide=${lampObs.struckSide} apertureExposed=${lampObs.apertureExposed} damageSpan=${lampObs.damageSpan}`);
              return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ recorded: true }) };
            }
            return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: 'Unknown tool' }) };
          });

        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: toolResults });

        // Second Claude call — no tools, produces the full assessment text
        const finalRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            max_tokens: 8000,
            system: ASSESSMENT_ENGINE_PROMPT,
            messages,
          }),
        });
        const finalData = await finalRes.json();
        console.log('[TOKEN LOG] iter=1 Input:', finalData.usage?.input_tokens, '| Output:', finalData.usage?.output_tokens, '| Stop:', finalData.stop_reason, '| Model:', finalData.model || 'unknown');
        if (!finalRes.ok) throw new Error(finalData.error?.message || 'Claude API error (iter 1)');
        rawText = (finalData.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      } else {
        rawText = content.filter(c => c.type === 'text').map(c => c.text).join('');
      }
    }

    // Join lamp detection (ran in parallel with Claude calls)
    const lampDetectionRaw = await lampDetectionPromise;
    const detectedCorner   = lampDetectionRaw ? selectStruckCornerVerdict(lampDetectionRaw) : null;
    if (frontStruck) {
      console.log('[LAMP DETECT]', detectedCorner
        ? `struck corner: verdict=${detectedCorner.verdict} lamp_type=${detectedCorner.lamp_type} evidence="${(detectedCorner.evidence || '').slice(0, 80)}"`
        : lampDetectionRaw ? 'no struck corner identified in response' : 'call skipped or failed');
    }

    // Guarantee lampObs for every front-struck lot regardless of tool co-operation
    if (frontStruck && !lampObs) {
      lampObs = { struckSide: 'central', apertureExposed: false };
      console.log('[LAMP] no tool call on frontStruck lot — Tier 1 floor defaults applied');
    }

    let lampResult = null;
    if (lampObs) {
      const derivedLampType = deriveLampType(enrichedVd);
      lampResult = computeLampResult(
        lampObs.struckSide, lampObs.apertureExposed, derivedLampType,
        detectedCorner?.verdict   || null,
        detectedCorner?.lamp_type || null,
        lampObs.damageSpan        || 'single_corner'
      );
      console.log(`[LAMP] final: tier=${lampResult.tier} effectiveVerdict=${lampResult.effectiveVerdict} band=£${lampResult.lampAllowance} type=${lampResult.lampType} assumed=${lampResult.lampTypeAssumed}`);
    }

    const assessment = parseAssessment(rawText);
    assessment._raw = rawText;
    assessment._market = market;
    if (lampResult) assessment._lampResult = lampResult;

    // Parts reconciliation — lamp band folded in; parts_sum is the sole repair figure
    const rawParts = parseParts(assessment['Parts Breakdown'] || '');
    const { parts: reconciledParts, lamp_delta, lamp_inserted, lamp_count } = reconcileParts(rawParts, lampResult);
    const parts_sum = sumPartsRealistic(reconciledParts);

    if (reconciledParts.length > 0) {
      assessment['Parts Breakdown'] = renderParts(reconciledParts);
    }
    assessment._reconciledParts = reconciledParts;
    assessment._partsReconciliation = { parts_sum, lamp_delta, lamp_inserted, lamp_count };
    console.log(`[PARTS] repair=£${parts_sum} lamp_inserted=${lamp_inserted} lamps=${lamp_count} band_each=£${lampResult?.lampAllowance ?? 0} lamp_delta=£${lamp_delta}`);

    // Code-owned margin table — fixed hammer set, repair = parts_sum, exit = model's stated value
    const HAMMER_SCENARIOS = [500, 1000, 1500, 2000, 2500, 3000];
    const exitValue = parseExitValue(assessment['Realistic Exit Value'] || '');
    const lotIsVatQualifying = enrichedVd.vatOnSale === 'Yes';

    if (auctionSource === 'copart' && parts_sum > 0 && exitValue != null) {
      const marginScenarios = HAMMER_SCENARIOS.map(hammer => {
        const fees = feeStack(hammer);
        const hammerVat = lotIsVatQualifying ? Math.round(hammer * 0.20 * 100) / 100 : 0;
        const margin = Math.round((exitValue - parts_sum - hammer - hammerVat - fees.totalIncVat) * 100) / 100;
        return { hammer, exit_value: exitValue, repair: parts_sum, hammerVat, ...fees, margin };
      });
      assessment._marginScenarios = marginScenarios;
      console.log(`[MARGIN] exit=£${exitValue} repair=£${parts_sum} scenarios=${marginScenarios.length}`);
    } else if (auctionSource === 'copart') {
      console.warn(`[MARGIN] skipped — parts_sum=${parts_sum} exitValue=${exitValue}`);
    }

    logEvent('assessment_submitted', { vrm: enrichedVd.vrm || '', metadata: { lot_number: enrichedVd.lotNumber || null } });

    await supabase
      .from('salvage_sessions')
      .update({ status: 'assessed', assessment, vehicle_details: enrichedVd })
      .eq('id', salvageId);

    return NextResponse.json({ assessment, vehicleDetails: enrichedVd, market, rerunCount: 0, bregoData: enrichedVd.bregoValuation ?? null });

  } catch (err) {
    console.error('Salvage assess error:', err);
    if (promoToken) {
      await supabase
        .from('salvage_sessions')
        .update({ status: 'promo_redeemed' })
        .eq('id', salvageId)
        .eq('status', 'processing');
    }
    return NextResponse.json({ error: err.message || 'Assessment failed' }, { status: 500 });
  }
}
