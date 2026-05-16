/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function fmtDate(str) {
  if (!str) return null;
  const [y, m, d] = str.split(' ')[0].split(/[-./]/);
  return d ? `${d}/${m}/${y}` : str;
}

function fmtCurrency(val, currency = 'GBP') {
  if (val == null) return null;
  const sym = currency === 'EUR' ? '€' : '£';
  return `${sym}${Number(val).toLocaleString('en-GB')}`;
}

// ── Shared UI primitives ──────────────────────────────────────────────────────

function SectionTitle({ children }) {
  return <div className="section-title">{children}</div>;
}

function DataRow({ label, value, tone }) {
  if (value == null || value === '') return null;
  return (
    <div className="result-row">
      <span className="result-key">{label}</span>
      <span className={`result-val${tone ? ` ${tone}` : ''}`}>{value}</span>
    </div>
  );
}

function FlagRow({ label, value, tone }) {
  return (
    <div className={`flag-row flag-${tone}`}>
      <span className="flag-label">{label}</span>
      <span className={`flag-val flag-val-${tone}`}>{value}</span>
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="history-empty">{text}</div>;
}

// ── Vehicle Identity ──────────────────────────────────────────────────────────

function IdentitySection({ result }) {
  const isIE = result.market === 'IE';
  return (
    <div className="card">
      <SectionTitle>Vehicle Identity</SectionTitle>
      <div className="info-grid">
        {result.make            && <div className="info-cell"><div className="info-key">Make</div><div className="info-val">{result.make}</div></div>}
        {result.yearOfManufacture && <div className="info-cell"><div className="info-key">Year</div><div className="info-val">{result.yearOfManufacture}</div></div>}
        {result.colour          && <div className="info-cell"><div className="info-key">Colour</div><div className="info-val">{result.colour}</div></div>}
        {result.engineSize      && <div className="info-cell"><div className="info-key">Engine</div><div className="info-val">{result.engineSize}</div></div>}
        {result.fuelType        && <div className="info-cell"><div className="info-key">Fuel</div><div className="info-val">{result.fuelType}</div></div>}
        {result.co2Emissions    && <div className="info-cell"><div className="info-key">CO₂</div><div className="info-val">{result.co2Emissions} g/km</div></div>}
        {result.monthOfFirstRegistration && <div className="info-cell"><div className="info-key">First Reg</div><div className="info-val">{result.monthOfFirstRegistration}</div></div>}
        {result.taxStatus       && <div className="info-cell"><div className="info-key">Tax</div><div className="info-val" style={{color: result.taxStatus === 'Taxed' ? '#4ade80' : '#f87171'}}>{result.taxStatus}</div></div>}
        {result.motStatus       && <div className="info-cell"><div className="info-key">{isIE ? 'NCT' : 'MOT'}</div><div className="info-val" style={{color: result.motStatus === 'Valid' ? '#4ade80' : '#f5c842'}}>{result.motStatus}</div></div>}
        {result.nctExpiryDate   && <div className="info-cell"><div className="info-key">NCT Expiry</div><div className="info-val">{fmtDate(result.nctExpiryDate) || result.nctExpiryDate}</div></div>}
        {result.dateOfLastV5CIssued && <div className="info-cell"><div className="info-key">Last V5C</div><div className="info-val">{fmtDate(result.dateOfLastV5CIssued)}</div></div>}
      </div>
    </div>
  );
}

// ── Valuation ─────────────────────────────────────────────────────────────────

function ValuationSection({ result }) {
  const val = result.valuation;
  if (!val) return (
    <div className="card">
      <SectionTitle>Valuation</SectionTitle>
      <EmptyState text="Valuation data not available for this vehicle" />
    </div>
  );
  return (
    <div className="card">
      <SectionTitle>Valuation</SectionTitle>
      <div className="bid-grid">
        {val.retail_low_valuation != null && (
          <div className="bid-card">
            <div className="bid-label">Retail Value</div>
            <div className="bid-value bid-green">{fmtCurrency(val.retail_low_valuation)} – {fmtCurrency(val.retail_high_valuation)}</div>
          </div>
        )}
        {val.trade_low_valuation != null && (
          <div className="bid-card">
            <div className="bid-label">Trade Value</div>
            <div className="bid-value">{fmtCurrency(val.trade_low_valuation)} – {fmtCurrency(val.trade_high_valuation)}</div>
          </div>
        )}
        {val.private_low_valuation != null && (
          <div className="bid-card">
            <div className="bid-label">Private Sale</div>
            <div className="bid-value">{fmtCurrency(val.private_low_valuation)} – {fmtCurrency(val.private_high_valuation)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Write-off ─────────────────────────────────────────────────────────────────

function WriteoffSection({ result }) {
  const isIE = result.market === 'IE';
  const ac = isIE ? result.hpi : result.autocheck;

  const hasWriteOff = ac?.condition_data_qty > 0;
  const writeOffItem = ac?.condition_data_items?.[0];
  const wSrc = writeOffItem?.recovered_category_desc || writeOffItem?.vehicle_status || '';
  const wMatch = wSrc.match(/\bCAT\s*([A-Z])\b/i);
  const wLabel = hasWriteOff ? (wMatch ? `Cat ${wMatch[1]}` : (wSrc || 'Write-off recorded')) : null;

  return (
    <div className="card">
      <SectionTitle>Write-off / Cat S·N Check</SectionTitle>
      {ac == null
        ? <EmptyState text="Write-off data not available for this vehicle" />
        : <div className="flag-list">
            <FlagRow
              label="Write-off Status"
              value={hasWriteOff ? `⚠️ ${wLabel}` : '✓ No write-off recorded'}
              tone={hasWriteOff ? 'red' : 'green'}
            />
            {writeOffItem?.total_loss_date && <DataRow label="Total Loss Date" value={fmtDate(writeOffItem.total_loss_date)} />}
            {writeOffItem?.mileage_at_loss != null && <DataRow label="Mileage at Loss" value={`${Number(writeOffItem.mileage_at_loss).toLocaleString('en-GB')} miles`} />}
          </div>
      }
    </div>
  );
}

// ── Finance ───────────────────────────────────────────────────────────────────

function FinanceSection({ result }) {
  const isIE = result.market === 'IE';
  const ac = isIE ? result.hpi : result.autocheck;
  const hasFinance = ac?.finance_data_qty > 0;
  const financeItems = ac?.finance_data_items || [];

  return (
    <div className="card">
      <SectionTitle>Finance Check</SectionTitle>
      {ac == null
        ? <EmptyState text="Finance data not available for this vehicle" />
        : <div className="flag-list">
            <FlagRow
              label="Outstanding Finance"
              value={hasFinance ? '⚠️ Finance outstanding' : '✓ No finance recorded'}
              tone={hasFinance ? 'red' : 'green'}
            />
            {financeItems.map((f, i) => (
              <div key={i} style={{marginTop: 8, padding: '10px 14px', background: 'var(--bg3)', borderRadius: 8, fontSize: 13}}>
                {f.finance_company && <div style={{fontWeight: 600, marginBottom: 4}}>{f.finance_company}</div>}
                {f.agreement_type && <div style={{color: 'var(--text-dim)'}}>{f.agreement_type}</div>}
                {f.start_date && <div style={{color: 'var(--text-dim)'}}>From: {fmtDate(f.start_date)}</div>}
              </div>
            ))}
          </div>
      }
    </div>
  );
}

// ── Stolen ────────────────────────────────────────────────────────────────────

function StolenSection({ result }) {
  const isIE = result.market === 'IE';
  const ac = isIE ? result.hpi : result.autocheck;
  const hasStolen = ac?.stolen_vehicle_data_qty > 0;

  return (
    <div className="card">
      <SectionTitle>Stolen Check</SectionTitle>
      {ac == null
        ? <EmptyState text="Stolen data not available for this vehicle" />
        : <div className="flag-list">
            <FlagRow
              label={isIE ? 'Stolen Register Check' : 'Police Stolen Database'}
              value={hasStolen ? '⚠️ Recorded as stolen' : '✓ Not recorded stolen'}
              tone={hasStolen ? 'red' : 'green'}
            />
            {isIE && (
              <div style={{fontSize:12,color:'var(--text-dim)',lineHeight:1.55,padding:'8px 12px',background:'rgba(255,255,255,0.04)',borderRadius:6,marginTop:2}}>
                Irish stolen data is based on a private register. An Garda Síochána do not share stolen vehicle data with third parties.
              </div>
            )}
          </div>
      }
    </div>
  );
}

// ── Experian Attribution ──────────────────────────────────────────────────────

function ExperianAttribution({ result, checks }) {
  const shown = ['writeoff', 'finance', 'stolen'].some(c => checks.includes(c));
  if (!shown || !result.autocheck) return null;
  return (
    <div style={{ textAlign: 'right', padding: '2px 20px 10px', fontSize: 11, color: 'var(--text-dim)', letterSpacing: '0.02em' }}>
      Data provided by{' '}
      <span style={{ fontWeight: 700, color: '#a01346', letterSpacing: 0 }}>Experian</span>
    </div>
  );
}

// ── Market Demand ─────────────────────────────────────────────────────────────

function MarketDemandSection({ result }) {
  const cazDem = result.cazanaDemand;
  const daysToSell = cazDem?.average_days_to_sell ?? cazDem?.days_to_sell ?? null;
  const demandScore = cazDem?.market_demand_score ?? null;
  const similarCount = cazDem?.similar_adverts_count ?? cazDem?.total_similar ?? null;

  return (
    <div className="card">
      <SectionTitle>Market Demand</SectionTitle>
      {!cazDem
        ? <EmptyState text="Market demand data not available for this vehicle" />
        : <div className="info-grid">
            {demandScore != null && <div className="info-cell"><div className="info-key">Demand Score</div><div className="info-val">{demandScore} / 100</div></div>}
            {daysToSell != null && <div className="info-cell"><div className="info-key">Avg Days to Sell</div><div className="info-val">{daysToSell}</div></div>}
            {similarCount != null && <div className="info-cell"><div className="info-key">Similar Listed</div><div className="info-val">{similarCount}</div></div>}
          </div>
      }
    </div>
  );
}

// ── Previous Adverts ──────────────────────────────────────────────────────────

function PreviousAdvertsSection({ result }) {
  const cazAdv = result.cazanaAdverts;
  const adverts = cazAdv?.result || [];

  return (
    <div className="card">
      <SectionTitle>Previous Adverts</SectionTitle>
      {adverts.length === 0
        ? <EmptyState text="No previous adverts found for this vehicle" />
        : <div className="history-list">
            {adverts.slice(0, 8).map((ad, i) => (
              <div className="history-record" key={i}>
                <div className="history-row">
                  <span className="history-date">{fmtDate(ad.last_seen_date) || ad.last_seen_date || '—'}</span>
                  {ad.advertised_price_gbp != null && <span style={{fontWeight: 700, color: 'var(--text)'}}>{fmtCurrency(ad.advertised_price_gbp)}</span>}
                </div>
                {ad.mileage_observed != null && <div className="history-detail">{Number(ad.mileage_observed).toLocaleString('en-GB')} mi</div>}
                {(ad.seller_name || ad.dealer_type) && <div className="history-detail" style={{color: 'var(--text-dim)'}}>{ad.seller_name || ad.dealer_type}</div>}
              </div>
            ))}
          </div>
      }
    </div>
  );
}

// ── MOT / NCT History ─────────────────────────────────────────────────────────

function MotSection({ result }) {
  const isIE = result.market === 'IE';

  if (isIE) {
    const nct = result.nctHistory;
    const tests = nct?.tests ?? nct?.nct_tests ?? nct ?? [];
    const testArray = Array.isArray(tests) ? tests : [];
    return (
      <div className="card">
        <SectionTitle>NCT History</SectionTitle>
        {testArray.length === 0
          ? <EmptyState text="No NCT history on record" />
          : <div className="history-list">
              {testArray.map((test, i) => (
                <div className="history-record" key={i}>
                  <div className="history-row">
                    <span className="history-date">{fmtDate(test.test_date || test.date) || '—'}</span>
                    <span className={test.result === 'PASS' || test.test_result === 'PASS' ? 'badge-pass' : 'badge-fail'}>
                      {test.result || test.test_result || '—'}
                    </span>
                  </div>
                  {(test.mileage || test.odometer) && (
                    <div className="history-mileage">
                      {Number(test.mileage || test.odometer).toLocaleString('en-GB')} km
                      {test.expiry_date && <span style={{marginLeft: 8, color: 'var(--text-dim)'}}>Expires {test.expiry_date}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
        }
      </div>
    );
  }

  const motHistory = result.motHistory || [];
  return (
    <div className="card">
      <SectionTitle>MOT History</SectionTitle>
      {motHistory.length === 0
        ? <EmptyState text="No MOT history on record" />
        : <div className="history-list">
            {motHistory.map((test, i) => {
              const advisories = test.rfrAndComments?.filter(r => r.type === 'ADVISORY') || [];
              const failures   = test.rfrAndComments?.filter(r => r.type === 'FAIL') || [];
              return (
                <div className="history-record" key={i}>
                  <div className="history-row">
                    <span className="history-date">{test.completedDate}</span>
                    <span className={test.testResult === 'PASSED' ? 'badge-pass' : 'badge-fail'}>{test.testResult}</span>
                  </div>
                  {test.odometerValue && (
                    <div className="history-mileage">
                      {Number(test.odometerValue).toLocaleString('en-GB')} {test.odometerUnit || 'mi'}
                      {test.expiryDate && <span style={{marginLeft: 8, color: 'var(--text-dim)'}}>Expires {test.expiryDate}</span>}
                    </div>
                  )}
                  {failures.map((f, j)   => <div className="mot-failure"  key={j}>✗ {f.text}</div>)}
                  {advisories.map((a, j) => <div className="mot-advisory" key={j}>⚠ {a.text}</div>)}
                </div>
              );
            })}
          </div>
      }
    </div>
  );
}

// ── Service History ───────────────────────────────────────────────────────────

function ServiceHistorySection({ result }) {
  const svcHistory  = result.serviceHistory;
  const svcCoverage = result.serviceHistoryCoverage;
  const coverageLabel = { full: 'Full Coverage', limited: 'Limited Coverage', workshop: 'Workshop Remarks Only' }[svcCoverage] || null;

  return (
    <div className="card">
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',paddingTop:18,paddingBottom:10,borderBottom:'1px solid var(--border-dim)',marginBottom:12}}>
        <span className="section-title" style={{paddingTop:0,paddingBottom:0,borderBottom:'none',marginBottom:0}}>Service History</span>
        {coverageLabel && (
          <span style={{fontSize:11,fontWeight:700,letterSpacing:'0.08em',textTransform:'uppercase',
            color: svcCoverage === 'full' ? '#4ade80' : svcCoverage === 'limited' ? 'var(--yellow)' : 'var(--text-dim)',
            fontFamily:"'Barlow Condensed',sans-serif"}}>
            {coverageLabel}
          </span>
        )}
      </div>
      {svcHistory === null && svcCoverage
        ? <EmptyState text="Service history unavailable — please try again" />
        : svcHistory?.service_records?.length > 0
          ? <div className="history-list">
              {svcHistory.service_records.map((rec, i) => (
                <div className="history-record" key={i}>
                  <div className="history-row">
                    <span className="history-date">{fmtDate(rec.date) || rec.date}</span>
                    {rec.mileage != null && <span className="history-mileage">{Number(rec.mileage).toLocaleString('en-GB')} mi</span>}
                  </div>
                  {rec.service_type && <div className="history-detail">{rec.service_type}</div>}
                  {rec.dealer       && <div className="history-detail" style={{color:'var(--text-dim)'}}>{rec.dealer}</div>}
                </div>
              ))}
            </div>
          : <EmptyState text="No digital service history on record" />
      }
    </div>
  );
}

// ── Page component ────────────────────────────────────────────────────────────

function PaymentSuccessContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus]     = useState('verifying');
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);

  const vrm       = searchParams.get('vrm');
  const market    = searchParams.get('market') || 'GB';
  const mileage   = searchParams.get('mileage');
  const sessionId = searchParams.get('session_id');

  const runLookup = useCallback(async () => {
    if (!vrm || !sessionId) { router.push('/'); return; }
    try {
      setStatus('verifying');
      const verifyRes  = await fetch(`/api/stripe/verify?session_id=${sessionId}`);
      const verifyData = await verifyRes.json();
      if (!verifyData.paid) {
        setError('Payment could not be verified. Please contact support.');
        setStatus('error');
        return;
      }

      setStatus('loading');
      const params = new URLSearchParams({
        vrm,
        checks: verifyData.checks || searchParams.get('checks') || '',
        verified: 'true',
        market: verifyData.market || market,
      });
      if (mileage) params.append('mileage', mileage);

      const res  = await fetch(`/api/vehicle?${params}`);
      const data = await res.json();
      if (data.error) { setError(data.error); setStatus('error'); return; }
      setResult(data);
      setStatus('done');
    } catch {
      setError('Something went wrong. Please contact support — you have not been charged twice.');
      setStatus('error');
    }
  }, [vrm, sessionId, mileage, market, router]);

  useEffect(() => { runLookup(); }, [runLookup]);

  async function generatePdf() {
    if (!result) return;
    setPdfLoading(true);
    try {
      const now = new Date();
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const datePart = `${now.getDate()}${months[now.getMonth()]}${now.getFullYear()}`;
      const filename = `${vrm}_${datePart}.pdf`;

      const response = await fetch('/api/generate-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result, vrm, checks: result.checks }),
      });
      if (!response.ok) throw new Error('PDF generation failed');

      const arrayBuffer = await response.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('PDF download failed:', err);
    } finally {
      setPdfLoading(false);
    }
  }

  const checks = result?.checks || [];

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
    .header { display: flex; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border-dim); }
    .logo { display: flex; align-items: center; gap: 10px; }
    .logo-icon { width: 36px; height: 36px; background: var(--orange); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-family: 'Barlow Condensed', sans-serif; font-weight: 900; font-size: 18px; color: white; }
    .logo-text { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 20px; letter-spacing: 0.05em; }
    .status-box { margin: 40px 20px; text-align: center; }
    .spinner { width: 40px; height: 40px; border: 3px solid var(--border-dim); border-top-color: var(--orange); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-text  { color: var(--text-dim); font-size: 15px; margin-top: 12px; }
    .status-title { font-family: 'Barlow Condensed', sans-serif; font-size: 22px; font-weight: 800; color: var(--orange); margin-bottom: 8px; }
    .error-box { margin: 20px; background: rgba(248,113,113,0.1); border: 1.5px solid rgba(248,113,113,0.3); border-radius: 10px; padding: 16px 20px; color: #f87171; font-size: 14px; line-height: 1.5; }
    .pdf-btn  { display: block; margin: 20px auto 6px; padding: 14px 28px; background: var(--orange); border: none; border-radius: 10px; color: white; font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 700; letter-spacing: 0.08em; cursor: pointer; text-align: center; width: calc(100% - 40px); }
    .pdf-btn:hover { background: var(--orange-light); }
    .pdf-btn:disabled { opacity: 0.6; cursor: wait; }
    .back-btn { display: block; margin: 0 auto 20px; padding: 14px 28px; background: var(--bg3); border: 1.5px solid var(--border-dim); border-radius: 10px; color: var(--text-dim); font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 700; letter-spacing: 0.08em; cursor: pointer; text-align: center; width: calc(100% - 40px); }
    .back-btn:hover { border-color: var(--orange); color: var(--orange); }
    .success-badge { display: inline-block; background: rgba(74,222,128,0.15); border: 1px solid rgba(74,222,128,0.3); border-radius: 6px; padding: 4px 12px; font-size: 12px; color: #4ade80; font-weight: 600; margin-bottom: 12px; }
    .report-header { margin: 0 20px 4px; background: var(--orange-dim); border: 1.5px solid var(--border); border-radius: 12px; padding: 16px 20px; }
    .report-reg { font-family: 'Barlow Condensed', sans-serif; font-size: 24px; font-weight: 900; letter-spacing: 0.1em; color: var(--orange); }
    .report-vehicle { font-size: 16px; color: var(--text); font-weight: 600; margin-top: 4px; }
    .card { margin: 0 20px 6px; background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 12px; padding: 0 16px 12px; }
    .section-title { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.18em; color: var(--orange); text-transform: uppercase; padding: 18px 0 10px; border-bottom: 1px solid var(--border-dim); margin-bottom: 12px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; }
    .info-cell { padding: 10px 12px 10px 0; border-bottom: 1px solid var(--border-dim); }
    .info-cell:nth-last-child(-n+2) { border-bottom: none; }
    .info-key { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 2px; }
    .info-val { font-size: 15px; font-weight: 600; color: var(--text); }
    .bid-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .bid-card { background: var(--bg3); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 14px 16px; }
    .bid-label { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 6px; }
    .bid-value { font-family: 'Barlow Condensed', sans-serif; font-size: 20px; font-weight: 900; color: var(--text); line-height: 1.2; }
    .bid-value.bid-green { color: #4ade80; }
    .result-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-dim); }
    .result-row:last-child { border-bottom: none; }
    .result-key { font-size: 13px; color: var(--text-dim); font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; font-family: 'Barlow Condensed', sans-serif; }
    .result-val { font-size: 15px; color: var(--text); font-weight: 600; text-align: right; }
    .result-val.good { color: #4ade80; }
    .result-val.warn { color: var(--yellow); }
    .result-val.bad  { color: #f87171; }
    .flag-list { display: flex; flex-direction: column; gap: 8px; }
    .flag-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 8px; }
    .flag-row.flag-green { border: 1.5px solid rgba(74,222,128,0.25); background: rgba(74,222,128,0.07); }
    .flag-row.flag-red   { border: 1.5px solid rgba(248,113,113,0.35); background: rgba(248,113,113,0.09); }
    .flag-row.flag-amber { border: 1.5px solid rgba(245,200,66,0.35); background: rgba(245,200,66,0.09); }
    .flag-label { font-size: 13px; font-weight: 600; color: var(--text); }
    .flag-val { font-size: 13px; font-weight: 700; }
    .flag-val-green { color: #4ade80; }
    .flag-val-red   { color: #f87171; }
    .flag-val-amber { color: var(--yellow); }
    .history-list { display: flex; flex-direction: column; }
    .history-record { padding: 12px 0; border-bottom: 1px solid var(--border-dim); }
    .history-record:last-child { border-bottom: none; }
    .history-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .history-date { font-size: 14px; font-weight: 600; color: var(--text); }
    .history-mileage { font-size: 12px; color: var(--text-dim); margin-bottom: 4px; }
    .history-detail  { font-size: 13px; color: var(--text); margin-top: 2px; }
    .history-empty   { font-size: 14px; color: var(--text-dim); padding: 12px 0; }
    .badge-pass { font-size: 12px; font-weight: 700; color: #4ade80; background: rgba(74,222,128,0.12); border: 1px solid rgba(74,222,128,0.25); border-radius: 4px; padding: 2px 8px; }
    .badge-fail { font-size: 12px; font-weight: 700; color: #f87171; background: rgba(248,113,113,0.12); border: 1px solid rgba(248,113,113,0.25); border-radius: 4px; padding: 2px 8px; }
    .mot-advisory { font-size: 12px; color: var(--yellow); padding: 2px 0; }
    .mot-failure  { font-size: 12px; color: #f87171; padding: 2px 0; }
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
              {status === 'verifying' ? 'Verifying your payment with Stripe' : 'Running your vehicle checks now'}
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
            <div style={{textAlign:'center', padding: '20px 20px 8px'}}>
              <span className="success-badge">✓ Payment confirmed</span>
            </div>

            <div className="report-header">
              <div className="report-reg">{vrm}</div>
              <div className="report-vehicle">{result.make} {result.yearOfManufacture}</div>
            </div>

            <IdentitySection result={result} />
            {checks.includes('valuation')        && <ValuationSection       result={result} />}
            {checks.includes('writeoff')          && <WriteoffSection        result={result} />}
            {checks.includes('finance')           && <FinanceSection         result={result} />}
            {checks.includes('stolen')            && <StolenSection          result={result} />}
            <ExperianAttribution result={result} checks={checks} />
            {checks.includes('market_demand')     && <MarketDemandSection    result={result} />}
            {checks.includes('previous_adverts')  && <PreviousAdvertsSection result={result} />}
            {checks.includes('mot')               && <MotSection             result={result} />}
            {checks.includes('service_history')   && <ServiceHistorySection  result={result} />}

            <button className="pdf-btn" onClick={generatePdf} disabled={pdfLoading}>
              {pdfLoading ? 'Generating PDF...' : '↓ Save as PDF'}
            </button>
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
