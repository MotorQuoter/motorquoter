'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { PRICING } from '@/config/pricing';

export default function Home() {
  const router = useRouter();
  const [vrm, setVrm] = useState('');
  const [mileage, setMileage] = useState('');
  const [market, setMarket] = useState('GB');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const fileInputRef = useRef(null);

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

  // ── Free DVLA check — functional until à la carte checkout wired in Step 4+ ─
  const handleCheck = async () => {
    if (!vrm.trim()) return;
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

        body {
          background: var(--bg);
          color: var(--text);
          font-family: 'Barlow', sans-serif;
          min-height: 100vh;
        }

        .app {
          max-width: 480px;
          margin: 0 auto;
          padding: 0 0 60px;
        }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-dim);
        }

        .logo {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .logo-icon {
          width: 36px;
          height: 36px;
          background: var(--orange);
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Barlow Condensed', sans-serif;
          font-weight: 900;
          font-size: 18px;
          color: white;
        }

        .logo-text {
          font-family: 'Barlow Condensed', sans-serif;
          font-weight: 800;
          font-size: 20px;
          letter-spacing: 0.05em;
          color: var(--text);
        }

        .hero {
          padding: 36px 20px 28px;
          text-align: center;
        }

        .hero-eyebrow {
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.2em;
          color: var(--orange);
          margin-bottom: 12px;
          text-transform: uppercase;
        }

        .hero-title {
          font-family: 'Barlow Condensed', sans-serif;
          font-weight: 900;
          font-size: 64px;
          line-height: 0.95;
          letter-spacing: -0.01em;
          text-transform: uppercase;
        }

        .hero-title span {
          color: var(--orange);
          display: block;
        }

        .hero-sub {
          margin-top: 16px;
          font-size: 16px;
          color: var(--text-dim);
          line-height: 1.5;
          max-width: 320px;
          margin-left: auto;
          margin-right: auto;
        }

        .form {
          padding: 0 20px;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .field-label {
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.15em;
          color: var(--orange);
          text-transform: uppercase;
          margin-bottom: 8px;
        }

        .field-label span {
          color: var(--text-dim);
          font-weight: 400;
          font-size: 12px;
          letter-spacing: 0.05em;
          text-transform: none;
          font-family: 'Barlow', sans-serif;
        }

        .vrm-wrap {
          position: relative;
          display: flex;
          gap: 10px;
          align-items: center;
        }

        .vrm-wrap .vrm-input {
          flex: 1;
        }

        .camera-btn {
          background: var(--bg3);
          border: 1.5px solid var(--border-dim);
          border-radius: 10px;
          padding: 0 16px;
          height: 64px;
          font-size: 24px;
          cursor: pointer;
          transition: all 0.2s;
          flex-shrink: 0;
        }

        .camera-btn:hover:not(:disabled) {
          border-color: var(--orange);
          background: var(--orange-dim);
        }

        .camera-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .scan-status {
          margin-top: 8px;
          font-size: 13px;
          color: var(--orange);
          text-align: center;
        }

        .vrm-input {
          width: 100%;
          background: var(--bg2);
          border: 1.5px solid var(--border-dim);
          border-radius: 10px;
          padding: 18px 20px;
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 28px;
          font-weight: 700;
          letter-spacing: 0.15em;
          color: var(--text-dim);
          text-align: center;
          text-transform: uppercase;
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
        }

        .vrm-input:focus {
          border-color: var(--orange);
          box-shadow: 0 0 0 3px var(--orange-dim);
          color: var(--text);
        }

        .vrm-input::placeholder {
          color: rgba(154,143,135,0.5);
          letter-spacing: 0.1em;
        }

        .mileage-wrap {
          position: relative;
        }

        .mileage-input {
          width: 100%;
          background: var(--bg2);
          border: 1.5px solid var(--border-dim);
          border-radius: 10px;
          padding: 16px 70px 16px 20px;
          font-family: 'Barlow', sans-serif;
          font-size: 18px;
          color: var(--text-dim);
          outline: none;
          transition: border-color 0.2s, box-shadow 0.2s;
        }

        .mileage-input:focus {
          border-color: var(--orange);
          box-shadow: 0 0 0 3px var(--orange-dim);
          color: var(--text);
        }

        .mileage-input::placeholder {
          color: rgba(154,143,135,0.4);
        }

        .mileage-unit {
          position: absolute;
          right: 16px;
          top: 50%;
          transform: translateY(-50%);
          color: var(--text-dim);
          font-size: 14px;
          font-weight: 500;
          pointer-events: none;
        }

        /* ── Market toggle ── */
        .market-toggle {
          display: flex;
          background: var(--bg2);
          border: 1.5px solid var(--border-dim);
          border-radius: 10px;
          padding: 4px;
          gap: 4px;
        }

        .market-toggle-btn {
          flex: 1;
          padding: 11px 16px;
          background: none;
          border: 1.5px solid transparent;
          border-radius: 7px;
          cursor: pointer;
          font-family: 'Barlow Condensed', sans-serif;
          font-weight: 800;
          font-size: 16px;
          letter-spacing: 0.06em;
          color: var(--text-dim);
          transition: all 0.18s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
        }

        .market-toggle-btn:hover {
          color: var(--text);
          background: var(--bg3);
        }

        .market-toggle-btn.active {
          background: var(--orange-dim);
          border-color: var(--border);
          color: var(--orange);
        }

        .market-toggle-btn .market-flag {
          font-size: 20px;
          line-height: 1;
        }

        /* ── Submit button ── */
        .btn-submit {
          width: 100%;
          padding: 18px;
          background: var(--orange);
          border: none;
          border-radius: 10px;
          color: white;
          font-family: 'Barlow Condensed', sans-serif;
          font-weight: 800;
          font-size: 18px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          cursor: pointer;
          transition: all 0.2s;
          margin-top: 4px;
        }

        .btn-submit:hover:not(:disabled) {
          background: var(--orange-light);
          transform: translateY(-1px);
          box-shadow: 0 4px 20px rgba(240,90,26,0.4);
        }

        .btn-submit:disabled {
          opacity: 0.45;
          cursor: not-allowed;
          transform: none;
          box-shadow: none;
        }

        /* ── Salvage assessment card ── */
        .salvage-card {
          margin: 28px 20px 0;
          background: var(--bg2);
          border: 1.5px solid var(--border-dim);
          border-radius: 12px;
          padding: 20px;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
        }

        .salvage-card:hover {
          border-color: var(--orange);
          background: var(--orange-dim);
        }

        .salvage-card-left {
          display: flex;
          align-items: center;
          gap: 14px;
        }

        .salvage-icon {
          font-size: 28px;
          flex-shrink: 0;
        }

        .salvage-title {
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 17px;
          font-weight: 800;
          letter-spacing: 0.04em;
          color: var(--text);
          margin-bottom: 3px;
        }

        .salvage-desc {
          font-size: 13px;
          color: var(--text-dim);
          line-height: 1.4;
        }

        .salvage-price {
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 20px;
          font-weight: 900;
          color: var(--orange);
          white-space: nowrap;
          flex-shrink: 0;
        }

        /* ── Loading ── */
        .loading {
          text-align: center;
          padding: 32px 20px;
        }

        .spinner {
          width: 40px;
          height: 40px;
          border: 3px solid var(--border-dim);
          border-top-color: var(--orange);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin: 0 auto 16px;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .loading-text {
          color: var(--text-dim);
          font-size: 15px;
        }

        /* ── Result ── */
        .result {
          margin: 24px 20px 0;
          background: var(--bg2);
          border: 1.5px solid var(--border);
          border-radius: 12px;
          overflow: hidden;
        }

        .result-header {
          background: var(--orange-dim);
          border-bottom: 1px solid var(--border);
          padding: 16px 20px;
        }

        .result-reg {
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 22px;
          font-weight: 900;
          letter-spacing: 0.1em;
          color: var(--orange);
        }

        .result-vehicle {
          font-size: 15px;
          color: var(--text);
          font-weight: 600;
          margin-top: 4px;
        }

        .result-body {
          padding: 16px 20px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .result-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 0;
          border-bottom: 1px solid var(--border-dim);
        }

        .result-row:last-child {
          border-bottom: none;
        }

        .result-key {
          font-size: 13px;
          color: var(--text-dim);
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-family: 'Barlow Condensed', sans-serif;
        }

        .result-val {
          font-size: 15px;
          color: var(--text);
          font-weight: 600;
          text-align: right;
        }

        .result-val.good { color: #4ade80; }
        .result-val.warn { color: var(--yellow); }
        .result-val.bad  { color: #f87171; }

        /* ── Error ── */
        .error-box {
          margin: 24px 20px 0;
          background: rgba(248,113,113,0.1);
          border: 1.5px solid rgba(248,113,113,0.3);
          border-radius: 10px;
          padding: 16px 20px;
          color: #f87171;
          font-size: 14px;
          line-height: 1.5;
        }

        .footer-note {
          text-align: center;
          padding: 28px 20px 0;
          font-size: 12px;
          color: var(--text-dim);
          line-height: 1.6;
        }
      `}</style>

      <div className="app">
        <header className="header">
          <div className="logo">
            <div className="logo-icon">M</div>
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
          <p className="hero-eyebrow">UK Vehicle Intelligence</p>
          <h1 className="hero-title">
            KNOW YOUR<span>NUMBERS</span>
          </h1>
          <p className="hero-sub">Accurate vehicle valuations. Cheaper and faster than CAP or HPI.</p>
        </div>

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
                onChange={e => setVrm(e.target.value.toUpperCase())}
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
                className={`market-toggle-btn ${market === 'GB' ? 'active' : ''}`}
                onClick={() => setMarket('GB')}
              >
                <span className="market-flag">🇬🇧</span> GB
              </button>
              <button
                className={`market-toggle-btn ${market === 'IE' ? 'active' : ''}`}
                onClick={() => setMarket('IE')}
              >
                <span className="market-flag">🇮🇪</span> IE
              </button>
            </div>
          </div>

          {/* Check button — temporary free DVLA lookup; replaced by à la carte in Step 4+ */}
          <button
            className="btn-submit"
            onClick={handleCheck}
            disabled={loading || !vrm.trim()}
          >
            {loading ? 'Looking up...' : 'Check →'}
          </button>
        </div>

        {/* Salvage Assessment Tool entry point */}
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

        {loading && (
          <div className="loading">
            <div className="spinner" />
            <p className="loading-text">Looking up {vrm}...</p>
          </div>
        )}

        {error && !loading && (
          <div className="error-box">⚠️ {error}</div>
        )}

        {result && !loading && (
          <div className="result">
            <div className="result-header">
              <div className="result-reg">{vrm.toUpperCase()}</div>
              <div className="result-vehicle">{result.make} {result.yearOfManufacture}</div>
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

        <p className="footer-note">
          Free DVLA lookup included. Paid checks selected at checkout.<br />
          Not affiliated with Copart, CAP or HPI.
        </p>
      </div>
    </>
  );
}
