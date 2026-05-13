/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function PaymentSuccessContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState('verifying');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const vrm = searchParams.get('vrm');
  const tier = searchParams.get('tier');
  const mileage = searchParams.get('mileage');
  const market = searchParams.get('market');
  const sessionId = searchParams.get('session_id');

  const runLookup = useCallback(async () => {
    if (!vrm || !tier || !sessionId) {
      router.push('/');
      return;
    }

    try {
      setStatus('verifying');

      const verifyRes = await fetch(`/api/stripe/verify?session_id=${sessionId}`);
      const verifyData = await verifyRes.json();

      if (!verifyData.paid) {
        setError('Payment could not be verified. Please contact support.');
        setStatus('error');
        return;
      }

      setStatus('loading');

      const params = new URLSearchParams({ vrm, tier, session_id: sessionId });
      if (mileage) params.append('mileage', mileage);
      if (market) params.append('market', market);

      const res = await fetch(`/api/vehicle?${params}`);
      const data = await res.json();

      if (data.error) {
        setError(data.error);
        setStatus('error');
      } else {
        setResult(data);
        setStatus('done');
      }

    } catch (err) {
      setError('Something went wrong. Please contact support — you have not been charged twice.');
      setStatus('error');
    }
  }, [vrm, tier, sessionId, mileage, market, router]);

  useEffect(() => {
    runLookup();
  }, [runLookup]);

  const styles = `
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
    .logo { display: flex; align-items: center; gap: 10px; }
    .logo-icon { width: 36px; height: 36px; background: var(--orange); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-family: 'Barlow Condensed', sans-serif; font-weight: 900; font-size: 18px; color: white; }
    .logo-text { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 20px; letter-spacing: 0.05em; }
    .status-box { margin: 40px 20px; text-align: center; }
    .spinner { width: 40px; height: 40px; border: 3px solid var(--border-dim); border-top-color: var(--orange); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-text { color: var(--text-dim); font-size: 15px; margin-top: 12px; }
    .status-title { font-family: 'Barlow Condensed', sans-serif; font-size: 22px; font-weight: 800; color: var(--orange); margin-bottom: 8px; }
    .result { margin: 20px; background: var(--bg2); border: 1.5px solid var(--border); border-radius: 12px; overflow: hidden; }
    .result-header { background: var(--orange-dim); border-bottom: 1px solid var(--border); padding: 16px 20px; }
    .result-reg { font-family: 'Barlow Condensed', sans-serif; font-size: 22px; font-weight: 900; letter-spacing: 0.1em; color: var(--orange); }
    .result-vehicle { font-size: 15px; color: var(--text); font-weight: 600; margin-top: 4px; }
    .result-tier { font-size: 12px; color: var(--text-dim); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.1em; }
    .result-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; }
    .result-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-dim); }
    .result-row:last-child { border-bottom: none; }
    .result-key { font-size: 13px; color: var(--text-dim); font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; font-family: 'Barlow Condensed', sans-serif; }
    .result-val { font-size: 15px; color: var(--text); font-weight: 600; text-align: right; }
    .result-val.good { color: #4ade80; }
    .result-val.warn { color: var(--yellow); }
    .result-val.bad { color: #f87171; }
    .error-box { margin: 20px; background: rgba(248,113,113,0.1); border: 1.5px solid rgba(248,113,113,0.3); border-radius: 10px; padding: 16px 20px; color: #f87171; font-size: 14px; line-height: 1.5; }
    .back-btn { display: block; margin: 20px auto; padding: 14px 28px; background: var(--bg3); border: 1.5px solid var(--border-dim); border-radius: 10px; color: var(--text-dim); font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 700; letter-spacing: 0.08em; cursor: pointer; text-align: center; }
    .back-btn:hover { border-color: var(--orange); color: var(--orange); }
    .success-badge { display: inline-block; background: rgba(74,222,128,0.15); border: 1px solid rgba(74,222,128,0.3); border-radius: 6px; padding: 4px 12px; font-size: 12px; color: #4ade80; font-weight: 600; margin-bottom: 12px; }
  `;

  return (
    <>
      <style>{styles}</style>
      <div className="app">
        <header className="header">
          <div className="logo">
            <div className="logo-icon">M</div>
            <span className="logo-text">MOTORQUOTER</span>
          </div>
        </header>

        {(status === 'verifying' || status === 'loading') && (
          <div className="status-box">
            <div className="spinner" />
            <div className="status-title">
              {status === 'verifying' ? 'Confirming payment...' : `Looking up ${vrm}...`}
            </div>
            <p className="status-text">
              {status === 'verifying' ? 'Verifying your payment with Stripe' : 'Running your vehicle check now'}
            </p>
          </div>
        )}

        {status === 'error' && (
          <>
            <div className="error-box">⚠️ {error}</div>
            <button className="back-btn" onClick={() => router.push('/')}>← Back to search</button>
          </>
        )}

        {status === 'done' && result && (
          <>
            <div style={{textAlign:'center', padding: '20px 20px 0'}}>
              <span className="success-badge">✓ Payment confirmed</span>
            </div>
            <div className="result">
              <div className="result-header">
                <div className="result-reg">{vrm}</div>
                <div className="result-vehicle">{result.make} {result.yearOfManufacture}</div>
                <div className="result-tier">{tier} check</div>
              </div>
              <div className="result-body">
                {result.colour && <div className="result-row"><span className="result-key">Colour</span><span className="result-val">{result.colour}</span></div>}
                {result.engineSize && <div className="result-row"><span className="result-key">Engine</span><span className="result-val">{result.engineSize}</span></div>}
                {result.fuelType && <div className="result-row"><span className="result-key">Fuel</span><span className="result-val">{result.fuelType}</span></div>}
                {result.taxStatus && <div className="result-row"><span className="result-key">Tax</span><span className={`result-val ${result.taxStatus === 'Taxed' ? 'good' : 'bad'}`}>{result.taxStatus}</span></div>}
                {result.motStatus && <div className="result-row"><span className="result-key">MOT</span><span className={`result-val ${result.motStatus === 'Valid' ? 'good' : 'warn'}`}>{result.motStatus}</span></div>}
                {result.valuation && <>
                  <div className="result-row"><span className="result-key">Retail Value</span><span className="result-val good">£{result.valuation.retail_low_valuation?.toLocaleString('en-GB')} – £{result.valuation.retail_high_valuation?.toLocaleString('en-GB')}</span></div>
                  <div className="result-row"><span className="result-key">Trade Value</span><span className="result-val">£{result.valuation.trade_low_valuation?.toLocaleString('en-GB')} – £{result.valuation.trade_high_valuation?.toLocaleString('en-GB')}</span></div>
                </>}
                {result.autocheck?.finance_data_qty === 0 && <div className="result-row"><span className="result-key">Finance</span><span className="result-val good">✓ No finance recorded</span></div>}
                {result.autocheck?.finance_data_qty > 0 && <div className="result-row"><span className="result-key">Finance</span><span className="result-val bad">⚠️ Outstanding finance recorded</span></div>}
                {result.autocheck?.stolen_vehicle_data_qty === 0 && <div className="result-row"><span className="result-key">Stolen</span><span className="result-val good">✓ Not recorded stolen</span></div>}
                {result.autocheck?.stolen_vehicle_data_qty > 0 && <div className="result-row"><span className="result-key">Stolen</span><span className="result-val bad">⚠️ Recorded as stolen</span></div>}
                {result.autocheck?.condition_data_qty === 0 && <div className="result-row"><span className="result-key">Write-off</span><span className="result-val good">✓ No write-off recorded</span></div>}
                {result.autocheck?.condition_data_qty > 0 && <div className="result-row"><span className="result-key">Write-off</span><span className="result-val bad">⚠️ {result.autocheck.condition_data_items?.[0]?.recovered_category_desc || 'Category recorded'}</span></div>}
                {result.motExpiryDate && <div className="result-row"><span className="result-key">MOT Expiry</span><span className="result-val">{result.motExpiryDate}</span></div>}
                {result.motMileage && <div className="result-row"><span className="result-key">Mileage at Last MOT</span><span className="result-val">{Number(result.motMileage).toLocaleString('en-GB')} miles</span></div>}
              </div>
            </div>
            <button className="back-btn" onClick={() => router.push('/')}>← New search</button>
          </>
        )}
      </div>
    </>
  );
}

export default function PaymentSuccess() {
  return (
    <Suspense fallback={<div style={{background:'#1e1a17',minHeight:'100vh'}} />}>
      <PaymentSuccessContent />
    </Suspense>
  );
}