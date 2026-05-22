'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { PRICING, IE_MENU } from '@/config/pricing';
import { isRoiPlate } from '@/lib/roiPlate';

const enabledItems = PRICING.menu.filter(i => i.enabled);
const defaultSelected = enabledItems.filter(i => i.preSelected).map(i => i.key);

const ieEnabledItems = IE_MENU.filter(i => i.enabled);
const ieDefaultSelected = ieEnabledItems.filter(i => i.preSelected).map(i => i.key);

const FULL_COVERAGE_MAKES = new Set([
  'AUDI', 'BMW', 'CUPRA', 'FORD', 'HONDA', 'INFINITI', 'JAGUAR', 'LAND ROVER',
  'LEXUS', 'MAZDA', 'MERCEDES-BENZ', 'MINI', 'NISSAN', 'OPEL', 'PORSCHE',
  'SEAT', 'SKODA', 'TOYOTA', 'VAUXHALL', 'VOLKSWAGEN',
]);

export default function Home() {
  const router = useRouter();
  const [vrm, setVrm] = useState('');
  const [mileage, setMileage] = useState('');
  const [market, setMarket] = useState('GB');
  const [loading, setLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState(defaultSelected);
  const fileInputRef = useRef(null);
  const [marketLocked, setMarketLocked] = useState(false);
  const [ieSelectedKeys, setIeSelectedKeys] = useState(ieDefaultSelected);
  const [promoInput, setPromoInput] = useState('');
  const [appliedPromo, setAppliedPromo] = useState(null);
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError, setPromoError] = useState(null);

  // Computed synchronously on every render — no useEffect, no async state cycle.
  const autoIrish = vrm.length >= 3 && isRoiPlate(vrm);
  const effectiveMarket = marketLocked ? market : (autoIrish ? 'IE' : 'GB');

  // ── Plate scan — preserved exactly ──────────────────────────────────────────
  const handlePhotoScan = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setScanning(true);
    setError(null);

    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const response = await fetch('/api/platescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageData: base64, mediaType: file.type }),
      });

      const data = await response.json();

      if (data.error || !data.reg) {
        setError('Could not read a registration plate from that photo. Please type it manually.');
      } else {
        setVrm(data.reg);
      }
    } catch {
      setError('Plate scan failed. Please type the registration manually.');
    } finally {
      setScanning(false);
    }
  };

  // ── Free DVLA check (GB) / IE menu reveal ────────────────────────────────────
  const handleCheck = async (vrmArg) => {
    const vrmToUse = vrmArg !== undefined ? vrmArg : vrm;
    if (!vrmToUse.trim()) return;

    // IE uses its own builder checkout — paste/auto-check should not trigger a lookup
    if (effectiveMarket === 'IE') return;
    if (isRoiPlate(vrmToUse.trim().replace(/\s/g, '').toUpperCase())) return;

    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const params = new URLSearchParams({
        vrm: vrmToUse.trim().replace(/\s/g, '').toUpperCase(),
        tier: 'free',
      });
      if (mileage) params.append('mileage', mileage);
      if (market)  params.append('market', market);

      const res = await fetch(`/api/vehicle?${params}`);
      const data = await res.json();

      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
        const make = data.make?.toUpperCase() || null;
        if (make && !FULL_COVERAGE_MAKES.has(make)) {
          setSelectedKeys(prev => prev.filter(k => k !== 'service_history'));
        }
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── IE checkout ──────────────────────────────────────────────────────────────
  const handleIeCheckout = async () => {
    if (!vrm.trim() || ieSelectedKeys.length === 0) return;
    setCheckoutLoading(true);
    setError(null);

    const cleanVrm = vrm.trim().replace(/\s/g, '').toUpperCase();
    const checksStr = ieSelectedKeys.join(',');

    // Free promo: skip Stripe entirely
    if (appliedPromo?.discount_type === 'free') {
      try {
        const res = await fetch('/api/promo/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vrm: cleanVrm, checks: ieSelectedKeys, mileage: mileage || '', market: 'IE', promo_code: appliedPromo.code }),
        });
        const data = await res.json();
        if (data.error) { setError(data.error); setCheckoutLoading(false); }
        else { window.location.href = `/payment-success?vrm=${cleanVrm}&checks=${checksStr}&market=IE&mileage=${mileage || ''}&session_id=${data.token}&free=true`; }
      } catch {
        setError('Could not redeem promo code. Please try again.');
        setCheckoutLoading(false);
      }
      return;
    }

    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vrm: cleanVrm,
          checks: ieSelectedKeys,
          mileage: mileage || '',
          market: 'IE',
          promoCode: appliedPromo?.code || null,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setCheckoutLoading(false);
      } else {
        window.location.href = data.url;
      }
    } catch {
      setError('Could not start checkout. Please try again.');
      setCheckoutLoading(false);
    }
  };

  // ── Promo code ───────────────────────────────────────────────────────────────
  const handleApplyPromo = async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code) return;
    setPromoLoading(true);
    setPromoError(null);
    try {
      const res = await fetch(`/api/promo/validate?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (data.valid) {
        setAppliedPromo({ code, discount_type: data.discount_type, discount_value: data.discount_value });
      } else {
        setPromoError(data.error || 'Invalid promo code');
      }
    } catch {
      setPromoError('Could not check promo code. Please try again.');
    } finally {
      setPromoLoading(false);
    }
  };

  // ── Checklist toggle ─────────────────────────────────────────────────────────
  // Optional items = enabled items that are not always-locked (MOT) and not valuation
  const optionalItems = enabledItems.filter(i => !i.locked && i.key !== 'valuation');
  const anyOptionalSelected = optionalItems.some(i => selectedKeys.includes(i.key));
  // Valuation is locked (mandatory) only while no optional item is selected
  const valuationLocked = !anyOptionalSelected;

  const toggleItem = (key) => {
    const item = enabledItems.find(i => i.key === key);
    if (!item) return;
    if (item.locked && key !== 'valuation') return; // MOT always locked
    if (key === 'valuation' && valuationLocked) return; // valuation locked with empty basket

    setSelectedKeys(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      // If basket just became all-optional-empty, re-lock valuation (auto-add it back)
      const anyOptInNext = optionalItems.some(i => next.includes(i.key));
      if (!anyOptInNext && !next.includes('valuation')) return [...next, 'valuation'];
      return next;
    });
  };

  const allOptionalSelected = optionalItems.length > 0 && optionalItems.every(i => selectedKeys.includes(i.key));

  const handleSelectAll = () => {
    if (allOptionalSelected) {
      // Deselect all optional — keep only locked items (Valuation + MOT)
      setSelectedKeys(defaultSelected);
    } else {
      // Select every enabled item
      setSelectedKeys(enabledItems.map(i => i.key));
    }
  };

  // ── IE checklist ─────────────────────────────────────────────────────────────
  const ieOptionalItems = ieEnabledItems.filter(i => !i.locked);
  const ieAnyOptionalSelected = ieOptionalItems.some(i => ieSelectedKeys.includes(i.key));
  const ieValuationLocked = !ieAnyOptionalSelected;
  const ieAllOptionalSelected = ieOptionalItems.length > 0 && ieOptionalItems.every(i => ieSelectedKeys.includes(i.key));

  const ieToggleItem = (key) => {
    const item = ieEnabledItems.find(i => i.key === key);
    if (!item) return;
    if (item.locked && key !== 'ie_valuation') return;
    if (key === 'ie_valuation' && ieValuationLocked) return;
    setIeSelectedKeys(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      const anyOptInNext = ieOptionalItems.some(i => next.includes(i.key));
      if (!anyOptInNext && !next.includes('ie_valuation')) return [...next, 'ie_valuation'];
      return next;
    });
  };

  const ieHandleSelectAll = () => {
    if (ieAllOptionalSelected) {
      setIeSelectedKeys(ieDefaultSelected);
    } else {
      setIeSelectedKeys(ieEnabledItems.map(i => i.key));
    }
  };

  const SERVICE_FEE = 0.25;
  const baseTotal = enabledItems
    .filter(i => selectedKeys.includes(i.key))
    .reduce((sum, i) => sum + i.price, 0) + SERVICE_FEE;

  let discountAmount = 0;
  if (appliedPromo) {
    if (appliedPromo.discount_type === 'percent') {
      discountAmount = parseFloat((baseTotal * (appliedPromo.discount_value / 100)).toFixed(2));
    } else if (appliedPromo.discount_type === 'fixed') {
      discountAmount = Math.min(Number(appliedPromo.discount_value), baseTotal);
    } else if (appliedPromo.discount_type === 'free') {
      discountAmount = baseTotal;
    }
  }
  const total = Math.max(0, parseFloat((baseTotal - discountAmount).toFixed(2)));

  // IE total
  const ieBaseTotal = ieEnabledItems
    .filter(i => ieSelectedKeys.includes(i.key))
    .reduce((sum, i) => sum + i.price, 0) + SERVICE_FEE;
  let ieDiscountAmount = 0;
  if (appliedPromo) {
    if (appliedPromo.discount_type === 'percent') {
      ieDiscountAmount = parseFloat((ieBaseTotal * (appliedPromo.discount_value / 100)).toFixed(2));
    } else if (appliedPromo.discount_type === 'fixed') {
      ieDiscountAmount = Math.min(Number(appliedPromo.discount_value), ieBaseTotal);
    } else if (appliedPromo.discount_type === 'free') {
      ieDiscountAmount = ieBaseTotal;
    }
  }
  const ieTotal = Math.max(0, parseFloat((ieBaseTotal - ieDiscountAmount).toFixed(2)));

  // ── Stripe checkout ──────────────────────────────────────────────────────────
  const handleGetReport = async () => {
    if (!vrm.trim() || selectedKeys.length === 0) return;
    setCheckoutLoading(true);
    setError(null);

    const cleanVrm = vrm.trim().replace(/\s/g, '').toUpperCase();

    // Free promo: skip Stripe entirely
    if (appliedPromo?.discount_type === 'free') {
      try {
        const res = await fetch('/api/promo/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vrm: cleanVrm, checks: selectedKeys, mileage: mileage || '', market: effectiveMarket || 'GB', promo_code: appliedPromo.code }),
        });
        const data = await res.json();
        if (data.error) { setError(data.error); setCheckoutLoading(false); }
        else {
          const checksStr = selectedKeys.join(',');
          window.location.href = `/payment-success?vrm=${cleanVrm}&checks=${checksStr}&mileage=${mileage || ''}&market=${effectiveMarket || 'GB'}&session_id=${data.token}&free=true`;
        }
      } catch {
        setError('Could not redeem promo code. Please try again.');
        setCheckoutLoading(false);
      }
      return;
    }

    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vrm: cleanVrm,
          checks: selectedKeys,
          mileage: mileage || '',
          market: effectiveMarket || 'GB',
          promoCode: appliedPromo?.code || null,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setCheckoutLoading(false);
      } else {
        window.location.href = data.url;
      }
    } catch {
      setError('Could not start checkout. Please try again.');
      setCheckoutLoading(false);
    }
  };

  const salvage = PRICING.salvageAssessment;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=Barlow:wght@400;500;600&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #1e1a17;
          --bg2: #2a2420;
          --bg3: #332e29;
          --orange: #f05a1a;
          --orange-light: #ff6b2b;
          --orange-dim: rgba(240,90,26,0.15);
          --text: #f0ebe6;
          --text-dim: #9a8f87;
          --border: rgba(240,90,26,0.25);
          --border-dim: rgba(255,255,255,0.08);
          --yellow: #f5c842;
        }

        body { background: var(--bg); color: var(--text); font-family: 'Barlow', sans-serif; min-height: 100vh; }
        .app { max-width: 480px; margin: 0 auto; padding: 0 0 60px; }

        .header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border-dim); }
        .logo { display: flex; align-items: center; gap: 10px; }
        .logo-text { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 20px; letter-spacing: 0.05em; color: var(--text); }

        .hero { padding: 36px 20px 28px; text-align: center; }
        .hero-eyebrow { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.2em; color: var(--orange); margin-bottom: 12px; text-transform: uppercase; }
        .hero-title { font-family: 'Barlow Condensed', sans-serif; font-weight: 900; font-size: 64px; line-height: 0.95; letter-spacing: -0.01em; text-transform: uppercase; }
        .hero-title span { color: var(--orange); display: block; }
        .hero-sub { margin-top: 16px; font-size: 16px; color: var(--text-dim); line-height: 1.5; max-width: 320px; margin-left: auto; margin-right: auto; }

        .form { padding: 0 20px; display: flex; flex-direction: column; gap: 20px; }

        .field-label { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.15em; color: var(--orange); text-transform: uppercase; margin-bottom: 8px; }
        .field-label span { color: var(--text-dim); font-weight: 400; font-size: 12px; letter-spacing: 0.05em; text-transform: none; font-family: 'Barlow', sans-serif; }

        .vrm-wrap { position: relative; display: flex; gap: 10px; align-items: center; }
        .vrm-wrap .vrm-input { flex: 1; }

        .camera-btn { background: var(--bg3); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 0 16px; height: 64px; font-size: 24px; cursor: pointer; transition: all 0.2s; flex-shrink: 0; }
        .camera-btn:hover:not(:disabled) { border-color: var(--orange); background: var(--orange-dim); }
        .camera-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .scan-status { margin-top: 8px; font-size: 13px; color: var(--orange); text-align: center; }

        .vrm-input { width: 100%; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 18px 20px; font-family: 'Barlow Condensed', sans-serif; font-size: 28px; font-weight: 700; letter-spacing: 0.15em; color: var(--text-dim); text-align: center; text-transform: uppercase; outline: none; transition: border-color 0.2s, box-shadow 0.2s; }
        .vrm-input:focus { border-color: var(--orange); box-shadow: 0 0 0 3px var(--orange-dim); color: var(--text); }
        .vrm-input::placeholder { color: rgba(154,143,135,0.5); letter-spacing: 0.1em; }

        .mileage-wrap { position: relative; }
        .mileage-input { width: 100%; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 16px 70px 16px 20px; font-family: 'Barlow', sans-serif; font-size: 18px; color: var(--text-dim); outline: none; transition: border-color 0.2s, box-shadow 0.2s; }
        .mileage-input:focus { border-color: var(--orange); box-shadow: 0 0 0 3px var(--orange-dim); color: var(--text); }
        .mileage-input::placeholder { color: rgba(154,143,135,0.4); }
        .mileage-unit { position: absolute; right: 16px; top: 50%; transform: translateY(-50%); color: var(--text-dim); font-size: 14px; font-weight: 500; pointer-events: none; }

        .market-toggle { display: flex; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 4px; gap: 4px; }
        .market-toggle-btn { flex: 1; padding: 11px 16px; background: none; border: 1.5px solid transparent; border-radius: 7px; cursor: pointer; font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 16px; letter-spacing: 0.06em; color: var(--text-dim); transition: all 0.18s; display: flex; align-items: center; justify-content: center; gap: 7px; }
        .market-toggle-btn:hover { color: var(--text); background: var(--bg3); }
        .market-toggle-btn.active { background: var(--orange-dim); border-color: var(--border); color: var(--orange); }
        .market-toggle-btn .market-flag { font-size: 20px; line-height: 1; }

        .btn-submit { width: 100%; padding: 18px; background: var(--orange); border: none; border-radius: 10px; color: white; font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 18px; letter-spacing: 0.1em; text-transform: uppercase; cursor: pointer; transition: all 0.2s; margin-top: 4px; }
        .btn-submit:hover:not(:disabled) { background: var(--orange-light); transform: translateY(-1px); box-shadow: 0 4px 20px rgba(240,90,26,0.4); }
        .btn-submit:disabled { opacity: 0.45; cursor: not-allowed; transform: none; box-shadow: none; }

        /* ── DVLA result ── */
        .result { margin: 24px 20px 0; background: var(--bg2); border: 1.5px solid var(--border); border-radius: 12px; overflow: hidden; }
        .result-header { background: var(--orange-dim); border-bottom: 1px solid var(--border); padding: 16px 20px; }
        .result-reg { font-family: 'Barlow Condensed', sans-serif; font-size: 22px; font-weight: 900; letter-spacing: 0.1em; color: var(--orange); }
        .result-vehicle { font-size: 15px; color: var(--text); font-weight: 600; margin-top: 4px; }
        .result-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
        .result-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-dim); }
        .result-row:last-child { border-bottom: none; }
        .result-key { font-size: 13px; color: var(--text-dim); font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; font-family: 'Barlow Condensed', sans-serif; }
        .result-val { font-size: 15px; color: var(--text); font-weight: 600; text-align: right; }
        .result-val.good { color: #4ade80; }
        .result-val.warn { color: var(--yellow); }
        .result-val.bad  { color: #f87171; }

        /* ── Build Your Report checklist ── */
        .report-builder { margin: 16px 20px 0; }
        .report-builder-label { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.2em; color: var(--orange); text-transform: uppercase; margin-bottom: 10px; }

        .check-list { background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 12px; overflow: hidden; }

        .check-item { display: flex; align-items: center; gap: 13px; padding: 13px 16px; border-bottom: 1px solid var(--border-dim); cursor: pointer; transition: background 0.15s; user-select: none; }
        .check-item:last-child { border-bottom: none; }
        .check-item.locked { cursor: default; }
        .check-item:not(.locked):hover { background: var(--bg3); }
        .check-item.selected:not(.locked) { background: rgba(240,90,26,0.08); }

        .check-box { width: 22px; height: 22px; border: 2px solid var(--border-dim); border-radius: 5px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; transition: all 0.15s; }
        .check-item.selected .check-box { background: var(--orange); border-color: var(--orange); color: white; }
        .check-item.locked .check-box { background: rgba(154,143,135,0.18); border-color: rgba(154,143,135,0.35); color: var(--text-dim); }

        .check-info { flex: 1; min-width: 0; }
        .check-label { font-family: 'Barlow Condensed', sans-serif; font-size: 15px; font-weight: 700; color: var(--text); letter-spacing: 0.02em; }
        .check-desc { font-size: 12px; color: var(--text-dim); margin-top: 2px; line-height: 1.4; }

        .check-price { font-family: 'Barlow Condensed', sans-serif; font-size: 15px; font-weight: 800; color: var(--text); white-space: nowrap; flex-shrink: 0; }
        .check-price.free { color: #4ade80; font-size: 13px; font-weight: 700; }

        .total-bar { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 4px; }
        .total-label { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.15em; color: var(--text-dim); text-transform: uppercase; }
        .total-amount { font-family: 'Barlow Condensed', sans-serif; font-size: 26px; font-weight: 900; color: var(--text); }

        .btn-get-report { width: 100%; padding: 18px; background: var(--orange); border: none; border-radius: 10px; color: white; font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 18px; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; transition: all 0.2s; margin-top: 10px; }
        .btn-get-report:hover:not(:disabled) { background: var(--orange-light); transform: translateY(-1px); box-shadow: 0 4px 20px rgba(240,90,26,0.4); }
        .btn-get-report:disabled { opacity: 0.45; cursor: not-allowed; transform: none; box-shadow: none; }

        /* ── Salvage card ── */
        .salvage-card { margin: 24px 20px 0; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 12px; padding: 20px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .salvage-card:hover { border-color: var(--orange); background: var(--orange-dim); }
        .salvage-card-left { display: flex; align-items: center; gap: 14px; }
        .salvage-icon { font-size: 28px; flex-shrink: 0; }
        .salvage-title { font-family: 'Barlow Condensed', sans-serif; font-size: 17px; font-weight: 800; letter-spacing: 0.04em; color: var(--text); margin-bottom: 3px; }
        .salvage-desc { font-size: 13px; color: var(--text-dim); line-height: 1.4; }
        .salvage-price { font-family: 'Barlow Condensed', sans-serif; font-size: 20px; font-weight: 900; color: var(--orange); white-space: nowrap; flex-shrink: 0; }

        /* ── Loading / error ── */
        .loading { text-align: center; padding: 32px 20px; }
        .spinner { width: 40px; height: 40px; border: 3px solid var(--border-dim); border-top-color: var(--orange); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .loading-text { color: var(--text-dim); font-size: 15px; }

        .error-box { margin: 24px 20px 0; background: rgba(248,113,113,0.1); border: 1.5px solid rgba(248,113,113,0.3); border-radius: 10px; padding: 16px 20px; color: #f87171; font-size: 14px; line-height: 1.5; }

        /* ── IE holding message ── */
        .ie-holding { margin: 24px 20px 0; background: var(--bg2); border: 1.5px solid var(--border); border-radius: 12px; padding: 24px 20px; text-align: center; }
        .ie-holding-icon { font-size: 32px; margin-bottom: 10px; }
        .ie-holding-title { font-family: 'Barlow Condensed', sans-serif; font-size: 22px; font-weight: 900; letter-spacing: 0.1em; color: var(--orange); margin-bottom: 8px; }
        .ie-holding-text { font-size: 14px; color: var(--text-dim); line-height: 1.6; max-width: 300px; margin: 0 auto; }

        .footer-note { text-align: center; padding: 28px 20px 0; font-size: 12px; color: var(--text-dim); line-height: 1.6; }
        .footer-note a { color: var(--orange); text-decoration: none; }


      `}</style>

      <div className="app">
        <header className="header">
          <div className="logo">
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

        <div className="hero">
          <p className="hero-eyebrow">UK & ROI Vehicle Intelligence</p>
          <h1 className="hero-title">
            KNOW YOUR<span>NUMBERS</span>
          </h1>
          <p className="hero-sub">Accurate vehicle valuations. Cheaper and faster than CAP or HPI.</p>
        </div>

        {salvage.enabled && (
          <div className="salvage-card" onClick={() => router.push('/salvage')}>
            <div className="salvage-card-left">
              <span className="salvage-icon">🔨</span>
              <div>
                <div className="salvage-title">Salvage Assessment Tool</div>
                <div className="salvage-desc">Full assessment for salvage and damaged vehicles — predicted hammer price included</div>
              </div>
            </div>
            <div className="salvage-price">£{salvage.price.toFixed(2)}</div>
          </div>
        )}

        <div className="form">
          {/* Registration number */}
          <div>
            <div className="field-label">Registration Number</div>
            <div className="vrm-wrap">
              <input
                className="vrm-input"
                type="text"
                placeholder="AB12CDE"
                value={vrm}
                onChange={e => { setVrm(e.target.value.toUpperCase()); setMarketLocked(false); }}
                onPaste={e => { const el = e.target; setTimeout(() => { const v = el.value.toUpperCase().replace(/\s/g, ''); if (v) handleCheck(v); }, 50); }}
                maxLength={12}
              />
              <button
                className="camera-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={scanning}
                title="Scan plate from photo"
              >
                {scanning ? '⏳' : '📷'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: 'none' }}
                onChange={handlePhotoScan}
              />
            </div>
            {scanning && <p className="scan-status">Reading plate...</p>}
          </div>

          {/* Mileage */}
          <div>
            <div className="field-label">
              Current {effectiveMarket === 'IE' ? 'Kilometres' : 'Mileage'} <span>(optional — improves valuation accuracy)</span>
            </div>
            <div className="mileage-wrap">
              <input
                className="mileage-input"
                type="text"
                inputMode="numeric"
                placeholder={effectiveMarket === 'IE' ? 'e.g. 98,500' : 'e.g. 61,309'}
                value={mileage}
                onChange={e => {
                  const raw = e.target.value.replace(/,/g, '');
                  if (!/^\d*$/.test(raw)) return;
                  setMileage(raw ? Number(raw).toLocaleString('en-GB') : '');
                }}
              />
              <span className="mileage-unit">{effectiveMarket === 'IE' ? 'km' : 'miles'}</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
              {effectiveMarket === 'IE' ? 'If no mileage entered, 50,000 km assumed for valuation' : 'If no mileage entered, 50,000 miles assumed for valuation'}
            </p>
          </div>

          {/* Market toggle */}
          <div>
            <div className="field-label">Target Market</div>
            <div className="market-toggle">
              <button
                className={`market-toggle-btn ${effectiveMarket === 'GB' ? 'active' : ''}`}
                onClick={() => { setMarket('GB'); setMarketLocked(true); }}
              >
                <span className="market-flag">🇬🇧</span> GB
              </button>
              <button
                className={`market-toggle-btn ${effectiveMarket === 'IE' ? 'active' : ''}`}
                onClick={() => { setMarket('IE'); setMarketLocked(true); }}
              >
                <span className="market-flag">🇮🇪</span> IE
              </button>
            </div>
          </div>

          {/* IE Build Your Report */}
          {effectiveMarket === 'IE' && (
            <div className="report-builder">
              <div className="report-builder-label">Build Your ROI Report</div>
              <div className="check-list">
                <div
                  className={`check-item ${ieAllOptionalSelected ? 'selected' : ''}`}
                  style={{ borderBottom: '2px solid var(--border-dim)' }}
                  onClick={ieHandleSelectAll}
                >
                  <div className="check-box">{ieAllOptionalSelected ? '✓' : ''}</div>
                  <div className="check-info">
                    <div className="check-label">Select All Items</div>
                    <div className="check-desc">
                      {ieAllOptionalSelected ? 'Click to deselect optional checks' : 'Add all available checks to your report'}
                    </div>
                  </div>
                </div>

                {ieEnabledItems.map(item => {
                  const selected = ieSelectedKeys.includes(item.key);
                  const isLocked = item.key === 'ie_valuation' ? ieValuationLocked : item.locked;
                  return (
                    <div
                      key={item.key}
                      className={`check-item ${selected ? 'selected' : ''} ${isLocked ? 'locked' : ''}`}
                      onClick={() => ieToggleItem(item.key)}
                    >
                      <div className="check-box">{selected || isLocked ? '✓' : ''}</div>
                      <div className="check-info">
                        <div className="check-label">{item.label}</div>
                        <div className="check-desc">{item.description}</div>
                      </div>
                      <div className={`check-price ${item.price === 0 ? 'free' : ''}`}>
                        {item.price === 0 ? 'FREE' : `£${item.price.toFixed(2)}`}
                      </div>
                    </div>
                  );
                })}

                <div className="check-item locked">
                  <div className="check-box" style={{fontSize: 11}}>✓</div>
                  <div className="check-info">
                    <div className="check-label">Service Fee</div>
                    <div className="check-desc">Payment processing contribution</div>
                  </div>
                  <div className="check-price">£0.25</div>
                </div>

                <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-dim)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>Have a promo code?</div>
                  {appliedPromo ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, background: 'rgba(74,222,128,0.1)', border: '1.5px solid rgba(74,222,128,0.3)', borderRadius: 7, padding: '7px 11px', fontSize: 13, color: '#4ade80', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>✓ {appliedPromo.code}</div>
                      <button style={{ background: 'none', border: '1.5px solid var(--border-dim)', borderRadius: 7, padding: '7px 10px', color: 'var(--text-dim)', fontSize: 12, cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif" }} onClick={() => { setAppliedPromo(null); setPromoInput(''); setPromoError(null); }}>Remove</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 7 }}>
                      <input type="text" placeholder="Enter code" value={promoInput} onChange={e => { setPromoInput(e.target.value.toUpperCase()); setPromoError(null); }} onKeyDown={e => e.key === 'Enter' && handleApplyPromo()} style={{ flex: 1, background: 'var(--bg)', border: '1.5px solid var(--border-dim)', borderRadius: 7, padding: '9px 11px', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: "'Barlow', sans-serif" }} />
                      <button onClick={handleApplyPromo} disabled={!promoInput.trim() || promoLoading} style={{ background: 'var(--bg3)', border: '1.5px solid var(--border-dim)', borderRadius: 7, padding: '9px 14px', color: 'var(--text)', fontSize: 13, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.05em', cursor: 'pointer', opacity: (!promoInput.trim() || promoLoading) ? 0.45 : 1 }}>{promoLoading ? '...' : 'Apply'}</button>
                    </div>
                  )}
                </div>
              </div>

              <div className="total-bar">
                <span className="total-label">Total</span>
                <span className="total-amount" style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  {appliedPromo && ieDiscountAmount > 0 && (
                    <span style={{ fontSize: 15, color: 'var(--text-dim)', textDecoration: 'line-through', fontWeight: 400 }}>£{ieBaseTotal.toFixed(2)}</span>
                  )}
                  {ieTotal === 0 ? <span style={{ color: '#4ade80' }}>FREE</span> : `£${ieTotal.toFixed(2)}`}
                </span>
              </div>

              <button
                className="btn-get-report"
                onClick={handleIeCheckout}
                disabled={checkoutLoading || ieSelectedKeys.length === 0}
              >
                {checkoutLoading ? 'Redirecting...' : ieTotal === 0 ? 'Get Report — FREE' : `Get Report — £${ieTotal.toFixed(2)}`}
              </button>
            </div>
          )}

          {/* Check button — GB only */}
          {effectiveMarket === 'GB' && (
            <button
              className="btn-submit"
              onClick={() => handleCheck()}
              disabled={loading || checkoutLoading || !vrm.trim()}
            >
              {loading ? 'Looking up...' : checkoutLoading ? 'Redirecting...' : 'Check →'}
            </button>
          )}
        </div>

        {loading && (
          <div className="loading">
            <div className="spinner" />
            <p className="loading-text">Looking up {vrm}...</p>
          </div>
        )}

        {error && !loading && !checkoutLoading && (
          <div className="error-box">⚠️ {error}</div>
        )}

        {result && !loading && effectiveMarket === 'GB' && (
          <>
            {/* Free DVLA result — GB only */}
            {!result._ieMarket && (
              <div className="result">
                <div className="result-header">
                  <div className="result-reg">{vrm.toUpperCase()}</div>
                  <div className="result-vehicle">{result.make}{result.model ? ` ${result.model}` : ''} {result.yearOfManufacture}</div>
                </div>
                <div className="result-body">
                  {result.colour     && <div className="result-row"><span className="result-key">Colour</span><span className="result-val">{result.colour}</span></div>}
                  {result.engineSize && <div className="result-row"><span className="result-key">Engine</span><span className="result-val">{result.engineSize}</span></div>}
                  {result.fuelType   && <div className="result-row"><span className="result-key">Fuel</span><span className="result-val">{result.fuelType}</span></div>}
                  {result.taxStatus  && <div className="result-row"><span className="result-key">Tax</span><span className={`result-val ${result.taxStatus === 'Taxed' ? 'good' : 'bad'}`}>{result.taxStatus}</span></div>}
                  {result.motStatus  && <div className="result-row"><span className="result-key">MOT</span><span className={`result-val ${result.motStatus === 'Valid' ? 'good' : 'warn'}`}>{result.motStatus}</span></div>}
                  {result.motExpiryDate && <div className="result-row"><span className="result-key">MOT Expiry</span><span className="result-val">{result.motExpiryDate}</span></div>}
                  {result.motMileage && <div className="result-row"><span className="result-key">Last MOT Mileage</span><span className="result-val">{Number(result.motMileage).toLocaleString('en-GB')} miles</span></div>}
                </div>
              </div>
            )}

            {/* IE holding message */}
            {result._ieMarket && (
              <div className="ie-holding">
                <div className="ie-holding-icon">🇮🇪</div>
                <div className="ie-holding-title">{vrm.trim().replace(/\s/g, '').toUpperCase()}</div>
                <p className="ie-holding-text">Vehicle identity and full data will be returned with your paid report. Select your checks below and proceed.</p>
              </div>
            )}

            {/* Build Your Report checklist */}
            <div className="report-builder">
              <div className="report-builder-label">Build Your Report</div>
              <div className="check-list">
                {/* Select All toggle */}
                <div
                  className={`check-item ${allOptionalSelected ? 'selected' : ''}`}
                  style={{ borderBottom: '2px solid var(--border-dim)' }}
                  onClick={handleSelectAll}
                >
                  <div className="check-box">
                    {allOptionalSelected ? '✓' : ''}
                  </div>
                  <div className="check-info">
                    <div className="check-label">Select All Items</div>
                    <div className="check-desc">
                      {allOptionalSelected ? 'Click to deselect optional checks' : 'Add all available checks to your report'}
                    </div>
                  </div>
                </div>

                {enabledItems.map(item => {
                  const selected = selectedKeys.includes(item.key);
                  const isLocked = item.key === 'valuation' ? valuationLocked : item.locked;
                  const vehicleMake = result?.make?.toUpperCase() || null;
                  const svcUnavailable = item.key === 'service_history' && vehicleMake !== null && !FULL_COVERAGE_MAKES.has(vehicleMake);
                  return (
                    <div
                      key={item.key}
                      className={`check-item ${selected && !svcUnavailable ? 'selected' : ''} ${isLocked ? 'locked' : ''}`}
                      style={svcUnavailable ? { opacity: 0.45, cursor: 'not-allowed' } : {}}
                      onClick={() => !svcUnavailable && toggleItem(item.key)}
                    >
                      <div className="check-box">
                        {(selected && !svcUnavailable) || isLocked ? '✓' : ''}
                      </div>
                      <div className="check-info">
                        <div className="check-label">{item.label}</div>
                        <div className="check-desc">
                          {svcUnavailable ? 'Service history not available for this vehicle' : item.description}
                        </div>
                        {['writeoff', 'finance', 'stolen'].includes(item.key) && (
                          <div style={{ fontSize: 10, color: '#a01346', marginTop: 2, fontWeight: 600 }}>Data provided by Experian</div>
                        )}
                      </div>
                      <div className={`check-price ${item.price === 0 ? 'free' : ''}`}>
                        {item.price === 0 ? 'FREE' : `£${item.price.toFixed(2)}`}
                      </div>
                    </div>
                  );
                })}
                {/* Service fee — always applied */}
                <div className="check-item locked">
                  <div className="check-box" style={{fontSize: 11}}>✓</div>
                  <div className="check-info">
                    <div className="check-label">Service Fee</div>
                    <div className="check-desc">Payment processing contribution</div>
                  </div>
                  <div className="check-price">£0.25</div>
                </div>

                {/* Promo code — GB report builder */}
                <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-dim)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 6 }}>Have a promo code?</div>
                  {appliedPromo ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, background: 'rgba(74,222,128,0.1)', border: '1.5px solid rgba(74,222,128,0.3)', borderRadius: 7, padding: '7px 11px', fontSize: 13, color: '#4ade80', fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>✓ {appliedPromo.code}</div>
                      <button style={{ background: 'none', border: '1.5px solid var(--border-dim)', borderRadius: 7, padding: '7px 10px', color: 'var(--text-dim)', fontSize: 12, cursor: 'pointer', fontFamily: "'Barlow Condensed', sans-serif" }} onClick={() => { setAppliedPromo(null); setPromoInput(''); setPromoError(null); }}>Remove</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 7 }}>
                      <input type="text" placeholder="Enter code" value={promoInput} onChange={e => { setPromoInput(e.target.value.toUpperCase()); setPromoError(null); }} onKeyDown={e => e.key === 'Enter' && handleApplyPromo()} style={{ flex: 1, background: 'var(--bg)', border: '1.5px solid var(--border-dim)', borderRadius: 7, padding: '9px 11px', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: "'Barlow', sans-serif" }} />
                      <button onClick={handleApplyPromo} disabled={!promoInput.trim() || promoLoading} style={{ background: 'var(--bg3)', border: '1.5px solid var(--border-dim)', borderRadius: 7, padding: '9px 14px', color: 'var(--text)', fontSize: 13, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.05em', cursor: 'pointer', opacity: (!promoInput.trim() || promoLoading) ? 0.45 : 1 }}>{promoLoading ? '...' : 'Apply'}</button>
                    </div>
                  )}
                  {promoError && <div style={{ marginTop: 5, fontSize: 11, color: '#f87171' }}>{promoError}</div>}
                </div>
              </div>

              <div className="total-bar">
                <span className="total-label">Total</span>
                <span className="total-amount" style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  {appliedPromo && discountAmount > 0 && (
                    <span style={{ fontSize: 15, color: 'var(--text-dim)', textDecoration: 'line-through', fontWeight: 400 }}>£{baseTotal.toFixed(2)}</span>
                  )}
                  {total === 0 ? <span style={{ color: '#4ade80' }}>FREE</span> : `£${total.toFixed(2)}`}
                </span>
              </div>

              <button
                className="btn-get-report"
                onClick={handleGetReport}
                disabled={checkoutLoading || selectedKeys.length === 0}
              >
                {checkoutLoading ? 'Redirecting...' : total === 0 ? 'Get Report — FREE' : `Get Report — £${total.toFixed(2)}`}
              </button>
            </div>
          </>
        )}


        <p className="footer-note">
          {effectiveMarket === 'IE' ? 'Select your checks and get your ROI vehicle report.' : 'Free vehicle lookup included. Paid checks selected at checkout.'}<br />
          Not affiliated with Copart, CAP or HPI. &nbsp;<a href="/terms">Terms &amp; Conditions</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a>
        </p>
      </div>
    </>
  );
}
