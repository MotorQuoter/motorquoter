/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function fmtFirstReg(str) {
  if (!str) return null;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const ym = str.match(/^(\d{4})-(\d{2})$/);
  if (ym) { const m = MONTHS[parseInt(ym[2], 10) - 1]; return m ? `${m} ${ym[1]}` : str; }
  return fmtDate(str) || str;
}

function fmtDate(str) {
  if (!str) return null;
  const s = str.split(' ')[0];
  const parts = s.split(/[-./]/);
  if (parts.length !== 3) return str;
  const [a, b, c] = parts;
  if (a.length === 4) return `${c}/${b}/${a}`;  // YYYY-MM-DD → DD/MM/YYYY
  if (c.length === 4) return `${b}/${a}/${c}`;  // MM/DD/YYYY → DD/MM/YYYY
  return str;
}

function fmtMotDate(str) {
  if (!str) return null;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const parts = str.split('/');
  if (parts.length === 3) {
    const m = MONTHS[parseInt(parts[1], 10) - 1];
    return m ? `${m} ${parts[2]}` : null;
  }
  return null;
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
        {result.model           && <div className="info-cell"><div className="info-key">Model</div><div className="info-val">{result.model}</div></div>}
        {result.yearOfManufacture && <div className="info-cell"><div className="info-key">Year</div><div className="info-val">{result.yearOfManufacture}</div></div>}
        {result.colour          && <div className="info-cell"><div className="info-key">Colour</div><div className="info-val">{result.colour}</div></div>}
        {result.engineSize      && <div className="info-cell"><div className="info-key">Engine</div><div className="info-val">{result.engineSize}</div></div>}
        {result.fuelType        && <div className="info-cell"><div className="info-key">Fuel</div><div className="info-val">{result.fuelType}</div></div>}
        {result.co2Emissions    && <div className="info-cell"><div className="info-key">CO₂</div><div className="info-val">{result.co2Emissions} g/km</div></div>}
        {result.monthOfFirstRegistration && <div className="info-cell"><div className="info-key">First Reg</div><div className="info-val">{fmtFirstReg(result.monthOfFirstRegistration)}</div></div>}
        {result.taxStatus       && <div className="info-cell"><div className="info-key">Tax</div><div className="info-val" style={{color: result.taxStatus === 'Taxed' ? '#4ade80' : '#f87171'}}>{result.taxStatus}</div></div>}
        {result.motStatus       && <div className="info-cell"><div className="info-key">{isIE ? 'NCT' : 'MOT'}</div><div className="info-val" style={{color: result.motStatus === 'Valid' ? '#4ade80' : '#f5c842'}}>{result.motStatus}</div></div>}
        {result.nctExpiryDate   && <div className="info-cell"><div className="info-key">NCT Expiry</div><div className="info-val">{fmtDate(result.nctExpiryDate) || result.nctExpiryDate}</div></div>}
        {result.dateOfLastV5CIssued && <div className="info-cell"><div className="info-key">Last V5C</div><div className="info-val">{fmtDate(result.dateOfLastV5CIssued)}</div></div>}
        {!isIE && result.valuationMileage != null && (() => {
          const src = result.valuationMileageSource;
          const fmtMi = Number(result.valuationMileage).toLocaleString('en-GB');
          const dvsaFmtMi = result.dvsaLastMileage != null
            ? Number(result.dvsaLastMileage).toLocaleString('en-GB')
            : null;
          const motDateVal  = fmtMotDate(result.valuationMileageDate);
          const motDateLast = fmtMotDate(result.dvsaLastMileageDate);
          const showDiscrepancy = src === 'user_entered'
            && result.dvsaLastMileage != null
            && (result.dvsaLastMileage - result.valuationMileage) > 500;
          const display = src === 'default_fallback' ? `${fmtMi} assumed` : fmtMi;
          const sub = src === 'user_entered'
            ? '(as you entered)'
            : src === 'dvsa_mot'
            ? (motDateVal
                ? `No mileage entered — we've used the most recent MOT reading (${motDateVal}). Enter exact mileage for a sharper valuation.`
                : `No mileage entered — we've used the most recent MOT reading. Enter exact mileage for a sharper valuation.`)
            : src === 'default_fallback'
            ? `No MOT mileage on record. Enter mileage for an accurate valuation.`
            : null;
          return (
            <div className="info-cell" style={showDiscrepancy ? { gridColumn: '1 / -1' } : undefined}>
              <div className="info-key">Mileage</div>
              <div className="info-val">
                {display}
                {sub && <span style={{display:'block', fontSize:11, color:'var(--text-dim)', fontWeight:400, marginTop:2, lineHeight:1.5}}>{sub}</span>}
              </div>
              {showDiscrepancy && (
                <div style={{marginTop:8, padding:'10px 12px', background:'rgba(245,200,66,0.08)', border:'1.5px solid rgba(245,200,66,0.3)', borderRadius:8, fontSize:12, color:'var(--yellow)', lineHeight:1.6}}>
                  ⚠️ Please double-check your mileage. You entered {fmtMi}, but the last recorded MOT{motDateLast ? ` (${motDateLast})` : ''} shows {dvsaFmtMi} miles. Vehicle mileage normally only increases, so this is worth verifying — it may be a typo, or worth checking against the V5 and service history before relying on this valuation.
                </div>
              )}
            </div>
          );
        })()}
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
      {!isIE && ac != null && <ExperianAttribution />}
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
      {!isIE && ac != null && <ExperianAttribution />}
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
      {!isIE && ac != null && <ExperianAttribution />}
    </div>
  );
}

