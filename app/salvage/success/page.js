'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { parseVdsParts } from '@/lib/parts.mjs';

const LOADING_MESSAGES = [
  'Verifying payment...',
  'Analysing photos...',
  'Identifying damage areas...',
  'Checking Cat S/N indicators...',
  'Calculating repair estimates...',
  'Applying market value discounts...',
  'Building inspection checklist...',
  'Finalising your report...',
];

const FIELD_ORDER = [
  'Visible Damage Summary',
  'Estimated Repair Range',
  'Parts Breakdown',
  'Key Cost Drivers',
  'Red Flags',
  'Alternative Damage Scenario',
  'Airbags',
  'Confidence Level',
  'Bidder Note',
  'Recommended Action',
  'Realistic Exit Value',
  'Margin Calculation',
];

function parseParts(text) {
  if (!text) return [];
  const result = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(?:\d+[.)]\s*)?(.+?)\s*\|\s*(.+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*$/);
    if (!m) continue;
    const [, name, action, col3, col4] = m;
    const parseP = s => {
      if (!s || /^[—\-–]+$|n\/a/i.test(s.trim())) return null;
      const n = s.replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
      return n ? Math.round(parseFloat(n[0])) : null;
    };
    result.push({ name: name.trim(), action: action.trim(), oem: parseP(col3), used: parseP(col4) });
  }
  return result;
}

function parseChecklist(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map(l => l.replace(/^\d+[.)]\s*/, '').trim())
    .filter(l => l.length > 0);
}

function confidenceColor(level) {
  if (!level) return '#f0ebe6';
  const l = level.toLowerCase();
  if (l.includes('high')) return '#4ade80';
  if (l.includes('medium')) return '#f5c842';
  if (l.includes('low')) return '#f87171';
  return '#f0ebe6';
}

function actionColor(action) {
  if (!action) return '#f0ebe6';
  const l = action.toLowerCase();
  if (l.includes('option a')) return '#4ade80';
  if (l.includes('option b')) return '#f5c842';
  if (l.includes('option c')) return '#f87171';
  return '#f0ebe6';
}

// One mapping covers every CORE slot verdict vocabulary (confirmation/damage/wheel/tyre) —
// the "clear" word is always green, the "contradicts" word always red, anything else (the
// honest-absence/info states: unconfirmed/not-visible/genuinely-not-visible/
// no-dedicated-shot-but-appears-intact) sits in amber.
function slotVerdictColor(verdict) {
  if (verdict === 'confirmed' || verdict === 'undamaged' || verdict === 'dedicated-photo-intact') return '#4ade80';
  if (verdict === 'discrepancy' || verdict === 'damaged') return '#f87171';
  return '#f5c842';
}

