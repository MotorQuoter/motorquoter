'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { PRICING } from '@/config/pricing';

export default function SalvagePage() {
  const router = useRouter();
  const [images, setImages] = useState([]);
  const [details, setDetails] = useState({ vrm: '', make: '', model: '', year: '', lotNumber: '', damageDescription: '' });
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
  const [auctionSource, setAuctionSource] = useState('copart');
  const fileInputRef = useRef(null);

  const price = PRICING.salvageAssessment.price;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('cancelled') === 'true') setCancelled(true);
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
    const MAX = 1024;
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
        resolve({ base64: canvas.toDataURL('image/jpeg', 0.75), name: file.name });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });

  const handleFiles = useCallback(async (files) => {
    const toAdd = Array.from(files).slice(0, 20 - images.length);
    if (toAdd.length === 0) return;
    const processed = await Promise.all(toAdd.map(compressImage));
    setImages(prev => [...prev, ...processed].slice(0, 20));
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

  const handleSubmit = async () => {
    if (images.length === 0) { setError('Please upload at least one photo of the vehicle.'); return; }
    setError('');
    setLoading(true);
    try {
      if (isRerun) {
        const res = await fetch('/api/salvage/rerun-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            salvage_id: rerunSalvageId,
            vehicleDetails: { ...details, auctionSource, dvlaVerified: dvlaStatus === 'found', motMileageFlag: motWarning || null, motHistory: dvlaData?.motHistory ?? null },
            images: images.map(i => i.base64),
            market,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.salvage_id) throw new Error(data.error || 'Re-run failed');
        router.push(`/salvage/success?salvage_id=${data.salvage_id}&session_id=${data.stripe_session_id}`);
      } else {
        const res = await fetch('/api/salvage/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vehicleDetails: { ...details, auctionSource, dvlaVerified: dvlaStatus === 'found', motMileageFlag: motWarning || null, motHistory: dvlaData?.motHistory ?? null },
            images: images.map(i => i.base64),
            market,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || 'Checkout failed');
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
            <span className="price-badge-amount">£{price.toFixed(2)}</span>
            <span className="price-badge-label">per assessment · no subscription</span>
          </div>
        </div>

        <div className="form">
          {cancelled && (
            <div className="cancel-box">Payment cancelled — your photos are still saved. You can try again below.</div>
          )}

          {/* Auction Source */}
          <div>
            <div className="field-label">Auction Source</div>
            <select
              className="select-input"
              value={auctionSource}
              onChange={e => setAuctionSource(e.target.value)}
            >
              <option value="copart">Copart UK</option>
              <option value="bca">BCA</option>
              <option value="manheim">Manheim</option>
              <option value="other">Other / Private</option>
            </select>
          </div>

          {/* Photo upload */}
          <div>
            <div className="field-label">
              Photos <span>(min 1, max 20 — drag & drop or click)</span>
            </div>

            <div
              className={`upload-zone ${dragging ? 'dragging' : ''} ${images.length > 0 ? 'has-images' : ''}`}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onClick={() => images.length === 0 && fileInputRef.current?.click()}
            >
              {images.length === 0 ? (
                <>
                  <div className="upload-icon">📸</div>
                  <div className="upload-title">Drop photos here or tap to upload</div>
                  <div className="upload-sub">All listing photos — exterior, interior, engine, dashboard</div>
                </>
              ) : (
                <>
                  <div className="photo-grid">
                    {images.map((img, idx) => (
                      <div key={idx} className="photo-thumb">
                        <img src={img.base64} alt={`Photo ${idx + 1}`} />
                        <button className="photo-remove" onClick={(e) => { e.stopPropagation(); removeImage(idx); }}>✕</button>
                      </div>
                    ))}
                    {images.length < 20 && (
                      <div className="add-more" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>+</div>
                    )}
                  </div>
                  <div className="upload-count">{images.length} / 20 photos</div>
                </>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; }}
            />
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
                        const advisories = test.rfrAndComments?.filter(c => c.type === 'ADVISORY') || [];
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
              <textarea
                className="textarea-input"
                placeholder="Damage description (copy from listing — helps AI compare against photos)"
                value={details.damageDescription}
                onChange={e => setDetails(p => ({ ...p, damageDescription: e.target.value }))}
              />
            </div>
          </div>

          {/* Market */}
          <div>
            <div className="field-label">Repair Market</div>
            <div className="market-toggle">
              <button className={`market-btn ${market === 'GB' ? 'active' : ''}`} onClick={() => setMarket('GB')}>
                🇬🇧 GB
              </button>
              <button className={`market-btn ${market === 'IE' ? 'active' : ''}`} onClick={() => setMarket('IE')}>
                🇮🇪 IE
              </button>
            </div>
          </div>

          {/* What's included */}
          <div className="feature-list">
            <div className="feature-item"><span className="feature-dot">▸</span>Repair cost range with key cost drivers</div>
            <div className="feature-item"><span className="feature-dot">▸</span>Cat S/N assessment, airbag deployment analysis, dashboard warning light interpretation</div>
            <div className="feature-item"><span className="feature-dot">▸</span>Realistic Cat N/S exit value with 20–35% discount applied</div>
            <div className="feature-item"><span className="feature-dot">▸</span>Margin calculation — hammer price ready to enter</div>
            <div className="feature-item"><span className="feature-dot">▸</span>Tailored WhatsApp inspection checklist for this lot</div>
            <div className="feature-item"><span className="feature-dot">▸</span>Downloadable PDF report</div>
          </div>

          {error && <div className="error-box">⚠️ {error}</div>}

          <button
            className="btn-pay"
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? '⏳ Saving...' : isRerun ? '↺ Re-run Assessment (free)' : `🔨 Pay £${price.toFixed(2)} and Assess`}
          </button>
        </div>

        <p className="footer-note">
          AI-powered damage assessment. Not a professional repair quote.<br />
          Not affiliated with Copart, CAP or HPI. &nbsp;<a href="/terms">Terms &amp; Conditions</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp; <a href="/">← Back to VRM lookup</a>
        </p>
      </div>
    </>
  );
}
