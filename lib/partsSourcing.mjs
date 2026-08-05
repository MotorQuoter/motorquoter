// Parts Sourcing (AEP-style) — purely additive shoppable-link layer over the EXISTING costed
// basket. It NEVER changes a costed figure: the repair total, parts_sum and per-part costs are
// untouched. This module only READS the reconciled parts and emits a search link per real part.
//
// Feeds (Vincent's affiliate decision — take revenue, clearly labelled):
//   • eBay UK  — used / breaker parts (the primary feed for salvage body parts)
//   • Amazon UK — new consumables (batteries, bulbs, filters, fluids, wipers) where relevant
//
// Affiliate tracking is applied ONLY when the real credentials are supplied (server env). Until
// then the links are honest plain searches — the panel works and earns nothing, rather than
// carrying fabricated/placeholder tracking IDs. See buildAffiliateConfig() call site in the route.

// Disclosure is MANDATORY and must render visibly on the panel (web + PDF). This is the whole
// point of the "labelled" choice — never ship the links without it.
export const PARTS_SOURCING_DISCLOSURE =
  'Affiliate links — we may earn a commission if you buy through them. Our costings and advice stay independent.';

// eBay UK category 6030 = "Vehicle Parts & Accessories" — scopes the search to car parts.
const EBAY_PARTS_CATEGORY = '6030';

// Rows that are not shoppable objects — labour/paint/prep are services, not parts. Same predicate
// renderParts() uses to keep them out of the itemised parts prose.
const NON_PART_RX = /labour|paint|prep/i;

// Consumables → Amazon UK (new). Everything else → eBay UK (used / breakers). Deliberately narrow:
// only route to Amazon when the part is genuinely a new-buy consumable, else default to eBay used.
const CONSUMABLE_RX = /\b(battery|bulb|wiper|coolant|antifreeze|oil filter|air filter|cabin filter|pollen filter|spark ?plug|glow ?plug|brake pad|brake disc|brake fluid|screen ?wash|fluid)\b/i;

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// DVLA model strings are often long spec descriptors ("A 180 AMG LNE EXECUTIVE MHEV A"). For a
// used-part search the leading tokens carry the model family ("A 180", "SANTA FE", "320d") and the
// trailing trim/spec noise only hurts recall. Keep the first MODEL_SEARCH_TOKENS tokens. Tunable.
export const MODEL_SEARCH_TOKENS = 2;
function modelForSearch(model) {
  const toks = String(model || '').trim().split(/\s+/).filter(Boolean);
  return toks.slice(0, MODEL_SEARCH_TOKENS).join(' ');
}

// eBay UK search URL. Affiliate wrap uses the EPN "smart link" params (mkcid/mkrid/campid/toolid)
// appended to the destination; siteid 3 = eBay UK. Applied only when both campaign + rotation IDs
// are present — otherwise a bare search URL (no tracking).
function ebayUrl(query, aff) {
  const base = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(query)}&_sacat=${EBAY_PARTS_CATEGORY}`;
  if (aff && aff.epnCampaignId && aff.epnRotationId) {
    const params =
      `&mkcid=1&mkrid=${encodeURIComponent(aff.epnRotationId)}` +
      `&siteid=3&campid=${encodeURIComponent(aff.epnCampaignId)}&toolid=10001&mkevt=1`;
    return base + params;
  }
  return base;
}

// Amazon UK search URL. Affiliate wrap = the Associates store tag; applied only when present.
function amazonUrl(query, aff) {
  const base = `https://www.amazon.co.uk/s?k=${encodeURIComponent(query)}`;
  return aff && aff.amazonTag ? `${base}&tag=${encodeURIComponent(aff.amazonTag)}` : base;
}

// buildPartsSourcing({ parts, vehicle, affiliate })
//   parts     — the reconciled/costed basket (gatedParts / assessment._reconciledParts)
//   vehicle   — { make, model, year } for search specificity
//   affiliate — { epnCampaignId, epnRotationId, amazonTag } | null (server env)
// Returns { disclosure, links: [{ part, action, cost, feed, feedLabel, url, tracked }] }.
// Presence-gated at the call site: an empty links array means the panel does not render.
export function buildPartsSourcing({ parts, vehicle, affiliate } = {}) {
  const out = { disclosure: PARTS_SOURCING_DISCLOSURE, links: [] };
  if (!Array.isArray(parts) || parts.length === 0) return out;

  const veh = [vehicle?.make, modelForSearch(vehicle?.model), vehicle?.year]
    .map(x => (x == null ? '' : String(x).trim()))
    .filter(Boolean)
    .join(' ')
    .trim();

  const seen = new Set();
  for (const p of parts) {
    const name = (p?.name || '').trim();
    if (!name) continue;
    if (NON_PART_RX.test(name)) continue;            // labour/paint/prep — not shoppable

    const key = name.toLowerCase();
    if (seen.has(key)) continue;                     // one link per distinct part
    seen.add(key);

    const isConsumable = CONSUMABLE_RX.test(name);
    const query = veh ? `${veh} ${name}` : name;
    const cost = money(p.used ?? p.oem ?? null);
    const tracked = isConsumable
      ? !!(affiliate && affiliate.amazonTag)
      : !!(affiliate && affiliate.epnCampaignId && affiliate.epnRotationId);

    out.links.push({
      part: name,
      action: p.action === 'repair' ? 'repair' : 'replace',
      cost,
      feed: isConsumable ? 'amazon' : 'ebay',
      feedLabel: isConsumable ? 'Amazon UK · new' : 'eBay UK · used / breakers',
      url: isConsumable ? amazonUrl(query, affiliate) : ebayUrl(query, affiliate),
      tracked,
    });
  }
  return out;
}
