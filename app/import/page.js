'use client';

import { useState } from 'react';

const fmtEur = n => (n != null && Number.isFinite(Number(n))) ? `€${Math.round(Number(n)).toLocaleString('en-IE')}` : '—';

export default function ImportPage() {
  const [reg, setReg] = useState('');
  const [price, setPrice] = useState('');
  const [provenance, setProvenance] = useState('GB'); // safe/over-stating default
  const [niQualifies, setNiQualifies] = useState(''); // '', 'yes', 'no'
  const [mileage, setMileage] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [nox, setNox] = useState('');
  const [loading, setLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  // Optional email capture (Brevo) on the free result
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [emailConsent, setEmailConsent] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailDone, setEmailDone] = useState(false);
  const [emailErr, setEmailErr] = useState('');

  // Effective provenance: only "NI" if the buyer affirmatively confirmed the NI qualification.
  const effectiveProvenance = (provenance === 'NI' && niQualifies === 'yes') ? 'NI' : 'GB';

  function validate() {
    if (!reg.trim()) return 'Enter the registration of the car.';
    if (!String(price).replace(/[^\d]/g, '')) return 'Enter the price you’re paying.';
    if (provenance === 'NI' && !niQualifies) return 'Let us know whether it qualifies for the NI exemption.';
    return '';
  }

  function params() {
    const p = new URLSearchParams({
      vrm: reg.toUpperCase().replace(/\s/g, ''),
      purchase_price: String(price).replace(/[^\d]/g, ''),
      provenance: effectiveProvenance,
    });
    if (nox) p.set('nox', String(nox).replace(/[^\d]/g, ''));
    if (mileage) p.set('mileage', String(mileage).replace(/[^\d]/g, ''));
    return p;
  }

  async function getFreeEstimate(e) {
    e?.preventDefault();
    const v = validate();
    if (v) { setError(v); return; }
    setError(''); setLoading(true); setResult(null);
    try {
      const res = await fetch(`/api/import-estimate?${params()}`);
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error || 'Something went wrong — try again.'); return; }
      setResult(data);
    } catch {
      setError('Something went wrong — please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function payForExact() {
    setPaying(true); setError('');
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vrm: reg.toUpperCase().replace(/\s/g, ''),
          checks: ['import_cost'],
          market: 'GB',
          provenance: effectiveProvenance,
          purchase_price: String(price).replace(/[^\d]/g, ''),
          nox: nox ? String(nox).replace(/[^\d]/g, '') : '',
          mileage: mileage ? String(mileage).replace(/[^\d]/g, '') : '',
        }),
      });
      const data = await res.json();
      if (data.url) { window.location.href = data.url; return; }
      setError(data.error || 'Could not start checkout — please try again.');
    } catch {
      setError('Could not start checkout — please try again.');
    } finally {
      setPaying(false);
    }
  }

  const est = result?.estimate;
  const isGB = est?.basis?.provenance === 'GB';

  async function subscribe() {
    if (!emailConsent) { setEmailErr('Please tick the box to confirm you’re happy to be emailed.'); return; }
    setEmailErr(''); setEmailBusy(true);
    try {
      const summary = est?.vrt
        ? `VRT from about ${fmtEur(est.vrt.total)}${isGB && est.vat ? ` · VAT ${fmtEur(est.vat)}` : ''}`
        : '';
      const res = await fetch('/api/import-estimate/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, consent: emailConsent, vrm: reg.toUpperCase().replace(/\s/g, ''), summary }),
      });
      const data = await res.json();
      if (!res.ok) { setEmailErr(data.error || 'Could not send — please try again.'); return; }
      setEmailDone(true);
    } catch {
      setEmailErr('Could not send — please try again.');
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <>
      <style>{styles}</style>
      <div className="app">
        <div className="header"><div className="logo"><span className="logo-text">MotorQuoter</span></div></div>

        <div className="hero">
          <h1 className="hero-title">Thinking of importing a car from the UK?</h1>
          <p className="hero-sub">Know what it’ll really cost to land it on Irish plates — before you buy. VRT, VAT, customs, and the Irish valuation, done right.</p>
        </div>

        <form className="card" onSubmit={getFreeEstimate}>
          <label className="field-label">Registration</label>
          <input className="field" value={reg} onChange={e => setReg(e.target.value)} placeholder="GB or NI reg — e.g. AB12CDE" autoCapitalize="characters" />

          <label className="field-label">Price you’re paying (£)</label>
          <input className="field" value={price} onChange={e => setPrice(e.target.value)} inputMode="numeric" placeholder="e.g. 18,000" />
          <div className="hint">You’re buying a UK car in £; your import cost is shown in €.</div>

          <label className="field-label">Where are you buying the car?</label>
          <div className="radios">
            <label className={`radio ${provenance === 'GB' ? 'on' : ''}`}>
              <input type="radio" name="prov" checked={provenance === 'GB'} onChange={() => { setProvenance('GB'); setNiQualifies(''); }} />
              Great Britain (England, Scotland, Wales)
            </label>
            <label className={`radio ${provenance === 'NI' ? 'on' : ''}`}>
              <input type="radio" name="prov" checked={provenance === 'NI'} onChange={() => setProvenance('NI')} />
              Northern Ireland
            </label>
          </div>

          {provenance === 'NI' && (
            <div className="ni-box">
              <p className="ni-q">To come in free of VAT and customs, the car must have been <strong>legally imported into NI</strong> — registered in NI before 1 January 2021, <em>or</em> you have the <strong>NI V5C plus NI service/MOT history</strong>. Does it qualify?</p>
              <label className={`radio ${niQualifies === 'yes' ? 'on' : ''}`}>
                <input type="radio" name="niq" checked={niQualifies === 'yes'} onChange={() => setNiQualifies('yes')} />
                Yes — it qualifies
              </label>
              <label className={`radio ${niQualifies === 'no' ? 'on' : ''}`}>
                <input type="radio" name="niq" checked={niQualifies === 'no'} onChange={() => setNiQualifies('no')} />
                No / not sure
              </label>
              {niQualifies === 'yes' && <div className="hint">You’ll need the NI paperwork at registration.</div>}
              {niQualifies === 'no' && <div className="hint">We’ll show the GB charges. If it turns out it was legally in NI, the VAT/customs may not apply — check with Revenue.</div>}
            </div>
          )}

          <label className="field-label">Mileage <span className="opt">(optional)</span></label>
          <input className="field" value={mileage} onChange={e => setMileage(e.target.value)} inputMode="numeric" placeholder="Sharpens the paid Irish valuation" />

          <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced(s => !s)}>
            {showAdvanced ? '− ' : '+ '}Advanced — exact NOx from your V5C
          </button>
          {showAdvanced && (
            <>
              <input className="field" value={nox} onChange={e => setNox(e.target.value)} inputMode="numeric" placeholder="NOx mg/km — V5C box V.3" />
              <div className="hint">Optional. Overrides our Euro-class NOx estimate for a more exact figure (matters most on diesels).</div>
            </>
          )}

          <button className="cta" type="submit" disabled={loading}>
            {loading ? 'Checking…' : 'Get my free estimate'}
          </button>
          {error && <div className="error">{error}</div>}
        </form>

        {result && est && (
          <div className="card result">
            <div className="section-title">Your rough import estimate</div>
            {result.vehicle && (
              <div className="veh">{[result.vehicle.year, result.vehicle.make, result.vehicle.fuel].filter(Boolean).join(' · ')}{result.vehicle.co2 != null ? ` · ${result.vehicle.co2} g/km` : ''}</div>
            )}
            {est.supported && est.vrt ? (
              <>
                <div className="row"><span className="k">VRT</span><span className="v">from about {fmtEur(est.vrt.total)}</span></div>
                {isGB && <div className="row"><span className="k">VAT (23%)</span><span className="v">{est.vat ? fmtEur(est.vat) : '—'}</span></div>}
                <div className="row"><span className="k">Customs</span><span className="v warn">{isGB ? 'origin-dependent' : 'not applicable'}</span></div>
                <p className="floor-note">This is a <strong>floor</strong> based on the price you entered. Revenue values the car for VRT using its own Irish market price — usually higher — so the real figure is likely more.</p>
              </>
            ) : (
              <p className="floor-note">{est.reason || 'We couldn’t compute an estimate from the free data — the exact check below will use a full Irish valuation.'}</p>
            )}

            <button className="cta cta-pay" onClick={payForExact} disabled={paying}>
              {paying ? 'Starting checkout…' : '▸ Get the exact figure — €9.99'}
            </button>
            <p className="pay-sub">A real Irish market valuation, the exact VRT band, VAT, customs, and what the car’s worth over here. The full landed cost, done right.</p>

            {emailDone ? (
              <div className="email-done">Sent — check your inbox.</div>
            ) : emailOpen ? (
              <div className="email-form">
                <input className="field" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" />
                <label className="consent">
                  <input type="checkbox" checked={emailConsent} onChange={e => setEmailConsent(e.target.checked)} />
                  <span>Email me this estimate and occasional MotorQuoter import tips. Unsubscribe anytime.</span>
                </label>
                <button className="cta email-send" onClick={subscribe} disabled={emailBusy}>{emailBusy ? 'Sending…' : 'Send it'}</button>
                {emailErr && <div className="error">{emailErr}</div>}
              </div>
            ) : (
              <button className="email-toggle" onClick={() => setEmailOpen(true)}>✉ Email me this estimate</button>
            )}

            <p className="disclaimer">Estimate only. The binding VRT is set by Revenue/NCTS when you register the car. VAT and customs are indicative and depend on the car’s origin — check with Revenue or a customs agent before you commit.</p>
            <p className="disclaimer">MotorQuoter accepts no liability for purchase or bidding decisions made in reliance on this estimate.</p>
            {effectiveProvenance === 'NI' && <p className="disclaimer">VAT/customs-free only if the car was legally imported into NI — keep the NI V5C and service/MOT history for registration.</p>}
          </div>
        )}
        <p className="page-note">MotorQuoter is not affiliated with or endorsed by the Revenue Commissioners or NCTS.</p>
      </div>
    </>
  );
}

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=Barlow:wght@400;500;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #1e1a17; --bg2: #2a2420; --bg3: #332e29; --orange: #f05a1a; --orange-light: #ff6b2b;
    --orange-dim: rgba(240,90,26,0.15); --text: #f0ebe6; --text-dim: #9a8f87;
    --border: rgba(240,90,26,0.25); --border-dim: rgba(255,255,255,0.08); --yellow: #f5c842;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Barlow', sans-serif; min-height: 100vh; }
  .app { max-width: 480px; margin: 0 auto; padding: 0 0 60px; }
  .header { display: flex; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border-dim); }
  .logo-text { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 20px; letter-spacing: 0.05em; }
  .hero { padding: 28px 20px 8px; }
  .hero-title { font-family: 'Barlow Condensed', sans-serif; font-weight: 900; font-size: 28px; line-height: 1.05; color: var(--text); }
  .hero-sub { font-size: 15px; color: var(--text-dim); margin-top: 10px; line-height: 1.5; }
  .card { margin: 16px 20px 6px; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 12px; padding: 16px; }
  .field-label { display: block; font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; color: var(--text-dim); text-transform: uppercase; margin: 14px 0 6px; }
  .field-label:first-child { margin-top: 0; }
  .opt { color: var(--text-dim); font-weight: 400; letter-spacing: 0; text-transform: none; }
  .field { width: 100%; padding: 12px 14px; background: var(--bg); border: 1.5px solid var(--border-dim); border-radius: 10px; color: var(--text); font-size: 16px; font-family: 'Barlow', sans-serif; }
  .field:focus { outline: none; border-color: var(--orange); }
  .hint { font-size: 12px; color: var(--text-dim); margin-top: 6px; line-height: 1.45; }
  .radios { display: flex; flex-direction: column; gap: 8px; }
  .radio { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: var(--bg); border: 1.5px solid var(--border-dim); border-radius: 10px; font-size: 14px; cursor: pointer; }
  .radio.on { border-color: var(--orange); background: var(--orange-dim); }
  .radio input { accent-color: var(--orange); width: 16px; height: 16px; }
  .ni-box { margin-top: 12px; padding: 14px; background: var(--bg); border: 1.5px solid var(--border); border-radius: 10px; }
  .ni-q { font-size: 13.5px; line-height: 1.5; color: var(--text); margin-bottom: 10px; }
  .advanced-toggle { display: block; margin: 14px 0 0; background: none; border: none; color: var(--orange); font-size: 13px; font-weight: 600; cursor: pointer; padding: 4px 0; }
  .cta { display: block; width: 100%; margin-top: 18px; padding: 15px; background: var(--orange); border: none; border-radius: 10px; color: #fff; font-family: 'Barlow Condensed', sans-serif; font-size: 17px; font-weight: 800; letter-spacing: 0.06em; cursor: pointer; }
  .cta:hover { background: var(--orange-light); }
  .cta:disabled { opacity: 0.6; cursor: wait; }
  .cta-pay { margin-top: 16px; }
  .pay-sub { font-size: 12.5px; color: var(--text-dim); margin-top: 8px; line-height: 1.5; text-align: center; }
  .error { margin-top: 12px; background: rgba(248,113,113,0.1); border: 1.5px solid rgba(248,113,113,0.3); border-radius: 10px; padding: 12px 14px; color: #f87171; font-size: 14px; }
  .result .section-title { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.18em; color: var(--orange); text-transform: uppercase; padding-bottom: 8px; border-bottom: 1px solid var(--border-dim); margin-bottom: 10px; }
  .veh { font-size: 13px; color: var(--text-dim); margin-bottom: 10px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; padding: 10px 0; border-top: 1px solid var(--border-dim); }
  .row .k { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); }
  .row .v { font-size: 16px; font-weight: 700; color: var(--text); }
  .row .v.warn { color: var(--yellow); }
  .floor-note { font-size: 13px; color: var(--text-dim); line-height: 1.55; margin: 12px 0 4px; font-style: italic; }
  .disclaimer { font-size: 11px; color: var(--text-dim); line-height: 1.5; margin-top: 12px; }
  .page-note { text-align: center; font-size: 11px; color: var(--text-dim); line-height: 1.6; padding: 22px 20px 0; }
  .email-toggle { display: block; width: 100%; margin-top: 14px; padding: 12px; background: var(--bg3); border: 1.5px solid var(--border-dim); border-radius: 10px; color: var(--text-dim); font-family: 'Barlow Condensed', sans-serif; font-size: 15px; font-weight: 700; letter-spacing: 0.04em; cursor: pointer; }
  .email-toggle:hover { border-color: var(--orange); color: var(--orange); }
  .email-form { margin-top: 14px; }
  .consent { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0; font-size: 12px; color: var(--text-dim); line-height: 1.45; cursor: pointer; }
  .consent input { accent-color: var(--orange); margin-top: 2px; width: 15px; height: 15px; flex-shrink: 0; }
  .email-send { margin-top: 4px; }
  .email-done { margin-top: 14px; padding: 12px; text-align: center; background: rgba(74,222,128,0.12); border: 1.5px solid rgba(74,222,128,0.3); border-radius: 10px; color: #4ade80; font-size: 14px; font-weight: 600; }
`;
