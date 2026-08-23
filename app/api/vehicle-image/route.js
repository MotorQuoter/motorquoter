import { after } from 'next/server';
import { oneAutoFetch, withOneAutoLog, flushOneAutoLog } from '@/lib/oneAuto.mjs';

// ⚠️ RETIREMENT RISK (batch 39 §5.3): the two calls below use the `oneauto/` endpoint prefix —
// the same family whose sibling `oneauto/servicehistory/` was silently retired (404) in May and hid
// as a per-request failure for weeks. These render vehicle images and work today, but if images ever
// stop appearing, suspect a One Auto path retirement here FIRST (probe with the keyless 403-vs-404
// technique) rather than assuming a bug. Not changed — flagged so the next retirement is not silent.

// Wrapper (commit 2): log this request's One Auto image calls (buffered, one post-response write).
export async function POST(request) {
  const { result, calls } = await withOneAutoLog(() => handleImagePost(request));
  if (calls.length) after(() => flushOneAutoLog(calls, null));
  return result;
}

async function handleImagePost(request) {
  try {
    const { vrm, colour } = await request.json();
    if (!vrm) return Response.json({ imageUrl: null });

    const cleanVrm = vrm.replace(/\s+/g, '').toUpperCase();

    // Step 1: resolve image_id from VRM
    const searchRes = await oneAutoFetch(
      `oneauto/imagesearchfromvrm/?vehicle_registration_mark=${cleanVrm}`
    );
    if (!searchRes.ok) return Response.json({ imageUrl: null });

    const searchData = await searchRes.json();

    // Find the front image across common response shapes
    const images = searchData?.image_data ?? searchData?.images ?? searchData?.result ?? searchData?.data ?? [];
    let imageId = null;
    if (Array.isArray(images) && images.length > 0) {
      const front = images.find(img =>
        (img.angle ?? img.image_angle ?? img.view ?? img.description ?? '').toLowerCase().includes('front')
      ) ?? images[0];
      imageId = front?.image_id ?? front?.id ?? null;
    } else if (searchData?.image_id) {
      imageId = searchData.image_id;
    }

    if (!imageId) return Response.json({ imageUrl: null });

    // Step 2: fetch the rendered image
    const params = new URLSearchParams({ image_id: String(imageId), image_background: 'Transparent' });
    if (colour) params.set('generic_colour_desc', colour);

    const imgRes = await oneAutoFetch(
      `oneauto/imagefromid/?${params}`
    );
    if (!imgRes.ok) return Response.json({ imageUrl: null });

    const contentType = imgRes.headers.get('content-type') ?? '';
    if (contentType.startsWith('image/')) {
      const buf = await imgRes.arrayBuffer();
      const mime = contentType.split(';')[0].trim();
      const b64 = Buffer.from(buf).toString('base64');
      return Response.json({ imageUrl: `data:${mime};base64,${b64}` });
    }

    // JSON response — extract URL
    const imgData = await imgRes.json();
    const imageUrl = imgData?.image_url ?? imgData?.url ?? imgData?.image ?? null;
    return Response.json({ imageUrl: imageUrl ?? null });

  } catch {
    return Response.json({ imageUrl: null });
  }
}
