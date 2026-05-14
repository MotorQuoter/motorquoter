/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function fmtDate(str) {
  if (!str) return null;
  const [y, m, d] = str.split(' ')[0].split(/[-./]/);
  return d ? `${d}/${m}/${y}` : str;
}

function fmtCurrency(val) {
  if (val == null) return null;
  return `£${Number(val).toLocaleString('en-GB')}`;
}

// ─── PDF generation ───────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPdfHtml(result, vrm, tierLabel, checkDate) {
  const ac = result.autocheck || {};
  const val = result.valuation || {};
  const motHistory = result.motHistory || [];
  const cazAdv = result.cazanaAdverts || {};
  const cazAdverts = cazAdv.result || [];
  const cazDem = result.cazanaDemand || {};
  const svcHistory = result.serviceHistory;
  const svcCoverage = result.serviceHistoryCoverage;

  const money = (v) => v != null ? `£${Number(v).toLocaleString('en-GB')}` : '—';
  const num = (v) => v != null ? Number(v).toLocaleString('en-GB') : '—';
  const dt = (s) => {
    if (!s) return '—';
    const [y, m, d] = s.split(/[ T]/)[0].split(/[-./]/);
    return d ? `${d}/${m}/${y}` : s;
  };

  const row = (label, value, bad = false) => `
    <tr>
      <td style="padding:7px 10px;font-size:12px;color:#555;width:44%;border-bottom:1px solid #eee;">${esc(label)}</td>
      <td style="padding:7px 10px;font-size:13px;font-weight:600;border-bottom:1px solid #eee;${bad ? 'color:#cc0000;' : ''}">${value}</td>
    </tr>`;

  const section = (title, body) => `
    <div style="margin-bottom:20px;page-break-inside:avoid;">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#555;padding:7px 0 6px;border-bottom:1.5px solid #000;margin-bottom:10px;">${esc(title)}</div>
      ${body}
    </div>`;

  const table = (rows) => `<table style="width:100%;border-collapse:collapse;">${rows}</table>`;

  // Write-off label
  const writeOffItem = ac.condition_data_items?.[0];
  const wSrc = writeOffItem?.recovered_category_desc || writeOffItem?.vehicle_status || '';
  const wMatch = wSrc.match(/\bCAT\s*([A-Z])\b/i);
  const hasWriteOff = ac.condition_data_qty > 0;
  const writeOffLabel = hasWriteOff ? (wMatch ? `Cat ${wMatch[1]}` : (wSrc || 'Write-off recorded')) : null;

  const vehicleSection = section('Vehicle Details', table([
    result.make            ? row('Make', esc(result.make)) : '',
    result.yearOfManufacture ? row('Year', esc(result.yearOfManufacture)) : '',
    result.colour          ? row('Colour', esc(result.colour)) : '',
    result.engineSize      ? row('Engine', esc(result.engineSize)) : '',
    result.fuelType        ? row('Fuel Type', esc(result.fuelType)) : '',
    result.co2Emissions    ? row('CO₂ Emissions', `${esc(result.co2Emissions)} g/km`) : '',
    result.taxStatus       ? row('Tax Status', esc(result.taxStatus), result.taxStatus !== 'Taxed') : '',
    result.motStatus       ? row('MOT Status', esc(result.motStatus), result.motStatus !== 'Valid') : '',
    result.monthOfFirstRegistration ? row('First Registered', esc(result.monthOfFirstRegistration)) : '',
    result.dateOfLastV5CIssued ? row('Last V5C Issued', dt(result.dateOfLastV5CIssued)) : '',
  ].join('')));

  const valuationSection = val.retail_low_valuation != null ? section('Valuation', table([
    row('Retail Value', `${money(val.retail_low_valuation)} – ${money(val.retail_high_valuation)}`),
    row('Trade Value', `${money(val.trade_low_valuation)} – ${money(val.trade_high_valuation)}`),
  ].join(''))) : '';

  const standardRiskSection = section('Risk Checks', table([
    row('Finance',  ac.finance_data_qty === 0 ? '✓ No finance recorded' : '⚠ Outstanding finance recorded', ac.finance_data_qty > 0),
    row('Stolen',   ac.stolen_vehicle_data_qty === 0 ? '✓ Not recorded stolen' : '⚠ Recorded as stolen', ac.stolen_vehicle_data_qty > 0),
    row('Write-off', hasWriteOff ? `⚠ ${esc(writeOffLabel)}` : '✓ No write-off recorded', hasWriteOff),
    result.motExpiryDate ? row('MOT Expiry', esc(result.motExpiryDate)) : '',
    result.motMileage    ? row('Mileage at Last MOT', `${num(result.motMileage)} miles`) : '',
  ].join('')));

  let proContent = '';
  if (result.tier === 'pro') {
    const keeperCount = ac.keeper_data_items?.[0]?.number_previous_keepers ?? ac.keeper_changes_qty ?? null;
    const vehicleAge = result.yearOfManufacture ? (new Date().getFullYear() - result.yearOfManufacture) : null;
    const keeperHigh = keeperCount != null && vehicleAge != null && keeperCount > vehicleAge;
    const exported = (ac.is_exported != null || ac.was_exported != null) ? (ac.is_exported || ac.was_exported) : null;

    const proRiskSection = section('Risk Flags', table([
      row('Write-off',  hasWriteOff ? `⚠ ${esc(writeOffLabel)}` : '✓ Clean', hasWriteOff),
      row('Finance',    ac.finance_data_qty === 0 ? '✓ No finance' : '⚠ Outstanding finance', ac.finance_data_qty > 0),
      row('Stolen',     ac.stolen_vehicle_data_qty === 0 ? '✓ Not stolen' : '⚠ Recorded stolen', ac.stolen_vehicle_data_qty > 0),
      keeperCount != null ? row(`Keepers (${keeperCount})`, keeperHigh ? '⚠ High for age' : '✓ Normal', keeperHigh) : '',
      exported != null    ? row('Exported / Reimported', exported ? '⚠ Yes' : '✓ No', !!exported) : '',
    ].join('')));

    const lastAskingPrice = cazAdverts[0]?.advertised_price_gbp ?? null;
    const advertCount = cazAdverts.length || null;
    const demandScore = cazDem.market_demand_score;

    const bidSection = (val.retail_low_valuation != null || lastAskingPrice != null || demandScore != null)
      ? section('Bid Intelligence', table([
          val.retail_low_valuation != null ? row('Retail Value (Repaired)', `${money(val.retail_low_valuation)} – ${money(val.retail_high_valuation)}`) : '',
          val.trade_low_valuation  != null ? row('Trade Value', `${money(val.trade_low_valuation)} – ${money(val.trade_high_valuation)}`) : '',
          lastAskingPrice != null ? row(`Last Asking Price${advertCount ? ` (${advertCount} ad${advertCount > 1 ? 's' : ''})` : ''}`, money(lastAskingPrice)) : '',
          demandScore != null ? row('Market Demand Score', `${demandScore} / 100`) : '',
        ].join('')))
      : '';

    const svcCoverageLabel = { full: 'Full Coverage', limited: 'Limited Coverage', workshop: 'Workshop Remarks Only' }[svcCoverage] || null;
    const svcTitle = `Service History${svcCoverageLabel ? ` — ${svcCoverageLabel}` : ''}`;
    const svcBody = svcHistory === null && svcCoverage
      ? '<p style="font-size:13px;color:#555;margin:0;">Service history unavailable — please try again</p>'
      : svcHistory?.service_records?.length > 0
        ? table(svcHistory.service_records.map(rec => `
            <tr>
              <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #eee;width:22%;">${dt(rec.date)}</td>
              <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #eee;width:20%;">${rec.mileage != null ? num(rec.mileage) + ' mi' : '—'}</td>
              <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #eee;">${esc(rec.service_type || '—')}</td>
              <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #eee;color:#555;">${esc(rec.dealer || '')}</td>
            </tr>`).join(''))
        : '<p style="font-size:13px;color:#555;margin:0;">No digital service history on record</p>';
    const svcSection = svcCoverage ? section(svcTitle, svcBody) : '';

    const motHead = `<thead><tr style="background:#f5f5f5;">
      <th style="padding:7px 10px;font-size:11px;text-align:left;border-bottom:1px solid #ddd;">Date</th>
      <th style="padding:7px 10px;font-size:11px;text-align:left;border-bottom:1px solid #ddd;">Result</th>
      <th style="padding:7px 10px;font-size:11px;text-align:left;border-bottom:1px solid #ddd;">Mileage</th>
      <th style="padding:7px 10px;font-size:11px;text-align:left;border-bottom:1px solid #ddd;">Expiry</th>
    </tr></thead>`;
    const motRows = motHistory.slice(0, 15).map(t => {
      const fails = t.rfrAndComments?.filter(r => r.type === 'FAIL') || [];
      const advs  = t.rfrAndComments?.filter(r => r.type === 'ADVISORY') || [];
      return `
        <tr>
          <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #eee;">${esc(t.completedDate || '—')}</td>
          <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #eee;font-weight:700;color:${t.testResult === 'PASSED' ? '#006600' : '#cc0000'};">${esc(t.testResult || '—')}</td>
          <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #eee;">${t.odometerValue ? num(t.odometerValue) + ' mi' : '—'}</td>
          <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #eee;">${esc(t.expiryDate || '—')}</td>
        </tr>
        ${fails.map(f => `<tr><td colspan="4" style="padding:2px 10px 2px 22px;font-size:11px;color:#cc0000;border-bottom:1px solid #fafafa;">✗ ${esc(f.text)}</td></tr>`).join('')}
        ${advs.map(a  => `<tr><td colspan="4" style="padding:2px 10px 2px 22px;font-size:11px;color:#885500;border-bottom:1px solid #fafafa;">⚠ ${esc(a.text)}</td></tr>`).join('')}`;
    }).join('');
    const motSection = section('MOT History', motHistory.length > 0
      ? `<table style="width:100%;border-collapse:collapse;">${motHead}<tbody>${motRows}</tbody></table>`
      : '<p style="font-size:13px;color:#555;margin:0;">No MOT history on record</p>');

    const listingsSection = cazAdverts.length > 0 ? section('Previous Listings', `
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#f5f5f5;">
          <th style="padding:7px 10px;font-size:11px;text-align:left;border-bottom:1px solid #ddd;">Last Seen</th>
          <th style="padding:7px 10px;font-size:11px;text-align:left;border-bottom:1px solid #ddd;">Price</th>
          <th style="padding:7px 10px;font-size:11px;text-align:left;border-bottom:1px solid #ddd;">Mileage</th>
          <th style="padding:7px 10px;font-size:11px;text-align:left;border-bottom:1px solid #ddd;">Seller</th>
        </tr></thead>
        <tbody>
          ${cazAdverts.slice(0, 10).map(ad => `
            <tr>
              <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #eee;">${dt(ad.last_seen_date)}</td>
              <td style="padding:6px 10px;font-size:12px;font-weight:600;border-bottom:1px solid #eee;">${ad.advertised_price_gbp != null ? money(ad.advertised_price_gbp) : '—'}</td>
              <td style="padding:6px 10px;font-size:12px;border-bottom:1px solid #eee;">${ad.mileage_observed != null ? num(ad.mileage_observed) + ' mi' : '—'}</td>
              <td style="padding:6px 10px;font-size:12px;color:#555;border-bottom:1px solid #eee;">${esc(ad.seller_name || ad.dealer_type || '—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`) : '';

    proContent = proRiskSection + bidSection + svcSection + motSection + listingsSection;
  }

  const header = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:22px;">
      <div>
        <div style="font-size:22px;font-weight:900;letter-spacing:0.04em;font-family:Arial Black,Arial,sans-serif;">MOTORQUOTER</div>
        <div style="font-size:11px;color:#666;margin-top:3px;letter-spacing:0.04em;">Vehicle Intelligence Report</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:20px;font-weight:700;letter-spacing:0.08em;">${esc(vrm)}</div>
        <div style="font-size:12px;color:#555;margin-top:3px;">${esc(result.make || '')} ${esc(result.yearOfManufacture || '')}</div>
        <div style="font-size:11px;color:#777;margin-top:2px;">${esc(tierLabel)} Check &bull; ${esc(checkDate)}</div>
      </div>
    </div>`;

  const footer = `
    <div style="margin-top:28px;padding-top:10px;border-top:1px solid #ccc;font-size:10px;color:#888;text-align:center;">
      Generated by MotorQuoter &bull; motorquoter.vercel.app &bull; ${esc(checkDate)} &bull; Data sourced from DVLA, Experian AutoCheck, DVSA and Cazana
    </div>`;

  const body = result.tier === 'pro'
    ? vehicleSection + proContent
    : vehicleSection + valuationSection + standardRiskSection;

  return `<div style="font-family:Arial,sans-serif;color:#111;background:#fff;padding:28px 32px;max-width:760px;margin:0 auto;">${header}${body}${footer}</div>`;
}

// ─── Standard tier result (existing layout) ───────────────────────────────────

function StandardResult({ vrm, tier, result }) {
  return (
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
        {result.autocheck?.condition_data_qty > 0 && (() => {
          const wItem = result.autocheck.condition_data_items?.[0];
          const wSrc = wItem?.recovered_category_desc || wItem?.vehicle_status || '';
          const wMatch = wSrc.match(/\bCAT\s*([A-Z])\b/i);
          const wLabel = wMatch ? `Cat ${wMatch[1]}` : (wSrc || 'Write-off recorded');
          return <div className="result-row"><span className="result-key">Write-off</span><span className="result-val bad">⚠️ {wLabel}</span></div>;
        })()}
        {result.motExpiryDate && <div className="result-row"><span className="result-key">MOT Expiry</span><span className="result-val">{result.motExpiryDate}</span></div>}
        {result.motMileage && <div className="result-row"><span className="result-key">Mileage at Last MOT</span><span className="result-val">{Number(result.motMileage).toLocaleString('en-GB')} miles</span></div>}
      </div>
    </div>
  );
}

// ─── Pro tier result ───────────────────────────────────────────────────────────

function RiskFlag({ label, value, tone }) {
  return (
    <div className={`flag-row flag-${tone}`}>
      <span className="flag-label">{label}</span>
      <span className={`flag-val flag-val-${tone}`}>{value}</span>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div className="section-title">{children}</div>;
}

function ProResult({ vrm, result }) {
  const ac = result.autocheck || {};
  const val = result.valuation || {};
  const salvage = result.salvage || {};
  const cazAdv = result.cazanaAdverts || {};
  const cazAdverts = cazAdv.result || [];
  const cazDem = result.cazanaDemand || {};
  const motHistory = result.motHistory || [];
  const svcHistory = result.serviceHistory;
  const svcCoverage = result.serviceHistoryCoverage;
  const svcCoverageLabel = { full: 'Full Coverage', limited: 'Limited Coverage', workshop: 'Workshop Remarks Only' }[svcCoverage] || null;

  // Write-off — recovered_category_desc is often null; fall back to vehicle_status which contains e.g. "CAT S STRUCTURAL DAMAGE"
  const hasWriteOff = ac.condition_data_qty > 0;
  const writeOffItem = ac.condition_data_items?.[0];
  const writeOffSrc = writeOffItem?.recovered_category_desc || writeOffItem?.vehicle_status || '';
  const writeOffCatMatch = writeOffSrc.match(/\bCAT\s*([A-Z])\b/i);
  const writeOffCat = hasWriteOff
    ? (writeOffCatMatch ? `Cat ${writeOffCatMatch[1]}` : (writeOffSrc || 'Write-off recorded'))
    : null;

  // Keeper count — field name may vary by AutoCheck version
  const keeperCount = ac.keeper_data_items?.[0]?.number_previous_keepers ?? ac.keeper_changes_qty ?? null;
  const vehicleAgeYears = result.yearOfManufacture ? (new Date().getFullYear() - result.yearOfManufacture) : null;
  const keeperHigh = keeperCount != null && vehicleAgeYears != null && keeperCount > vehicleAgeYears;

  // Mileage anomaly
  const mileageAnomaly = ac.mileage_anomaly ?? ac.mileage_discrepancy ?? null;

  // Exported / reimported
  const exported = (ac.is_exported != null || ac.was_exported != null) ? (ac.is_exported || ac.was_exported) : null;

  // Finance / stolen
  const hasFinance = ac.finance_data_qty > 0;
  const hasStolen = ac.stolen_vehicle_data_qty > 0;

  // Cazana — previous asking price (array sorted newest-first)
  const lastAskingPrice = cazAdverts[0]?.advertised_price_gbp ?? null;
  const advertCount = cazAdverts.length || null;

  // Cazana — market demand
  const demandRating = cazDem.market_demand_score != null ? `${cazDem.market_demand_score} / 100` : null;
  const daysToSell = cazDem.average_days_to_sell ?? cazDem.days_to_sell ?? null;
  const similarCount = cazDem.similar_adverts_count ?? cazDem.total_similar ?? null;

  // SalvageGuide — predicted hammer
  const predictedHammer = salvage.predicted_hammer_price ?? salvage.hammer_price ?? salvage.bid_predictor?.predicted_price ?? null;

  return (
    <div className="pro-wrap">

      {/* ── Vehicle Identity ── */}
      <div className="pro-section">
        <SectionTitle>Vehicle Identity</SectionTitle>
        <div className="info-grid">
          {result.make && <><div className="info-cell"><div className="info-key">Make</div><div className="info-val">{result.make}</div></div></>}
          {result.yearOfManufacture && <div className="info-cell"><div className="info-key">Year</div><div className="info-val">{result.yearOfManufacture}</div></div>}
          {result.colour && <div className="info-cell"><div className="info-key">Colour</div><div className="info-val">{result.colour}</div></div>}
          {result.engineSize && <div className="info-cell"><div className="info-key">Engine</div><div className="info-val">{result.engineSize}</div></div>}
          {result.fuelType && <div className="info-cell"><div className="info-key">Fuel</div><div className="info-val">{result.fuelType}</div></div>}
          {result.co2Emissions && <div className="info-cell"><div className="info-key">CO₂</div><div className="info-val">{result.co2Emissions} g/km</div></div>}
          {result.monthOfFirstRegistration && <div className="info-cell"><div className="info-key">First Reg</div><div className="info-val">{result.monthOfFirstRegistration}</div></div>}
          {keeperCount != null && <div className="info-cell"><div className="info-key">Keepers</div><div className="info-val" style={{color: keeperHigh ? '#f5c842' : 'inherit'}}>{keeperCount}</div></div>}
        </div>
      </div>

      {/* ── Bid Intelligence ── */}
      <div className="pro-section">
        <SectionTitle>Bid Intelligence</SectionTitle>

        {predictedHammer != null && (
          <div className="bid-card bid-hero">
            <div className="bid-label">Predicted Hammer Price</div>
            <div className="bid-value bid-orange">{fmtCurrency(predictedHammer)}</div>
          </div>
        )}

        <div className="bid-grid">
          {val.retail_low_valuation != null && (
            <div className="bid-card">
              <div className="bid-label">Retail (Repaired)</div>
              <div className="bid-value bid-green">
                {fmtCurrency(val.retail_low_valuation)} – {fmtCurrency(val.retail_high_valuation)}
              </div>
            </div>
          )}
          {val.trade_low_valuation != null && (
            <div className="bid-card">
              <div className="bid-label">Trade Value</div>
              <div className="bid-value">
                {fmtCurrency(val.trade_low_valuation)} – {fmtCurrency(val.trade_high_valuation)}
              </div>
            </div>
          )}
          {lastAskingPrice != null && (
            <div className="bid-card">
              <div className="bid-label">Previous Asking Price{advertCount ? ` (${advertCount} ads)` : ''}</div>
              <div className="bid-value">{fmtCurrency(lastAskingPrice)}</div>
            </div>
          )}
          {demandRating && (
            <div className="bid-card">
              <div className="bid-label">Market Demand</div>
              <div className="bid-value">{demandRating}</div>
              {daysToSell != null && <div className="bid-sub">~{daysToSell} days to sell</div>}
            </div>
          )}
        </div>
      </div>

      {/* ── Risk Flags ── */}
      <div className="pro-section">
        <SectionTitle>Risk Flags</SectionTitle>
        <div className="flag-list">
          {hasWriteOff
            ? <RiskFlag label="Write-off" value={`⚠️ ${writeOffCat}`} tone="red" />
            : <RiskFlag label="Write-off" value="✓ Clean" tone="green" />
          }
          {mileageAnomaly != null && (
            mileageAnomaly
              ? <RiskFlag label="Mileage" value="⚠️ Anomaly detected" tone="red" />
              : <RiskFlag label="Mileage" value="✓ Consistent" tone="green" />
          )}
          {keeperCount != null && (
            keeperHigh
              ? <RiskFlag label={`Keepers (${keeperCount})`} value="⚠️ High for age" tone="amber" />
              : <RiskFlag label={`Keepers (${keeperCount})`} value="✓ Normal" tone="green" />
          )}
          {exported != null && (
            exported
              ? <RiskFlag label="Exported / Reimported" value="⚠️ Yes" tone="amber" />
              : <RiskFlag label="Exported / Reimported" value="✓ No" tone="green" />
          )}
          {hasFinance
            ? <RiskFlag label="Finance" value="⚠️ Outstanding finance" tone="red" />
            : <RiskFlag label="Finance" value="✓ No finance" tone="green" />
          }
          {hasStolen
            ? <RiskFlag label="Stolen" value="⚠️ Recorded stolen" tone="red" />
            : <RiskFlag label="Stolen" value="✓ Not stolen" tone="green" />
          }
        </div>
      </div>

      {/* ── Service History ── */}
      <div className="pro-section">
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',paddingTop:18,paddingBottom:10,borderBottom:'1px solid var(--border-dim)',marginBottom:12}}>
          <span style={{fontFamily:"'Barlow Condensed',sans-serif",fontSize:13,fontWeight:700,letterSpacing:'0.18em',color:'var(--orange)',textTransform:'uppercase'}}>Service History</span>
          {svcCoverageLabel && (
            <span style={{fontSize:11,fontWeight:700,letterSpacing:'0.08em',textTransform:'uppercase',
              color: svcCoverage === 'full' ? '#4ade80' : svcCoverage === 'limited' ? 'var(--yellow)' : 'var(--text-dim)',
              fontFamily:"'Barlow Condensed',sans-serif"}}>
              {svcCoverageLabel}
            </span>
          )}
        </div>
        {svcHistory === null && svcCoverage ? (
          <div className="history-empty" style={{color:'var(--yellow)'}}>Service history unavailable — please try again</div>
        ) : svcHistory?.service_records?.length > 0 ? (
          <div className="history-list">
            {svcHistory.service_records.map((rec, i) => (
              <div className="history-record" key={i}>
                <div className="history-row">
                  <span className="history-date">{fmtDate(rec.date) || rec.date}</span>
                  {rec.mileage != null && <span className="history-mileage">{Number(rec.mileage).toLocaleString('en-GB')} mi</span>}
                </div>
                {rec.service_type && <div className="history-detail">{rec.service_type}</div>}
                {rec.dealer && <div className="history-detail" style={{color:'var(--text-dim)'}}>{rec.dealer}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="history-empty">No digital service history on record</div>
        )}
      </div>

      {/* ── MOT History ── */}
      <div className="pro-section">
        <SectionTitle>MOT History</SectionTitle>
        {motHistory.length > 0 ? (
          <div className="history-list">
            {motHistory.map((test, i) => {
              const advisories = test.rfrAndComments?.filter(r => r.type === 'ADVISORY') || [];
              const failures = test.rfrAndComments?.filter(r => r.type === 'FAIL') || [];
              return (
                <div className="history-record" key={i}>
                  <div className="history-row">
                    <span className="history-date">{test.completedDate}</span>
                    <span className={test.testResult === 'PASSED' ? 'badge-pass' : 'badge-fail'}>
                      {test.testResult}
                    </span>
                  </div>
                  {test.odometerValue && (
                    <div className="history-mileage">
                      {Number(test.odometerValue).toLocaleString('en-GB')} {test.odometerUnit || 'mi'}
                      {test.expiryDate && <span style={{marginLeft:8,color:'var(--text-dim)'}}>Expires {test.expiryDate}</span>}
                    </div>
                  )}
                  {failures.map((f, j) => <div className="mot-failure" key={j}>✗ {f.text}</div>)}
                  {advisories.map((a, j) => <div className="mot-advisory" key={j}>⚠ {a.text}</div>)}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="history-empty">No MOT history on record</div>
        )}
      </div>

      {/* ── Market Intelligence ── */}
      {(daysToSell != null || similarCount != null || cazAdverts.length > 0) && (
        <div className="pro-section">
          <SectionTitle>Market Intelligence</SectionTitle>
          <div className="info-grid">
            {daysToSell != null && (
              <div className="info-cell">
                <div className="info-key">Avg Days to Sell</div>
                <div className="info-val">{daysToSell}</div>
              </div>
            )}
            {similarCount != null && (
              <div className="info-cell">
                <div className="info-key">Similar Listed</div>
                <div className="info-val">{similarCount}</div>
              </div>
            )}
            {advertCount != null && (
              <div className="info-cell">
                <div className="info-key">Times Advertised</div>
                <div className="info-val">{advertCount}</div>
              </div>
            )}
            {demandRating && (
              <div className="info-cell">
                <div className="info-key">Demand Rating</div>
                <div className="info-val">{demandRating}</div>
              </div>
            )}
          </div>

          {cazAdverts.length > 0 && (
            <>
              <div style={{fontSize:12,color:'var(--text-dim)',marginTop:14,marginBottom:8,textTransform:'uppercase',letterSpacing:'0.1em',fontFamily:"'Barlow Condensed',sans-serif"}}>Previous Listings</div>
              <div className="history-list">
                {cazAdverts.slice(0, 5).map((ad, i) => (
                  <div className="history-record" key={i}>
                    <div className="history-row">
                      <span className="history-date">{fmtDate(ad.last_seen_date) || ad.last_seen_date}</span>
                      {ad.advertised_price_gbp != null && <span style={{fontWeight:700,color:'var(--text)'}}>{fmtCurrency(ad.advertised_price_gbp)}</span>}
                    </div>
                    {ad.mileage_observed != null && <div className="history-detail">{Number(ad.mileage_observed).toLocaleString('en-GB')} mi</div>}
                    {(ad.seller_name || ad.dealer_type) && <div className="history-detail" style={{color:'var(--text-dim)'}}>{ad.seller_name || ad.dealer_type}</div>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page component ────────────────────────────────────────────────────────────

function PaymentSuccessContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState('verifying');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);

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

      const params = new URLSearchParams({ vrm, tier: verifyData.tier || tier, session_id: sessionId, verified: 'true' });
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

    } catch {
      setError('Something went wrong. Please contact support — you have not been charged twice.');
      setStatus('error');
    }
  }, [vrm, tier, sessionId, mileage, market, router]);

  useEffect(() => {
    runLookup();
  }, [runLookup]);

  async function generatePdf() {
    if (!result) return;
    setPdfLoading(true);
    try {
      const { default: html2pdf } = await import('html2pdf.js');
      const today = new Date().toLocaleDateString('en-GB');
      const tierLabel = tier === 'pro' ? 'Pro' : 'Standard';

      // html2canvas only captures elements within the viewport bounds.
      // Positioning at left:-10000px produces a blank canvas. Instead we
      // place the element at (0,0) with pointer-events:none so it doesn't
      // interfere with the page during the brief capture window.
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:0;left:0;width:794px;background:white;z-index:9999;pointer-events:none;';
      el.innerHTML = buildPdfHtml(result, vrm, tierLabel, today);
      document.body.appendChild(el);

      await html2pdf().set({
        margin: [12, 12, 12, 12],
        filename: `MotorQuoter_${vrm}_${new Date().toISOString().slice(0, 10)}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: false,
          windowWidth: 794,
          scrollX: 0,
          scrollY: 0,
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      }).from(el).save();

      document.body.removeChild(el);
    } finally {
      setPdfLoading(false);
    }
  }

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
    .error-box { margin: 20px; background: rgba(248,113,113,0.1); border: 1.5px solid rgba(248,113,113,0.3); border-radius: 10px; padding: 16px 20px; color: #f87171; font-size: 14px; line-height: 1.5; }
    .pdf-btn { display: block; margin: 20px auto 6px; padding: 14px 28px; background: var(--orange); border: none; border-radius: 10px; color: white; font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 700; letter-spacing: 0.08em; cursor: pointer; text-align: center; width: calc(100% - 40px); }
    .pdf-btn:hover { background: var(--orange-light); }
    .pdf-btn:disabled { opacity: 0.6; cursor: wait; }
    .back-btn { display: block; margin: 0 auto 20px; padding: 14px 28px; background: var(--bg3); border: 1.5px solid var(--border-dim); border-radius: 10px; color: var(--text-dim); font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 700; letter-spacing: 0.08em; cursor: pointer; text-align: center; width: calc(100% - 40px); }
    .back-btn:hover { border-color: var(--orange); color: var(--orange); }
    .success-badge { display: inline-block; background: rgba(74,222,128,0.15); border: 1px solid rgba(74,222,128,0.3); border-radius: 6px; padding: 4px 12px; font-size: 12px; color: #4ade80; font-weight: 600; margin-bottom: 12px; }

    /* ── Standard result ── */
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

    /* ── Pro result ── */
    .pro-wrap { margin-top: 8px; }
    .pro-header { margin: 0 20px 4px; background: var(--orange-dim); border: 1.5px solid var(--border); border-radius: 12px; padding: 16px 20px; }
    .pro-reg { font-family: 'Barlow Condensed', sans-serif; font-size: 24px; font-weight: 900; letter-spacing: 0.1em; color: var(--orange); }
    .pro-vehicle { font-size: 16px; color: var(--text); font-weight: 600; margin-top: 4px; }
    .pro-badge { display: inline-block; margin-top: 8px; background: var(--orange); border-radius: 4px; padding: 3px 10px; font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; color: white; text-transform: uppercase; }

    .pro-section { margin: 0 20px 6px; }
    .section-title { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: 0.18em; color: var(--orange); text-transform: uppercase; padding: 18px 0 10px; border-bottom: 1px solid var(--border-dim); margin-bottom: 12px; }

    .info-grid { display: grid; grid-template-columns: 1fr 1fr; }
    .info-cell { padding: 10px 0; border-bottom: 1px solid var(--border-dim); padding-right: 12px; }
    .info-cell:nth-child(odd) { padding-right: 12px; }
    .info-cell:nth-last-child(-n+2) { border-bottom: none; }
    .info-key { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 2px; }
    .info-val { font-size: 15px; font-weight: 600; color: var(--text); }

    .bid-hero { background: var(--orange-dim); border: 1.5px solid var(--border); border-radius: 12px; padding: 16px 20px; margin-bottom: 10px; }
    .bid-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .bid-card { background: var(--bg2); border: 1.5px solid var(--border-dim); border-radius: 10px; padding: 14px 16px; }
    .bid-label { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 6px; }
    .bid-value { font-family: 'Barlow Condensed', sans-serif; font-size: 22px; font-weight: 900; color: var(--text); line-height: 1.1; }
    .bid-value.bid-green { color: #4ade80; }
    .bid-value.bid-orange { font-size: 32px; color: var(--orange); }
    .bid-sub { font-size: 12px; color: var(--text-dim); margin-top: 4px; }

    .flag-list { display: flex; flex-direction: column; gap: 8px; }
    .flag-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 8px; }
    .flag-row.flag-green { border: 1.5px solid rgba(74,222,128,0.25); background: rgba(74,222,128,0.07); }
    .flag-row.flag-red { border: 1.5px solid rgba(248,113,113,0.35); background: rgba(248,113,113,0.09); }
    .flag-row.flag-amber { border: 1.5px solid rgba(245,200,66,0.35); background: rgba(245,200,66,0.09); }
    .flag-label { font-size: 13px; font-weight: 600; color: var(--text); }
    .flag-val { font-size: 13px; font-weight: 700; }
    .flag-val-green { color: #4ade80; }
    .flag-val-red { color: #f87171; }
    .flag-val-amber { color: var(--yellow); }

    .history-list { display: flex; flex-direction: column; }
    .history-record { padding: 12px 0; border-bottom: 1px solid var(--border-dim); }
    .history-record:last-child { border-bottom: none; }
    .history-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .history-date { font-size: 14px; font-weight: 600; color: var(--text); }
    .history-mileage { font-size: 12px; color: var(--text-dim); margin-bottom: 4px; }
    .history-detail { font-size: 13px; color: var(--text); margin-top: 2px; }
    .history-empty { font-size: 14px; color: var(--text-dim); padding: 12px 0; }
    .badge-pass { font-size: 12px; font-weight: 700; color: #4ade80; background: rgba(74,222,128,0.12); border: 1px solid rgba(74,222,128,0.25); border-radius: 4px; padding: 2px 8px; }
    .badge-fail { font-size: 12px; font-weight: 700; color: #f87171; background: rgba(248,113,113,0.12); border: 1px solid rgba(248,113,113,0.25); border-radius: 4px; padding: 2px 8px; }
    .mot-advisory { font-size: 12px; color: var(--yellow); padding: 2px 0; }
    .mot-failure { font-size: 12px; color: #f87171; padding: 2px 0; }
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

            {result.tier === 'pro' ? (
              <>
                <div className="pro-header">
                  <div className="pro-reg">{vrm}</div>
                  <div className="pro-vehicle">{result.make} {result.yearOfManufacture}</div>
                  <span className="pro-badge">Pro Intelligence Report</span>
                </div>
                <ProResult vrm={vrm} result={result} />
              </>
            ) : (
              <StandardResult vrm={vrm} tier={tier} result={result} />
            )}

            <button className="pdf-btn" onClick={generatePdf} disabled={pdfLoading}>
              {pdfLoading ? 'Generating PDF...' : '↓ Download PDF'}
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
