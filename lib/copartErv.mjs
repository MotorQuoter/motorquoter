// batch 190 — THE ONE OWNER of the Copart ERV display string, used by the PDF and the web report.
// Copart writes the figure with its currency code glued on ("£13,250.00GBP"); the stored value is left exactly as Copart
// wrote it (the model reads it), so this is display-only. Rule:
//   - any currency code ("GBP", any case, with or without a space, before or after the number) goes; exactly one "£" leads;
//   - whole pounds print without pence ("£13,250"), like every other figure in the report; non-zero pence are kept as
//     Copart wrote them ("£6,953.33");
//   - anything that does not parse as a money figure prints unchanged (never blank, never invented); null → ''.
const MONEY = /^(?:£\s*)?(?:GBP\s*)?(?:£\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:GBP)?$/i;

export function fmtCopartErv(v) {
  if (v == null) return '';
  const s = String(v).trim();
  const m = s.match(MONEY);
  if (!m) return String(v);
  const pounds = Number(m[1].replace(/,/g, '')).toLocaleString('en-GB');
  return m[2] && !/^0+$/.test(m[2]) ? `£${pounds}.${m[2]}` : `£${pounds}`;
}
