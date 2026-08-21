// ─────────────────────────────────────────────────────────────────────────────
// formatOdometer — the ONE place that resolves a DVSA MOT test's odometer for DISPLAY.
// ─────────────────────────────────────────────────────────────────────────────
// The unit was normalised once at the DVSA boundary (lib/dvsa.js → odometerMiles). Every render
// surface — the report screen, the report PDF, the salvage screen/PDF, and the salvage assessment
// prompt — must show that normalised figure, never the raw odometerValue with an assumed " mi".
// Printing a km reading as "104,471 mi" invited a false subtraction and a phantom rollback (the
// defect that started this thread). Rather than repeat the `odometerMiles ?? toMiles(...)` triple in
// six files, every consumer imports this.
//
// The `?? toMiles(...)` fallback is load-bearing: rows cached / stored before the boundary change
// (report cache, saved salvage sessions) have no odometerMiles, and MUST render identically to a
// fresh row — no undefined, no NaN, no bare number with an assumed unit.
import { toMiles, normUnit } from './mileageCheck.mjs';

/**
 * @param {object} test  one DVSA MOT test row
 * @param {object} [opts]
 *   kmSuffix  text placed inside the km annotation, e.g. ' recorded' → "(104,471 km recorded)".
 *             Default '' → "(104,471 km)". Lets each surface match its own established wording
 *             without duplicating the resolution logic.
 * @returns {{miles:number|null, recordedValue:(number|string|null), recordedUnit:('mi'|'km'),
 *            isKm:boolean, label:(string|null)}}
 *   label is display-ready: "111,119 mi" for a mi row, "64,915 mi (104,471 km)" for a km row,
 *   or null when there is no genuine reading (absent / 0 / non-numeric).
 */
export function formatOdometer(test, { kmSuffix = '' } = {}) {
  const miles = test?.odometerMiles ?? toMiles(test?.odometerValue, test?.odometerUnit);
  const recordedUnit = test?.odometerRecordedUnit || normUnit(test?.odometerUnit);
  const recordedValue = test?.odometerRecordedValue ?? test?.odometerValue ?? null;
  const isKm = recordedUnit === 'km';
  if (miles == null) return { miles: null, recordedValue, recordedUnit, isKm, label: null };
  const miFmt = Number(miles).toLocaleString('en-GB');
  const label = isKm && recordedValue != null
    ? `${miFmt} mi (${Number(String(recordedValue).replace(/,/g, '')).toLocaleString('en-GB')} km${kmSuffix})`
    : `${miFmt} mi`;
  return { miles, recordedValue, recordedUnit, isKm, label };
}

/**
 * Compact variant for the salvage assessment PROMPT (the £8.99 model-input path): no space before
 * "mi", and the km original placed as "(recorded Nkm)" BEFORE-style so the model reads a normalised
 * figure and can still see a unit switch (genuine import/NI signal, never silently dropped).
 * "64,915mi (recorded 104,471km)" / "111,119mi" / "" (no genuine reading). Same resolution as
 * formatOdometer; only the template differs — kept here so the two never drift.
 * @returns {string}
 */
export function formatOdometerCompact(test) {
  const o = formatOdometer(test);
  if (o.miles == null) return '';
  const mi = `${Number(o.miles).toLocaleString('en-GB')}mi`;
  return o.isKm && o.recordedValue != null
    ? `${mi} (recorded ${Number(String(o.recordedValue).replace(/,/g, '')).toLocaleString('en-GB')}km)`
    : mi;
}
