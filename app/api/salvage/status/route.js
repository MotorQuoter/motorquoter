// batch 253 A2 (Vincent, 19 Nov) — GET /api/salvage/status?salvage_id=…&session_id=… | &promo_token=…
// The waiting page polls this when its assess fetch drops (network error) or answers 409 "already in progress". It reads ONE
// row and never calls Stripe or a model: ownership is the same credential the assess GET binds (promo token = the row's
// promoToken; paid session id = the row's stripe_session_id, written by the assess GET with the 'processing' claim — the
// re-run route checks it the same way). It never returns another session's report. The decisions are lib/assessStatus.mjs.
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ownsSession, statusReply } from '@/lib/assessStatus.mjs';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const salvageId = searchParams.get('salvage_id');
  const sessionId = searchParams.get('session_id');
  const promoToken = searchParams.get('promo_token');
  if (!salvageId || !UUID_RE.test(salvageId) || (!sessionId && !promoToken)) {
    return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: row, error } = await supabase
    .from('salvage_sessions')
    .select('status, assessment, vehicle_details, market, rerun_count, stripe_session_id, created_at')
    .eq('id', salvageId)
    .single();
  if (error || !row) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (!ownsSession(row, { sessionId, promoToken })) return NextResponse.json({ error: 'Unauthorised' }, { status: 403 });
  const reply = statusReply(row);
  return NextResponse.json(reply.body, { status: reply.http, headers: { 'Cache-Control': 'no-store' } });
}
