import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import AdmZip from 'adm-zip';

export const maxDuration = 60;

const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_EXT  = /\.(jpe?g|png|webp)$/i;

const MAX_IMAGE_ENTRIES = 40;
const MAX_ENTRY_BYTES   = 15 * 1024 * 1024;   // per-entry uncompressed ceiling
const MAX_TOTAL_BYTES   = 200 * 1024 * 1024;  // total uncompressed ceiling

// In-memory rate limit — per-instance only (Vercel serverless: resets on cold start / redeploy;
// not shared across concurrent function instances). Provides a guard within a warm instance.
// Cross-instance rate limiting requires edge middleware + KV — out of scope here.
const _ipWindow  = new Map();
const RL_WINDOW_MS = 60_000;
const RL_MAX       = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const e   = _ipWindow.get(ip);
  if (!e || now > e.resetAt) { _ipWindow.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS }); return true; }
  e.count++;
  return e.count <= RL_MAX;
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function trailingInt(name) {
  const m = name.match(/(\d+)(?:\.\w+)?$/);
  return m ? parseInt(m[1], 10) : 0;
}

function lotFromFilename(name) {
  const m = name.match(/^(\d+)_/);
  return m ? m[1] : null;
}

// JPEG: FF D8 FF | PNG: 89 50 4E 47 | WebP: RIFF....WEBP (bytes 0-3 + 8-11)
function isSupportedImageBuffer(buf) {
  if (buf.length < 12) return false;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

export async function POST(request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Too many requests — please wait a moment' }, { status: 429 });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const zipFile      = formData.get('zip');
  const assessmentId = formData.get('assessmentId');

  if (!zipFile || typeof zipFile.arrayBuffer !== 'function') {
    return NextResponse.json({ error: 'No zip file provided' }, { status: 400 });
  }
  if (!assessmentId || !UUID_RE.test(String(assessmentId))) {
    return NextResponse.json({ error: 'Invalid or missing assessmentId' }, { status: 400 });
  }

  const supabase = getSupabase();

  // Overwrite guard: reject if this session UUID already has stored images.
  // Prevents a caller from clobbering another session's images by reusing a known UUID.
  {
    const { data: existing } = await supabase
      .from('salvage_sessions')
      .select('image_paths')
      .eq('id', assessmentId)
      .maybeSingle();
    if (existing?.image_paths?.length) {
      return NextResponse.json({ error: 'Session already has images — cannot overwrite' }, { status: 409 });
    }
  }

  let imageEntries;
  try {
    const arrayBuffer = await zipFile.arrayBuffer();
    const buffer      = Buffer.from(arrayBuffer);
    const zip         = new AdmZip(buffer);
    imageEntries = zip.getEntries()
      .filter(e => !e.isDirectory && IMAGE_EXT.test(e.entryName))
      .sort((a, b) => trailingInt(a.entryName) - trailingInt(b.entryName));
  } catch (err) {
    console.error('[EXTRACT-ZIP] zip parse failed:', err.message);
    return NextResponse.json({ error: 'Could not read zip file — make sure it is a valid Copart download' }, { status: 400 });
  }

  if (imageEntries.length === 0) {
    return NextResponse.json({ error: 'No images found in zip' }, { status: 400 });
  }
  if (imageEntries.length > MAX_IMAGE_ENTRIES) {
    return NextResponse.json({ error: `Too many images in zip — maximum ${MAX_IMAGE_ENTRIES}` }, { status: 400 });
  }

  // Pre-scan uncompressed sizes from zip central-directory headers (no decompression yet).
  // Guards against zip-bomb: a tiny compressed file expanding to gigabytes.
  let totalUncompressed = 0;
  for (const entry of imageEntries) {
    const entryUncompressed = entry.header.size;
    if (entryUncompressed > MAX_ENTRY_BYTES) {
      return NextResponse.json(
        { error: `Image too large — maximum ${MAX_ENTRY_BYTES / (1024 * 1024)} MB per file` },
        { status: 400 }
      );
    }
    totalUncompressed += entryUncompressed;
    if (totalUncompressed > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { error: `Zip too large — maximum ${MAX_TOTAL_BYTES / (1024 * 1024)} MB total uncompressed` },
        { status: 400 }
      );
    }
  }

  const zipLotNumber = lotFromFilename(imageEntries[0].entryName);
  console.log(`[EXTRACT-ZIP] assessmentId=${assessmentId} entries=${imageEntries.length} zipLot=${zipLotNumber ?? '(unknown)'}`);

  const imagePaths = [];
  let skipped = 0;

  for (let i = 0; i < imageEntries.length; i++) {
    const entry     = imageEntries[i];
    const imgBuffer = entry.getData();

    // Magic-byte check: reject entries whose content doesn't match a supported image format.
    // Extension-only filtering (IMAGE_EXT above) is bypassable; magic bytes are not.
    if (!isSupportedImageBuffer(imgBuffer)) {
      console.warn(`[EXTRACT-ZIP] ${entry.entryName} — magic-byte mismatch, skipped`);
      skipped++;
      continue;
    }

    const path = `${assessmentId}/${imagePaths.length}.jpg`; // consecutive index, gaps from skips not reflected
    const { error } = await supabase.storage
      .from('lot-images')
      .upload(path, imgBuffer, { contentType: 'image/jpeg', upsert: false });
    if (error) {
      console.error(`[EXTRACT-ZIP] upload failed entry ${i + 1}/${imageEntries.length}:`, error.message);
      return NextResponse.json({ error: `Failed to store image ${i + 1}` }, { status: 500 });
    }
    imagePaths.push(path);
  }

  if (imagePaths.length === 0) {
    return NextResponse.json({ error: 'No valid images found after type verification' }, { status: 400 });
  }
  if (skipped > 0) console.warn(`[EXTRACT-ZIP] skipped ${skipped} entries (magic-byte mismatch)`);
  console.log(`[EXTRACT-ZIP] stored ${imagePaths.length} images for ${assessmentId}`);
  return NextResponse.json({ imagePaths, zipLotNumber });
}
