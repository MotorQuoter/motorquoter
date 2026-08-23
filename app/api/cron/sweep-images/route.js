import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sweepExpiredImages } from '@/lib/imageRetention.mjs';
import { sendOpsAlert } from '@/lib/opsAlert';

// Daily 24-hour image-retention sweep (batch 39). Frees the storage that pushed Supabase over quota.
// Triggered by Vercel Cron (vercel.json), which sends Authorization: Bearer ${CRON_SECRET}.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request) {
  // Auth — same pattern as the model canary. Missing/wrong secret (or CRON_SECRET unset) → 401, no work.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ⚠️ ARM GATE. Deletion is IRREVERSIBLE, so it runs ONLY when explicitly enabled. Default (env unset)
  // = DRY RUN: it counts exactly what a real run would delete and touches nothing. The cron is
  // therefore INERT on deploy — it reports the backlog size daily but destroys nothing — until Vincent
  // has (1) backed up fixtures/ off the machine, (2) created the `keep` column in salvage_sessions,
  // (3) marked the fixture lots keep=true, and only THEN sets IMAGE_SWEEP_ENABLED=true. Even armed, the
  // sweep aborts if the keep column is missing (see lib/imageRetention) and always skips keep=true.
  const armed = process.env.IMAGE_SWEEP_ENABLED === 'true';

  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const result = await sweepExpiredImages(supabase, { olderThanHours: 24, dryRun: !armed });
    console.log(`[SWEEP IMAGES] armed=${armed} ${JSON.stringify(result)}`);

    // Silence is a defect (rule 10): alert on an aborted sweep or any per-row error.
    if (!result.ok || (result.errors?.length ?? 0) > 0) {
      await sendOpsAlert(
        'image-sweep-failed',
        '[MotorQuoter] Image sweep problem',
        `armed=${armed}<br>${result.reason || ''}<br>candidates=${result.candidates} swept=${result.rowsSwept} ` +
        `objects=${result.objectsRemoved}<br>errors: ${(result.errors || []).slice(0, 10).join('; ') || 'none'}`
      );
    }
    return NextResponse.json({ armed, ...result });
  } catch (err) {
    console.error('[SWEEP IMAGES] threw:', err?.message || err);
    try {
      await sendOpsAlert('image-sweep-failed', '[MotorQuoter] Image sweep threw', String(err?.message || err));
    } catch { /* alert best-effort */ }
    // Never 500 — a cron that 500s just retries the same failure. Report it in the body.
    return NextResponse.json({ error: 'sweep failed', detail: String(err?.message || err) });
  }
}
