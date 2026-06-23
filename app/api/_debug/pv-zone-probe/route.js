// ============================================================================
// DIAGNOSTIC THROWAWAY — DO NOT MERGE TO MAIN.
// Purpose: confirm whether the model assigns different zone tags to struck-side
// vs opposite-side votes for the same panel ID (FRONT_DOOR etc.) on lot EY68CWC.
// This answers whether Option B (zone-filter fix) is viable.
//
// Gate: requires env var  DEBUG_PV_ZONE_PROBE_ENABLED=true
// Set this in Vercel project → Environment Variables → Preview only.
// NEVER set it in Production. Remove this file before merging to main.
// ============================================================================

import { NextResponse }      from 'next/server';
import { createClient }      from '@supabase/supabase-js';
import { PER_VIEW_PROMPT }   from '@/app/api/salvage/assess/route';

export const maxDuration = 300;

const SESSION_ID = '7b5bf9e3-ac9b-43b3-ac68-4d16882e175d'; // EY68CWC lot 41685626

const FOCUS = new Set(['FRONT_DOOR', 'REAR_DOOR', 'FRONT_WING', 'SILL']);

const VIEW_LABELS = [
  'V0  front-L(nearside) 3/4 — struck side',
  'V1  front-R(offside)  3/4 — OPPOSITE (clean) side',
  'V2  rear-R(offside)   3/4 — opposite side',
  'V3  rear-L(nearside)  3/4 — struck side',
  'V4  interior-front (nearside door open)',
  'V5  interior-rear',
  'V6  engine bay',
  'V7  dashboard/speedo',
  'V8  direct side-on STRUCK SIDE',
  'V9  nearside front corner close-up',
  'V10 boot interior',
  'V11 rear screen/tailgate',
  'V12 windscreen/bonnet overhead',
  'V13 MBUX airbag display (left-side deployed)',
];

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

const ZONES    = 'front|rear|flank-damaged-side|roof|underside|interior';
const PART_RE  = new RegExp(
  `^PART:\\s+(.+?)\\s*\\|\\s*iv:(true|false|na|missing)\\s*(?:\\|\\s*sev:(SEVERE|MODERATE|MINOR|-)\\s*)?\\|\\s*z:(${ZONES})`,
  'i'
);

function parseRaw(raw) {
  return raw.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const m = line.match(PART_RE);
      if (!m) return null;
      const [, panelId, iv, sev, zone] = m;
      return { panelId: panelId.trim(), iv: iv.toLowerCase(), sev: sev || '-', zone };
    })
    .filter(Boolean);
}

async function probeView(b64, mediaType, idx) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      // no cache_control — throwaway diagnostic; production uses ephemeral cache
      system: [{ type: 'text', text: PER_VIEW_PROMPT }],
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
      ]}],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { idx, error: `API ${res.status}: ${body.slice(0, 120)}`, parts: [] };
  }
  const j   = await res.json();
  const raw = ((j.content || []).find(b => b.type === 'text')?.text || '').trim();
  return { idx, parts: parseRaw(raw) };
}

export async function GET() {
  if (process.env.DEBUG_PV_ZONE_PROBE_ENABLED !== 'true') {
    return NextResponse.json({ error: 'disabled — set DEBUG_PV_ZONE_PROBE_ENABLED=true in Vercel preview env' }, { status: 403 });
  }

  const supabase = getSupabase();

  const { data: session, error: sessionErr } = await supabase
    .from('salvage_sessions')
    .select('image_paths')
    .eq('id', SESSION_ID)
    .single();

  if (sessionErr || !session?.image_paths?.length) {
    return NextResponse.json({ error: 'session not found or no image_paths', detail: sessionErr?.message }, { status: 404 });
  }

  // Fetch all images from storage — read-only, no DB mutations
  const images = await Promise.all(
    session.image_paths.map(async (path, i) => {
      const { data: blob, error } = await supabase.storage.from('lot-images').download(path);
      if (error || !blob) throw new Error(`image ${i} (${path}): ${error?.message || 'not found'}`);
      const buf = Buffer.from(await blob.arrayBuffer());
      return { b64: buf.toString('base64'), mediaType: 'image/jpeg' };
    })
  );

  // Run per-view inference sequentially to respect rate limits
  const rows = [];
  for (let i = 0; i < images.length; i++) {
    const result = await probeView(images[i].b64, images[i].mediaType, i);
    const focus  = result.parts.filter(p => FOCUS.has(p.panelId));
    rows.push({
      view:       i,
      label:      VIEW_LABELS[i] || `V${i}`,
      focusParts: focus,
      error:      result.error || null,
    });
    console.log(
      `[PROBE] ${VIEW_LABELS[i] || `V${i}`}: ` +
      (result.error || focus.map(p =>
        `${p.panelId}|iv:${p.iv}|z:${p.zone}${p.iv === 'false' ? ' <<<CLEAN' : ''}`
      ).join('  ') || '(none of focus panels)')
    );
  }

  // Flat table — all focus-panel votes across all views
  const table = rows.flatMap(r =>
    r.focusParts.map(p => ({
      view:    r.view,
      label:   r.label,
      panelId: p.panelId,
      iv:      p.iv,
      sev:     p.sev,
      zone:    p.zone,
      verdict: p.iv === 'false' ? 'CLEAN_VOTE'
             : p.iv === 'true'  ? `DAMAGED_${p.sev}`
             : 'non-vote',
    }))
  );

  // Decision summary: view 1 FRONT_DOOR
  const v1FrontDoor = table.filter(r => r.view === 1 && r.panelId === 'FRONT_DOOR');

  return NextResponse.json({
    _diagnostic: 'REMOVE BEFORE MERGE TO MAIN',
    session:     SESSION_ID,
    totalViews:  images.length,
    decision: {
      question:    'View 1 (offside clean side) FRONT_DOOR iv:false — what zone?',
      v1FrontDoor,
      verdict:     v1FrontDoor.length === 0
        ? 'NO_DATA — model did not emit FRONT_DOOR for view 1; inconclusive'
        : v1FrontDoor.every(r => r.zone !== 'flank-damaged-side')
          ? 'Option B VIABLE — opposite-side clean vote carries a different zone'
          : 'Option B DEAD — model tags opposite-side door as flank-damaged-side; zone does not separate struck from opposite',
    },
    table,
  });
}
