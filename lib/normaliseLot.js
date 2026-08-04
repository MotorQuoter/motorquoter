// Source-routed normaliser — produces a canonical vehicle-details object from the raw
// session.vehicle_details blob. Category is separated from damage text at normalisation,
// for every source, by construction. The category field and the damageDescription field
// are always independent: the cleaned blob never carries the category label or value.
//
// BCA/Manheim stubs pass the blob through unchanged with structured fields null —
// matches current behaviour for non-Copart sources (the Copart-specific label patterns
// never matched non-Copart text, so all structured fields were already null for those).
// Note: the Copart noise-strip filters (cleanCopartDescription) are NOT applied to
// non-Copart blobs — those filter rules are Copart-specific and could strip valid content
// from other sources.

// Truncate at the VAT line — the primary defence against the decoy-vehicle block.
// The Copart page always ends vehicle data at "VAT to be added to final price:" + value.
// Everything below (Highlights, Similar vehicles, name/email, footer) is discarded here
// so neither the structured-field extraction nor cleanedDescription ever sees the noise.
// Falls back to the full text if the VAT line is absent (format variance).
function truncateAtVAT(raw) {
  if (!raw) return raw;
  const m = raw.match(/^VAT to be added[^\n]*/im);
  if (!m) return raw;
  const end = m.index + m[0].length;
  // If value is on the NEXT line (e.g. "VAT to be added to final price:\nNo"), capture it too.
  const rest = raw.slice(end);
  const nextVal = rest.match(/^\s*\n\s*(Yes|No)\b/i);
  if (nextVal) return raw.slice(0, end + nextVal[0].length);
  return raw.slice(0, end);
}

// Closed list of Copart handling-liability boilerplate values that are NOT damage
// evidence. Shared by BOTH the structured-field filter (secondary/additional only —
// primary is never filtered) and the blob line-scrub below, so the two can never
// disagree. Vincent-dictated; do not extend without a ruling.
export const BOILERPLATE_DAMAGE_VALUES = ['Minor Dents/scratches'];

const _boilerplateSet = new Set(BOILERPLATE_DAMAGE_VALUES.map(v => v.trim().toLowerCase()));

// Exact full-value match, case-insensitive, both sides trimmed. NOT substring — a
// value like "Minor Dents/scratches Front End" carries a real zone and must pass through.
function isBoilerplateDamage(value) {
  if (value == null) return false;
  return _boilerplateSet.has(String(value).trim().toLowerCase());
}

// Structured-field guard: strip a boilerplate value to null and log; else pass through.
// Silence when nothing strips.
function filterBoilerplateDamage(fieldName, value) {
  if (isBoilerplateDamage(value)) {
    console.log(`[BOILERPLATE FILTER] field=${fieldName} stripped="${value}"`);
    return null;
  }
  return value;
}

// ── Sale-date capture + STRICT parse (4f C-6) ──────────────────────────────────
// The Copart "Sale date:" value appears in ONE observed format: "Mon. Jun 15, 2026 12:30 PM GMT+1"
// (weekday-dot, month-name, day, year, 12h time, GMT±N). Date.parse is NOT trusted on the GMT±N
// suffix — the string is parsed by hand into { ms, offsetH }. Anything not matching this exact shape
// returns null (parse failure → the render falls back to generic 48h wording; never a computed date).
const _SALE_MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function parseCopartSaleDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.trim().match(/^[A-Za-z]{3}\.?\s+([A-Za-z]{3})\.?\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s+GMT([+-]\d{1,2})$/i);
  if (!m) return null;
  const mon = _SALE_MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]), year = Number(m[3]), min = Number(m[5]), offsetH = Number(m[7]);
  let hour = Number(m[4]);
  const ap = m[6].toUpperCase();
  if (mon == null || day < 1 || day > 31 || hour < 1 || hour > 12 || min > 59) return null;
  if (ap === 'PM' && hour !== 12) hour += 12;
  if (ap === 'AM' && hour === 12) hour = 0;
  const ms = Date.UTC(year, mon, day, hour, min) - offsetH * 3600000; // local wall-clock at GMT±N → UTC epoch
  if (!Number.isFinite(ms)) return null;
  return { ms, offsetH };
}

