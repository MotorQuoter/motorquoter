import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function POST(request) {
  const { salvage_id } = await request.json();
  if (!salvage_id) return NextResponse.json({ error: 'Missing salvage_id' }, { status: 400 });

  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('salvage_sessions')
    .select('rerun_count, assessment')
    .eq('id', salvage_id)
    .single();

  if (error || !data) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  const currentCount = data.rerun_count ?? 0;
  if (currentCount >= 1) return NextResponse.json({ error: 'Re-run limit reached' }, { status: 403 });

  await supabase
    .from('salvage_sessions')
    .update({ assessment: null, status: 'pending', rerun_count: currentCount + 1 })
    .eq('id', salvage_id);

  return NextResponse.json({ success: true });
}
