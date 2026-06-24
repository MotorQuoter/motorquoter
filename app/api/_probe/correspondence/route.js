// TEMPORARY PROBE ROUTE — back out before merge to main.
// Revert with: git revert <this commit> using the same checklist as bebf36b.
// Steps: delete this file, delete app/api/_probe/ if empty,
//        remove PROBE_CORRESPONDENCE_ENABLED from Vercel preview env.
//
// Purpose: test whether the model can group A-Class photos by physical door
// from images alone — no side labels, no per-view hints.
// Gate: PROBE_CORRESPONDENCE_ENABLED=true in Vercel preview env only.
//       Returns 404 immediately when unset — dead in production by construction.

import { NextResponse }  from 'next/server';
import { createClient }  from '@supabase/supabase-js';

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
  if (process.env.PROBE_CORRESPONDENCE_ENABLED !== 'true') {
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

  // 1-based label (Image 1 = array[0]) matches Vincent's numbering.
  // Vincent's key: struck = Images 9, 4, 1 | clean (opposite side) = Images 3, 2
  const indexMapping = paths.map((path, i) => ({
    model_label: i + 1,
    array_index: i,
    path,
  }));

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

  // No side naming anywhere in the prompt.
  // 1-based numbering so "Image 9" in the answer = array[8] = Vincent's Image 9.
  const N = imageBlocks.length;
  const question = `These are ${N} photos of one salvage vehicle, numbered Image 1 through Image ${N} in the order they appear in this message (Image 1 = first photo, Image 2 = second, and so on).

Looking only at the images: for the front doors and the rear doors, how many PHYSICALLY DISTINCT damaged doors are there? A car has two front doors (one each side) and two rear doors (one each side).

For each distinct damaged door you identify, list the image numbers that show it. Group images showing the SAME physical door together.

Do NOT name sides or use left, right, nearside, or offside anywhere — group only by same-vs-different physical instance. If you cannot tell whether two images show the same door or different doors, say so explicitly for that pair.

Respond with ONLY a raw JSON object — no markdown, no explanation, no surrounding text:
{
  "panels": [
    {
      "panel": "FRONT_DOOR",
      "distinct_damaged_instances": <number>,
      "instance_groups": [[<image numbers for instance 1>], [<image numbers for instance 2>]],
      "uncertain_pairs": [[<a>, <b>]],
      "confidence": "low" | "med" | "high"
    },
    {
      "panel": "REAR_DOOR",
      "distinct_damaged_instances": <number>,
      "instance_groups": [[...], [...]],
      "uncertain_pairs": [[...]],
      "confidence": "low" | "med" | "high"
    }
  ]
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

  // Parse model JSON; preserve raw text on parse error so no data is lost
  let modelRaw;
  try {
    const m = rawText.match(/\{[\s\S]*\}/);
    modelRaw = m ? JSON.parse(m[0]) : { _parse_error: true, raw_text: rawText };
  } catch {
    modelRaw = { _parse_error: true, raw_text: rawText };
  }

  return NextResponse.json({
    index_mapping: indexMapping,
    vincent_key: 'struck=9,4,1 | clean=3,2 | both FRONT_DOOR and REAR_DOOR damaged on struck side',
    model_raw: modelRaw,
    token_usage: {
      input:       apiData.usage?.input_tokens,
      output:      apiData.usage?.output_tokens,
      stop_reason: apiData.stop_reason,
    },
  });
}