// ── Salvage History ───────────────────────────────────────────────────────────

function SalvageHistorySection({ result }) {
  const sh = result.salvageHistory;
  const records = sh?.salvage_auction_records || [];
  const found = sh?.salvage_auction_record_found === true && records.length > 0;

  return (
    <div className="card">
      <SectionTitle>Salvage History Check</SectionTitle>
      {sh == null
        ? <EmptyState text="Salvage history data not available for this vehicle" />
        : !found
          ? <div className="flag-list">
              <FlagRow label="Salvage Auction History" value="✓ No previous salvage auction records found" tone="green" />
            </div>
          : <>
              <div className="flag-list" style={{marginBottom: 12}}>
                <FlagRow
                  label="Salvage Auction History"
                  value={`⚠️ This vehicle has been through salvage auction ${records.length} time${records.length !== 1 ? 's' : ''}`}
                  tone="red"
                />
              </div>
              <div className="history-list">
                {records.map((rec, i) => (
                  <div className="history-record" key={i}>
                    <div className="history-row">
                      <span className="history-date">{fmtDate(rec.salvage_auction_lot_date) || rec.salvage_auction_lot_date || '—'}</span>
                      {rec.salvage_auction_lot_desc && <span className="badge-fail">{rec.salvage_auction_lot_desc}</span>}
                    </div>
                    {rec.mileage != null && <div className="history-mileage">{Number(rec.mileage).toLocaleString('en-GB')} miles at sale</div>}
                    {rec.primary_damage_desc   && <div className="history-detail">Primary: {rec.primary_damage_desc}</div>}
                    {rec.secondary_damage_desc && <div className="history-detail">Secondary: {rec.secondary_damage_desc}</div>}
                    {rec.salvage_auction_location && <div className="history-detail" style={{color:'var(--text-dim)'}}>{rec.salvage_auction_location}</div>}
                    {rec.external_image_urls?.length > 0 && (
                      <div style={{display:'flex', gap:6, marginTop:8, flexWrap:'wrap'}}>
                        {rec.external_image_urls.slice(0, 4).map((url, j) => (
                          <img
                            key={j}
                            src={url}
                            alt={`Salvage record photo`}
                            style={{width:80, height:60, objectFit:'cover', borderRadius:6, border:'1px solid var(--border-dim)'}}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
      }
    </div>
  );
}

// ── Outstanding Recall Warning ────────────────────────────────────────────────

function RecallWarning({ result }) {
  if (!result.hasOutstandingRecall) return null;
  return (
    <div style={{ margin: '0 20px 6px', background: 'rgba(248,113,113,0.09)', border: '1.5px solid rgba(248,113,113,0.35)', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <span style={{ fontSize: 20, flexShrink: 0 }}>⚠️</span>
      <div>
        <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 15, color: '#f87171', letterSpacing: '0.04em', marginBottom: 4 }}>
          OUTSTANDING SAFETY RECALL
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          An outstanding safety recall has been recorded for this vehicle. Contact the manufacturer or a franchise dealer before purchase to confirm the recall status and arrange rectification.
        </div>
      </div>
    </div>
  );
}

// ── Experian Attribution ──────────────────────────────────────────────────────

function ExperianAttribution() {
  return (
    <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-dim)', paddingTop: 6, letterSpacing: '0.02em' }}>
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
  const adverts = Array.isArray(cazAdv?.result) ? cazAdv.result : [];

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
              const advisories = test.defects?.filter(r => r.type === 'ADVISORY') || [];
              const failures   = test.defects?.filter(r => ['MAJOR', 'MINOR', 'DANGEROUS'].includes(r.type)) || [];
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

// ── Owner / Keeper History ─────────────────────────────────────────────────────

function OwnerHistorySection({ result }) {
  const oh = result.ownerHistory;
  return (
    <div className="card">
      <SectionTitle>Owner / Keeper History</SectionTitle>
      {!oh || oh.status !== 'ok'
        ? <EmptyState text="No keeper-change history on record" />
        : <>
            <div className="info-grid">
              <div className="info-cell"><div className="info-key">Total Keepers</div><div className="info-val">{oh.totalKeepers ?? '—'}</div></div>
              <div className="info-cell"><div className="info-key">Recorded Changes</div><div className="info-val">{oh.keeperChanges}</div></div>
              {oh.latestChangeDate && <div className="info-cell"><div className="info-key">Last Change</div><div className="info-val">{oh.latestChangeDate}</div></div>}
            </div>
            {Array.isArray(oh.changes) && oh.changes.length > 0 && (
              <div className="history-list" style={{ marginTop: 12 }}>
                {oh.changes.map((c, i) => (
                  <div className="history-record" key={i}>
                    <div className="history-row">
                      <span className="history-date">{c.date || '—'}</span>
                      {c.previousKeepers != null && <span className="history-mileage">after {c.previousKeepers} previous keeper{c.previousKeepers === 1 ? '' : 's'}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
      }
      {/* Previous registration plates — shown when the provider returns plate-change data. */}
      {oh?.plateChanges?.status === 'ok' && oh.plateChanges.plates.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: "'Barlow Condensed', sans-serif", marginBottom: 8 }}>
            Previous Registration Plates
          </div>
          <div className="history-list">
            {oh.plateChanges.plates.map((p, i) => (
              <div className="history-record" key={i}>
                <div className="history-row">
                  <span className="history-mileage" style={{ fontWeight: 700, letterSpacing: '0.05em' }}>{p.plate}</span>
                  {p.date && <span className="history-date">{p.date}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Service History ───────────────────────────────────────────────────────────

function ServiceHistorySection({ result }) {
  const svcHistory  = result.serviceHistory;
  const svcCoverage = result.serviceHistoryCoverage;
  const refunded     = result.serviceHistoryRefunded;
  const refundFailed = result.serviceHistoryRefundFailed;
  // Charged-currency refund label from the server (charge-derived). Fall back to the config
  // GBP figure by market only if the server didn't attach the amount (legacy/pre-fix rows).
  const refundLabel = (() => {
    const r = result.serviceHistoryRefund;
    if (r && typeof r.amount === 'number') return `${r.currency === 'eur' ? '€' : '£'}${(r.amount / 100).toFixed(2)}`;
    return result.market === 'IE' ? '£5.00' : '£3.49';
  })();
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
      {svcHistory?.service_records?.length > 0
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
        : refunded
          ? <EmptyState text={`No service history records found — ${refundLabel} refunded to your card automatically`} />
          : refundFailed
            ? <EmptyState text="No service history records found. Your refund could not be processed automatically — please contact support and it will be refunded manually." />
            : <EmptyState text="No service history records found" />
      }
    </div>
  );
}

// ── ROI Valuation ─────────────────────────────────────────────────────────────

function RoiValuationSection({ result }) {
  const val = result.roiValuation;
  if (!val) return null;
  const retail = val.retail ?? null;
  const trade  = val.trade  ?? null;
  if (retail == null && trade == null) return null;
  const fmtEur = v => `€${Number(v).toLocaleString('en-IE')}`;
  return (
    <div className="card">
      <SectionTitle>Market Valuation</SectionTitle>
      <div className="bid-grid">
        {retail != null && <div className="bid-card"><div className="bid-label">Current Retail</div><div className="bid-value bid-green">{fmtEur(retail)}</div></div>}
        {trade  != null && <div className="bid-card"><div className="bid-label">Trade Value</div><div className="bid-value">{fmtEur(trade)}</div></div>}
      </div>
    </div>
  );
}

// ── Brego ROI Valuation ───────────────────────────────────────────────────────

function BregoRoiValuationSection({ result }) {
  const v = result.bregoRoi;
  if (!v) return null;
  const { retailLow, retailAvg, retailHigh, tradeLow, tradeAvg, tradeHigh } = v;
  if (retailHigh == null && tradeLow == null) return null;
  const fmtEur = n => n != null ? `€${Number(n).toLocaleString('en-IE')}` : '—';
  const rows = [
    { label: 'High',    retail: retailHigh, trade: tradeHigh },
    { label: 'Average', retail: retailAvg,  trade: tradeAvg  },
    { label: 'Low',     retail: retailLow,  trade: tradeLow  },
  ];
  const headSt = { fontSize: 10, color: 'var(--text-dim)', fontFamily: "'Barlow Condensed', sans-serif", textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, padding: '0 0 6px', textAlign: 'right' };
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '18px 0 10px', borderBottom: '1px solid var(--border-dim)', marginBottom: 4 }}>
        <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: '0.18em', color: 'var(--orange)', textTransform: 'uppercase' }}>Valuation</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
        <thead>
          <tr>
            <th style={{ ...headSt, textAlign: 'left' }}>Condition</th>
            <th style={headSt}>Retail</th>
            <th style={headSt}>Trade</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, retail, trade }) => (
            <tr key={label} style={{ borderTop: '1px solid var(--border-dim)' }}>
              <td style={{ fontSize: 13, color: 'var(--text-dim)', fontFamily: "'Barlow Condensed', sans-serif", textTransform: 'uppercase', letterSpacing: '0.06em', padding: '10px 0' }}>{label}</td>
              <td style={{ fontSize: 15, fontWeight: 700, color: '#4ade80', textAlign: 'right', padding: '10px 0' }}>{fmtEur(retail)}</td>
              <td style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', textAlign: 'right', padding: '10px 0' }}>{fmtEur(trade)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── ROI Market Demand ─────────────────────────────────────────────────────────

function RoiMarketDemandSection({ result }) {
  const d = result.roiMarketDemand;
  if (!d) return null;
  const score   = d.market_demand_score ?? d.demand_score ?? null;
  const days    = d.average_days_to_sell ?? d.days_to_sell ?? null;
  const similar = d.similar_adverts_count ?? d.total_similar ?? null;
  if (score == null && days == null && similar == null) return null;
  return (
    <div className="card">
      <SectionTitle>Market Demand</SectionTitle>
      <div className="info-grid">
        {score   != null && <div className="info-cell"><div className="info-key">Demand Score</div><div className="info-val">{score} / 100</div></div>}
        {days    != null && <div className="info-cell"><div className="info-key">Avg Days to Sell</div><div className="info-val">{days}</div></div>}
        {similar != null && <div className="info-cell"><div className="info-key">Similar Listed</div><div className="info-val">{similar}</div></div>}
      </div>
    </div>
  );
}

// ── ROI Price Guide ───────────────────────────────────────────────────────────

function RoiPriceGuideSection({ result }) {
  const pg = result.roiPriceGuide;
  if (!pg) return null;
  const retail  = pg.retail  ?? pg.retail_price  ?? pg.dealer_price ?? null;
  const trade   = pg.trade   ?? pg.trade_price   ?? pg.auction_price ?? null;
  const priv    = pg.private ?? pg.private_price ?? null;
  if (retail == null && trade == null && priv == null) return null;
  return (
    <div className="card">
      <SectionTitle>Price Guide</SectionTitle>
      <div className="bid-grid">
        {retail != null && <div className="bid-card"><div className="bid-label">Retail</div><div className="bid-value bid-green">{fmtCurrency(retail, 'EUR')}</div></div>}
        {trade  != null && <div className="bid-card"><div className="bid-label">Trade</div><div className="bid-value">{fmtCurrency(trade,  'EUR')}</div></div>}
        {priv   != null && <div className="bid-card"><div className="bid-label">Private</div><div className="bid-value">{fmtCurrency(priv,   'EUR')}</div></div>}
      </div>
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
  const [vehicleImage, setVehicleImage] = useState(null);

  const vrm          = searchParams.get('vrm');
  const market       = searchParams.get('market') || 'GB';
  const mileage      = searchParams.get('mileage');
  const sessionId    = searchParams.get('session_id');
  const roiTierParam = searchParams.get('roiTier');
  const isFree       = searchParams.get('free') === 'true';

  const runLookup = useCallback(async () => {
    if (!vrm || !sessionId) { router.push('/'); return; }
    try {
      setStatus('verifying');
      const verifyRes  = await fetch(`/api/stripe/verify?session_id=${sessionId}${isFree ? '&free=true' : ''}`);
      const verifyData = await verifyRes.json();
      if (!verifyData.paid) {
        setError('Payment could not be verified. Please contact support.');
        setStatus('error');
        return;
      }

      setStatus('loading');
      const resolvedRoiTier = verifyData.roiTier || roiTierParam;
      const resolvedMarket  = verifyData.market  || market;

      const params = new URLSearchParams({ vrm, verified: 'true', market: resolvedMarket, session_id: sessionId });
      if (resolvedRoiTier && resolvedMarket === 'IE') {
        params.set('roiTier', resolvedRoiTier);
      } else {
        params.set('checks', verifyData.checks || searchParams.get('checks') || '');
      }
      if (mileage) params.append('mileage', mileage);
      if (verifyData.paymentIntentId) params.set('paymentIntentId', verifyData.paymentIntentId);

      const res  = await fetch(`/api/vehicle?${params}`);
      const data = await res.json();
      if (data.error) { setError(data.error); setStatus('error'); return; }
      setResult(data);
      setStatus('done');
    } catch {
      setError('Something went wrong. Please contact support — you have not been charged twice.');
      setStatus('error');
    }
  }, [vrm, sessionId, isFree, mileage, market, roiTierParam, router]);

  useEffect(() => { runLookup(); }, [runLookup]);

  useEffect(() => {
    if (!result || result.market === 'IE') return;
    fetch('/api/vehicle-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vrm, colour: result.colour }),
    })
      .then(r => r.json())
      .then(d => { if (d.imageUrl) setVehicleImage(d.imageUrl); })
      .catch(() => {});
  }, [result, vrm]);

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

  const checks     = result?.checks || [];
  const isRoiTier  = !!result?.roiTier && result?.market === 'IE';
  const isRoiPro   = ['roi_pro', 'roi_history'].includes(result?.roiTier);
  const isRoiHistory = result?.roiTier === 'roi_history';

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
    .footer-note { text-align: center; padding: 16px 20px 0; font-size: 12px; color: var(--text-dim); line-height: 1.6; }
    .footer-note a { color: var(--orange); text-decoration: none; }
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
              <div className="report-vehicle">
                {result.make} {result.model ? `${result.model} ` : ''}{result.yearOfManufacture}
                {isRoiTier && <span style={{marginLeft:8,fontSize:13,fontWeight:400,color:'var(--text-dim)'}}>
                  🇮🇪 ROI {result.roiTier === 'roi_history' ? 'History' : result.roiTier === 'roi_pro' ? 'Pro' : 'Standard'} Report
                </span>}
              </div>
            </div>

            <RecallWarning result={result} />

            {vehicleImage && (
              <div style={{ margin: '0 20px 6px', textAlign: 'center' }}>
                <img
                  src={vehicleImage}
                  alt={`${result.make} representative image`}
                  style={{ width: '100%', maxHeight: 220, objectFit: 'contain', background: 'transparent', display: 'block' }}
                />
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                  Representative image — not the actual vehicle
                </div>
              </div>
            )}

            <IdentitySection result={result} />
            {isRoiTier ? (
              <>
                {result.bregoRoi        && <BregoRoiValuationSection result={result} />}
                {result.roiMarketDemand && <RoiMarketDemandSection  result={result} />}
                {isRoiPro && result.roiPriceGuide && <RoiPriceGuideSection result={result} />}
                {isRoiHistory && <FinanceSection result={result} />}
                {isRoiHistory && <StolenSection  result={result} />}
                {isRoiHistory && <MotSection     result={result} />}
              </>
            ) : (
              <>
                {checks.includes('valuation')        && <ValuationSection       result={result} />}
                {checks.includes('writeoff')          && <WriteoffSection        result={result} />}
                {checks.includes('finance')           && <FinanceSection         result={result} />}
                {checks.includes('stolen')            && <StolenSection          result={result} />}
                {checks.includes('salvagehistory')    && <SalvageHistorySection  result={result} />}
                {checks.includes('market_demand')     && <MarketDemandSection    result={result} />}
                {checks.includes('previous_adverts')  && <PreviousAdvertsSection result={result} />}
                {checks.includes('mot')               && <MotSection             result={result} />}
                {checks.includes('owner_history')     && <OwnerHistorySection    result={result} />}
                {(checks.includes('service_history') || checks.includes('ie_service_history')) && <ServiceHistorySection result={result} />}
                {result.market === 'IE' && checks.includes('ie_valuation') && result.bregoRoi && <BregoRoiValuationSection result={result} />}
              </>
            )}

            <button className="pdf-btn" onClick={generatePdf} disabled={pdfLoading}>
              {pdfLoading ? 'Generating PDF...' : '↓ Save as PDF'}
            </button>
            <button className="back-btn" onClick={() => router.push('/')}>← New search</button>
            <p className="footer-note">Not affiliated with CAP or HPI. &nbsp;<a href="/terms">Terms &amp; Conditions</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a></p>
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
