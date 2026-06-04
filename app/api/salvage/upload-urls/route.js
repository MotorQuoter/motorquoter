import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { assessmentId, count } = body;

  if (!assessmentId || !UUID_RE.test(assessmentId)) {
    return NextResponse.json({ error: 'Invalid assessment ID' }, { status: 400 });
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    return NextResponse.json({ error: 'count must be 1–20' }, { status: 400 });
  }

  const supabase = getSupabase();
  const uploadUrls = [];

  for (let i = 0; i < count; i++) {
    const path = `${assessmentId}/${i}.jpg`;
    const { data, error } = await supabase.storage
      .from('lot-images')
      .createSignedUploadUrl(path, { upsert: true });

    if (error || !data?.signedUrl) {
      console.error('[UPLOAD-URLS] signed URL error:', error);
      return NextResponse.json({ error: `Failed to prepare upload for image ${i + 1}` }, { status: 500 });
    }

    uploadUrls.push({ path, uploadUrl: data.signedUrl });
  }

  return NextResponse.json({ uploadUrls });
}
