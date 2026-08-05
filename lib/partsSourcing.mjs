// Parts Sourcing (AEP-style) — purely additive shoppable-link layer over the EXISTING costed
// basket. It NEVER changes a costed figure: the repair total, parts_sum and per-part costs are
// untouched. This module only READS the reconciled parts and emits an eBay UK search link per part.
//
// Feed (Vincent's affiliate decision — take revenue, clearly labelled):
//   • eBay UK — the PRIMARY and only feed wired now. Salvage / breaker parts live on eBay UK.
//
// Amazon is SECONDARY and deliberately NOT wired yet (it needs PA-API + a 3-sales-in-180-days
// conditional-approval period). The routing is single-feed by design; if Amazon is added later it
// slots in beside ebayUrl() without disturbing the eBay path.
//
// eBay Partner Network (EPN) tracking is applied ONLY when the campaign ID is supplied (server
// env). Vincent's EPN application isn't filed/approved yet, so until the ID is set the links are
// honest plain eBay UK searches (no campid) — the panel is build-complete and simply switches
// live when the ID lands. No broken/empty-campid links ever ship.

// Disclosure is MANDATORY and must render visibly on the panel (web + PDF). This is the whole
// point of the "labelled" choice — never ship the links without it.
export const PARTS_SOURCING_DISCLOSURE =
  'Affiliate links — we may earn a commission. Pricing and advice are independent.';

// eBay UK search host. Category 6030 = "Vehicle Parts & Accessories" — scopes to car parts.
const EBAY_SEARCH_BASE = 'https://www.ebay.co.uk/sch/i.html';
const EBAY_PARTS_CATEGORY = '6030';

// ── EPN link template — the ONE place the affiliate params live ───────────────────────────────
// IMPORTANT: eBay's EPN "smart link" param set (mkcid / mkrid / campid / customid / toolid) and the
// UK rotation id (mkrid) must be CONFIRMED against the live EPN dashboard AT WIRING TIME — do not
// treat the values below as authoritative. They are the documented smart-link shape so the code is
// structurally complete; when Vincent's EPN account is approved, verify mkrid/toolid on the
// dashboard and adjust here only. campid + customid are runtime (env); the rest are the template.
const EPN_TEMPLATE = {
  mkcid: '1',                    // 1 = affiliate link
  mkrid: '711-53200-19255-0',    // eBay UK rover rotation — CONFIRM against EPN dashboard at go-live
  siteid: '3',                   // 3 = eBay UK
  toolid: '10001',               // CONFIRM against EPN dashboard at go-live
  mkevt: '1',
};

// Apply EPN params to an eBay URL. Returns the url unchanged when no campaign ID is configured,
// so an unfiled/unapproved account yields plain (untracked) search links rather than broken ones.
function applyEpn(url, epn) {
  if (!epn || !epn.campaignId) return url;
  const params = new URLSearchParams({
    mkcid: EPN_TEMPLATE.mkcid,
    mkrid: EPN_TEMPLATE.mkrid,
    siteid: EPN_TEMPLATE.siteid,
    campid: String(epn.campaignId),
    toolid: EPN_TEMPLATE.toolid,
    mkevt: EPN_TEMPLATE.mkevt,
  });
  if (epn.customId) params.set('customid', String(epn.customId));
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${params.toString()}`;
}

function ebayUrl(query, epn) {
  const base = `${EBAY_SEARCH_BASE}?_nkw=${encodeURIComponent(query)}&_sacat=${EBAY_PARTS_CATEGORY}`;
  return applyEpn(base, epn);
}

// Rows that are not shoppable objects — labour/paint/prep are services, not parts. Same predicate
// renderParts() uses to keep them out of the itemised parts prose.
const NON_PART_RX = /labour|paint|prep/i;

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

// buildPartsSourcing({ parts, vehicle, epn })
//   parts   — the reconciled/costed basket (gatedParts / assessment._reconciledParts)
//   vehicle — { make, model, year } for search specificity
//   epn     — { campaignId, customId } | null (server env). campaignId absent → plain search links.
// Returns { disclosure, links: [{ part, action, cost, feed, feedLabel, url, tracked }] }.
// Presence-gated at the call site: an empty links array means the panel does not render.
export function buildPartsSourcing({ parts, vehicle, epn } = {}) {
  const out = { disclosure: PARTS_SOURCING_DISCLOSURE, links: [] };
  if (!Array.isArray(parts) || parts.length === 0) return out;

  const veh = [vehicle?.make, modelForSearch(vehicle?.model), vehicle?.year]
    .map(x => (x == null ? '' : String(x).trim()))
    .filter(Boolean)
    .join(' ')
    .trim();

  const tracked = !!(epn && epn.campaignId);
  const seen = new Set();
  for (const p of parts) {
    const name = (p?.name || '').trim();
    if (!name) continue;
    if (NON_PART_RX.test(name)) continue;            // labour/paint/prep — not shoppable

    const key = name.toLowerCase();
    if (seen.has(key)) continue;                     // one link per distinct part
    seen.add(key);

    const query = veh ? `${veh} ${name}` : name;
    out.links.push({
      part: name,
      action: p.action === 'repair' ? 'repair' : 'replace',
      cost: money(p.used ?? p.oem ?? null),
      feed: 'ebay',
      feedLabel: 'eBay UK · used / breakers',
      url: ebayUrl(query, epn),
      tracked,
    });
  }
  return out;
}