function cleanCopartDescription(raw) {
  if (!raw) return '';
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !/^Category:/i.test(l))           // category label + value stripped here
    .filter(l => !/thumbnail/i.test(l))
    .filter(l => !/^https?:\/\//i.test(l))
    .filter(l => !/^VIN:/i.test(l))
    .filter(l => !/^Lot number:/i.test(l))
    .filter(l => !/^Lane\/Item:/i.test(l))
    .filter(l => !/^Sale name:/i.test(l))
    .filter(l => !/^Sale date:/i.test(l))
    .filter(l => !/^Location:/i.test(l))
    .filter(l => !/^\d+\/\d+$/.test(l))
    .filter(l => !/^Watchlist$/i.test(l))
    .filter(l => !/^HD$/i.test(l))
    .filter(l => !/VIEW FULL VEHICLE/i.test(l))
    .filter(l => !/^Estimated retail value:\s*$/i.test(l))
    .filter(l => !/^Transmission:\s*$/i.test(l))
    .filter(l => !/^2 AXLE RIGID BODY/i.test(l))
    .filter(l => !/^Drive:/i.test(l))
    .filter(l => !/^Transmission engages/i.test(l))
    .filter(l => !/^1 Speed/i.test(l))
    .filter(l => !/^2 Speed/i.test(l))
    .filter(l => !/^\d+ Speed/i.test(l))
    .filter(l => !/^Gears engage/i.test(l))
    .filter(l => !/^Physical V5/i.test(l))
    .filter(l => !/^Auction countdown/i.test(l))
    .filter(l => !/^Minimum bid/i.test(l))
    .filter(l => !/^Seller reserve/i.test(l))
    .filter(l => !isBoilerplateDamage(l))          // boilerplate values (shared constant) — a line that IS one drops
    .filter(l => !/^Front End$/i.test(l))
    .filter(l => !/^Rear End$/i.test(l))
    .filter(l => !/^No V5/i.test(l))
    .filter(l => !/^N REPAIRABLE/i.test(l))
    .filter(l => !/^S REPAIRABLE/i.test(l))
    .filter(l => !/^Water\/flood/i.test(l))
    .filter(l => !/^VAT to be added/i.test(l))
    .filter(l => !/^Yes$/i.test(l))
    .filter(l => !/^No$/i.test(l))
    .filter(l => /[a-zA-Z]{4,}/.test(l))
    .join('\n')
    .trim();
}

// ── IAA UK / SYNETIQ paste parser ───────────────────────────────────────────
// IAA/SYNETIQ paste is a bullet list where each line is "Label Value" — but the
// spacing is inconsistent (sometimes "KeysYes", sometimes "Odometer Unverified 62,955").
// There are NO colons and NO primary/secondary damage fields: IAA gives category +
// a short description + condition flags only. We match each known label as a line
// PREFIX (space-tolerant) and capture the remainder. The Copart noise-strip
// (cleanCopartDescription) is deliberately NOT used — its rules are Copart-specific.
//
// Canonical output forms are VERIFIED against the Copart path's downstream consumers
// (not the raw IAA wording):
//   • category → "S REPAIRABLE STRUCTURAL" / "N REPAIRABLE NON STRUCTURAL" (A/B → "Cat A"/"Cat B")
//     so catLetter() (route.js) and categoryDirective() (booking.mjs) read the letter.
//   • runCondition → "Runs and drives" / "Engine starts" / "Does not run" — the actual Copart
//     vocabulary; the EV-presence gate tests /runs?\s+and\s+drives?/i, which a novel string
//     like "Starts & drives" would fail.
//   • odometer → bare comma form "62,955" (matches Copart "41,716"); a qualifier concatenated
//     in would NaN at salvage/page.js. The qualifier is kept separately (odometerQualifier).
function iaaLabelValue(lines, label) {
  const lower = label.toLowerCase();
  for (const l of lines) {
    if (l.toLowerCase().startsWith(lower)) return l.slice(label.length).trim();
  }
  return null;
}