export default function SalvageSuccessPage() {
  const router = useRouter();
  const [status, setStatus] = useState('loading'); // loading | success | error
  const [assessment, setAssessment] = useState(null);
  const [vehicleDetails, setVehicleDetails] = useState(null);
  const [market, setMarket] = useState('GB');
  const [errorMsg, setErrorMsg] = useState('');
  const [msgIdx, setMsgIdx] = useState(0);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [rerunCount, setRerunCount] = useState(null);
  const [savedLot, setSavedLot] = useState(null);
  const [showComparison, setShowComparison] = useState(false);
  const [bregoData, setBregoData] = useState(null);
  const [rerunLimitReached, setRerunLimitReached] = useState(false);
  const intervalRef = useRef(null);
  const salvageIdRef = useRef(null);
  const sessionIdRef = useRef(null);
  const promoTokenRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    salvageIdRef.current = params.get('salvage_id');
    sessionIdRef.current = params.get('session_id');
    promoTokenRef.current = params.get('promo_token');
    if (!salvageIdRef.current || (!sessionIdRef.current && !promoTokenRef.current)) {
      setErrorMsg('Invalid session. Please return to the salvage tool.');
      setStatus('error');
      return;
    }
    runAssessment();
  }, []);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem('motorquoter_saved_lot');
      if (saved) setSavedLot(JSON.parse(saved));
    } catch {}
  }, []);

  useEffect(() => {
    if (status === 'loading') {
      intervalRef.current = setInterval(() => {
        setMsgIdx(i => (i + 1) % LOADING_MESSAGES.length);
      }, 3500);
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [status]);

  const runAssessment = async () => {
    try {
      const url = promoTokenRef.current
        ? `/api/salvage/assess?salvage_id=${salvageIdRef.current}&promo_token=${promoTokenRef.current}`
        : `/api/salvage/assess?salvage_id=${salvageIdRef.current}&session_id=${sessionIdRef.current}`;
      const res = await fetch(url);
      if (!res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const err = await res.json();
          throw new Error(err.error || `Assessment failed (${res.status})`);
        }
        throw new Error(`Assessment failed (${res.status})`);
      }
      const data = await res.json();
      setAssessment(data.assessment);
      setVehicleDetails(data.vehicleDetails || {});
      setMarket(data.market || 'GB');
      setRerunCount(data.rerunCount ?? 0);
      setBregoData(data.bregoData || null);
      setStatus('success');
    } catch (e) {
      setErrorMsg(e.message);
      setStatus('error');
    }
  };

  const handleRerun = async () => {
    if (!salvageIdRef.current) return;
    try {
      const res = await fetch('/api/salvage/rerun', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salvage_id: salvageIdRef.current }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 403) {
          setRerunLimitReached(true);
          setErrorMsg("You've used your free re-run for this assessment.");
          setStatus('error');
          return;
        }
        throw new Error(body.error || 'Re-run failed');
      }
      router.push(`/salvage?rerun=${salvageIdRef.current}&vrm=${vehicleDetails?.vrm || ''}`);
    } catch(e) {
      setErrorMsg(e.message);
      setStatus('error');
    }
  };

  const handleDownloadPdf = async () => {
    if (!assessment) return;
    setPdfLoading(true);
    try {
      const vd = vehicleDetails || {};
      const identifier = vd.vrm || vd.lotNumber || [vd.make, vd.model, vd.year].filter(Boolean).join(' ') || 'Salvage';
      const assessmentForPdf = { ...assessment };
      delete assessmentForPdf._raw;
      delete assessmentForPdf._market;
      const res = await fetch('/api/salvage/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assessment: assessmentForPdf, vehicleDetails: vd, market, identifier, bregoData: bregoData || null }),
      });
      if (!res.ok) throw new Error('PDF generation failed');
      const buf = await res.arrayBuffer();
      const blob = new Blob([buf], { type: 'application/octet-stream' });
      const link = document.createElement('a');
      const now = new Date();
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const datePart = `${now.getDate()}${months[now.getMonth()]}${now.getFullYear()}`;
      const ref = (identifier).replace(/\s+/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'Salvage';
      link.href = URL.createObjectURL(blob);
      link.download = `${ref}Assessment${datePart}.pdf`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (e) {
      alert('PDF download failed: ' + e.message);
    } finally {
      setPdfLoading(false);
    }
  };

  const handleSaveForComparison = () => {
    try {
      const lotData = {
        identifier,
        assessment,
        vehicleDetails,
        market,
        savedAt: new Date().toISOString(),
      };
      sessionStorage.setItem('motorquoter_saved_lot', JSON.stringify(lotData));
      setSavedLot(lotData);
      alert(`${identifier} saved for comparison`);
    } catch {
      alert('Could not save lot for comparison');
    }
  };

  const handleClearSaved = () => {
    sessionStorage.removeItem('motorquoter_saved_lot');
    setSavedLot(null);
    setShowComparison(false);
  };

  const identifier = vehicleDetails
    ? (vehicleDetails.vrm || vehicleDetails.lotNumber || [vehicleDetails.make, vehicleDetails.model, vehicleDetails.year].filter(Boolean).join(' ') || 'Assessment')
    : 'Assessment';

  const checklist = parseChecklist(assessment?.['WhatsApp Inspection Checklist']);

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

        /* Loading */
        .loading-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 60vh; padding: 40px 20px; text-align: center; }
        .spinner { width: 56px; height: 56px; border: 4px solid var(--border-dim); border-top-color: var(--orange); border-radius: 50%; animation: spin 0.9s linear infinite; margin-bottom: 24px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .loading-title { font-family: 'Barlow Condensed', sans-serif; font-size: 22px; font-weight: 800; color: var(--text); margin-bottom: 8px; }
        .loading-msg { font-size: 14px; color: var(--orange); min-height: 22px; }
        .loading-sub { font-size: 13px; color: var(--text-dim); margin-top: 12px; line-height: 1.5; }

        /* Error */
        .error-wrap { padding: 32px 20px; }
        .error-box { background: rgba(248,113,113,0.1); border: 1.5px solid rgba(248,113,113,0.3); border-radius: 12px; padding: 20px; text-align: center; }
        .error-title { font-family: 'Barlow Condensed', sans-serif; font-size: 18px; font-weight: 800; color: #f87171; margin-bottom: 8px; }
        .error-msg { font-size: 14px; color: var(--text-dim); line-height: 1.5; margin-bottom: 16px; }
        .btn-retry { padding: 12px 24px; background: var(--orange); border: none; border-radius: 8px; color: white; font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 15px; cursor: pointer; }
        .btn-retry:hover { background: var(--orange-light); }

        /* Results */
        .result-header { padding: 20px 20px 0; }
        .result-eyebrow { font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.2em; color: var(--orange); text-transform: uppercase; margin-bottom: 6px; }
        .result-id { font-family: 'Barlow Condensed', sans-serif; font-size: 32px; font-weight: 900; letter-spacing: 0.06em; color: var(--text); margin-bottom: 4px; }
        .result-sub { font-size: 13px; color: var(--text-dim); }

        .repair-banner { margin: 16px 20px 0; background: var(--orange); border-radius: 12px; padding: 16px 20px; }
        .repair-banner-label { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(255,255,255,0.75); margin-bottom: 4px; }
        .repair-banner-value { font-family: 'Barlow Condensed', sans-serif; font-size: 28px; font-weight: 900; color: white; line-height: 1.1; }

        .section { margin: 12px 20px 0; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 12px; overflow: hidden; }
        .section-title { background: rgba(255,255,255,0.04); border-bottom: 1px solid var(--border-dim); padding: 10px 16px; font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.15em; color: var(--text-dim); text-transform: uppercase; }
        .section-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
        .field-row { border-bottom: 1px solid var(--border-dim); padding-bottom: 10px; }
        .field-row:last-child { border-bottom: none; padding-bottom: 0; }
        .field-key { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.15em; color: var(--text-dim); text-transform: uppercase; margin-bottom: 4px; }
        .field-val { font-size: 14px; color: var(--text); line-height: 1.55; white-space: pre-wrap; }

        .checklist-section { margin: 12px 20px 0; background: var(--bg2); border: 1.5px solid var(--border); border-radius: 12px; overflow: hidden; }
        .checklist-header { background: var(--orange-dim); border-bottom: 1px solid var(--border); padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; }
        .checklist-header-left { font-family: 'Barlow Condensed', sans-serif; font-size: 14px; font-weight: 800; letter-spacing: 0.06em; color: var(--orange); }
        .checklist-header-right { font-size: 12px; color: var(--text-dim); }
        .checklist-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
        .checklist-item { display: flex; gap: 12px; font-size: 13px; color: var(--text); line-height: 1.5; padding: 6px 0; border-bottom: 1px solid var(--border-dim); }
        .checklist-item:last-child { border-bottom: none; }
        .checklist-num { font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 900; color: var(--orange); flex-shrink: 0; width: 22px; }

        .actions { margin: 16px 20px 0; display: flex; flex-direction: column; gap: 10px; }
        .btn-pdf { width: 100%; padding: 16px; background: var(--orange); border: none; border-radius: 10px; color: white; font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 18px; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; transition: all 0.2s; }
        .btn-pdf:hover:not(:disabled) { background: var(--orange-light); transform: translateY(-1px); box-shadow: 0 4px 20px rgba(240,90,26,0.4); }
        .btn-pdf:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
        .btn-new { width: 100%; padding: 14px; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 10px; color: var(--text-dim); font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 0.06em; cursor: pointer; transition: all 0.2s; }
        .btn-new:hover { border-color: var(--orange); color: var(--text); }
        .btn-rerun { width: 100%; padding: 12px; background: transparent; border: 1.5px solid var(--orange); border-radius: 10px; color: var(--orange); font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 0.06em; cursor: pointer; transition: all 0.2s; }
        .btn-rerun:hover { background: var(--orange-dim); }
        .rerun-used { text-align: center; font-size: 12px; color: var(--text-dim); padding: 8px; }

        .footer-note { text-align: center; padding: 24px 20px 0; font-size: 11px; color: var(--text-dim); line-height: 1.6; }
        .footer-note a { color: var(--orange); text-decoration: none; }

        .compare-bar { margin: 16px 20px 0; padding: 12px 16px; background: var(--bg2); border: 1.5px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; gap: 8px; }
        .compare-bar-title { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; color: var(--orange); letter-spacing: 0.1em; text-transform: uppercase; }
        .compare-bar-saved { font-size: 12px; color: var(--text-dim); }
        .btn-compare { width: 100%; padding: 13px; background: transparent; border: 1.5px solid var(--orange); border-radius: 10px; color: var(--orange); font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 16px; letter-spacing: 0.06em; cursor: pointer; transition: all 0.2s; }
        .btn-compare:hover { background: var(--orange-dim); }
        .btn-save { width: 100%; padding: 13px; background: transparent; border: 1.5px solid var(--border-dim); border-radius: 10px; color: var(--text-dim); font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 0.06em; cursor: pointer; transition: all 0.2s; }
        .btn-save:hover { border-color: var(--orange); color: var(--text); }
        .comparison-view { margin: 16px 20px 0; }
        .comparison-title { font-family: 'Barlow Condensed', sans-serif; font-size: 20px; font-weight: 900; color: var(--text); margin-bottom: 12px; letter-spacing: 0.05em; }
        .compare-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .compare-table th { background: var(--bg3); padding: 8px 6px; text-align: left; font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 800; color: var(--orange); letter-spacing: 0.08em; border-bottom: 1px solid var(--border-dim); }
        .compare-table td { padding: 8px 6px; border-bottom: 1px solid var(--border-dim); color: var(--text); vertical-align: top; line-height: 1.4; }
        .compare-table tr:nth-child(even) td { background: var(--bg2); }
        .compare-field { font-size: 10px; color: var(--text-dim); font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; padding-bottom: 2px; }

        @media print {
          .actions { display: none; }
          .header { display: none; }
        }
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

        {status === 'loading' && (
          <div className="loading-wrap">
            <div className="spinner" />
            <div className="loading-title">Running Assessment</div>
            <div className="loading-msg">{LOADING_MESSAGES[msgIdx]}</div>
            <div className="loading-sub">This takes 20–60 seconds.<br />Please keep this page open.</div>
          </div>
        )}

        {status === 'error' && (
          <div className="error-wrap">
            <div className="error-box">
              {rerunLimitReached ? (
                <>
                  <div className="error-title">Re-run Limit Reached</div>
                  <div className="error-msg">{errorMsg}</div>
                </>
              ) : (
                <>
                  <div className="error-title">Assessment Failed</div>
                  <div className="error-msg">{errorMsg || 'Something went wrong. Your payment has been taken — click Retry to try again.'}</div>
                  <button className="btn-retry" onClick={() => { setStatus('loading'); setMsgIdx(0); runAssessment(); }}>
                    Retry Assessment
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {status === 'success' && assessment && (
          <>
            <div className="result-header">
              <p className="result-eyebrow">Damage Assessment Report</p>
              <div className="result-id">{identifier}</div>
              <div className="result-sub">
                {vehicleDetails && [vehicleDetails.year, vehicleDetails.make, vehicleDetails.model].filter(Boolean).join(' ')}
                {vehicleDetails?.lotNumber && ` · Lot ${vehicleDetails.lotNumber}`}
                {` · ${market} Market`}
              </div>
            </div>

            {/* Repair estimate banner — code-owned parts_sum, single figure */}
            {assessment._partsReconciliation?.parts_sum > 0 && (
              <div className="repair-banner">
                <div className="repair-banner-label">Estimated Repair — visible items</div>
                <div className="repair-banner-value">£{Number(assessment._partsReconciliation.parts_sum).toLocaleString('en-GB')}</div>
              </div>
            )}

            {/* Confidence level quick badge */}
            {assessment['Confidence Level'] && (
              <div style={{ margin: '10px 20px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: '0.15em', color: 'var(--text-dim)', textTransform: 'uppercase' }}>Confidence:</span>
                <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 15, fontWeight: 800, color: confidenceColor(assessment['Confidence Level']) }}>
                  {assessment['Confidence Level']}
                </span>
              </div>
            )}

            {/* CORE Checklist — code-owned forced-verdict slots, shared shape with the PDF */}
            {(() => {
              const slotData = assessment._slots;
              if (!slotData?.groups?.length) return null;
              const allClearSet = new Set(slotData.allClear);
              const allClearSlots = slotData.groups.flatMap(g => g.slots).filter(s => allClearSet.has(s.id));
              return (
                <div className="section">
                  <div className="section-title">Structured Checklist (CORE)</div>
                  <div className="section-body">
                    {allClearSlots.length > 0 && (
                      <div className="field-row">
                        <div className="field-val" style={{ color: '#4ade80' }}>
                          ✓ Verified clear — {allClearSlots.map(s => s.label).join(' · ')}
                        </div>
                      </div>
                    )}
                    {slotData.groups.map((group) => {
                      if (group.id === 'physical') return null;
                      const shown = group.slots.filter(s => !allClearSet.has(s.id));
                      if (shown.length === 0) return null;
                      return (
                        <div className="field-row" key={group.id}>
                          <div className="field-key">{group.label}</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                            {shown.map((slot) => (
                              <div key={slot.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                                <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: slotVerdictColor(slot.verdict), minWidth: 84, flexShrink: 0 }}>
                                  {slot.verdict}
                                </span>
                                <span style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
                                  <strong style={{ color: 'var(--text-dim)', fontWeight: 700 }}>{slot.label}:</strong> {slot.detail}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* MOT History */}
            {vehicleDetails?.motHistory?.length > 0 && (
              <div className="section">
                <div className="section-title">MOT History</div>
                <div className="section-body">
                  {vehicleDetails.motHistory.map((test, i) => {
                    const pass = test.testResult?.toUpperCase() === 'PASSED';
                    const failures  = test.rfrAndComments?.filter(c => c.type === 'FAIL') || [];
                    const advisories = test.rfrAndComments?.filter(c => c.type === 'ADVISORY') || [];
                    return (
                      <div className="field-row" key={i}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: (failures.length || advisories.length) ? 5 : 0 }}>
                          <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 800, color: pass ? '#4ade80' : '#f87171' }}>
                            {test.testResult}
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                            {test.completedDate}
                            {test.odometerValue ? ` · ${Number(test.odometerValue).toLocaleString()} mi` : ''}
                            {pass && test.expiryDate ? ` · exp ${test.expiryDate}` : ''}
                          </span>
                        </div>
                        {failures.map((f, j) => (
                          <div key={`f${j}`} style={{ fontSize: 12, color: '#f87171', paddingLeft: 10, lineHeight: 1.5 }}>✗ {f.text}</div>
                        ))}
                        {advisories.map((a, j) => (
                          <div key={`a${j}`} style={{ fontSize: 11, color: 'var(--text-dim)', paddingLeft: 10, lineHeight: 1.5 }}>↳ {a.text}</div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Salvage History */}
            {(() => {
              const sh = vehicleDetails?.salvageHistory;
              if (!sh) return null;
              const found = sh.salvage_auction_record_found === true;
              const records = sh.salvage_auction_records || [];
              const isSelfRef = sh.isSelfReferenceFirstWriteOff === true;
              const genuinePriors = sh.genuinePriorCount ?? records.length;
              return (
                <div className="section">
                  <div className="section-title">Salvage History Check</div>
                  <div className="section-body">
                    {!found ? (
                      <div className="field-row">
                        <div className="field-val" style={{ color: '#4ade80' }}>✓ No previous salvage auction records found</div>
                      </div>
                    ) : (isSelfRef || genuinePriors === 0) ? (
                      <>
                        <div className="field-row">
                          <div className="field-val" style={{ color: '#4ade80' }}>✓ First write-off — no prior salvage auction history</div>
                        </div>
                        {records.map((rec, i) => (
                          <div className="field-row" key={i}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                              <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>
                                {rec.salvage_auction_lot_date ? rec.salvage_auction_lot_date.split('T')[0].split('-').reverse().join('/') : '—'}
                              </span>
                              {rec.salvage_auction_lot_desc && (
                                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-dim)', borderRadius: 4, padding: '2px 8px' }}>
                                  {rec.salvage_auction_lot_desc}
                                </span>
                              )}
                            </div>
                            {rec.mileage != null          && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 2 }}>{Number(rec.mileage).toLocaleString('en-GB')} miles at sale</div>}
                            {rec.primary_damage_desc      && <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>Primary: {rec.primary_damage_desc}</div>}
                            {rec.secondary_damage_desc    && <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>Secondary: {rec.secondary_damage_desc}</div>}
                            {rec.salvage_auction_location && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{rec.salvage_auction_location}</div>}
                          </div>
                        ))}
                      </>
                    ) : (
                      <>
                        <div className="field-row" style={{ background: 'rgba(248,113,113,0.07)', borderRadius: 8, padding: '10px 12px', marginBottom: 4 }}>
                          <div className="field-val" style={{ color: '#f87171', fontWeight: 700 }}>
                            ⚠️ This vehicle has been through salvage auction {genuinePriors} time{genuinePriors !== 1 ? 's' : ''}
                          </div>
                        </div>
                        {records.map((rec, i) => (
                          <div className="field-row" key={i}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                              <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>
                                {rec.salvage_auction_lot_date ? rec.salvage_auction_lot_date.split('T')[0].split('-').reverse().join('/') : '—'}
                              </span>
                              {rec.salvage_auction_lot_desc && (
                                <span style={{ fontSize: 11, fontWeight: 700, color: '#f87171', background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 4, padding: '2px 8px' }}>
                                  {rec.salvage_auction_lot_desc}
                                </span>
                              )}
                            </div>
                            {rec.mileage != null          && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 2 }}>{Number(rec.mileage).toLocaleString('en-GB')} miles at sale</div>}
                            {rec.primary_damage_desc      && <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>Primary: {rec.primary_damage_desc}</div>}
                            {rec.secondary_damage_desc    && <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 2 }}>Secondary: {rec.secondary_damage_desc}</div>}
                            {rec.salvage_auction_location && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{rec.salvage_auction_location}</div>}
                            {rec.external_image_urls?.length > 0 && (
                              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                                {rec.external_image_urls.slice(0, 4).map((url, j) => (
                                  <img key={j} src={url} alt="Salvage record photo"
                                    style={{ width: 80, height: 60, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border-dim)' }} />
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Damage Assessment section */}
            <div className="section">
              <div className="section-title">Damage Assessment</div>
              <div className="section-body">
                {assessment['Visible Damage Summary'] && (() => {
                  const { preamble, parts } = parseVdsParts(assessment['Visible Damage Summary']);
                  if (parts.length === 0) {
                    return (
                      <div className="field-row">
                        <div className="field-key">Visible Damage Summary</div>
                        <div className="field-val">{assessment['Visible Damage Summary']}</div>
                      </div>
                    );
                  }
                  return (
                    <div className="field-row">
                      <div className="field-key">Visible Damage Summary</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {preamble && <div className="field-val">{preamble}</div>}
                        {parts.map((p, i) => (
                          <div key={i}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{p.partName}</div>
                            <div className="field-val">{p.prose}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {/* Parts Breakdown — structured line-per-item table */}
                {(() => {
                  const parts = assessment._reconciledParts?.length
                    ? assessment._reconciledParts
                    : parseParts(assessment['Parts Breakdown'] || '');
                  const allowanceParts = assessment._allowanceParts || [];
                  if (!parts.length && !allowanceParts.length) return null;
                  const fmtP = v => v != null ? `£${Number(v).toLocaleString('en-GB')}` : '—';
                  const colSt = (align = 'left', bold = false) => ({
                    fontSize: 12, fontWeight: bold ? 700 : 400,
                    color: 'var(--text)', textAlign: align,
                    padding: '5px 4px', borderTop: '1px solid var(--border-dim)',
                  });
                  const headSt = (align = 'left') => ({
                    fontSize: 10, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700,
                    letterSpacing: '0.1em', color: 'var(--text-dim)', textTransform: 'uppercase',
                    textAlign: align, paddingBottom: 4,
                  });
                  return (
                    <div className="field-row">
                      <div className="field-key">Parts Breakdown</div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
                        <thead>
                          <tr>
                            <th style={headSt('left')}>Part</th>
                            <th style={headSt('center')}>Action</th>
                            <th style={headSt('right')}>OEM</th>
                            <th style={headSt('right')}>Used/SH</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parts.map((p, i) => (
                            <tr key={i}>
                              <td style={colSt('left')}>{p.name}</td>
                              <td style={{ ...colSt('center'), color: 'var(--text-dim)', fontSize: 11 }}>{p.action}</td>
                              <td style={colSt('right')}>{fmtP(p.oem)}</td>
                              <td style={colSt('right', true)}>{fmtP(p.used)}</td>
                            </tr>
                          ))}
                          {allowanceParts.map((p, i) => (
                            <tr key={`al-${i}`} style={{ opacity: 0.65 }}>
                              <td style={{ ...colSt('left'), fontStyle: 'italic' }}>{p.name}</td>
                              <td style={{ ...colSt('center'), color: 'var(--text-dim)', fontSize: 11, fontStyle: 'italic' }}>inspect</td>
                              <td style={colSt('right')}>—</td>
                              <td style={{ ...colSt('right'), fontStyle: 'italic' }}>~{fmtP(p.used)}</td>
                            </tr>
                          ))}
                          {allowanceParts.length > 0 && (
                            <tr>
                              <td colSpan={4} style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic', padding: '5px 4px', borderTop: '1px solid var(--border-dim)' }}>
                                Italic rows: inspection allowance — confirm on inspection, not in repair total. See Inspection Flags for other excluded items.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
                {assessment['Key Cost Drivers'] ? (
                  <div className="field-row" key="Key Cost Drivers">
                    <div className="field-key">Key Cost Drivers</div>
                    <div className="field-val">{assessment['Key Cost Drivers']}</div>
                  </div>
                ) : null}
                {/* Inspection Flags — structured per-part flags (model + gate-generated), weight high→low */}
                {(() => {
                  const flags = assessment._flaggedParts || [];
                  if (!flags.length) return null;
                  const wc = { high: '#c0392b', medium: '#b8860b', low: '#888' };
                  return (
                    <div className="field-row">
                      <div className="field-key">Inspection Flags</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                        {flags.map((f, i) => (
                          <div key={i}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
                              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: wc[f.weight] || '#888', textTransform: 'uppercase' }}>
                                {f.weight}
                              </span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{f.partName}</span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>{f.reason}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
                {['Red Flags', 'Alternative Damage Scenario', 'Airbags'].map(field => (
                  assessment[field] ? (
                    <div className="field-row" key={field}>
                      <div className="field-key">{field}</div>
                      <div className="field-val">{assessment[field]}</div>
                    </div>
                  ) : null
                ))}
              </div>
            </div>

            {/* Valuation & Bidding section */}
            <div className="section">
              <div className="section-title">Valuation &amp; Bidding</div>
              <div className="section-body">
                {/* Brego live market valuation matrix */}
                {(() => {
                  const fmtGbp = (v) => v != null ? `£${Number(v).toLocaleString('en-GB')}` : '—';
                  const monthYear = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });
                  const headSt = { fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-dim)', textTransform: 'uppercase', textAlign: 'right', paddingBottom: 4 };
                  const cellSt = (highlight) => ({ fontSize: 14, fontWeight: highlight ? 800 : 500, color: highlight ? '#4ade80' : 'var(--text)', textAlign: 'right', padding: '6px 0', borderTop: '1px solid var(--border-dim)' });
                  const rowLabelSt = { fontSize: 12, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-dim)', textTransform: 'uppercase', padding: '6px 0', borderTop: '1px solid var(--border-dim)' };
                  if (bregoData) {
                    const src = bregoData._mileageSource;
                    const srcLabel = src === 'copart_listed' ? 'Copart listing'
                      : src === 'listing_odometer' ? 'Copart listing (parsed)'
                      : src === 'dvsa_mot' ? 'DVSA last MOT'
                      : src === 'photo_odometer' ? 'Odometer read from photos'
                      : src === 'age_estimate' ? 'Age-based estimate'
                      : src === 'age_anomaly' ? 'Age-based estimate (no data found)'
                      : 'default (50k)';
                    return (
                      <div className="field-row">
                        <div className="field-key">
                          Live Market Valuation
                          <span style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)', fontFamily: "'Barlow', sans-serif", textTransform: 'none', letterSpacing: 0, fontWeight: 400, marginTop: 2 }}>
                            Live data · {monthYear} · {Number(bregoData._mileageUsed).toLocaleString('en-GB')} miles ({srcLabel})
                          </span>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
                          <thead>
                            <tr>
                              <th style={{ ...headSt, textAlign: 'left' }}> </th>
                              <th style={headSt}>Low</th>
                              <th style={headSt}>Average</th>
                              <th style={headSt}>High</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td style={rowLabelSt}>Retail</td>
                              <td style={cellSt(false)}>{fmtGbp(bregoData.retail_low_valuation)}</td>
                              <td style={cellSt(true)}>{fmtGbp(bregoData.retail_average_valuation)}</td>
                              <td style={cellSt(false)}>{fmtGbp(bregoData.retail_high_valuation)}</td>
                            </tr>
                            <tr>
                              <td style={rowLabelSt}>Trade</td>
                              <td style={cellSt(false)}>{fmtGbp(bregoData.trade_low_valuation)}</td>
                              <td style={cellSt(true)}>{fmtGbp(bregoData.trade_average_valuation)}</td>
                              <td style={cellSt(false)}>{fmtGbp(bregoData.trade_high_valuation)}</td>
                            </tr>
                          </tbody>
                        </table>
                        {vehicleDetails?.estimatedRetail && (
                          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)', borderTop: '1px solid var(--border-dim)', paddingTop: 8 }}>
                            Copart ERV: <span style={{ color: 'var(--text)', fontWeight: 600 }}>{vehicleDetails.estimatedRetail}</span> — vendor-type interpretation in assessment above
                          </div>
                        )}
                        {(src === 'age_estimate' || src === 'age_anomaly') && (
                          <div style={{ marginTop: 6, fontSize: 12, color: '#f87171', fontWeight: 600, lineHeight: 1.5 }}>
                            ⚠️ ESTIMATED mileage — actual figure NOT confirmed.{' '}
                            {src === 'age_anomaly' ? 'Vehicle is over 4 years old with no listing, photo, or DVSA mileage available. ' : ''}
                            Valuation, exit value, and margin all depend on this assumed figure.{' '}
                            Confirm actual mileage before bidding.
                          </div>
                        )}
                        {vehicleDetails?.photoMileageFlag && (
                          <div style={{ marginTop: 6, fontSize: 12, color: '#f5c842' }}>
                            ⚠️ {vehicleDetails.photoMileageFlag}
                          </div>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div className="field-row">
                      <div className="field-key">Live Market Valuation</div>
                      <div className="field-val" style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>Unavailable — engine used wider confidence range</div>
                    </div>
                  );
                })()}
                {assessment['Realistic Exit Value'] && (
                  <div className="field-row">
                    <div className="field-key">Realistic Exit Value</div>
                    <div className="field-val" style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 800 }}>{assessment['Realistic Exit Value']}</div>
                  </div>
                )}
                {(assessment['Margin Calculation'] || assessment._marginScenarios?.length > 0) && (
                  <div className="field-row">
                    <div className="field-key">Margin Calculation</div>
                    {assessment['Margin Calculation'] && (
                      <div className="field-val" style={{ marginBottom: assessment._marginScenarios?.length > 0 ? 10 : 0 }}>{assessment['Margin Calculation']}</div>
                    )}
                    {(() => {
                      const scenarios = assessment._marginScenarios;
                      if (!scenarios?.length) return null;
                      const carExit   = scenarios[0].exit_value;
                      const carRepair = scenarios[0].repair;
                      const hasVat    = scenarios.some(s => s.hammerVat > 0);
                      const hasMargin = scenarios.some(s => s.margin !== null);
                      const fmtGbp    = (v) => {
                        if (v == null) return '—';
                        const n = Number(v);
                        const abs = Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        return (n < 0 ? '-' : '') + '£' + abs;
                      };
                      const headSt    = { fontSize: 11, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-dim)', textTransform: 'uppercase', textAlign: 'right', paddingBottom: 4 };
                      const cellSt    = (bold, color) => ({ fontSize: 13, fontWeight: bold ? 800 : 500, color: color || 'var(--text)', textAlign: 'right', padding: '5px 0', borderTop: '1px solid var(--border-dim)' });
                      const lblRowSt  = { fontSize: 12, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-dim)', textTransform: 'uppercase' };
                      return (
                        <div style={{ marginTop: 4 }}>
                          {(carExit != null || carRepair != null) && (
                            <div style={{ marginBottom: 8 }}>
                              {carExit != null && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border-dim)' }}>
                                  <span style={lblRowSt}>Exit value</span>
                                  <span style={{ fontSize: 13, fontWeight: 800, color: '#4ade80' }}>{fmtGbp(carExit)}</span>
                                </div>
                              )}
                              {carRepair != null && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border-dim)' }}>
                                  <span style={lblRowSt}>Repair cost</span>
                                  <span style={{ fontSize: 13, fontWeight: 500, color: '#f87171' }}>{fmtGbp(carRepair)}</span>
                                </div>
                              )}
                            </div>
                          )}
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th style={{ ...headSt, textAlign: 'left' }}>Hammer</th>
                                {hasVat && <th style={headSt}>Hammer VAT</th>}
                                <th style={headSt}>Copart fees</th>
                                {hasMargin && <th style={headSt}>Margin</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {scenarios.map((s, i) => (
                                <tr key={i}>
                                  <td style={{ ...cellSt(false), textAlign: 'left' }}>{fmtGbp(s.hammer)}</td>
                                  {hasVat && <td style={cellSt(false, s.hammerVat > 0 ? '#f87171' : 'var(--text-dim)')}>{s.hammerVat > 0 ? fmtGbp(s.hammerVat) : '—'}</td>}
                                  <td style={cellSt(false, '#f87171')}>{fmtGbp(s.totalIncVat)}</td>
                                  {hasMargin && (
                                    <td style={cellSt(true, s.margin == null ? 'var(--text-dim)' : s.margin >= 0 ? '#4ade80' : '#f87171')}>
                                      {s.margin !== null ? fmtGbp(s.margin) : '—'}
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                  </div>
                )}
                {assessment['Bidder Note'] && (
                  <div className="field-row">
                    <div className="field-key">Bidder Note</div>
                    <div className="field-val">{assessment['Bidder Note']}</div>
                  </div>
                )}
                {assessment['Recommended Action'] && (
                  <div className="field-row">
                    <div className="field-key">Recommended Action</div>
                    <div className="field-val" style={{ color: actionColor(assessment['Recommended Action']), fontWeight: 600 }}>{assessment['Recommended Action']}</div>
                  </div>
                )}
              </div>
            </div>

            {/* WhatsApp Inspection Checklist */}
            {checklist.length > 0 && (
              <div className="checklist-section">
                <div className="checklist-header">
                  <span className="checklist-header-left">WhatsApp Inspection Checklist</span>
                  <span className="checklist-header-right">£10 · book 48hrs before sale</span>
                </div>
                <div className="checklist-body">
                  {checklist.map((item, i) => (
                    <div className="checklist-item" key={i}>
                      <span className="checklist-num">{i + 1}</span>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* If raw text didn't parse cleanly, show full response */}
            {!assessment['Visible Damage Summary'] && assessment._raw && (
              <div className="section">
                <div className="section-title">Assessment</div>
                <div className="section-body">
                  <div className="field-val" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>{assessment._raw}</div>
                </div>
              </div>
            )}

            {status === 'success' && assessment && !showComparison && (
              <div className="compare-bar">
                <div className="compare-bar-title">⚖ Compare Lots</div>
                {savedLot && savedLot.identifier !== identifier ? (
                  <>
                    <div className="compare-bar-saved">Saved: {savedLot.identifier} — {[savedLot.vehicleDetails?.make, savedLot.vehicleDetails?.model, savedLot.vehicleDetails?.year].filter(Boolean).join(' ')}</div>
                    <button className="btn-compare" onClick={() => setShowComparison(true)}>Compare with {savedLot.identifier}</button>
                    <button className="btn-save" onClick={handleSaveForComparison}>Replace saved lot with {identifier}</button>
                  </>
                ) : (
                  <button className="btn-save" onClick={handleSaveForComparison}>
                    {savedLot?.identifier === identifier ? '✓ This lot is saved' : `Save ${identifier} for comparison`}
                  </button>
                )}
              </div>
            )}

            {showComparison && savedLot && (
              <div className="comparison-view">
                <div className="comparison-title">⚖ LOT COMPARISON</div>
                <table className="compare-table">
                  <thead>
                    <tr>
                      <th style={{width:'30%'}}>Field</th>
                      <th style={{width:'35%'}}>{savedLot.identifier}</th>
                      <th style={{width:'35%'}}>{identifier}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['Category', savedLot.vehicleDetails?.category, vehicleDetails?.category],
                      ['Odometer', savedLot.vehicleDetails?.odometer ? savedLot.vehicleDetails.odometer + ' mi' : '-', vehicleDetails?.odometer ? vehicleDetails.odometer + ' mi' : '-'],
                      ['Run Condition', savedLot.vehicleDetails?.runCondition, vehicleDetails?.runCondition],
                      ['Primary Damage', savedLot.vehicleDetails?.primaryDamage, vehicleDetails?.primaryDamage],
                      ['Repair', savedLot.assessment?._partsReconciliation?.parts_sum ? `£${Number(savedLot.assessment._partsReconciliation.parts_sum).toLocaleString('en-GB')}` : '-', assessment?._partsReconciliation?.parts_sum ? `£${Number(assessment._partsReconciliation.parts_sum).toLocaleString('en-GB')}` : '-'],
                      ['Exit Value', savedLot.assessment?.['Realistic Exit Value']?.split('.')[0] + '.', assessment?.['Realistic Exit Value']?.split('.')[0] + '.'],
                      ['Airbags', savedLot.assessment?.['Airbags']?.split('.')[0] + '.', assessment?.['Airbags']?.split('.')[0] + '.'],
                      ['Confidence', savedLot.assessment?.['Confidence Level']?.split('\n')[0], assessment?.['Confidence Level']?.split('\n')[0]],
                      ['Action', savedLot.assessment?.['Recommended Action']?.split('.')[0] + '.', assessment?.['Recommended Action']?.split('.')[0] + '.'],
                    ].map(([field, val1, val2]) => (
                      <tr key={field}>
                        <td><div className="compare-field">{field}</div></td>
                        <td>{val1 || '-'}</td>
                        <td>{val2 || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button className="btn-save" style={{marginTop: 12, width: '100%'}} onClick={() => setShowComparison(false)}>← Back to Assessment</button>
                <button className="btn-save" style={{marginTop: 8, width: '100%', color: '#f87171', borderColor: 'rgba(248,113,113,0.3)'}} onClick={handleClearSaved}>Clear saved lot</button>
              </div>
            )}

            <div className="actions">
              <button className="btn-pdf" onClick={handleDownloadPdf} disabled={pdfLoading}>
                {pdfLoading ? 'Generating PDF...' : '⬇ Download Assessment Report'}
              </button>
              <button className="btn-new" onClick={() => router.push('/salvage')}>
                + New Assessment
              </button>
              {rerunCount !== null && rerunCount < 1 ? (
                <button className="btn-rerun" onClick={handleRerun}>
                  ↺ Re-run Assessment (1 free re-run remaining)
                </button>
              ) : rerunCount >= 1 ? (
                <div className="rerun-used">Re-run already used</div>
              ) : null}
            </div>

            <p className="footer-note">
              AI-generated guidance only. Not a professional repair quote. The repair figure is the sum of itemised parts costed as visible in the photos. Items not independently confirmable appear in Inspection Flags and italic allowance rows — they are not in this figure. Hidden, secondary, or unphotographed damage may increase actual costs.<br />
              MotorQuoter is not affiliated with Copart, CAP or HPI. &nbsp;<a href="/terms">Terms &amp; Conditions</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a>
            </p>
          </>
        )}
      </div>
    </>
  );
}
