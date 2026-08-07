'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PRICING } from '@/config/pricing';

const ZIP_IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const MAX_PHOTOS = 40;          // shared ceiling: individual-photo path and zip path both cap here
const ZIP_MAX_IMAGES = MAX_PHOTOS;

// Ported verbatim from app/api/salvage/extract-zip/route.js so client-side ordering + lot
// parsing match the old server behaviour exactly (Option A: unzip in the browser).
function zipTrailingInt(name) {
  const m = name.match(/(\d+)(?:\.\w+)?$/);
  return m ? parseInt(m[1], 10) : 0;
}
function zipLotFromFilename(name) {
  const m = name.match(/^(\d+)_/);
  return m ? m[1] : null;
}

// Source-aware listing paste copy. Keyed by the same auctionSource that routes fees (copart|iaa).
// Copart keeps its verified Select-All guidance; IAA/SYNETIQ uses neutral guidance until the
// IAA-specific paste flow is verified against a real IAA lot (do not fabricate their steps).
const LISTING_COPY = {
  copart: {
    label: 'Copart Listing',
    placeholder: 'Select All on the Copart listing page (Ctrl+A / Cmd+A), then paste here.\n\nVRM, lot number, and damage details are extracted automatically.',
  },
  iaa: {
    label: 'IAA / SYNETIQ Listing',
    placeholder: 'Paste the full IAA / SYNETIQ listing page here.\n\nVRM, lot number, and damage details are extracted automatically.',
  },
};
function listingCopy(source) {
  return LISTING_COPY[source] || { label: 'Auction Listing', placeholder: 'Paste the full auction listing page here.\n\nVRM, lot number, and damage details are extracted automatically.' };
}

