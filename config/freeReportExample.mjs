// batch 231 — the example report shown on /salvage/free-report. STATIC: the page never queries the database.
// batch 233 — swapped from the MINI (Vincent, 13 Oct: "Lets go with the crossland").
//
// Every figure below is copied verbatim from ONE stored production report and formatted exactly as the report
// (app/salvage/success/page.js) prints it — no rounding, no editing, no figures from anywhere else:
//   salvage_sessions.id 4bdffc9c-6752-4b6c-9eb9-77cc56e92c96 · created_at 2026-09-24T13:48:57Z
//   VAUXHALL SV24YCN · Copart lot 61691896 · status 'assessed' · no buyer edits (edit_layer null)
// Source fields: vehicle_details.year/make/model/primaryDamage/secondaryDamage · assessment._reconciledParts (charged
// figure = used ?? oem, as partsTableCells shows it; a floor row — _structFloor / _srsFloor — prints "from £500", never
// a bare £500) · _partsReconciliation.parts_sum (Bid (S/H)) · _investmentBlock.afterRepairValue ·
// _marginScenarios[5] (the £4,800 rung — the report has no fee row at the break-even bid; it is the stored rung nearest
// below it, Cowork ruling) · _investmentBlock.bidCeilings.rebuild · WhatsApp Inspection Checklist.

export const FREE_REPORT_EXAMPLE = {
  sessionId: '4bdffc9c-6752-4b6c-9eb9-77cc56e92c96',
  label: 'Example: a real MotorQuoter report on a Copart lot',
  vehicle: '2024 VAUXHALL CROSSLAND ULTIMATE TURBO AUTO',
  damage: 'Front End / Undercarriage',
  note: "The report's estimate from the auction photos. You can strike or add any line, or amend any figure.",
  rows: [
    { name: 'Front bumper (replace)', figure: '£200' },
    { name: 'Grille (replace)', figure: '£90' },
    { name: 'Bonnet (replace)', figure: '£165' },
    { name: 'Slam panel (replace)', figure: '£50' },
    { name: 'Front wing (replace)', figure: '£130' },
    { name: 'Headlamp (replace)', figure: '£350' },
    { name: 'Radiator pack (replace)', figure: '£300' },
    { name: 'Wheel arch liner (replace)', figure: '£35' },
    { name: 'Front structure (inspect)', figure: 'from £500' },
    { name: 'SRS airbag kit (deployed)', figure: 'from £500' },
    { name: 'Front fog lamp (replace)', figure: '£50' },
    { name: 'Labour & paint (new & painted)', figure: '£1,500' },
  ],
  repairTotal: '£3,870',
  worthRepaired: '£9,666',
  feesHammer: '£4,800.00',
  fees: '£820.80',
  breakEven: '£4,968',
  checklist: [
    'Show the front chassis leg/rail behind the damaged front corner from below, and the inner wing, for any deformation, folding or buckling — this is the key structural question.',
    'Show the damaged-side front wheel and suspension close up (hub carrier, lower arm, subframe mount) and confirm whether the wheel sits straight in the arch.',
    'Confirm frontal airbag deployment — show the steering wheel centre and passenger fascia (interior shots suggest deployed bag material is present in the cabin).',
  ],
  footer: 'Every report: itemised repair, value repaired, auction fees and your break-even bid.',
};

export const EXAMPLE_MAX_ROWS = 5;
export const EXAMPLE_CHECK_CHARS = 90;

// The card's ledger lines: up to 5 rows; more than that shows the 4 largest and "+ N more lines".
export function exampleRows(rows = FREE_REPORT_EXAMPLE.rows) {
  if (rows.length <= EXAMPLE_MAX_ROWS) return { rows, more: 0 };
  const pounds = (s) => Number(String(s).replace(/[^0-9.]/g, '')) || 0;
  const top = [...rows].sort((a, b) => pounds(b.figure) - pounds(a.figure)).slice(0, 4);
  return { rows: top, more: rows.length - 4 };
}

// Shortened only by cutting at a word and adding an ellipsis — never reworded.
export function truncateCheck(text, max = EXAMPLE_CHECK_CHARS) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > 0 ? cut.slice(0, at) : cut).replace(/[\s,;:—-]+$/, '') + '…';
}
