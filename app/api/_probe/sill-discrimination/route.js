// TEMPORARY PROBE ROUTE — back out before merge to main.
// Revert with: git revert <this commit> using the same checklist as 89da26e.
// Steps: delete this file, delete app/api/_probe/ if empty,
//        remove PROBE_SILL_ENABLED from Vercel preview env.
//
// Purpose: test whether Opus 4.8, shown only images, can correctly discriminate
// that the A-Class sill/rocker is NOT independently deformed — the damage at sill
// height is the bottom edge of the door tear, not a crushed rocker structure.
// This is Option 2's load-bearing assumption.
// Gate: PROBE_SILL_ENABLED=true in Vercel preview env only.
//       Returns 404 immediately when unset — dead in production by construction.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 180;

// EY68CWC A-Class — 14 images confirmed (array[0]=0.jpg … array[13]=13.jpg under e45cb9a0-…).
const SESSION_ID = '7b5bf9e3-ac9b-43b3-ac68-4d16882e175d';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function GET() {
  if (process.env.PROBE_SILL_ENABLED !== 'true') {
    return new Response(null, { status: 404 });
  }

  const supabase = getSupabase();

  // Fetch stored image_paths for the confirmed A-Class session
  const { data: session, error: sessionErr } = await supabase
    .from('salvage_sessions')
    .select('image_paths')
    .eq('id', SESSION_ID)
    .single();

  if (sessionErr || !session?.image_paths?.length) {
    return NextResponse.json(
      { error: 'session not found or no image_paths', detail: sessionErr?.message },
      { status: 404 }
    );
  }

  const paths = session.image_paths;

  // Download all images from storage — full stored size, no resize (same as lamp-detect)
  const imageBlocks = [];
  for (let i = 0; i < paths.length; i++) {
    const { data: blob, error } = await supabase.storage
      .from('lot-images')
      .download(paths[i]);
    if (error || !blob) {
      return NextResponse.json(
        { error: `storage fetch failed for image ${i + 1}`, path: paths[i], detail: error?.message },
        { status: 500 }
      );
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    imageBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
    });
  }

  // No side naming anywhere in the prompt. Pure visual discrimination.
  const question = `These are photos of one vehicle with damage along one flank. Look ONLY at the SILL / ROCKER PANEL — the structural member running along the bottom of the body between the front and rear wheels, BELOW the doors.

Question: is the rocker panel itself deformed — crushed, buckled, dented, or its lower body line displaced — INDEPENDENT of any damage on the door skins above it?

Answer about the rocker structure ONLY. If the only damage near sill height is the bottom edge of DOOR damage (a door tear or crease reaching down to sill height), that is DOOR damage, not sill damage — answer false. Answer true ONLY if the rocker panel's own structure is visibly deformed separate from the doors.

Respond with ONLY a raw JSON object — no markdown, no explanation, no surrounding text:
{
  "sill_independently_deformed": true | false,
  "confidence": "low" | "med" | "high",
  "reasoning": "<what you see at the rocker line specifically>"
}`;

  // Opus 4.8, all images first in one user turn, question text last — same shape as lamp-detect
  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: 'You are a vehicle damage assessor. Respond ONLY with a raw JSON object. No markdown, no explanation, no surrounding text.',
      messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: question }] }],
    }),
  });

  if (!apiRes.ok) {
    const body = await apiRes.text().catch(() => '');
    return NextResponse.json(
      { error: `Anthropic API ${apiRes.status}`, detail: body.slice(0, 300) },
      { status: 502 }
    );
  }

  const apiData = await apiRes.json();
  const rawText = ((apiData.content || []).find(b => b.type === 'text')?.text || '').trim();

  // Fail-loud: preserve raw text on parse error, expose stop_reason for max_tokens / refusal
  let modelResult;
  try {
    const m = rawText.match(/\{[\s\S]*\}/);
    modelResult = m ? JSON.parse(m[0]) : { _parse_error: true, raw_text: rawText };
  } catch {
    modelResult = { _parse_error: true, raw_text: rawText };
  }

  console.log('[SILL PROBE]', JSON.stringify(modelResult));

  return NextResponse.json({
    model_result: modelResult,
    token_usage: {
      input:       apiData.usage?.input_tokens,
      output:      apiData.usage?.output_tokens,
      stop_reason: apiData.stop_reason,
    },
  });
}