export default function SalvagePage() {
  const router = useRouter();
  const [images, setImages] = useState([]);
  const [details, setDetails] = useState({ vrm: '', make: '', model: '', year: '', lotNumber: '', damageDescription: '', bodyStyle: '' });
  const [market, setMarket] = useState('GB');
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [dvlaData, setDvlaData] = useState(null);
  const [dvlaStatus, setDvlaStatus] = useState(''); // '' | 'loading' | 'found' | 'not_found' | 'error'
  const [dvlaError, setDvlaError] = useState('');
  const [motWarning, setMotWarning] = useState('');
  const [isRerun, setIsRerun] = useState(false);
  const [rerunSalvageId, setRerunSalvageId] = useState('');
  const [freeReportToken, setFreeReportToken] = useState(''); // Commit 3: single-use free-report credential from the verify redirect
  const [auctionSource, setAuctionSource] = useState('copart');
  const [copartMileage, setCopartMileage] = useState('');
  const [promoInput, setPromoInput] = useState('');
  const [appliedPromo, setAppliedPromo] = useState(null);
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError, setPromoError] = useState(null);
  const fileInputRef = useRef(null);
  const zipFileInputRef = useRef(null);

  // Zip ingest state
  const [zipStatus, setZipStatus] = useState(''); // '' | 'extracting' | 'ready' | 'error'
  const [zipError, setZipError] = useState('');
  const [zipLotNumber, setZipLotNumber] = useState(null);
  const [zipImagePaths, setZipImagePaths] = useState([]);
  const [zipAssessmentId, setZipAssessmentId] = useState('');
  const [zipDragging, setZipDragging] = useState(false);
  const [vrnAutoFilled, setVrnAutoFilled] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState(false);
  // Payment currency — INDEPENDENT of market. GBP default; EUR is opt-in and shown ONLY on IE
  // lots. Fresh page load / new assessment resets to 'gbp' (useState default); switching market
  // away from IE also reasserts 'gbp' (see the GB button handler). No sticky EUR across sessions.
  const [payCurrency, setPayCurrency] = useState('gbp');

  const price = PRICING.salvageAssessment.price;
  const priceEUR = PRICING.salvageAssessment.priceEUR;
  // EUR fires only when the lot is IE AND EUR is explicitly chosen — so a GB/NI lot always
  // displays and charges GBP regardless of any stale toggle state.
  const useEUR = market === 'IE' && payCurrency === 'eur';
  const displaySymbol = useEUR ? '€' : '£';
  const displayAmount = useEUR ? priceEUR : price;
  const payCurrencyValue = useEUR ? 'eur' : 'gbp'; // exactly what the checkout POST sends

  // Auto-proceed: if submit was attempted while zip was still extracting, fire it
  // the moment extraction finishes. Clears on error so a retry is needed.
  useEffect(() => {
    if (zipStatus === 'ready' && pendingSubmit) {
      setPendingSubmit(false);
      handleSubmit();
    } else if (zipStatus === 'error' && pendingSubmit) {
      setPendingSubmit(false);
    }
  }, [zipStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('cancelled') === 'true') setCancelled(true);
    const frt = params.get('free_report_token');
    if (frt) setFreeReportToken(frt);
    const rerunId = params.get('rerun');
    const rerunVrm = params.get('vrm');
    if (rerunId) {
      setIsRerun(true);
      setRerunSalvageId(rerunId);
      if (rerunVrm) {
        setDetails(p => ({ ...p, vrm: rerunVrm.toUpperCase() }));
        handleVrmLookup(rerunVrm.toUpperCase());
      }
    }
  }, []);

  const compressImage = (file) => new Promise((resolve) => {
    const MAX = 1568;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          if (width > height) { height = Math.round(height * MAX / width); width = MAX; }
          else { width = Math.round(width * MAX / height); height = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve({ base64: canvas.toDataURL('image/jpeg', 0.82), name: file.name });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });

  const handleFiles = useCallback(async (files) => {
    const incoming = Array.from(files);
    const available = Math.max(0, MAX_PHOTOS - images.length);
    const toAdd = incoming.slice(0, available);
    // Tell the user when their selection overflowed the cap instead of silently dropping the extras.
    if (incoming.length > toAdd.length) {
      setError(`Maximum ${MAX_PHOTOS} photos — the extras weren't added`);
    }
    if (toAdd.length === 0) return;
    const processed = await Promise.all(toAdd.map(compressImage));
    setImages(prev => [...prev, ...processed].slice(0, MAX_PHOTOS));
    // Photos added — clear any latched zip-error so the "Zip failed" banner
    // doesn't lie about state once the user has chosen the individual path.
    setZipStatus('');
    setZipError('');
  }, [images.length]);

  const removeImage = (idx) => setImages(prev => prev.filter((_, i) => i !== idx));

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const onDragOver = (e) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);

  const handleVrmLookup = async (vrm) => {
    if (!vrm || vrm.length < 2) return;
    setDvlaStatus('loading');
    setDvlaError('');
    setMotWarning('');
    try {
      const res = await fetch(`/api/vehicle?vrm=${encodeURIComponent(vrm)}&tier=free`);
      const data = await res.json();

      if (data.make) {
        setDvlaData(data);
        setDvlaStatus('found');
        setDetails(p => ({
          ...p,
          make: data.make || p.make,
          model: data.model || p.model,
          year: data.yearOfManufacture ? String(data.yearOfManufacture) : p.year,
          colour: data.colour || p.colour,
          fuelType: data.fuelType || p.fuelType,
          taxStatus: data.taxStatus || p.taxStatus,
          motStatus: data.motStatus || p.motStatus,
          lastMotMileage: data.motMileage ? String(data.motMileage) : p.lastMotMileage,
        }));

        // Cross-reference MOT mileage vs Copart odometer if both available
        if (data.motMileage && details.odometer) {
          const copartMiles = parseInt(String(details.odometer).replace(/,/g, ''));
          if (!isNaN(copartMiles) && copartMiles < data.motMileage * 0.95) {
            setMotWarning(`⚠️ MILEAGE FLAG: Last MOT recorded ${data.motMileage.toLocaleString()} miles — listing shows ${copartMiles.toLocaleString()} miles. Possible clocking — verify before bidding.`);
          }
        }

        // Flag SORN or expired MOT
        if (data.taxStatus && data.taxStatus.toUpperCase().includes('SORN')) {
          setMotWarning(prev => prev + (prev ? ' | ' : '') + '⚠️ Vehicle is SORN — not currently taxed.');
        }
      } else {
        setDvlaError(data.error || '');
        setDvlaStatus('not_found');
      }
    } catch {
      setDvlaStatus('error');
    }
  };

  const handleApplyPromo = async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code) return;
    setPromoLoading(true);
    setPromoError(null);
    try {
      const res = await fetch(`/api/promo/validate?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (data.valid) {
        if (data.allowed_products && !data.allowed_products.includes('salvage')) {
          setPromoError('This code is not valid for this product');
        } else {
          setAppliedPromo({ code, discount_type: data.discount_type, discount_value: data.discount_value });
        }
      } else {
        setPromoError(data.error || 'Invalid promo code');
      }
    } catch {
      setPromoError('Could not check promo code. Please try again.');
    } finally {
      setPromoLoading(false);
    }
  };

  // ── Paste-in helpers ───────────────────────────────────────────────────
  function extractVrnFromText(text) {
    const m = text.match(/VRN:\s*\n?\s*([A-Z0-9]{2,9})/i);
    return m ? m[1].toUpperCase().replace(/\s+/g, '') : null;
  }

  function extractLotFromText(text) {
    const m = text.match(/Lot number:\s*\n?\s*(\d+)/i);
    return m ? m[1] : null;
  }

  const handleDescriptionChange = (text) => {
    const vrn = extractVrnFromText(text);
    const lot = extractLotFromText(text);
    setDetails(p => ({
      ...p,
      damageDescription: text,
      ...(vrn && !p.vrm ? { vrm: vrn } : {}),
      ...(lot && !p.lotNumber ? { lotNumber: lot } : {}),
    }));
    if (vrn && !details.vrm) {
      setVrnAutoFilled(true);
      setDvlaStatus('');
      handleVrmLookup(vrn);
    }
  };

  const handleZipFile = async (file) => {
    if (!file || !/\.zip$/i.test(file.name)) {
      setZipError('Please drop a .zip file (the auction download)');
      setZipStatus('error');
      return;
    }
    const id = crypto.randomUUID();
    setZipAssessmentId(id);
    setZipStatus('extracting');
    setZipError('');
    setZipLotNumber(null);
    setZipImagePaths([]);
    try {
      // Option A: unzip in the browser (no size cap, no function timeout), then reuse the
      // signed-URL image upload path. Trades away the server-side magic-byte check (parity
      // with the individual-photo path, which is also client-trust); zip-bomb risk is moot
      // because unpacking happens here, not in a function.
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files)
        .filter(e => !e.dir && ZIP_IMAGE_EXT.test(e.name))
        .sort((a, b) => zipTrailingInt(a.name) - zipTrailingInt(b.name));

      if (entries.length === 0) {
        throw new Error('No images found in the zip — is it an auction download?');
      }
      if (entries.length > ZIP_MAX_IMAGES) {
        throw new Error(`Too many images in the zip — maximum ${ZIP_MAX_IMAGES}.`);
      }

      const lot = zipLotFromFilename(entries[0].name);

      // Signed upload URLs, one per image (same endpoint the photo path uses).
      const urlRes = await fetch('/api/salvage/upload-urls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assessmentId: id, count: entries.length }),
      });
      if (!urlRes.ok) {
        const ct = urlRes.headers.get('content-type') || '';
        const msg = ct.includes('application/json') ? (await urlRes.json()).error : null;
        throw new Error(msg || 'Failed to prepare zip image upload');
      }
      const { uploadUrls } = await urlRes.json();

      const paths = await Promise.all(entries.map(async (entry, i) => {
        const blob = await entry.async('blob');
        const { path, uploadUrl } = uploadUrls[i];
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body: blob,
        });
        if (!putRes.ok) {
          throw new Error(`Failed to upload image ${i + 1} of ${entries.length} — please try again`);
        }
        return path;
      }));

      setZipImagePaths(paths);
      setZipLotNumber(lot || null);
      setZipStatus('ready');
    } catch (e) {
      setZipStatus('error');
      setZipError(e.message || 'Failed to process zip');
    }
  };

  const handleSubmit = async () => {
    if (zipStatus === 'extracting') {
      setPendingSubmit(true);
      return;
    }
    // Zip-error feedback applies ONLY when there are no individual photos to fall
    // back on. With photos present, skip it and fall through to the convergent
    // else-branch (which uploads `images`).
    if (zipStatus === 'error' && images.length === 0) {
      setError(zipError || 'Zip extraction failed — tap the zip zone to retry.');
      return;
    }
    if (zipImagePaths.length === 0 && images.length === 0) {
      setError('Drop the auction zip or upload photos to continue.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      let assessmentId, imagePaths;

      if (zipImagePaths.length > 0) {
        // Zip path — images already stored during drop
        assessmentId = zipAssessmentId;
        imagePaths = zipImagePaths;
      } else {
        // Legacy individual upload path
        assessmentId = crypto.randomUUID();
        const urlRes = await fetch('/api/salvage/upload-urls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assessmentId, count: images.length }),
        });
        if (!urlRes.ok) {
          const ct = urlRes.headers.get('content-type') || '';
          const msg = ct.includes('application/json') ? (await urlRes.json()).error : null;
          throw new Error(msg || 'Failed to prepare image upload');
        }
        const { uploadUrls } = await urlRes.json();

        imagePaths = await Promise.all(images.map(async (img, i) => {
          const { path, uploadUrl } = uploadUrls[i];
          const blob = await fetch(img.base64).then(r => r.blob());
          const uploadRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/jpeg' },
            body: blob,
          });
          if (!uploadRes.ok) {
            throw new Error(`Failed to upload image ${i + 1} of ${images.length} — please try again`);
          }
          return path;
        }));
      }

      // Proceed to checkout/promo/rerun with storage paths
      const vehicleDetails = {
        ...details,
        // Immutable original Copart paste — captured untouched at first submit. parseCopart
        // reads THIS (not the mutable/cleaned damageDescription), so re-assess/rerun are
        // idempotent. Server enforces write-once: inserts set it, updates preserve it.
        rawCopartPaste: details.damageDescription,
        copartListedMileage: copartMileage ? parseInt(copartMileage, 10) : null,
        auctionSource,
        dvlaVerified: dvlaStatus === 'found',
        motMileageFlag: motWarning || null,
        motHistory: dvlaData?.motHistory ?? null,
        typeApproval: dvlaData?.typeApproval || null,
        wheelplan: dvlaData?.wheelplan || null,
        revenueWeight: dvlaData?.revenueWeight ?? null,
      };

      // Scope gate — pre-payment. Only M1/N1/M2 admitted. Reruns exempt (already paid/admitted).
      if (!isRerun) {
        const ta = vehicleDetails.typeApproval;
        const IN_SCOPE = ['M1', 'N1', 'M2'];
        if (!ta) {
          setError('A registration is required so we can confirm the vehicle type. Please enter the VRM to continue.');
          setLoading(false);
          return;
        }
        if (!IN_SCOPE.includes(ta)) {
          setError(`This vehicle type (${ta}) isn't supported — MotorQuoter covers cars, vans, pickups and minibuses only.`);
          setLoading(false);
          return;
        }
      }

      if (appliedPromo?.discount_type === 'free') {
        const res = await fetch('/api/salvage/promo-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vehicleDetails, imagePaths, market, promoCode: appliedPromo.code }),
        });
        if (!res.ok) {
          const ct = res.headers.get('content-type') || '';
          const data = ct.includes('application/json') ? await res.json() : {};
          throw new Error(data.error || 'Promo checkout failed');
        }
        const data = await res.json();
        if (!data.salvage_id) throw new Error(data.error || 'Promo checkout failed');
        router.push(`/salvage/success?salvage_id=${data.salvage_id}&promo_token=${data.promoToken}`);
        return;
      }

      if (freeReportToken && !isRerun) {
        const res = await fetch('/api/salvage/promo-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vehicleDetails, imagePaths, market, free_report_token: freeReportToken }),
        });
        if (!res.ok) {
          const ct = res.headers.get('content-type') || '';
          const data = ct.includes('application/json') ? await res.json() : {};
          throw new Error(data.error || 'Free report failed');
        }
        const data = await res.json();
        if (!data.salvage_id) throw new Error(data.error || 'Free report failed');
        router.push(`/salvage/success?salvage_id=${data.salvage_id}&promo_token=${data.promoToken}`);
        return;
      }

      if (isRerun) {
        const res = await fetch('/api/salvage/rerun-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ salvage_id: rerunSalvageId, vehicleDetails, imagePaths, market }),
        });
        if (!res.ok) {
          const ct = res.headers.get('content-type') || '';
          const data = ct.includes('application/json') ? await res.json() : {};
          throw new Error(data.error || 'Re-run failed');
        }
        const data = await res.json();
        if (!data.salvage_id) throw new Error(data.error || 'Re-run failed');
        if (data.promoToken) {
          router.push(`/salvage/success?salvage_id=${data.salvage_id}&promo_token=${data.promoToken}`);
        } else {
          router.push(`/salvage/success?salvage_id=${data.salvage_id}&session_id=${data.stripe_session_id}`);
        }
      } else {
        const res = await fetch('/api/salvage/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vehicleDetails, imagePaths, market, currency: payCurrencyValue }),
        });
        if (!res.ok) {
          const ct = res.headers.get('content-type') || '';
          const data = ct.includes('application/json') ? await res.json() : {};
          throw new Error(data.error || 'Checkout failed');
        }
        const data = await res.json();
        if (!data.url) throw new Error(data.error || 'Checkout failed');
        window.location.href = data.url;
      }
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=Barlow:wght@400;500;600&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --bg: #1e1a17; --bg2: #2a2420; --bg3: #332e29;
          --orange: #f05a1a; --orange-light: #ff6b2b; --orange-dim: rgba(240,90,26,0.15);
          --text: #f0ebe6; --text-dim: #9a8f87;
          --border: rgba(240,90,26,0.25); --border-dim: rgba(255,255,255,0.08);
          --yellow: #f5c842;
        }
        body { background: var(--bg); color: var(--text); font-family: 'Barlow', sans-serif; min-height: 100vh; }
        .app { max-width: 480px; margin: 0 auto; padding: 0 0 60px; }

        .header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border-dim); }
        .logo { display: flex; align-items: center; gap: 10px; cursor: pointer; }
        .logo-text { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 20px; letter-spacing: 0.05em; }

        .hero { padding: 32px 20px 20px; }
        .hero-eyebrow { font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.2em; color: var(--orange); text-transform: uppercase; margin-bottom: 8px; }
        .hero-title { font-family: 'Barlow Condensed', sans-serif; font-weight: 900; font-size: 52px; line-height: 0.96; letter-spacing: -0.01em; text-transform: uppercase; }
        .hero-title span { color: var(--orange); }
        .hero-sub { margin-top: 12px; font-size: 14px; color: var(--text-dim); line-height: 1.5; }
        .price-badge { display: inline-flex; align-items: center; gap: 8px; margin-top: 14px; background: var(--orange-dim); border: 1.5px solid var(--border); border-radius: 8px; padding: 8px 14px; }
        .price-badge-amount { font-family: 'Barlow Condensed', sans-serif; font-size: 24px; font-weight: 900; color: var(--orange); }
        .price-badge-label { font-size: 13px; color: var(--text-dim); }

        .form { padding: 0 20px; display: flex; flex-direction: column; gap: 22px; }
        .field-label { font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; color: var(--orange); text-transform: uppercase; margin-bottom: 8px; }
        .field-label span { color: var(--text-dim); font-weight: 400; font-size: 11px; letter-spacing: 0.04em; text-transform: none; font-family: 'Barlow', sans-serif; }

        .upload-zone { border: 2px dashed var(--border-dim); border-radius: 12px; padding: 28px 16px; text-align: center; cursor: pointer; transition: all 0.2s; background: var(--bg2); }
        .upload-zone.dragging { border-color: var(--orange); background: var(--orange-dim); }
        .upload-zone:hover { border-color: rgba(240,90,26,0.4); }
        .upload-zone.has-images { padding: 16px; }
        .upload-icon { font-size: 32px; margin-bottom: 8px; }
        .upload-title { font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 800; color: var(--text); margin-bottom: 4px; }
        .upload-sub { font-size: 13px; color: var(--text-dim); }
        .upload-count { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; color: var(--orange); margin-top: 8px; }

        .photo-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
        .photo-thumb { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--bg3); }
        .photo-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .photo-remove { position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; background: rgba(0,0,0,0.75); border: none; border-radius: 50%; color: white; font-size: 12px; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; }
        .photo-remove:hover { background: rgba(240,90,26,0.9); }
        .add-more { aspect-ratio: 1; border-radius: 8px; border: 2px dashed var(--border-dim); background: var(--bg3); display: flex; align-items: center; justify-content: center; font-size: 22px; cursor: pointer; color: var(--text-dim); transition: all 0.15s; }
        .add-more:hover { border-color: var(--orange); color: var(--orange); }

        .row-fields { display: flex; gap: 10px; }
        .row-fields > div { flex: 1; }

        .text-input { width: 100%; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 13px 16px; font-family: 'Barlow', sans-serif; font-size: 15px; color: var(--text); outline: none; transition: border-color 0.2s, box-shadow 0.2s; }
        .text-input:focus { border-color: var(--orange); box-shadow: 0 0 0 3px var(--orange-dim); }
        .text-input::placeholder { color: rgba(154,143,135,0.45); }
        .textarea-input { width: 100%; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 13px 16px; font-family: 'Barlow', sans-serif; font-size: 14px; color: var(--text); outline: none; transition: border-color 0.2s, box-shadow 0.2s; resize: vertical; min-height: 90px; line-height: 1.5; }
        .textarea-input:focus { border-color: var(--orange); box-shadow: 0 0 0 3px var(--orange-dim); }
        .textarea-input::placeholder { color: rgba(154,143,135,0.45); }

        .select-input { width: 100%; background: var(--bg2); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='none' stroke='%239a8f87' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' d='M2 4l4 4 4-4'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 14px center; border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 13px 40px 13px 16px; font-family: 'Barlow', sans-serif; font-size: 15px; color: var(--text); outline: none; transition: border-color 0.2s, box-shadow 0.2s; appearance: none; cursor: pointer; }
        .select-input:focus { border-color: var(--orange); box-shadow: 0 0 0 3px var(--orange-dim); }
        .select-input option { background: var(--bg2); color: var(--text); }

        .market-toggle { display: flex; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 4px; gap: 4px; }
        .market-btn { flex: 1; padding: 11px 16px; background: none; border: 1.5px solid transparent; border-radius: 7px; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 16px; letter-spacing: 0.06em; color: var(--text-dim); transition: all 0.18s; display: flex; align-items: center; justify-content: center; gap: 7px; }
        .market-btn:hover { color: var(--text); background: var(--bg3); }
        .market-btn.active { background: var(--orange-dim); border-color: var(--border); color: var(--orange); }

        .btn-pay { width: 100%; padding: 18px; background: var(--orange); border: none; border-radius: 10px; color: white; font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 20px; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
        .btn-pay:hover:not(:disabled) { background: var(--orange-light); transform: translateY(-1px); box-shadow: 0 4px 20px rgba(240,90,26,0.45); }
        .btn-pay:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }

        .error-box { background: rgba(248,113,113,0.1); border: 1.5px solid rgba(248,113,113,0.3); border-radius: 10px; padding: 14px 18px; color: #f87171; font-size: 14px; line-height: 1.5; }
        .cancel-box { background: rgba(154,143,135,0.1); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 14px 18px; color: var(--text-dim); font-size: 14px; line-height: 1.5; }

        .feature-list { background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
        .feature-item { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: var(--text-dim); line-height: 1.4; }
        .feature-dot { color: var(--orange); font-size: 16px; flex-shrink: 0; margin-top: -1px; }

        .footer-note { text-align: center; padding: 24px 20px 0; font-size: 12px; color: var(--text-dim); line-height: 1.6; }
        .footer-note a { color: var(--orange); text-decoration: none; }
      `}</style>

      <div className="app">
        <header className="header">
          <div className="logo" onClick={() => router.push('/')}>
            <svg viewBox="0 0 36 36" width="36" height="36" xmlns="http://www.w3.org/2000/svg">
              <circle cx="18" cy="18" r="16" fill="none" stroke="#e8500a" strokeWidth="2.5"/>
              <circle cx="18" cy="18" r="11" fill="none" stroke="#e8500a" strokeWidth="1.5"/>
              <line x1="18" y1="18" x2="18"   y2="7"    stroke="#e8500a" strokeWidth="1.5"/>
              <line x1="18" y1="18" x2="28.5" y2="14.6" stroke="#e8500a" strokeWidth="1.5"/>
              <line x1="18" y1="18" x2="24.5" y2="26.9" stroke="#e8500a" strokeWidth="1.5"/>
              <line x1="18" y1="18" x2="11.5" y2="26.9" stroke="#e8500a" strokeWidth="1.5"/>
              <line x1="18" y1="18" x2="7.5"  y2="14.6" stroke="#e8500a" strokeWidth="1.5"/>
              <circle cx="18" cy="18" r="2.5" fill="#e8500a"/>
            </svg>
            <span className="logo-text">MOTORQUOTER</span>
          </div>
        </header>

        <div className="hero" style={{ padding: '32px 20px 20px' }}>
          <p className="hero-eyebrow">Salvage & Auction Intelligence</p>
          <h1 className="hero-title">
            DAMAGE<br /><span>ASSESSMENT</span>
          </h1>
          <p className="hero-sub">Upload auction listing photos. Our AI reads the damage, estimates repair costs, and calculates your margin — before you bid.</p>
          <div className="price-badge">
            <span className="price-badge-amount">{displaySymbol}{displayAmount.toFixed(2)}</span>
            <span className="price-badge-label">per assessment · no subscription</span>
          </div>
        </div>

        <div className="form">
          {cancelled && (
            <div className="cancel-box">Payment cancelled — your photos are still saved. You can try again below.</div>
          )}

          {/* Auction Listing paste box — label + guidance adapt to the selected auction source */}
          <div>
            <div className="field-label">{listingCopy(auctionSource).label} <span>(paste the whole page — VRM and lot extracted automatically)</span></div>
            <textarea
              className="textarea-input"
              style={{ minHeight: 160 }}
              placeholder={listingCopy(auctionSource).placeholder}
              value={details.damageDescription}
              onChange={e => handleDescriptionChange(e.target.value)}
            />
            {vrnAutoFilled && details.vrm && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                Auto-extracted — VRM: <strong style={{ color: 'var(--text)' }}>{details.vrm}</strong>{details.lotNumber ? ` · Lot: ${details.lotNumber}` : ''}
              </div>
            )}
          </div>

          {/* Photos — ZIP drop zone */}
          <div>
            <div className="field-label">Photos <span>(drop the auction zip — no extraction needed)</span></div>
            <div
              className={`upload-zone ${zipDragging ? 'dragging' : ''}`}
              onDrop={e => { e.preventDefault(); setZipDragging(false); const files = e.dataTransfer.files; if (!files.length) return; files[0].name.toLowerCase().endsWith('.zip') ? handleZipFile(files[0]) : handleFiles(files); }}
              onDragOver={e => { e.preventDefault(); setZipDragging(true); }}
              onDragLeave={() => setZipDragging(false)}
              onClick={() => zipStatus !== 'extracting' && zipFileInputRef.current?.click()}
              style={{ cursor: zipStatus === 'extracting' ? 'wait' : 'pointer' }}
            >
              {zipStatus === '' && (
                <>
                  <div className="upload-icon">🗜</div>
                  <div className="upload-title">Drop auction zip here or tap</div>
                  <div className="upload-sub">Drag the downloaded zip directly — no need to extract</div>
                </>
              )}
              {zipStatus === 'extracting' && (
                <>
                  <div className="upload-icon">⏳</div>
                  <div className="upload-title">Extracting photos…</div>
                  <div className="upload-sub">Uploading images from zip</div>
                </>
              )}
              {zipStatus === 'ready' && (
                <>
                  <div className="upload-icon">✓</div>
                  <div className="upload-title">{zipImagePaths.length} photos ready</div>
                  {zipLotNumber && <div className="upload-sub">Lot {zipLotNumber} · tap to replace</div>}
                </>
              )}
              {zipStatus === 'error' && (
                <>
                  <div className="upload-icon">⚠</div>
                  <div className="upload-title">Zip failed — tap to retry</div>
                  <div className="upload-sub" style={{ color: '#f87171' }}>{zipError}</div>
                </>
              )}
            </div>
            <input
              ref={zipFileInputRef}
              type="file"
              accept=".zip"
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files[0]) handleZipFile(e.target.files[0]); e.target.value = ''; }}
            />
            {/* Lot cross-check warning */}
            {zipLotNumber && details.lotNumber && zipLotNumber !== details.lotNumber && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#f5c842', padding: '8px 12px', background: 'rgba(245,200,66,0.08)', borderRadius: 8, border: '1px solid rgba(245,200,66,0.2)' }}>
                ⚠ Photos are for lot {zipLotNumber} but the pasted description shows lot {details.lotNumber} — check you have the right listing.
              </div>
            )}
            {/* Individual photo fallback */}
            <div
              style={{ marginTop: 10, borderRadius: 8, border: '1px solid var(--border-dim)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', background: 'var(--bg2)' }}
              onClick={() => fileInputRef.current?.click()}
            >
              <span style={{ fontSize: 20, lineHeight: 1 }}>📸</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>Upload individual photos</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>Click to pick files, or drag images onto the zone above</div>
              </div>
              {images.length > 0 && (
                <span style={{ fontSize: 12, color: 'var(--orange)', whiteSpace: 'nowrap' }}>{images.length} selected</span>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; }}
            />
          </div>

          {/* Auction Source */}
          <div>
            <div className="field-label">Auction Source</div>
            <select
              className="select-input"
              value={auctionSource}
              onChange={e => setAuctionSource(e.target.value)}
            >
              <option value="copart">Copart UK</option>
              <option value="iaa">IAA UK / SYNETIQ</option>
              <option value="bca">BCA</option>
              <option value="manheim">Manheim</option>
              <option value="other">Other / Private</option>
            </select>
          </div>

          {/* Vehicle details */}
          <div>
            <div className="field-label">Vehicle Details <span>(all optional)</span></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                className="text-input"
                placeholder="Registration / VRM (e.g. AB12CDE)"
                value={details.vrm}
                onChange={e => { setDetails(p => ({ ...p, vrm: e.target.value.toUpperCase() })); setDvlaStatus(''); }}
                onBlur={e => { if (e.target.value.length >= 2) handleVrmLookup(e.target.value.trim()); }}
                maxLength={12}
                disabled={isRerun}
                style={{ opacity: isRerun ? 0.6 : 1, cursor: isRerun ? 'not-allowed' : 'text' }}
              />
              {isRerun && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>VRM locked — re-run is for this vehicle only</div>}
              {dvlaStatus === 'loading' && (
                <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '4px 0' }}>🔍 Looking up vehicle...</div>
              )}
              {dvlaStatus === 'found' && dvlaData && (
                <div>
                  <div style={{ fontSize: 12, color: '#4ade80', padding: '4px 0' }}>
                    {dvlaData.market === 'IE' ? '🇮🇪 ROI Register' : '✓ Verified'} — {[dvlaData.make, dvlaData.model, dvlaData.yearOfManufacture].filter(Boolean).join(' ')} · {dvlaData.fuelType} · {dvlaData.colour}
                  </div>
                  {dvlaData.motHistory?.length > 0 && (
                    <div style={{ marginTop: 4, paddingLeft: 2 }}>
                      {dvlaData.motHistory.slice(0, 4).map((test, i) => {
                        const pass = test.testResult?.toUpperCase() === 'PASSED';
                        const advisories = test.defects?.filter(d => d.type === 'ADVISORY' || d.type === 'PRS') || [];
                        return (
                          <div key={i} style={{ marginBottom: 3 }}>
                            <div style={{ fontSize: 11, display: 'flex', gap: 6 }}>
                              <span style={{ color: pass ? '#4ade80' : '#f87171', fontWeight: 700, flexShrink: 0 }}>{pass ? '✓' : '✗'}</span>
                              <span style={{ color: 'var(--text-dim)' }}>{test.completedDate}{test.odometerValue ? ` · ${Number(test.odometerValue).toLocaleString()} mi` : ''}</span>
                            </div>
                            {advisories.map((adv, j) => (
                              <div key={j} style={{ fontSize: 10, color: 'var(--text-dim)', paddingLeft: 16, lineHeight: 1.4 }}>↳ {adv.text}</div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {dvlaStatus === 'not_found' && (
                <div style={{ fontSize: 12, color: '#f87171', padding: '4px 0' }}>
                  ⚠️ {dvlaError || 'VRM not found — check and retry'}
                </div>
              )}
              {motWarning && (
                <div style={{ fontSize: 12, color: '#f5c842', padding: '6px 10px', background: 'rgba(245,200,66,0.1)', borderRadius: 6, marginTop: 4 }}>
                  {motWarning}
                </div>
              )}
              <div className="row-fields">
                <div>
                  <input
                    className="text-input"
                    placeholder="Make"
                    value={details.make}
                    onChange={e => setDetails(p => ({ ...p, make: e.target.value }))}
                  />
                </div>
                <div>
                  <input
                    className="text-input"
                    placeholder="Model"
                    value={details.model}
                    onChange={e => setDetails(p => ({ ...p, model: e.target.value }))}
                  />
                </div>
                <div style={{ maxWidth: 90 }}>
                  <input
                    className="text-input"
                    placeholder="Year"
                    inputMode="numeric"
                    maxLength={4}
                    value={details.year}
                    onChange={e => setDetails(p => ({ ...p, year: e.target.value.replace(/\D/g, '') }))}
                  />
                </div>
              </div>
              <input
                className="text-input"
                placeholder="Lot Number"
                value={details.lotNumber}
                onChange={e => setDetails(p => ({ ...p, lotNumber: e.target.value }))}
              />
              <select
                className="select-input"
                value={details.bodyStyle}
                onChange={e => setDetails(p => ({ ...p, bodyStyle: e.target.value }))}
              >
                <option value="">Body type (optional)</option>
                <option value="Panel van">Panel van</option>
                <option value="Crew van">Crew van</option>
                <option value="Pickup">Pickup</option>
                <option value="People carrier">People carrier</option>
                <option value="Minibus">Minibus</option>
                <option value="Luton van">Luton / box van</option>
                <option value="Dropside tipper flatbed">Dropside / tipper / flatbed</option>
              </select>
              <div>
                <input
                  className="text-input"
                  placeholder="Auction listed mileage (optional)"
                  inputMode="numeric"
                  value={copartMileage}
                  onChange={e => setCopartMileage(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5 }}>Enter the mileage shown on the auction listing. If blank, we'll use the last MOT mileage from DVSA.</div>
              </div>
            </div>
          </div>

          {/* Market */}
          <div>
            <div className="field-label">Repair Market</div>
            <div className="market-toggle">
              <button className={`market-btn ${market === 'GB' ? 'active' : ''}`} onClick={() => { setMarket('GB'); setPayCurrency('gbp'); }}>
                🇬🇧 GB
              </button>
              <button className={`market-btn ${market === 'IE' ? 'active' : ''}`} onClick={() => setMarket('IE')}>
                🇮🇪 IE
              </button>
            </div>
          </div>

          {/* Pay currency — ROI/IE lots only. GBP is the default; EUR is opt-in. */}
          {market === 'IE' && (
            <div>
              <div className="field-label">Pay in</div>
              <div className="market-toggle">
                <button className={`market-btn ${payCurrency === 'gbp' ? 'active' : ''}`} onClick={() => setPayCurrency('gbp')}>
                  £ GBP
                </button>
                <button className={`market-btn ${payCurrency === 'eur' ? 'active' : ''}`} onClick={() => setPayCurrency('eur')}>
                  € EUR
                </button>
              </div>
            </div>
          )}

          {/* What's included */}
          <div className="feature-list">
            <div className="feature-item"><span className="feature-dot">▸</span>Repair cost range with key cost drivers</div>
            <div className="feature-item"><span className="feature-dot">▸</span>Cat S/N assessment, airbag deployment analysis, dashboard warning light interpretation</div>
            <div className="feature-item"><span className="feature-dot">▸</span>Realistic Cat N/S exit value with 20–35% discount applied</div>
            <div className="feature-item"><span className="feature-dot">▸</span>Margin calculation — hammer price ready to enter</div>
            <div className="feature-item"><span className="feature-dot">▸</span>Tailored WhatsApp inspection checklist for this lot</div>
            <div className="feature-item"><span className="feature-dot">▸</span>Downloadable PDF report</div>
          </div>

          {/* Promo code */}
          {!isRerun && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>Have a promo code?</div>
              {appliedPromo ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1, background: 'rgba(74,222,128,0.1)', border: '1.5px solid rgba(74,222,128,0.3)', borderRadius: 7, padding: '7px 11px', fontSize: 13, color: '#4ade80', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>✓ {appliedPromo.code}</div>
                  <button style={{ background: 'none', border: '1.5px solid var(--border-dim)', borderRadius: 7, padding: '7px 10px', color: 'var(--text-dim)', fontSize: 12, cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif" }} onClick={() => { setAppliedPromo(null); setPromoInput(''); setPromoError(null); }}>Remove</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" placeholder="Enter code" value={promoInput} onChange={e => { setPromoInput(e.target.value.toUpperCase()); setPromoError(null); }} onKeyDown={e => e.key === 'Enter' && handleApplyPromo()} style={{ flex: 1, background: 'var(--bg)', border: '1.5px solid var(--border-dim)', borderRadius: 7, padding: '9px 11px', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: "'Barlow', sans-serif" }} />
                  <button onClick={handleApplyPromo} disabled={!promoInput.trim() || promoLoading} style={{ background: 'var(--bg3)', border: '1.5px solid var(--border-dim)', borderRadius: 7, padding: '9px 14px', color: 'var(--text)', fontSize: 13, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.05em', cursor: 'pointer', opacity: (!promoInput.trim() || promoLoading) ? 0.45 : 1 }}>{promoLoading ? '...' : 'Apply'}</button>
                </div>
              )}
              {promoError && <div style={{ marginTop: 5, fontSize: 11, color: '#f87171' }}>{promoError}</div>}
            </div>
          )}

          {error && <div className="error-box">⚠️ {error}</div>}

          <button
            className="btn-pay"
            onClick={handleSubmit}
            disabled={loading || zipStatus === 'extracting'}
          >
            {loading
              ? '⏳ Saving...'
              : zipStatus === 'extracting'
                ? '⏳ Loading photos…'
                : isRerun
                  ? '↺ Re-run Assessment (free)'
                  : appliedPromo?.discount_type === 'free'
                    ? '🎟 Redeem & Assess'
                    : freeReportToken
                      ? '✓ Get my free assessment'
                      : `🔨 Pay ${displaySymbol}${displayAmount.toFixed(2)} and Assess`}
          </button>
        </div>

        <p className="footer-note">
          <span style={{ color: 'var(--text)', fontWeight: 700 }}>Official DVLA &amp; DVSA data.</span><br />
          AI-powered damage assessment. Not a professional repair quote.<br />
          Not affiliated with Copart, IAA/SYNETIQ, CAP or HPI. &nbsp;<a href="/terms">Terms &amp; Conditions</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp; <a href="/">← Back to VRM lookup</a>
        </p>
      </div>
    </>
  );
}
