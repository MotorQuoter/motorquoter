// 2-letter county codes before 1-letter so regex prefers the longer match
const COUNTIES = 'CE|CN|CW|DL|KE|KK|KY|LD|LH|LK|LM|LS|MH|MN|MO|OY|RN|SO|TN|TS|WD|WH|WW|C|D|G|L|T|W';
// Old format: 1-2 digit year + county code + 1-5 digit sequence (pre-2013)
const OLD_FORMAT = new RegExp(`^(0?[1-9]|[1-9][0-9])(${COUNTIES})\\d{1,5}$`, 'i');
// New format (2013+): 2-digit year + half-year digit (1 or 2) + county code + 1-5 digit sequence
const NEW_FORMAT = new RegExp(`^\\d{2}[12](${COUNTIES})\\d{1,5}$`, 'i');

export function isRoiPlate(vrm) {
  const clean = vrm.toUpperCase().replace(/\s/g, '');
  return OLD_FORMAT.test(clean) || NEW_FORMAT.test(clean);
}
