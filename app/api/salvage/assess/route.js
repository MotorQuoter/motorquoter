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

    const contextLines = [
      vd.vrm && `Registration: ${vd.vrm}`,
      vd.make && `Make: ${vd.make}`,
      vd.model && `Model: ${vd.model}`,
      vd.year && `Year: ${vd.year}`,
      vd.lotNumber && `Copart Lot Number: ${vd.lotNumber}`,
      vd.damageDescription && `Seller/Copart Damage Description: ${vd.damageDescription}`,
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
    const assessment = parseAssessment(rawText);
    assessment._raw = rawText;
    assessment._market = market;

    await supabase
      .from('salvage_sessions')
      .update({ status: 'assessed', assessment })
      .eq('id', salvageId);

    return NextResponse.json({ assessment, vehicleDetails: vd, market });

  } catch (err) {
    console.error('Salvage assess error:', err);
    return NextResponse.json({ error: err.message || 'Assessment failed' }, { status: 500 });
  }
}
