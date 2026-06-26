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
    .filter(l => !/^Minor Dents/i.test(l))
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
               : source === 'bca'     ? { cleanedDescription: rawVd.damageDescription || '' }
               : source === 'manheim' ? { cleanedDescription: rawVd.damageDescription || '' }
               : { cleanedDescription: rawVd.damageDescription || '' };

  return {
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
    secondaryDamage:  rawVd.secondaryDamage   || parsed.secondaryDamage  || null,
    additionalDamage: rawVd.additionalDamage  || parsed.additionalDamage || null,
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
  };
}
