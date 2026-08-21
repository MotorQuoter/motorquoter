// 2-letter county codes before 1-letter so regex prefers the longer match
const COUNTIES = 'CE|CN|CW|DL|KE|KK|KY|LD|LH|LK|LM|LS|MH|MN|MO|OY|RN|SO|TN|TS|WD|WH|WW|C|D|G|L|T|W';
// Old format: 1-2 digit year + county code + 1-5 digit sequence (pre-2013)
const OLD_FORMAT = new RegExp(`^(0?[1-9]|[1-9][0-9])(${COUNTIES})\\d{1,5}$`, 'i');
// New format (2013+): 2-digit year + half-year digit (1 or 2) + county code + 1-5 digit sequence
const NEW_FORMAT = new RegExp(`^\\d{2}[12](${COUNTIES})\\d{1,5}$`, 'i');

// Capturing variants — extract (yearPart, county, sequence) for dash insertion
const OLD_PARSE = new RegExp(`^(0?[1-9]|[1-9][0-9])(${COUNTIES})(\\d{1,5})$`, 'i');
const NEW_PARSE = new RegExp(`^(\\d{2}[12])(${COUNTIES})(\\d{1,5})$`, 'i');

export function isRoiPlate(vrm) {
  // Strip spaces AND hyphens (a listing often gives 08-D-12345) — matches formatRoiVrm's own
  // normalisation, which stripped [\s-]. Hyphen-stripping only broadens Irish detection; no UK plate
  // becomes digit-led by removing a hyphen, so there is no false-positive risk.
  const clean = vrm.toUpperCase().replace(/[\s-]/g, '');
  return OLD_FORMAT.test(clean) || NEW_FORMAT.test(clean);
}

// Convert 142D4260 → 142-D-4260 (official dashed format required by some APIs).
// New format tried first so 132D1234 is read as 13+2+D+1234, not 1+32+D+1234.
// Falls back to the clean undashed value if the plate doesn't match either pattern.
export function formatRoiVrm(vrm) {
  const clean = vrm.toUpperCase().replace(/[\s-]/g, '');
  const m = clean.match(NEW_PARSE) || clean.match(OLD_PARSE);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : clean;
}
