'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { PRICING, ROI_TIERS } from '@/config/pricing';
import { isRoiPlate } from '@/lib/roiPlate';

const enabledItems = PRICING.menu.filter(i => i.enabled);
const defaultSelected = enabledItems.filter(i => i.preSelected).map(i => i.key);

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
  const [roiTier, setRoiTier] = useState('roi_standard');

  // Computed synchronously on every render — no useEffect, no async state cycle.
  const autoIrish = vrm.length >= 3 && isRoiPlate(vrm);
  const effectiveMarket = marketLocked ? market : (autoIrish ? 'IE' : 'GB');
  const selectedRoiTier = ROI_TIERS.find(t => t.key === roiTier);

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
  const handleCheck = async () => {
    if (!vrm.trim()) return;

    // IE: go directly to paid checkout for selected ROI tier
    if (effectiveMarket === 'IE') {
      handleRoiCheckout();
      return;
    }

    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const params = new URLSearchParams({
        vrm: vrm.trim().replace(/\s/g, '').toUpperCase(),
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
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── ROI checkout ─────────────────────────────────────────────────────────────
  const handleRoiCheckout = async () => {
    if (!vrm.trim()) return;
    setCheckoutLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vrm: vrm.trim().replace(/\s/g, '').toUpperCase(),
          mileage: mileage || '',
          market: 'IE',
          roiTier,
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

  const SERVICE_FEE = 0.25;
  const total = enabledItems
    .filter(i => selectedKeys.includes(i.key))
    .reduce((sum, i) => sum + i.price, 0) + SERVICE_FEE;

  // ── Stripe checkout ──────────────────────────────────────────────────────────
  const handleGetReport = async () => {
    if (!vrm.trim() || selectedKeys.length === 0) return;
    setCheckoutLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vrm: vrm.trim().replace(/\s/g, '').toUpperCase(),
          checks: selectedKeys,
          mileage: mileage || '',
          market: effectiveMarket || 'GB',
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

        /* ── ROI tier cards ── */
        .tier-menu { display: flex; flex-direction: column; gap: 8px; }
        .tier-card { background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 13px 14px; cursor: pointer; transition: all 0.15s; display: flex; align-items: flex-start; gap: 12px; }
        .tier-card.selected { border-color: var(--orange); background: var(--orange-dim); }
        .tier-card:hover:not(.selected) { border-color: rgba(240,90,26,0.3); }
        .tier-radio { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border-dim); flex-shrink: 0; margin-top: 2px; display: flex; align-items: center; justify-content: center; background: var(--bg3); }
        .tier-card.selected .tier-radio { border-color: var(--orange); }
        .tier-radio-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--orange); display: none; }
        .tier-card.selected .tier-radio-dot { display: block; }
        .tier-info { flex: 1; }
        .tier-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 2px; }
        .tier-name { font-family: 'Barlow Condensed', sans-serif; font-size: 17px; font-weight: 800; color: var(--text); letter-spacing: 0.03em; }
        .tier-price { font-family: 'Barlow Condensed', sans-serif; font-size: 14px; font-weight: 700; color: var(--orange); }
        .tier-desc { font-size: 12px; color: var(--text-dim); line-height: 1.4; margin-bottom: 4px; }
        .tier-features { display: flex; flex-direction: column; gap: 1px; }
        .tier-feat { font-size: 11px; color: var(--text-dim); display: flex; gap: 5px; line-height: 1.5; }
        .tier-feat-dot { color: var(--orange); flex-shrink: 0; }
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
          <img
            src="/Wheel.jpeg"
            alt="MotorQuoter"
            style={{
              width: '160px',
              height: '160px',
              objectFit: 'cover',
              borderRadius: '50%',
              border: '3px solid var(--orange)',
              marginBottom: '20px',
              boxShadow: '0 0 30px rgba(240,90,26,0.3)',
            }}
          />
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
              Current Mileage <span>(optional — improves valuation accuracy)</span>
            </div>
            <div className="mileage-wrap">
              <input
                className="mileage-input"
                type="text"
                inputMode="numeric"
                placeholder="e.g. 61,309"
                value={mileage}
                onChange={e => {
                  const raw = e.target.value.replace(/,/g, '');
                  if (!/^\d*$/.test(raw)) return;
                  setMileage(raw ? Number(raw).toLocaleString('en-GB') : '');
                }}
              />
              <span className="mileage-unit">miles</span>
            </div>
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

          {/* ROI tier menu — IE market only */}
          {effectiveMarket === 'IE' && (
            <div>
              <div className="field-label">ROI Vehicle Data <span>(select a tier)</span></div>
              <div className="tier-menu">
                {ROI_TIERS.filter(t => t.addOn > 0).map(tier => (
                  <div
                    key={tier.key}
                    className={`tier-card ${roiTier === tier.key ? 'selected' : ''}`}
                    onClick={() => setRoiTier(tier.key)}
                  >
                    <div className="tier-radio">
                      <div className="tier-radio-dot" />
                    </div>
                    <div className="tier-info">
                      <div className="tier-header">
                        <span className="tier-name">{tier.label}</span>
                        <span className="tier-price">£{tier.addOn.toFixed(2)}</span>
                      </div>
                      <div className="tier-desc">{tier.description}</div>
                      <div className="tier-features">
                        {tier.features.map((f, i) => (
                          <div className="tier-feat" key={i}><span className="tier-feat-dot">▸</span>{f}</div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Check / Get ROI Report button */}
          <button
            className="btn-submit"
            onClick={handleCheck}
            disabled={loading || checkoutLoading || !vrm.trim()}
          >
            {loading ? 'Looking up...'
              : checkoutLoading ? 'Redirecting...'
              : effectiveMarket === 'IE' ? `Get ROI Report — £${selectedRoiTier?.addOn?.toFixed(2) ?? '4.99'}`
              : 'Check →'}
          </button>
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
                  return (
                    <div
                      key={item.key}
                      className={`check-item ${selected ? 'selected' : ''} ${isLocked ? 'locked' : ''}`}
                      onClick={() => toggleItem(item.key)}
                    >
                      <div className="check-box">
                        {selected || isLocked ? '✓' : ''}
                      </div>
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
                {/* Service fee — always applied */}
                <div className="check-item locked">
                  <div className="check-box" style={{fontSize: 11}}>✓</div>
                  <div className="check-info">
                    <div className="check-label">Service Fee</div>
                    <div className="check-desc">Payment processing contribution</div>
                  </div>
                  <div className="check-price">£0.25</div>
                </div>
              </div>

              <div className="total-bar">
                <span className="total-label">Total</span>
                <span className="total-amount">£{total.toFixed(2)}</span>
              </div>

              <button
                className="btn-get-report"
                onClick={handleGetReport}
                disabled={checkoutLoading || total === 0}
              >
                {checkoutLoading ? 'Redirecting...' : `Get Report — £${total.toFixed(2)}`}
              </button>
            </div>
          </>
        )}


        <p className="footer-note">
          {effectiveMarket === 'IE' ? 'Select a tier and get your ROI vehicle report.' : 'Free vehicle lookup included. Paid checks selected at checkout.'}<br />
          Not affiliated with Copart, CAP or HPI.
        </p>
      </div>
    </>
  );
}
