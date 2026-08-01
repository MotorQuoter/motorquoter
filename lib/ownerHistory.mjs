// ─────────────────────────────────────────────────────────────────────────────
// Owner / keeper history — pure, deterministic. From One Auto UK Vehicle Data
// (`vehicleandmodeldetailsfromvrm` → result.vehicle_details.keeper_change_list).
// Keeper data is NOT masked (unlike the VIN). GB/NI only — no ROI keeper data.
// ─────────────────────────────────────────────────────────────────────────────
// Confirmed live shape (GY67LLD, 31 Jul): keeper_change_list is an array of
//   { number_previous_keepers: <int>, date_of_last_keeper_change: "YYYY-MM-DD" }
// e.g. [{2, "2025-08-28"}, {1, "2023-04-07"}] → 2 changes, current keeper is the 3rd.

function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);            // YYYY-MM-DD
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);             // DD/MM/YYYY
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : t;
}
const fmtDate = (ms) => {
  if (ms == null) return null;
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * summariseOwnerHistory — normalise One Auto keeper_change_list into a buyer-facing summary.
 * @param {Array} keeperChangeList  from result.vehicle_details.keeper_change_list.
 * @returns {{ status:'ok'|'no_data', totalKeepers:number|null, keeperChanges:number,
 *            latestChangeDate:string|null, changes:Array, verdict:string }}
 */
export function summariseOwnerHistory(keeperChangeList) {
  const list = Array.isArray(keeperChangeList) ? keeperChangeList : [];
  const changes = list
    .map((e) => {
      const pk = Number(e?.number_previous_keepers);
      return {
        previousKeepers: Number.isFinite(pk) ? pk : null,
        date: e?.date_of_last_keeper_change ?? null,
        _ms: parseDate(e?.date_of_last_keeper_change),
      };
    })
    .filter((c) => c.date != null || c.previousKeepers != null)
    .sort((a, b) => (a._ms ?? 0) - (b._ms ?? 0)); // oldest → newest

  if (!changes.length) {
    return { status: 'no_data', totalKeepers: null, keeperChanges: 0, latestChangeDate: null, changes: [], verdict: 'No keeper-change history on record.' };
  }

  const keeperChanges = changes.length;
  const prevCounts = changes.map((c) => c.previousKeepers).filter((n) => n != null);
  // Total keepers = highest "previous keepers" seen + the current keeper; fall back to
  // (changes + 1) when the count field is absent (each change begins a new keeper).
  const totalKeepers = prevCounts.length ? Math.max(...prevCounts) + 1 : keeperChanges + 1;
  const latest = changes[changes.length - 1];
  const latestChangeDate = latest._ms != null ? fmtDate(latest._ms) : null;

  const verdict = `${totalKeepers} keeper${totalKeepers === 1 ? '' : 's'} · ${keeperChanges} recorded change${keeperChanges === 1 ? '' : 's'}${latestChangeDate ? ` · last change ${latestChangeDate}` : ''}`;

  return {
    status: 'ok',
    totalKeepers,
    keeperChanges,
    latestChangeDate,
    changes: changes.map((c) => ({ previousKeepers: c.previousKeepers, date: c._ms != null ? fmtDate(c._ms) : c.date })),
    verdict,
  };
}

// Candidate field names for a plate value / change date inside a plate-change entry — the exact
// One Auto shape for previous plates is unconfirmed, so we read defensively across the plausible
// keys and degrade gracefully (empty list) when none are present. GB VRM shape, spaces stripped.
const PLATE_SHAPE = /^[A-Z0-9]{2,8}$/;
// We surface the PREVIOUS plate the vehicle wore, not its current one — so
// `previous_vehicle_registration_mark` (One Auto's `plate_change_list` shape, confirmed live on
// S500VNY) is checked first, with the generic candidates kept for other providers. The current-
// plate keys are deliberately NOT read (they'd list the plate the car has now as "previous").
function pickPlate(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') { const s = entry.replace(/\s/g, '').toUpperCase(); return PLATE_SHAPE.test(s) ? s : null; }
  for (const k of ['previous_vehicle_registration_mark', 'previous_vrm', 'previous_registration', 'registration_mark', 'vehicle_registration_mark', 'registration', 'vrm', 'plate', 'number_plate']) {
    const v = entry[k];
    if (typeof v === 'string' && v.trim()) { const s = v.replace(/\s/g, '').toUpperCase(); if (PLATE_SHAPE.test(s)) return s; }
  }
  return null;
}
function pickPlateDate(entry) {
  if (entry == null || typeof entry !== 'object') return null;
  for (const k of ['cherished_plate_transfer_date', 'date_of_receipt', 'date_of_change', 'date_of_last_change', 'change_date', 'date', 'date_of_transaction', 'transaction_date']) {
    if (entry[k]) return entry[k];
  }
  return null;
}

/**
 * summarisePlateChanges — normalise a previous-registration-plate list into a buyer-facing list.
 * Defensive across field names; returns oldest → newest. Never throws on odd shapes.
 * @param {Array} plateChangeList  candidate plate-change entries from the One Auto response.
 * @returns {{ status:'ok'|'no_data', count:number, plates:Array<{plate:string,date:string|null}> }}
 */
export function summarisePlateChanges(plateChangeList) {
  const list = Array.isArray(plateChangeList) ? plateChangeList : [];
  const seen = new Set();
  const plates = list
    .map((e) => ({ plate: pickPlate(e), _ms: parseDate(pickPlateDate(e)) }))
    .filter((p) => p.plate && !seen.has(p.plate) && seen.add(p.plate))
    .sort((a, b) => (a._ms ?? 0) - (b._ms ?? 0));
  if (!plates.length) return { status: 'no_data', count: 0, plates: [] };
  return {
    status: 'ok',
    count: plates.length,
    plates: plates.map((p) => ({ plate: p.plate, date: p._ms != null ? fmtDate(p._ms) : null })),
  };
}
