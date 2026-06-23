import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import AdmZip from 'adm-zip';

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Parse the trailing integer from a filename for numeric sort.
// "45760446_Image_10.jpg" → 10; "Image_2.jpg" → 2; "photo.jpg" → 0
function trailingInt(name) {
  const m = name.match(/(\d+)(?:\.\w+)?$/);
  return m ? parseInt(m[1], 10) : 0;
}

// Extract the lot-number prefix from the first filename.
// "45760446_Image_1.jpg" → "45760446"; "other.jpg" → null
function lotFromFilename(name) {
  const m = name.match(/^(\d+)_/);
  return m ? m[1] : null;
}

export async function POST(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const zipFile = formData.get('zip');
  const assessmentId = formData.get('assessmentId');

  if (!zipFile || typeof zipFile.arrayBuffer !== 'function') {
    return NextResponse.json({ error: 'No zip file provided' }, { status: 400 });
  }
  if (!assessmentId || !UUID_RE.test(String(assessmentId))) {
    return NextResponse.json({ error: 'Invalid or missing assessmentId' }, { status: 400 });
  }

  let imageEntries;
  try {
    const arrayBuffer = await zipFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const zip = new AdmZip(buffer);
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

  const zipLotNumber = lotFromFilename(imageEntries[0].entryName);
  console.log(`[EXTRACT-ZIP] assessmentId=${assessmentId} images=${imageEntries.length} zipLot=${zipLotNumber ?? '(unknown)'}`);

  const supabase = getSupabase();
  const imagePaths = [];

  for (let i = 0; i < imageEntries.length; i++) {
    const entry = imageEntries[i];
    const imgBuffer = entry.getData();
    const path = `${assessmentId}/${i}.jpg`;
    const { error } = await supabase.storage
      .from('lot-images')
      .upload(path, imgBuffer, { contentType: 'image/jpeg', upsert: true });
    if (error) {
      console.error(`[EXTRACT-ZIP] storage upload failed image ${i + 1}/${imageEntries.length}:`, error.message);
      return NextResponse.json({ error: `Failed to store image ${i + 1} of ${imageEntries.length}` }, { status: 500 });
    }
    imagePaths.push(path);
  }

  console.log(`[EXTRACT-ZIP] stored ${imagePaths.length} images for ${assessmentId}`);
  return NextResponse.json({ imagePaths, zipLotNumber });
}
