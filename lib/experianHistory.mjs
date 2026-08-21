// ─────────────────────────────────────────────────────────────────────────────
// experianVerdict — the ONE place that turns a raw Experian/HPI block into a
// history-check verdict, so "absent" and "checked, clear" can never be conflated.
// ─────────────────────────────────────────────────────────────────────────────
// Finding 1 (21 Aug): app/api/vehicle/route.js sets `autocheck: autocheck?.result || null`, so a
// failed or empty Experian call yields NULL. The PDF collapsed that to `{}` (`ac = ... || {}`), and
// then `ac.condition_data_qty > 0` was `false`, printing "[OK] No write-off recorded" IN GREEN on a
// £6.99 document — asserting the opposite of the truth on a check that never ran, with no refund path.
//
// The rule this earns: A MISSING SUPPLIER RESPONSE MUST NEVER RENDER AS A NEGATIVE FINDING. Absence of
// evidence is not evidence of absence. So the raw block (null when the call failed / returned nothing)
// is decided HERE: acRaw == null ⟹ { missing:true } ⟹ the caller renders an honest "not available",
// never a green all-clear. A real "we checked, qty 0" is a genuine, reassuring clean result and stays.
//
// The IE path feeds `result.hpi` and the GB path `result.autocheck` — both flow through here, so both
// are guarded by the same code (this function is source-agnostic; the caller picks which block).

const UNAVAILABLE = {
  writeoff:  'Write-off data not available for this vehicle',
  finance:   'Finance data not available for this vehicle',
  stolen:    'Stolen-register data not available for this vehicle',
  high_risk: 'High-risk marker data not available for this vehicle',
  plate:     'Plate-change data not available for this vehicle',
  searches:  'Search-history data not available for this vehicle',
};

/**
 * @param {object|null} acRaw  the raw Experian (autocheck) / HPI block, or null when the call failed.
 * @param {string} kind  writeoff | finance | stolen | high_risk | plate | searches
 * @returns {{missing:boolean, value:string, tone:('good'|'bad'|undefined)}}
 *   missing=true ⟹ render `value` as a neutral "not available" row (no [OK], no green).
 */
export function experianVerdict(acRaw, kind) {
  if (acRaw == null) return { missing: true, value: UNAVAILABLE[kind] ?? 'Not available for this vehicle', tone: undefined };
  const ac = acRaw;
  switch (kind) {
    case 'writeoff': {
      const has = ac.condition_data_qty > 0;
      const item = ac.condition_data_items?.[0];
      const src = item?.recovered_category_desc || item?.vehicle_status || '';
      const m = src.match(/\bCAT\s*([A-Z])\b/i);
      const label = has ? (m ? `Cat ${m[1]}` : (src || 'Write-off recorded')) : null;
      return { missing: false, value: has ? `[!] ${label}` : '[OK] No write-off recorded', tone: has ? 'bad' : 'good' };
    }
    case 'finance': {
      const has = ac.finance_data_qty > 0;
      return { missing: false, value: has ? '[!] Finance outstanding' : '[OK] No finance recorded', tone: has ? 'bad' : 'good' };
    }
    case 'stolen': {
      const has = ac.stolen_vehicle_data_qty > 0;
      return { missing: false, value: has ? '[!] Recorded as stolen' : '[OK] Not recorded stolen', tone: has ? 'bad' : 'good' };
    }
    case 'high_risk': {
      const q = ac.high_risk_data_qty ?? 0;
      return { missing: false, value: q > 0 ? `[!] ${q} marker${q === 1 ? '' : 's'} recorded` : '[OK] None recorded', tone: q > 0 ? 'bad' : 'good' };
    }
    case 'plate': {
      const q = ac.cherished_data_qty ?? 0;
      return { missing: false, value: q > 0 ? `${q} recorded` : '[OK] None recorded', tone: q > 0 ? undefined : 'good' };
    }
    case 'searches': {
      const q = ac.previous_search_qty ?? 0;
      return { missing: false, value: q > 0 ? `${q} recorded` : '[OK] No recent searches', tone: q > 0 ? undefined : 'good' };
    }
    default:
      return { missing: false, value: '-', tone: undefined };
  }
}