function parseIaaSynetiq(raw) {
  if (!raw || typeof raw !== 'string') return { cleanedDescription: '' };
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const yes = v => /^yes\b/i.test(v || '');
  const no  = v => /^no\b/i.test(v || '');

  // Registration — may be redacted (label with empty value)
  const regRaw = iaaLabelValue(lines, 'Registration');
  const vrn = regRaw ? regRaw.toUpperCase().replace(/\s+/g, '') || null : null;

  // Category — trailing letter is authoritative; emit the Copart canonical form.
  const catRaw = iaaLabelValue(lines, 'Category');
  let category = null;
  if (catRaw) {
    const m = catRaw.match(/([snab])\s*$/i);
    const letter = m ? m[1].toUpperCase() : null;
    category = letter === 'S' ? 'S REPAIRABLE STRUCTURAL'
             : letter === 'N' ? 'N REPAIRABLE NON STRUCTURAL'
             : letter === 'A' ? 'Cat A'
             : letter === 'B' ? 'Cat B'
             : null;
  }

  // Odometer — "Unverified 62,955" → number "62,955" + separate qualifier.
  const odoRaw = iaaLabelValue(lines, 'Odometer');
  let odometer = null, odometerQualifier = null;
  if (odoRaw) {
    const q = odoRaw.match(/^(Unverified|Verified|Warranted)\b/i);
    odometerQualifier = q ? q[1][0].toUpperCase() + q[1].slice(1).toLowerCase() : null;
    const num = odoRaw.match(/(\d[\d,]*)/);
    odometer = num ? num[1] : null;
  }

  // Run condition — synthesise the Copart vocabulary from the two boolean flags.
  const starts = iaaLabelValue(lines, 'Engine starts');
  const drives = iaaLabelValue(lines, 'Drivetrain drives');
  let runCondition = null;
  if (no(starts)) runCondition = 'Does not run';
  else if (yes(starts) && yes(drives)) runCondition = 'Runs and drives';
  else if (yes(starts)) runCondition = 'Engine starts';
  else if (yes(drives)) runCondition = 'Runs and drives';
  else if (no(drives)) runCondition = 'Does not run';

  // Engine spec line ("Engine 1996cc DIESEL TURBO CHARGED") — NOT the "Engine starts" line.
  const engineSpec = lines.find(l => /^Engine\b/i.test(l) && /\d{3,5}\s*cc/i.test(l)) || '';
  const ccM = engineSpec.match(/(\d{3,5})\s*cc/i);
  const engineSize = ccM ? `${ccM[1]}cc` : null;
  const fuel = /electric/i.test(engineSpec) ? 'Electric'
             : /hybrid/i.test(engineSpec)   ? 'Hybrid'
             : /diesel/i.test(engineSpec)   ? 'Diesel'
             : /petrol/i.test(engineSpec)   ? 'Petrol'
             : null;

  const gearRaw = iaaLabelValue(lines, 'Gearbox');
  const transmission = gearRaw
    ? (/auto/i.test(gearRaw) ? 'Automatic' : /manual/i.test(gearRaw) ? 'Manual'
       : gearRaw[0].toUpperCase() + gearRaw.slice(1).toLowerCase())
    : null;

  // Body style — "5 DOOR HATCHBACK" from the title / Vehicle line (Body line is a class code).
  const bodyM = raw.match(/(\d)\s*DOOR\s+([A-Z]+)/i);
  const bodyStyle = bodyM ? bodyM[0].replace(/\s+/g, ' ').toUpperCase() : null;

  // VAT — presence of the VAT-subject line means the hammer is VAT-qualifying.
  const vatLine = lines.find(l => /^VAT\b/i.test(l) && /subject to VAT/i.test(l));
  const vatOnSale = vatLine ? 'Yes' : 'No';

  const v5Raw = iaaLabelValue(lines, 'V5 Document');
  const v5Status = v5Raw ? (yes(v5Raw) ? 'Yes' : no(v5Raw) ? 'No' : v5Raw) : null;

  const lotNumber = iaaLabelValue(lines, 'Item ref no.') || null;

  // Description — IAA's own light clean: take the Description value only. IAA has no
  // primary/secondary damage fields, so the cleaned blob is the short seller note.
  // Category label/value never enters here (separate field), preserving the invariant.
  const descRaw = iaaLabelValue(lines, 'Description');
  const cleanedDescription = descRaw ? descRaw.trim() : '';

  return {
    vrn,
    category,
    runCondition,
    odometer,
    odometerQualifier,
    keys:             iaaLabelValue(lines, 'Keys'),
    fuel,
    transmission,
    bodyStyle,
    colour:           null,
    engineSize,
    primaryDamage:    null,
    secondaryDamage:  null,
    additionalDamage: null,
    estimatedRetail:  null,
    vatOnSale,
    v5Status,
    lotNumber,
    saleDateRaw:      null,
    cleanedDescription,
  };
}

