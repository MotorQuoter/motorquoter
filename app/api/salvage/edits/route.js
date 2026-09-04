import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ledgerHash } from '@/lib/ledgerEdits';

// Buyer ledger edits (batch 82). Stores a reversible, version-stamped edit layer over the IMMUTABLE
// engine assessment. GET returns the stored layer; POST replaces it (the client owns the strikes/adds
// arrays — reversible by construction). The layer is stamped with the ledgerHash of the assessment's
// _reconciledParts; on POST we recompute that hash and REJECT (409) if it no longer matches what the
// client edited against (the report was re-run / body-type-patched under them). The assessment jsonb is
// never touched here. Ownership reuses the salvage_id + Stripe/promo credential gate (same as
// patch-body-type / pdf). Service-role only.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STRIKES = 200;
const MAX_ADDS = 50;
const MAX_TEXT = 200;
const MAX_AMOUNT = 10_000_000;

function getSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function owns(session, session_id, promo_token) {
  const viaStripe = session_id && session.stripe_session_id && session.stripe_session_id === session_id;
  const viaPromo  = promo_token && session.vehicle_details?.promoToken && session.vehicle_details.promoToken === promo_token;
  return !!(viaStripe || viaPromo);
}

function sanitizeStrikes(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const k of raw) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 128) continue;
    if (seen.has(k)) continue;             // a strike is a set — one entry per row
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_STRIKES) break;
  }
  return out;
}

function sanitizeAdds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const text = typeof a.text === 'string' ? a.text.slice(0, MAX_TEXT) : '';
    const amountNum = Number(a.amount);
    if (!text.trim() || !Number.isFinite(amountNum)) continue;
    // The buyer's own figure is not second-guessed (batch 82 §4) — only bounded to a sane numeric range
    // to keep it a valid number; never blocked, never clamped toward "our" figure.
    const amount = Math.max(0, Math.min(MAX_AMOUNT, Math.round(amountNum * 100) / 100));
    const id = (typeof a.id === 'string' && a.id.length && a.id.length <= 64)
      ? a.id
      : `add_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    out.push({ id, text, amount });
    if (out.length >= MAX_ADDS) break;
  }
  return out;
}

async function loadSession(supabase, salvage_id) {
  return supabase
    .from('salvage_sessions')
    .select('stripe_session_id, vehicle_details, assessment, edit_layer, rerun_count')
    .eq('id', salvage_id)
    .single();
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const salvage_id = searchParams.get('salvage_id');
  const session_id = searchParams.get('session_id');
  const promo_token = searchParams.get('promo_token');

  if (!salvage_id || !UUID_RE.test(String(salvage_id))) {
    return NextResponse.json({ error: 'Missing or invalid salvage_id' }, { status: 400 });
  }
  if (!session_id && !promo_token) {
    return NextResponse.json({ error: 'Missing payment token' }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data: session, error } = await loadSession(supabase, salvage_id);
  if (error || !session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (!owns(session, session_id, promo_token)) return NextResponse.json({ error: 'Unauthorised' }, { status: 403 });

  const currentStamp = ledgerHash(session.assessment?._reconciledParts);
  return NextResponse.json({ editLayer: session.edit_layer ?? null, currentStamp });
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const { salvage_id, session_id, promo_token, stamp, strikes, adds } = body;
  if (!salvage_id || !UUID_RE.test(String(salvage_id))) {
    return NextResponse.json({ error: 'Missing or invalid salvage_id' }, { status: 400 });
  }
  if (!session_id && !promo_token) {
    return NextResponse.json({ error: 'Missing payment token' }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data: session, error } = await loadSession(supabase, salvage_id);
  if (error || !session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  if (!owns(session, session_id, promo_token)) return NextResponse.json({ error: 'Unauthorised' }, { status: 403 });

  // Cat A/B hard stop is not editable (batch 82 §4). Refuse rather than store an inert layer.
  // The engine stores the hard stop as `_catABHardStop`; `_catAB` was never written (dead gate fixed
  // batch 105). Read the real field, keep the old name as a defensive alias.
  if (session.assessment?._catABHardStop || session.assessment?._catAB) {
    return NextResponse.json({ error: 'This report is under a Cat A/B legal hard stop and cannot be edited.' }, { status: 409 });
  }

  const currentStamp = ledgerHash(session.assessment?._reconciledParts);
  // Conflict guard: the client edited against a specific ledger. If the report was re-run or
  // body-type-patched since, the stamp changed — reject so the client re-renders rather than saving
  // edits that would land on rows the buyer never saw.
  if (stamp && stamp !== currentStamp) {
    return NextResponse.json({ error: 'The report changed since you started editing — reload before saving.', currentStamp }, { status: 409 });
  }

  const cleanStrikes = sanitizeStrikes(strikes);
  const cleanAdds = sanitizeAdds(adds);

  const editLayer = (cleanStrikes.length === 0 && cleanAdds.length === 0)
    ? null   // no edits → clear the layer
    : { stamp: currentStamp, rerunStamp: session.rerun_count ?? 0, strikes: cleanStrikes, adds: cleanAdds, updatedAt: new Date().toISOString() };

  const { error: updErr } = await supabase
    .from('salvage_sessions')
    .update({ edit_layer: editLayer })
    .eq('id', salvage_id);
  if (updErr) return NextResponse.json({ error: 'Failed to save edits' }, { status: 500 });

  return NextResponse.json({ ok: true, editLayer, currentStamp });
}
