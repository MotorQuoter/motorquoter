import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { ASSESSMENT_ENGINE_PROMPT } from '@/config/assessmentEngine';

export const maxDuration = 120;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

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

  // Strip markdown formatting that wraps field labels so labels are found reliably
  const clean = text
    .replace(/\*{1,3}/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-=_]{3,}\s*$/gm, '');

  // Find the position of each field label in the cleaned text
  const positions = [];
  for (const field of ASSESSMENT_FIELDS) {
    const rx = new RegExp(esc(field) + '\\s*:', 'i');
    const m = clean.match(rx);
    if (m !== null) {
      positions.push({ field, start: m.index, afterColon: m.index + m[0].length });
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

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const stripeSessionId = searchParams.get('session_id');
  const salvageId = searchParams.get('salvage_id');

  if (!stripeSessionId || !salvageId) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = getSupabase();

  try {
    const stripeSession = await stripe.checkout.sessions.retrieve(stripeSessionId);
    if (stripeSession.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Payment not confirmed' }, { status: 402 });
    }

    // Check for cached assessment first (without fetching images)
    const { data: check } = await supabase
      .from('salvage_sessions')
      .select('status, vehicle_details, market, assessment')
      .eq('id', salvageId)
      .single();

    if (check?.assessment) {
      return NextResponse.json({
        assessment: check.assessment,
        vehicleDetails: check.vehicle_details,
        market: check.market,
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

    await supabase
      .from('salvage_sessions')
      .update({ status: 'processing', stripe_session_id: stripeSessionId })
      .eq('id', salvageId);

    const vd = session.vehicle_details || {};
    const market = session.market || 'GB';

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
        category:         get(/Category:\s*\n?([^\n]+)/i),
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
        vatOnSale:        get(/VAT to be added[^:]*:\s*\n?([^\n]+)/i),
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

    const contextLines = [
      enrichedVd.vrm && `Registration: ${enrichedVd.vrm}`,
      enrichedVd.make && `Make: ${enrichedVd.make}`,
      enrichedVd.model && `Model: ${enrichedVd.model}`,
      enrichedVd.year && `Year: ${enrichedVd.year}`,
      enrichedVd.lotNumber && `Copart Lot Number: ${enrichedVd.lotNumber}`,
      enrichedVd.damageDescription && `Seller/Copart Damage Description: ${enrichedVd.damageDescription}`,
      `Market: ${market}`,
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

    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: ASSESSMENT_ENGINE_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    const apiData = await apiResponse.json();
    if (!apiResponse.ok) throw new Error(apiData.error?.message || 'Claude API error');

    const rawText = apiData.content?.[0]?.text || '';
    console.log('RAW ASSESSMENT TEXT:', rawText.slice(0, 500));
    const assessment = parseAssessment(rawText);
    assessment._raw = rawText;
    assessment._market = market;

    await supabase
      .from('salvage_sessions')
      .update({ status: 'assessed', assessment })
      .eq('id', salvageId);

    return NextResponse.json({ assessment, vehicleDetails: enrichedVd, market });

  } catch (err) {
    console.error('Salvage assess error:', err);
    return NextResponse.json({ error: err.message || 'Assessment failed' }, { status: 500 });
  }
}