function parseCopart(raw) {
  if (!raw) return { cleanedDescription: '' };
  const truncated = truncateAtVAT(raw);
  const get = (pattern) => {
    const m = truncated.match(pattern);
    return m ? m[1].trim() : null;
  };
  const vrnRaw = get(/VRN:\s*([^\n]+)/i);
  const vrn = vrnRaw ? vrnRaw.toUpperCase().replace(/\s+/g, '') : null;
  const vatOnSale = get(/VAT to be added[^:\n]*(?::\s*|\s*\r?\n\s*)(Yes|No)/i);
  if (!vatOnSale && /VAT\s+to\s+be\s+added/i.test(truncated)) {
    console.warn('[VAT PARSE] possible missed VAT flag: "VAT to be added" found in listing but vatOnSale parsed as null');
  }
  return {
    vrn,
    category:         get(/^Category:\s*([^\n]+)/im),
    runCondition:     get(/Run condition:\s*\n?([^\n]+)/i),
    odometer:         get(/Odometer:\s*\n?([^\n]+)/i),
    keys:             get(/Has key:\s*\n?([^\n]+)/i),
    fuel:             get(/Fuel:\s*\n?([^\n]+)/i),
    transmission:     get(/Transmission:\s*\n?([^\n]+)/i),
    bodyStyle:        (() => { const v = get(/Body style:\s*\n?([^\n]+)/i); return (v && !/:\s*$/.test(v)) ? v : null; })(),
    colour:           get(/Colour:\s*\n?([^\n]+)/i),
    engineSize:       get(/Engine type:\s*\n?([^\n]+)/i),
    primaryDamage:    get(/Primary damage:\s*\n?([^\n]+)/i),
    secondaryDamage:  get(/Secondary damage:\s*\n?([^\n]+)/i),
    additionalDamage: get(/Additional damage[^:]*:\s*\n?([^\n]+)/i),
    estimatedRetail:  get(/Estimated retail value:\s*\n?([^\n]+)/i),
    vatOnSale,
    v5Status:         get(/V5 available:\s*\n?([^\n]+)/i),
    lotNumber:        get(/Lot number:\s*\n?([^\n]+)/i),
    // Sale date — NOT line-anchored: labels can concatenate ("Sale name:WHITBURNSale date:Mon. Jun 15,
    // 2026 12:30 PM GMT+1Location:…"). Capture the value substring up to the next Label: or line end;
    // the strict parser (parseCopartSaleDate) is the real gate — a bad capture simply fails to null.
    saleDateRaw:      (() => { const mm = truncated.match(/Sale date:\s*([^\n]*?)\s*(?=[A-Z][a-z]+:|$)/im); return mm ? mm[1].trim() : null; })(),
    cleanedDescription: cleanCopartDescription(truncated),
  };
}

