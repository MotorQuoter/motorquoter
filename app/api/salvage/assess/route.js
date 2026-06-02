import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { ASSESSMENT_ENGINE_PROMPT } from '@/config/assessmentEngine';
import { feeStack } from '@/lib/copartFees';
import { logEvent } from '@/lib/analytics';
import { getMileageForValuation } from '@/lib/getMileageForValuation';

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
  'Estimated Repair Range',
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

async function runLampDetection(images) {
  try {
    const imageBlocks = images.slice(0, 20).map(img => {
      let mediaType = 'image/jpeg';
      let data = img;
      const m = img.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mediaType = m[1]; data = m[2]; }
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    });
    const userText = `These are photos of the front of a salvage vehicle. For EACH front headlamp position (both corners), determine whether a headlamp unit is physically present in the aperture or the mount is empty. A displaced bumper can expose an empty recess that looks occupied — judge whether an actual lens/reflector/lamp body is present, not just that the recess is visible. Report per corner. Describe each corner by its relation to the body damage (e.g. 'the corner with the major impact damage' / 'the undamaged corner') or as left/right as viewed — do NOT use offside/nearside. Also state the lamp TYPE if determinable (halogen / HID / LED-adaptive).

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
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }, ...imageBlocks] }],
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

function computeLampResult(struckSide, apertureExposed, lampType, detectionVerdict = null, detectionLampType = null) {
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

  const assumedDisclosure = ' Lamp type could not be confirmed from the vehicle spec, so the higher LED/adaptive band has been used to avoid under-budgeting — confirm the actual lamp type and unit cost on inspection; a halogen unit would be materially cheaper.';
  const tier1Line = 'Struck front corner — confirm a serviceable headlamp on inspection.';

  if (!apertureExposed) {
    return { tier: 1, tier2Fired: false, struckSide: side, tier1Line, lampType: resolvedType, lampTypeAssumed, lampAllowance: 0 };
  }

  // Verdict branch: toggle gates confident 'missing' wording; detection is authoritative otherwise
  const effectiveVerdict = (detectionVerdict === 'missing' && !LAMP_DETECTION_CONFIDENT_WORDING)
    ? 'cannot_determine'
    : (detectionVerdict || 'cannot_determine');

  const checklistEntry = 'Show the struck-side front headlamp aperture with the bumper pulled clear — confirm the actual headlamp type and that a serviceable unit is fitted, not just an exposed recess.';

  if (effectiveVerdict === 'present') {
    const verdictLine = 'Struck front corner headlamp — the front headlamp on the damaged corner appears present. Confirm serviceability on inspection; a struck-corner lamp may be cracked or displaced even if visible.';
    return { tier: 2, tier2Fired: false, struckSide: side, tier1Line, verdictLine, costDriverEntry: null, checklistEntry, lampType: resolvedType, lampTypeAssumed, lampAllowance: 0, detectionVerdict, effectiveVerdict };
  }

  if (effectiveVerdict === 'missing') {
    let verdictLine = `Struck front corner headlamp — the front headlamp on the damaged corner is missing. Replacement costed at £${bandValue} (${resolvedType}).`;
    verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
    const costDriverEntry = lampTypeAssumed
      ? `Struck front corner headlamp — missing; replacement costed at £${bandValue} (${resolvedType}, assumed).`
      : `Struck front corner headlamp — missing; replacement costed at £${bandValue} (${resolvedType}).`;
    return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, detectionVerdict, effectiveVerdict };
  }

  // cannot_determine — default path and toggle-OFF 'missing'
  let verdictLine = `Struck front corner headlamp — on a displaced-bumper front-corner impact the headlamp is treated as a replacement; presence and serviceability cannot be confirmed from the photos. Replacement costed at £${bandValue} (${resolvedType}).`;
  verdictLine += lampTypeAssumed ? assumedDisclosure : ' Confirm on inspection.';
  const costDriverEntry = lampTypeAssumed
    ? `Struck front corner headlamp — replacement costed at £${bandValue} (${resolvedType}, assumed).`
    : `Struck front corner headlamp — replacement costed at £${bandValue} (${resolvedType}).`;
  return { tier: 2, tier2Fired: true, struckSide: side, tier1Line, verdictLine, costDriverEntry, checklistEntry, lampType: resolvedType, lampTypeAssumed, lampAllowance: bandValue, detectionVerdict, effectiveVerdict };
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
    const { data: check } = await supabase
      .from('salvage_sessions')
      .select('status, vehicle_details, market, assessment, rerun_count')
      .eq('id', salvageId)
      .single();

    if (check?.assessment) {
      const vd = check.vehicle_details || {};
      if (!vd.salvageHistory && check.market !== 'IE' && vd.vrm) {
        try {
          const oneAutoBase = process.env.ONE_AUTO_BASE_URL || 'https://api.oneautoapi.com';
          const cleanVrm = vd.vrm.replace(/\s+/g, '').toUpperCase();
          const shRes = await fetch(
            `${oneAutoBase}/carguide/salvagecheck/v2?vehicle_registration_mark=${cleanVrm}`,
            { headers: { 'x-api-key': process.env.ONE_AUTO_API_KEY } }
          );
          const shText = await shRes.text();
          const shRaw = shText ? JSON.parse(shText) : null;
          const shResult = shRaw?.result ?? shRaw;
          if (shResult && !shResult.error) {
            tagSelfReference(shResult, vd);
            vd.salvageHistory = shResult;
            await supabase
              .from('salvage_sessions')
              .update({ vehicle_details: vd })
              .eq('id', salvageId);
          }
        } catch {}
      }
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
      const safeGet = async (url) => {
        try {
          const r = await fetch(url, { headers: { 'x-api-key': oneAutoKey } });
          const t = await r.text();
          return t ? JSON.parse(t) : null;
        } catch { return null; }
      };

      roiData = {};
      const isPro = ['roi_pro', 'roi_history'].includes(roiTier);
      const isHistory = roiTier === 'roi_history';

      const fetches = [
        safeGet(`${oneAutoBase}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}`),
        safeGet(`${oneAutoBase}/percayso/marketdemandfromvrm/?vrm=${cleanVrm}`),
        isPro ? safeGet(`${oneAutoBase}/cartell/priceguide/?vehicle_registration_mark=${cleanVrm}`) : Promise.resolve(null),
        isHistory ? safeGet(`${oneAutoBase}/cartell/hpicheck/v1?vehicle_registration_mark=${cleanVrm}`) : Promise.resolve(null),
      ];
      const [bregoRaw, demandRaw, cpgRaw, hpiRaw] = await Promise.all(fetches);

      if (bregoRaw?.success === true) roiData.valuation = bregoRaw.result ?? bregoRaw;
      else if (bregoRaw?.result) roiData.valuation = bregoRaw.result;
      if (demandRaw?.result || demandRaw?.success) roiData.marketDemand = demandRaw?.result ?? demandRaw;
      if (isPro && cpgRaw) roiData.priceGuide = cpgRaw?.result ?? cpgRaw;
      if (isHistory && hpiRaw) roiData.historyCheck = hpiRaw?.result ?? hpiRaw;
    }

    if (roiData) enrichedVd.roiData = roiData;

    // Pre-extraction pass (#62): Haiku reads dashboard odometer before Brego valuation
    let photoOdometer = null;
    try {
      const preExtractBlocks = session.images.map((img) => {
        let mediaType = 'image/jpeg';
        let data = img;
        const m = img.match(/^data:([^;]+);base64,(.+)$/);
        if (m) { mediaType = m[1]; data = m[2]; }
        return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
      });
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

      const [shRes, brRes] = await Promise.all([
        fetch(`${oneAutoBase}/carguide/salvagecheck/v2?vehicle_registration_mark=${cleanVrmB}`, { headers: hdrs }).catch(() => null),
        fetch(`${oneAutoBase}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrmB}&current_mileage=${brMileage}`, { headers: hdrs }).catch(() => null),
      ]);

      try {
        const shText = await shRes?.text();
        const shRaw = shText ? JSON.parse(shText) : null;
        const shResult = shRaw?.result ?? shRaw;
        if (shResult && !shResult.error) {
          tagSelfReference(shResult, enrichedVd);
          enrichedVd.salvageHistory = shResult;
        }
      } catch {}

      try {
        const brText = await brRes?.text();
        const brRaw = brText ? JSON.parse(brText) : null;
        const brResult = brRaw?.result ?? brRaw;
        if (brResult && !brResult.error) {
          bregoData = { ...brResult, _mileageSource: brMileageSource, _mileageUsed: brMileage };
          enrichedVd.bregoValuation = bregoData;
        }
      } catch {}
    }

    const AUCTION_SOURCE_LABELS = {
      copart: 'Copart UK',
      bca: 'BCA',
      manheim: 'Manheim',
      other: 'Other / Private',
    };

    const auctionSource = enrichedVd.auctionSource || 'copart';

    const feeRef = auctionSource === 'copart'
      ? 'Copart fees: Call the computeCopartFees tool for every hammer scenario you are evaluating, before writing the Margin Calculation. Pass your judged exit_value (single GBP integer — your chosen realistic exit price for this vehicle) and repair (single GBP integer — your chosen repair cost from within your stated range) alongside each hammer. Both are car-level constants: pass identical values across all your hammer calls. The server computes all fees, hammer VAT, and the full margin. Your Margin Calculation prose must explain WHY you chose that exit anchor and that repair figure — it must NOT state any fee amount, hammer VAT amount, or margin figure.'
      : null;

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

    const imageBlocks = session.images
      .map((img) => {
        let mediaType = 'image/jpeg';
        let data = img;
        const match = img.match(/^data:([^;]+);base64,(.+)$/);
        if (match) { mediaType = match[1]; data = match[2]; }
        return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
      });

    const userContent = [
      {
        type: 'text',
        text: `Please assess this vehicle for auction bidding purposes.\n\nVehicle Details:\n${contextLines}\n\nAnalyse all provided photos and give a complete assessment using the required output format. After the Margin Calculation field, include a "WhatsApp Inspection Checklist:" section with at minimum 5 specific items tailored to this vehicle's damage profile, selected and expanded from the standard checklist items in your knowledge base.`,
      },
      ...imageBlocks,
    ];

    const COPART_FEES_TOOL = {
      name: 'computeCopartFees',
      description: 'Returns the exact Copart UK fee stack for a given hammer price. Call this for every hypothetical hammer scenario before writing the Margin Calculation. Pass your judged exit_value and repair alongside each hammer — both are car-level constants, pass identical values for every hammer call. Do not estimate or calculate fees or margins yourself; the server computes and displays all figures.',
      input_schema: {
        type: 'object',
        properties: {
          hammer:     { type: 'number', description: 'Hypothetical hammer price in GBP (e.g. 2500 for £2,500)' },
          exit_value: { type: 'number', description: 'Your chosen realistic exit price for this vehicle in GBP — constant across all hammer scenarios' },
          repair:     { type: 'number', description: 'Your chosen repair cost for this vehicle in GBP (single figure from within your estimated range, EXCLUDING any struck-corner lamp — the engine adds that) — constant across all hammer scenarios' },
        },
        required: ['hammer', 'exit_value', 'repair'],
      },
    };

    const LAMP_OBS_TOOL = {
      name: 'recordLampObservation',
      description: 'Call exactly once on any front-struck lot, BEFORE computeCopartFees. Pass your plate-anchor side determination and the bumper displacement observation. The engine renders the lamp verdict and adds the replacement allowance — exclude the lamp from your repair figure and do not describe lamp presence/absence anywhere in your report.',
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
        },
        required: ['struckSide', 'apertureExposed'],
      },
    };

    const frontStruck = /front/i.test(enrichedVd.primaryDamage || '') || /front/i.test(enrichedVd.secondaryDamage || '');

    // Fire lamp detection in parallel with the main assess loop — joins post-loop
    const lampDetectionPromise = frontStruck ? runLampDetection(session.images) : Promise.resolve(null);

    const MAX_TOOL_ITERATIONS = 3;
    const claudeTools = [
      ...(auctionSource === 'copart' ? [COPART_FEES_TOOL] : []),
      ...(frontStruck ? [LAMP_OBS_TOOL] : []),
    ];
    const messages = [{ role: 'user', content: userContent }];
    const marginScenarios = [];
    let lampResult = null;
    let lampObs    = null; // raw tool inputs; computeLampResult deferred to post-loop after detection joins
    const lotIsVatQualifying = enrichedVd.vatOnSale === 'Yes';

    let rawText = '';
    let toolCallCount = 0;
    let capHit = false;

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: 8000,
          system: ASSESSMENT_ENGINE_PROMPT,
          messages,
          ...(claudeTools.length ? { tools: claudeTools } : {}),
        }),
      });

      const apiData = await apiRes.json();
      console.log(`[TOKEN LOG] iter=${iter} Input:`, apiData.usage?.input_tokens, '| Output:', apiData.usage?.output_tokens, '| Stop:', apiData.stop_reason, '| Model:', apiData.model || 'unknown');
      if (!apiRes.ok) throw new Error(apiData.error?.message || 'Claude API error');

      const content = apiData.content || [];

      if (apiData.stop_reason === 'end_turn') {
        rawText = content.filter(c => c.type === 'text').map(c => c.text).join('');
        break;
      }

      if (apiData.stop_reason === 'tool_use') {
        // Sort: process recordLampObservation before computeCopartFees within a single response
        // (Item 2 within-response ordering guarantee — cross-iteration ordering handled post-loop)
        const toolUseBlocks = [
          ...content.filter(c => c.type === 'tool_use' && c.name === 'recordLampObservation'),
          ...content.filter(c => c.type === 'tool_use' && c.name !== 'recordLampObservation'),
        ];
        const toolResults = toolUseBlocks
          .map(block => {
            if (block.name === 'recordLampObservation') {
              const struckSide      = block.input?.struckSide || 'central';
              const apertureExposed = Boolean(block.input?.apertureExposed);
              lampObs = { struckSide, apertureExposed };
              // computeLampResult deferred to post-loop when lamp detection result is available
              const prelimTier = apertureExposed ? 2 : 1;
              console.log(`[LAMP] recordLampObservation: struckSide=${struckSide} apertureExposed=${apertureExposed} (computeLampResult deferred)`);
              return {
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify({ recorded: true, tier: prelimTier, note: 'Lamp verdict and allowance are engine-rendered. Exclude lamp from your repair figure and do not describe lamp presence/absence in your report.' }),
              };
            }
            if (block.name === 'computeCopartFees') {
              const hammer     = Number(block.input?.hammer);
              const exitValue  = Number(block.input?.exit_value);
              const repair     = Number(block.input?.repair);
              if (!Number.isFinite(hammer) || hammer <= 0) {
                console.warn('[FEE TOOL] Invalid hammer from model:', block.input?.hammer);
                return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: 'Invalid hammer — must be a positive number' }) };
              }
              const fees            = feeStack(hammer);
              const hammerVat       = lotIsVatQualifying ? Math.round(hammer * 0.20 * 100) / 100 : 0;
              const hasMarginInputs = Number.isFinite(exitValue) && exitValue > 0 &&
                                      Number.isFinite(repair) && repair >= 0;
              const margin          = hasMarginInputs
                ? Math.round((exitValue - repair - hammer - hammerVat - fees.totalIncVat) * 100) / 100
                : null;
              marginScenarios.push({
                hammer, exit_value: hasMarginInputs ? exitValue : null,
                repair: hasMarginInputs ? repair : null,
                hammerVat, ...fees, margin,
              });
              toolCallCount++;
              console.log(`[FEE TOOL] computeCopartFees(${hammer}) exit=${exitValue} repair=${repair} hammerVat=${hammerVat} →`, { ...fees, margin });
              return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ ...fees, hammerVat, margin }) };
            }
            return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: 'Unknown tool' }) };
          });

        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason — take whatever text exists and break
      rawText = content.filter(c => c.type === 'text').map(c => c.text).join('');
      break;
    }

    // Car-level enforcement: exit_value and repair must be identical across all scenarios
    if (marginScenarios.length > 1) {
      const firstValid = marginScenarios.find(s => s.exit_value != null && s.repair != null);
      if (firstValid) {
        const canonicalExit   = firstValid.exit_value;
        const canonicalRepair = firstValid.repair;
        const exitDiverged    = marginScenarios.some(s => s.exit_value != null && s.exit_value !== canonicalExit);
        const repairDiverged  = marginScenarios.some(s => s.repair   != null && s.repair   !== canonicalRepair);
        if (exitDiverged || repairDiverged) {
          console.warn('[MARGIN] exit_value or repair diverged across scenarios — normalising to first valid values', { canonicalExit, canonicalRepair });
          for (let i = 0; i < marginScenarios.length; i++) {
            const s = marginScenarios[i];
            marginScenarios[i] = {
              ...s,
              exit_value: canonicalExit,
              repair:     canonicalRepair,
              margin:     Math.round((canonicalExit - canonicalRepair - s.hammer - s.hammerVat - s.totalIncVat) * 100) / 100,
            };
          }
        }
      }
    }

    // Join lamp detection (ran in parallel with main assess loop)
    const lampDetectionRaw  = await lampDetectionPromise;
    const detectedCorner    = lampDetectionRaw ? selectStruckCornerVerdict(lampDetectionRaw) : null;
    if (frontStruck) {
      console.log('[LAMP DETECT]', detectedCorner
        ? `struck corner: verdict=${detectedCorner.verdict} lamp_type=${detectedCorner.lamp_type} evidence="${(detectedCorner.evidence || '').slice(0, 80)}"`
        : lampDetectionRaw ? 'no struck corner identified in response' : 'call skipped or failed');
    }

    // Item 1: guarantee lampObs for every frontStruck lot regardless of tool co-operation
    if (frontStruck && !lampObs) {
      lampObs = { struckSide: 'central', apertureExposed: false };
      console.log('[LAMP] no tool call on frontStruck lot — Tier 1 floor defaults applied');
    }

    // Single computeLampResult call with all inputs — tool obs + detection result
    if (lampObs) {
      const derivedLampType = deriveLampType(enrichedVd);
      lampResult = computeLampResult(
        lampObs.struckSide, lampObs.apertureExposed, derivedLampType,
        detectedCorner?.verdict   || null,
        detectedCorner?.lamp_type || null
      );
      console.log(`[LAMP] final: tier=${lampResult.tier} effectiveVerdict=${lampResult.effectiveVerdict} band=£${lampResult.lampAllowance} type=${lampResult.lampType} assumed=${lampResult.lampTypeAssumed}`);
    }

    // Item 2: post-loop margin finalisation — apply headlamp allowance after both inputs are settled
    if (lampResult?.lampAllowance > 0 && marginScenarios.length > 0) {
      const lampAdj = lampResult.lampAllowance;
      for (let i = 0; i < marginScenarios.length; i++) {
        const s = marginScenarios[i];
        marginScenarios[i] = {
          ...s,
          repair:         (s.repair ?? 0) + lampAdj,
          _lampAllowance: lampAdj,
          margin:         s.margin != null ? Math.round((s.margin - lampAdj) * 100) / 100 : null,
        };
      }
      console.log(`[LAMP] post-loop margin finalisation: +£${lampAdj} headlamp allowance applied to ${marginScenarios.length} scenario(s)`);
    }

    // Cap hit: loop exhausted with tool_use still pending — force a final no-tool call
    if (!rawText && messages[messages.length - 1].role === 'user') {
      capHit = true;
      console.warn('[FEE TOOL] Iteration cap hit — forcing final response without tools');
      const finalRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: 8000,
          system: ASSESSMENT_ENGINE_PROMPT,
          messages,
        }),
      });
      const finalData = await finalRes.json();
      console.log('[TOKEN LOG] cap-fallback Input:', finalData.usage?.input_tokens, '| Output:', finalData.usage?.output_tokens);
      if (!finalRes.ok) throw new Error(finalData.error?.message || 'Claude API error (cap fallback)');
      rawText = (finalData.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    }

    if (auctionSource === 'copart' && toolCallCount === 0) {
      console.warn('[FEE TOOL] Tool never called — no margin table will be shown');
    }

    const assessment = parseAssessment(rawText);
    assessment._raw = rawText;
    assessment._market = market;
    if (capHit) assessment._feeCapHit = true;
    if (marginScenarios.length > 0) assessment._marginScenarios = marginScenarios;
    if (lampResult) assessment._lampResult = lampResult;

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
