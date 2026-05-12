'use client';

import { useState, useRef } from 'react';

export default function Home() {
  const [vrm, setVrm] = useState('');
  const [mileage, setMileage] = useState('');
  const [market, setMarket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [tier, setTier] = useState(null);
  const [scanning, setScanning] = useState(false);
  const fileInputRef = useRef(null);

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
        body: JSON.stringify({ imageData: base64, mediaType: file.type })
      });

      const data = await response.json();

      if (data.error || !data.reg) {
        setError('Could not read a registration plate from that photo. Please type it manually.');
      } else {
        setVrm(data.reg);
      }
    } catch (err) {
      setError('Photo scan failed. Please type the registration manually.');
    } finally {
      setScanning(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCheck = async (selectedTier) => {
    if (!vrm.trim()) return;
    setTier(selectedTier);
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const params = new URLSearchParams({ vrm: vrm.trim().replace(/\s/g, '').toUpperCase() });
      if (mileage) params.append('mileage', mileage);
      params.append('market', market);
      params.append('tier', selectedTier);

      const res = await fetch(`/api/vehicle?${params}`);
      const data = await res.json();

      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const markets = [
    { id: 'GB', label: 'GB', sub: 'Standard value', icon: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
    { id: 'NI', label: 'NI', sub: 'N. Ireland', detail: '+8–12% premium', icon: '🏴' },
    { id: 'IE', label: 'IE', sub: 'Rep. Ireland', detail: '+ VRT calculated', icon: '🇮🇪' },
  ];

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

        /* HEADER */
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

        .header-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .btn-standard {
          background: var(--orange);
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 6px;
          font-family: 'Barlow Condensed', sans-serif;
          font-weight: 700;
          font-size: 14px;
          letter-spacing: 0.05em;
          cursor: pointer;
        }

        .bolt {
          color: var(--orange);
          font-size: 20px;
        }

        /* HERO */
        .hero {
          padding: 36px 20px 28px;
          text-align: center;
          position: relative;
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

        /* FORM */
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

        /* MARKET CARDS */
        .market-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
        }

        .market-card {
          background: var(--bg2);
          border: 1.5px solid var(--border-dim);
          border-radius: 10px;
          padding: 14px 8px;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s;
        }

        .market-card:hover {
          border-color: var(--orange);
          background: var(--bg3);
        }

        .market-card.active {
          border-color: var(--yellow);
          background: rgba(245,200,66,0.12);
        }

        .market-card.active .market-label,
        .market-card.active .market-sub {
          color: var(--yellow);
        }

        .market-card .flag {
          font-size: 22px;
          margin-bottom: 6px;
          display: block;
        }

        .market-card .market-label {
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 18px;
          font-weight: 800;
          color: var(--text);
          letter-spacing: 0.05em;
        }

        .market-card .market-sub {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-dim);
          margin-top: 2px;
        }

        .market-card .market-detail {
          font-size: 11px;
          color: var(--orange);
          margin-top: 3px;
          font-weight: 500;
        }

        /* BUTTONS */
        .btn-row {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 10px;
          margin-top: 4px;
        }

        .btn-check {
          padding: 16px;
          border-radius: 10px;
          border: none;
          cursor: pointer;
          font-family: 'Barlow Condensed', sans-serif;
          font-weight: 800;
          font-size: 16px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          transition: all 0.2s;
          position: relative;
          overflow: hidden;
        }

        .btn-check:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-basic {
          background: var(--bg3);
          border: 1.5px solid var(--border-dim);
          color: var(--text-dim);
          font-size: 14px;
        }

        .btn-basic:hover:not(:disabled) {
          border-color: var(--text-dim);
          color: var(--text);
        }

        .btn-basic.selected {
          border-color: var(--yellow);
          color: var(--yellow);
          background: rgba(245,200,66,0.08);
        }

        .btn-free {
          background: var(--bg3);
          border: 1.5px solid var(--orange);
          color: var(--orange);
        }

        .btn-free:hover:not(:disabled) {
          background: var(--orange-dim);
          color: var(--orange);
        }

        .btn-free.selected {
          border-color: var(--yellow);
          color: var(--yellow);
          background: rgba(245,200,66,0.08);
        }

        .btn-pro.selected {
          background: var(--yellow);
          color: var(--bg);
          box-shadow: 0 4px 20px rgba(245,200,66,0.4);
        }

        .btn-pro {
          background: var(--orange);
          color: white;
        }

        .btn-pro:hover:not(:disabled) {
          background: var(--orange-light);
          transform: translateY(-1px);
          box-shadow: 0 4px 20px rgba(240,90,26,0.4);
        }

        .btn-check .btn-price {
          display: block;
          font-size: 11px;
          font-weight: 500;
          opacity: 0.8;
          margin-top: 2px;
          font-family: 'Barlow', sans-serif;
          letter-spacing: 0.02em;
          text-transform: none;
        }

        /* DIVIDER */
        .divider {
          height: 1px;
          background: var(--border-dim);
          margin: 4px 0;
        }

        /* LOADING */
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

        /* RESULT */
        .result {
          margin: 0 20px;
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
        .result-val.bad { color: #f87171; }

        /* ERROR */
        .error-box {
          margin: 0 20px;
          background: rgba(248,113,113,0.1);
          border: 1.5px solid rgba(248,113,113,0.3);
          border-radius: 10px;
          padding: 16px 20px;
          color: #f87171;
          font-size: 14px;
          line-height: 1.5;
        }

        /* FOOTER NOTE */
        .footer-note {
          text-align: center;
          padding: 24px 20px 0;
          font-size: 12px;
          color: var(--text-dim);
          line-height: 1.6;
        }
      `}</style>

      <div className="app">
        {/* HEADER */}
        <header className="header">
          <div className="logo">
            <div className="logo-icon">M</div>
            <span className="logo-text">MOTORQUOTER</span>
          </div>
          <div className="header-actions">
            <button className="btn-standard">Standard</button>
            <span className="bolt">⚡</span>
          </div>
        </header>

        {/* HERO */}
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

        {/* FORM */}
        <div className="form">

          {/* REG INPUT */}
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

          {/* MILEAGE */}
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

          {/* MARKET */}
          <div>
            <div className="field-label">Target Market</div>
            <div className="market-grid">
              {markets.map(m => (
                <div
                  key={m.id}
                  className={`market-card ${market === m.id ? 'active' : ''}`}
                  onClick={() => setMarket(m.id)}
                >
                  <span className="flag">{m.icon}</span>
                  <div className="market-label">{m.label}</div>
                  <div className="market-sub">{m.sub}</div>
                  {m.detail && <div className="market-detail">{m.detail}</div>}
                </div>
              ))}
            </div>
          </div>

          <div className="divider" />

          {/* BUTTONS */}
          <div className="btn-row">
            <button
              className={`btn-check btn-basic ${tier === 'free' ? 'selected' : ''}`}
              onClick={() => handleCheck('free')}
              disabled={loading || !vrm.trim()}
            >
              Free
              <span className="btn-price">DVLA only</span>
            </button>
            <button
              className={`btn-check btn-free ${tier === 'standard' ? 'selected' : ''}`}
              onClick={() => handleCheck('standard')}
              disabled={loading || !vrm.trim()}
            >
              Standard
              <span className="btn-price">£1.99 per check</span>
            </button>
            <button
              className={`btn-check btn-pro ${tier === 'pro' ? 'selected' : ''}`}
              onClick={() => handleCheck('pro')}
              disabled={loading || !vrm.trim()}
            >
              Pro ⚡
              <span className="btn-price">£6.99 per check</span>
            </button>
          </div>

        </div>

        {/* LOADING */}
        {loading && (
          <div className="loading">
            <div className="spinner" />
            <p className="loading-text">Looking up {vrm}...</p>
          </div>
        )}

        {/* ERROR */}
        {error && !loading && (
          <div className="error-box">
            ⚠️ {error}
          </div>
        )}

        {/* RESULT */}
        {result && !loading && (
          <div className="result">
            <div className="result-header">
              <div className="result-reg">{vrm.toUpperCase()}</div>
              <div className="result-vehicle">
                {result.make} {result.yearOfManufacture}
              </div>
            </div>
            <div className="result-body">
              {result.colour && (
                <div className="result-row">
                  <span className="result-key">Colour</span>
                  <span className="result-val">{result.colour}</span>
                </div>
              )}
              {result.engineSize && (
                <div className="result-row">
                  <span className="result-key">Engine</span>
                  <span className="result-val">{result.engineSize}</span>
                </div>
              )}
              {result.fuelType && (
                <div className="result-row">
                  <span className="result-key">Fuel</span>
                  <span className="result-val">{result.fuelType}</span>
                </div>
              )}
              {result.taxStatus && (
                <div className="result-row">
                  <span className="result-key">Tax</span>
                  <span className={`result-val ${result.taxStatus === 'Taxed' ? 'good' : 'bad'}`}>
                    {result.taxStatus}
                  </span>
                </div>
              )}
          {result.motStatus && (
  <div className="result-row">
    <span className="result-key">MOT</span>
    <span className={`result-val ${result.motStatus === 'Valid' ? 'good' : 'warn'}`}>
      {result.motStatus}
    </span>
  </div>
)}
{result.motExpiryDate && (
  <div className="result-row">
    <span className="result-key">MOT Expiry</span>
    <span className="result-val">{result.motExpiryDate}</span>
  </div>
)}
{result.motMileage && (
  <div className="result-row">
    <span className="result-key">Mileage at Last MOT</span>
    <span className="result-val">{result.motMileage.toLocaleString('en-GB')} miles</span>
  </div>
)}
              {result.raw && (
                <div className="result-row">
                  <span className="result-key">Raw Data</span>
                  <span className="result-val" style={{fontSize:'11px', wordBreak:'break-all', textAlign:'right', maxWidth:'200px'}}>
                    {JSON.stringify(result.raw).substring(0, 120)}...
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        <p className="footer-note">
          Free DVLA lookup. Standard and Pro checks require payment.<br />
          Not affiliated with Copart, CAP or HPI.
        </p>
      </div>
    </>
  );
}