// Normalises raw session.vehicle_details into a canonical object consumed by route.js,
// slot builders, and contextLines. Category is always its own field; the cleaned
// damageDescription blob never carries the category label or value.
//
// Merge rule: uses || (not ??) — matches the original inline merge behaviour where
// an empty string from the form is treated as absent and falls through to the parsed
// value. This preserves exact field values vs the inline code it replaces.
//
// bodyStyle merge: user-supplied input (rawVd.bodyStyle, tier 3) wins over the
// Copart listing parse (parsed.bodyStyle, tier 2). Both absent → null.
export function normaliseLot(rawVd) {
  const source = rawVd.auctionSource || 'copart';
  // Parse from the IMMUTABLE original paste (rawCopartPaste), written once at first submit
  // and never overwritten. Re-assess/rerun therefore re-derive identical Copart fields
  // (idempotent). Fallback to damageDescription for legacy rows created before the field
  // existed — those parse transitionally, with the category field still surviving the merge.
  const rawCopart = rawVd.rawCopartPaste || rawVd.damageDescription;
  const parsed = source === 'copart'  ? parseCopart(rawCopart)
               : source === 'iaa'     ? parseIaaSynetiq(rawCopart)
               : source === 'bca'     ? { cleanedDescription: rawVd.damageDescription || '' }
               : source === 'manheim' ? { cleanedDescription: rawVd.damageDescription || '' }
               : { cleanedDescription: rawVd.damageDescription || '' };

  const out = {
    ...rawVd,
    vrm:              rawVd.vrm              || parsed.vrn              || null,
    category:         rawVd.category         || parsed.category         || null,
    runCondition:     rawVd.runCondition      || parsed.runCondition     || null,
    odometer:         rawVd.odometer          || parsed.odometer         || null,
    keys:             rawVd.keys              || parsed.keys             || null,
    fuel:             rawVd.fuel              || parsed.fuel             || null,
    transmission:     rawVd.transmission      || parsed.transmission     || null,
    colour:           rawVd.colour            || parsed.colour           || null,
    engineSize:       rawVd.engineSize        || parsed.engineSize       || null,
    primaryDamage:    rawVd.primaryDamage     || parsed.primaryDamage    || null,
    // Boilerplate filter applied POST-merge (catches rawVd.* form-supplied and parsed alike).
    // Secondary/additional ONLY — primaryDamage is never filtered (protects hasDamageText).
    secondaryDamage:  filterBoilerplateDamage('secondaryDamage',  rawVd.secondaryDamage   || parsed.secondaryDamage  || null),
    additionalDamage: filterBoilerplateDamage('additionalDamage', rawVd.additionalDamage  || parsed.additionalDamage || null),
    estimatedRetail:  rawVd.estimatedRetail   || parsed.estimatedRetail  || null,
    vatOnSale:        rawVd.vatOnSale         || parsed.vatOnSale        || null,
    v5Status:         rawVd.v5Status          || parsed.v5Status         || null,
    lotNumber:        rawVd.lotNumber         || parsed.lotNumber        || null,
    bodyStyle:        rawVd.bodyStyle         || parsed.bodyStyle        || null,
    // Immutable source — preserved verbatim on every normalise so the assess-time write-back
    // (enrichedVd) never destroys it. Source (rawCopartPaste) and derivative
    // (damageDescription = cleaned blob) are separate fields; never collapse one onto the other.
    rawCopartPaste:   rawVd.rawCopartPaste || null,
    damageDescription: parsed.cleanedDescription,
    // 4f C-6 booking reminder: raw sale-date substring + strict parse ({ ms, offsetH } | null).
    saleDateRaw:      rawVd.saleDateRaw || parsed.saleDateRaw || null,
    saleDate:         parseCopartSaleDate(rawVd.saleDateRaw || parsed.saleDateRaw || null),
  };

  // Odometer qualifier (IAA-only: Unverified/Verified/Warranted) — attached CONDITIONALLY
  // so the Copart key-set stays byte-identical (the normaliser invariance validator fails on
  // any new key). Copart never produces this, so Copart lots are untouched.
  const odoQual = rawVd.odometerQualifier || parsed.odometerQualifier || null;
  if (odoQual) out.odometerQualifier = odoQual;

  return out;
}
