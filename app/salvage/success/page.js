'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

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
  const intervalRef = useRef(null);
  const salvageIdRef = useRef(null);
  const sessionIdRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    salvageIdRef.current = params.get('salvage_id');
    sessionIdRef.current = params.get('session_id');
    if (!salvageIdRef.current || !sessionIdRef.current) {
      setErrorMsg('Invalid session. Please return to the salvage tool.');
      setStatus('error');
      return;
    }
    runAssessment();
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
      const url = `/api/salvage/assess?salvage_id=${salvageIdRef.current}&session_id=${sessionIdRef.current}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Assessment failed');
      setAssessment(data.assessment);
      setVehicleDetails(data.vehicleDetails || {});
      setMarket(data.market || 'GB');
      setRerunCount(data.rerunCount ?? 0);
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
      if (!res.ok) throw new Error('Re-run failed');
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
        body: JSON.stringify({ assessment: assessmentForPdf, vehicleDetails: vd, market, identifier }),
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
        .logo-icon { width: 36px; height: 36px; background: var(--orange); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-family: 'Barlow Condensed', sans-serif; font-weight: 900; font-size: 18px; color: white; }
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

        @media print {
          .actions { display: none; }
          .header { display: none; }
        }
      `}</style>

      <div className="app">
        <header className="header">
          <div className="logo" onClick={() => router.push('/')}>
            <div className="logo-icon">M</div>
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
              <div className="error-title">Assessment Failed</div>
              <div className="error-msg">{errorMsg || 'Something went wrong. Your payment has been taken — click Retry to try again.'}</div>
              <button className="btn-retry" onClick={() => { setStatus('loading'); setMsgIdx(0); runAssessment(); }}>
                Retry Assessment
              </button>
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

            {/* Repair estimate banner */}
            {assessment['Estimated Repair Range'] && (
              <div className="repair-banner">
                <div className="repair-banner-label">Estimated Repair Range</div>
                <div className="repair-banner-value">{assessment['Estimated Repair Range']}</div>
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

            {/* Damage Assessment section */}
            <div className="section">
              <div className="section-title">Damage Assessment</div>
              <div className="section-body">
                {['Visible Damage Summary', 'Key Cost Drivers', 'Red Flags', 'Alternative Damage Scenario', 'Airbags'].map(field => (
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
                {assessment['Realistic Exit Value'] && (
                  <div className="field-row">
                    <div className="field-key">Realistic Exit Value</div>
                    <div className="field-val" style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 18, fontWeight: 800 }}>{assessment['Realistic Exit Value']}</div>
                  </div>
                )}
                {assessment['Margin Calculation'] && (
                  <div className="field-row">
                    <div className="field-key">Margin Calculation</div>
                    <div className="field-val">{assessment['Margin Calculation']}</div>
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
              AI-generated guidance only. Not a professional repair quote. Repair costs are estimates based on visible photo evidence — hidden or secondary damage may increase actual costs.<br />
              MotorQuoter is not affiliated with Copart, CAP or HPI.
            </p>
          </>
        )}
      </div>
    </>
  );
}
