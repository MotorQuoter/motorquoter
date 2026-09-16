// Single owner of the footer sentence that explains WHAT THE REPAIR FIGURE IS, shared by the web
// report (app/salvage/success/page.js) and the PDF (app/api/salvage/pdf/route.js) so the two can
// never drift. The surrounding footer copy legitimately differs between screen and print; only this
// claim about the money is shared, because only this claim can be wrong about the money.
//
// batch 142 R4 (Vincent, 16 Sep). The old sentence was:
//
//   "The repair figure is the sum of itemised parts costed as visible in the photos. Items not
//    independently confirmable appear in Inspection Flags and italic allowance rows and are not in
//    this figure."
//
// Two things wrong with it:
//   1. "the sum of itemised parts" LEFT OUT LABOUR AND PAINT, which are in the total (the
//      "Labour & paint" row) — HV25ODX: parts + labour = £5,695, not the parts alone.
//   2. "items ... appear in Inspection Flags ... and are not in this figure" is FALSE for the
//      from-£500 floors. The structural jig/geometry floor (batch 106) and the SRS airbag floor
//      (batch 130) are BOTH shown in Inspection Flags AND counted in the repair total. The footer
//      told the buyer his £500 structure floor and his £500 airbag floor were excluded when they
//      were charged — on HV25ODX that is £1,000 of the £5,695 he was told he was not paying.
//
// The floors say "from £X" on their own rows, so the sentence names them rather than pretending
// every flagged item is uncosted.
//
// The figure is INTERPOLATED from the two floor constants, never typed here: a literal would be a
// second place to update, and batch 131's bare-£500 detector (validate-from-floor) rightly fails any
// "£500" in the rendered PDF that is not preceded by "from ". Both floors are £500 today; if they
// ever diverge the sentence names them separately rather than quoting one figure for both.
import { STRUCT_FLOOR_GBP, SRS_FLOOR_GBP } from '../lib/labour.mjs';

const gbp = (n) => `£${Number(n).toLocaleString('en-GB')}`;
const FLOORS = STRUCT_FLOOR_GBP === SRS_FLOOR_GBP
  ? `the structural-work and airbag floors shown there, each from ${gbp(STRUCT_FLOOR_GBP)}`
  : `the structural-work floor shown there from ${gbp(STRUCT_FLOOR_GBP)} and the airbag floor from ${gbp(SRS_FLOOR_GBP)}`;

export const REPAIR_FIGURE_FOOTER =
  'The repair figure is the sum of the itemised parts, labour and paint in the breakdown above, '
  + `and it includes ${FLOORS}. `
  + 'Other items in the Inspection Flags are not costed.';
