'use client';

import { useState } from 'react';
import { REGISTRATION_CLOCK } from '@/config/importClock';

const fmtEur = n => (n != null && Number.isFinite(Number(n))) ? `€${Math.round(Number(n)).toLocaleString('en-IE')}` : '—';
const fxDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return iso || ''; const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${+m[3]} ${M[+m[2] - 1]} ${m[1]}`; };

export default function ImportPage() {
  const [reg, setReg] = useState('');
  const [price, setPrice] = useState('');
  // sellerType drives single-vs-dual presentation (Vincent's batch-26 ruling): 'private'|'dealer' →
  // both outcomes shown; 'pre2021' → single NI (EU goods); 'gb' → single GB.
  const [sellerType, setSellerType] = useState('gb');
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

  function validate() {
    if (!reg.trim()) return 'Enter the registration of the car.';
    if (!String(price).replace(/[^\d]/g, '')) return 'Enter the price you’re paying.';
    return '';
  }

  function params() {
    const p = new URLSearchParams({
      vrm: reg.toUpperCase().replace(/\s/g, ''),
      purchase_price: String(price).replace(/[^\d]/g, ''),
      seller_type: sellerType,
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
          seller_type: sellerType,
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
  const isDual = est?.mode === 'dual';
  const single = isDual ? null : est;              // single-mode: est spreads the estimate
  const isGB = single?.basis?.provenance === 'GB';
  const nmt = isDual ? est?.dual?.gb?.newMeansOfTransport : single?.newMeansOfTransport;
  const catC = isDual ? est?.dual?.gb?.categoryC : single?.categoryC;
  const catCNear = isDual ? est?.dual?.gb?.categoryCNear : single?.categoryCNear;

  async function subscribe() {
    if (!emailConsent) { setEmailErr('Please tick the box to confirm you’re happy to be emailed.'); return; }
    setEmailErr(''); setEmailBusy(true);
    try {
      const summary = isDual
        ? (est.supported ? `If NI-qualifying: from about ${fmtEur(est.dual.ni.grandTotal)} (VRT only); if not: ${fmtEur(est.dual.gb.grandTotal)} (VRT + VAT)` : '')
        : (single?.vrt ? `VRT from about ${fmtEur(single.vrt.total)}${isGB && single.vat ? ` · VAT ${fmtEur(single.vat)}` : ''}` : '');
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

          <label className="field-label">Where are you buying it, and what’s its NI history?</label>
          <div className="radios">
            <label className={`radio ${sellerType === 'private' ? 'on' : ''}`}>
              <input type="radio" name="seller" checked={sellerType === 'private'} onChange={() => setSellerType('private')} />
              Private seller in Northern Ireland
            </label>
            <label className={`radio ${sellerType === 'dealer' ? 'on' : ''}`}>
              <input type="radio" name="seller" checked={sellerType === 'dealer'} onChange={() => setSellerType('dealer')} />
              Northern Ireland dealer / trade
            </label>
            <label className={`radio ${sellerType === 'pre2021' ? 'on' : ''}`}>
              <input type="radio" name="seller" checked={sellerType === 'pre2021'} onChange={() => setSellerType('pre2021')} />
              It was in NI before January 2021
            </label>
            <label className={`radio ${sellerType === 'gb' ? 'on' : ''}`}>
              <input type="radio" name="seller" checked={sellerType === 'gb'} onChange={() => setSellerType('gb')} />
              Great Britain seller / not sure
            </label>
          </div>

          {(sellerType === 'private' || sellerType === 'dealer') && (
            <div className="ni-box">
              {sellerType === 'private'
                ? <p className="ni-q">Revenue looks for the car having been in private ownership in NI for <strong>“a reasonable period of time”</strong> — Revenue’s own phrase; they don’t publish a length and decide case by case. We’ll show <strong>both</strong> outcomes so you can see what hinges on the evidence.</p>
                : <p className="ni-q">Ask the dealer for the <strong>UKIMS movement reference (MRN)</strong> for this car — the record from when it was moved to NI. We’ll show <strong>both</strong> outcomes.</p>}
            </div>
          )}
          {sellerType === 'pre2021' && <div className="hint">Treated as EU goods — no VAT or customs. Keep proof it was in NI before the cut-off.</div>}

          <label className="field-label">Mileage in miles <span className="opt">(optional)</span></label>
          <input className="field" value={mileage} onChange={e => setMileage(e.target.value)} inputMode="numeric" placeholder="In miles — sharpens the paid Irish valuation" />

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

        {result?.refused && (
          <div className="card result">
            <div className="section-title">Not a passenger car</div>
            {result.vehicle && (
              <div className="veh">{[result.vehicle.year, result.vehicle.make, result.vehicle.fuel].filter(Boolean).join(' · ')}{result.vehicle.typeApproval ? ` · ${result.vehicle.typeApproval}` : ''}</div>
            )}
            <p className="floor-note">{result.reason}</p>
            <p className="disclaimer">Work out other categories with <a href="https://www.ros.ie/evrt-enquiry/vrtenquiry.html" target="_blank" rel="noopener noreferrer">Revenue’s official VRT calculator</a>.</p>
          </div>
        )}

        {result && est && !result.refused && (
          <div className="card result">
            <div className="section-title">Your rough import estimate</div>
            {result.vehicle && (
              <div className="veh">{[result.vehicle.year, result.vehicle.make, result.vehicle.fuel].filter(Boolean).join(' · ')}{result.vehicle.co2 != null ? ` · ${result.vehicle.co2} g/km` : ''}</div>
            )}
            {catC && <p className="floor-note"><strong>Over 30 years old → Category C flat €200 VRT</strong> (CO₂ and NOx don’t apply).</p>}
            {catCNear && <p className="floor-note">Close to 30 years old — VRT is measured at the date you register it. If it passes 30 by then it’s a flat €200 (Category C). Check the exact date.</p>}
            {nmt && (nmt.isNew || nmt.near || nmt.distanceUncheckable) && (
              <p className="floor-note" style={{ color: nmt.isNew ? '#f05a1a' : undefined }}>
                {nmt.isNew
                  ? <><strong>Counts as new for VAT</strong> ({[nmt.ageNew && '6 months or less', nmt.kmNew && '6,000 km or less'].filter(Boolean).join(' · ')}) — Irish VAT at 23% is due regardless of NI history or seller.</>
                  : nmt.near
                    ? <><strong>Close to the “new vehicle” threshold.</strong> If under 6 months or 6,000 km, VAT (23%) is due regardless — check with Revenue.</>
                    : <>We couldn’t confirm the mileage here (free tier). If the car has 6,000 km or less it counts as new and VAT (23%) is due — the paid check reads the odometer.</>}
              </p>
            )}
            {isDual ? (
              est.supported ? (
                <>
                  <div className="row"><span className="k">If Revenue accepts your NI evidence</span><span className="v">from about {fmtEur(est.dual.ni.grandTotal)} — VRT only</span></div>
                  <div className="row"><span className="k">If not</span><span className="v warn">from about {fmtEur(est.dual.gb.grandTotal)} — VRT + VAT{est.dual.gb.customsDutyFlag?.indicativeWithVat != null ? `, + up to ${fmtEur(est.dual.gb.customsDutyFlag.indicativeWithVat)} duty` : ''}</span></div>
                  <p className="floor-note">We show <strong>both</strong> — neither is assumed. These are <strong>floors</strong> from the price you entered; Revenue values the car itself (usually higher), so the real figures are likely more. The full check adds the Irish valuation and the NI evidence timeline.</p>
                </>
              ) : (
                <p className="floor-note">{est.dual?.gb?.reason || 'We couldn’t compute an estimate from the free data — the exact check below will use a full Irish valuation.'}</p>
              )
            ) : single?.supported && single.vrt ? (
              <>
                <div className="row"><span className="k">VRT</span><span className="v">from about {fmtEur(single.vrt.total)}</span></div>
                {isGB && <div className="row"><span className="k">VAT (23%)</span><span className="v">{single.vat ? fmtEur(single.vat) : '—'}</span></div>}
                <div className="row"><span className="k">Customs</span><span className="v warn">{isGB ? 'origin-dependent' : 'not applicable'}</span></div>
                <p className="floor-note">This is a <strong>floor</strong> based on the price you entered. Revenue values the car for VRT using its own Irish market price — usually higher — so the real figure is likely more.</p>
              </>
            ) : (
              <p className="floor-note">{single?.reason || 'We couldn’t compute an estimate from the free data — the exact check below will use a full Irish valuation.'}</p>
            )}

            {result.fx && (
              <p className="floor-note" style={{ opacity: 0.7 }}>Converted at £1 = €{Number(result.fx.rate).toFixed(2)} ({fxDate(result.fx.date)}). You pay in £; Irish charges are in €.</p>
            )}

            {/* Registration clock (batch 53 gap 4) — content, not a computed late charge. */}
            <div style={{ marginTop: 12, padding: '11px 13px', borderRadius: 9, border: '1.5px solid rgba(240,90,26,0.35)', background: 'rgba(240,90,26,0.06)' }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>⏱ {REGISTRATION_CLOCK.heading}</div>
              {REGISTRATION_CLOCK.lines.map((l, i) => (
                <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5, opacity: 0.9 }}>• {l}</div>
              ))}
            </div>

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
            <p className="disclaimer">Moving your residence to Ireland, or a disabled driver/passenger? VRT reliefs may reduce or remove this — see <a href="https://www.revenue.ie/en/vrt/reliefs-and-exemptions/index.aspx" target="_blank" rel="noopener noreferrer">Revenue’s reliefs page</a>.</p>
            <p className="disclaimer">MotorQuoter accepts no liability for purchase or bidding decisions made in reliance on this estimate.</p>
            {sellerType !== 'gb' && <p className="disclaimer">VAT/customs-free only if the car was legally imported into NI — keep the NI V5C and NI service/MOT history for registration. We don’t decide whether you qualify; Revenue does.</p>}
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
