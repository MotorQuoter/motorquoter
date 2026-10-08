// batch 229 — where a free-report visitor came from. ONE owner of the UTM rules, used by the browser (capture on
// arrival, send with the request) and the server (request route, signed link, verify). Import-free so the validator
// loads it under plain node. Attribution is best-effort: every path here returns nulls rather than throwing.

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'];
export const UTM_MAX_LEN = 100;
export const UTM_STORAGE_KEY = 'motorquoter_utm';

// One value: strings only, control characters removed, trimmed, capped at 100 chars. Anything else (number, object,
// empty after trimming) → null.
export function cleanUtmValue(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, UTM_MAX_LEN).trim();
  return s || null;
}

// The three values from any object (a POST body, a stored record, a link payload). Always all three keys.
export function cleanUtm(obj) {
  const src = obj && typeof obj === 'object' ? obj : {};
  return Object.fromEntries(UTM_KEYS.map(k => [k, cleanUtmValue(src[k])]));
}

export const hasUtm = (u) => !!u && UTM_KEYS.some(k => u[k] != null);

// The three values from a query string, or null when the URL carries none of them.
export function utmFromSearch(search) {
  let p;
  try { p = new URLSearchParams(search || ''); } catch { return null; }
  const u = cleanUtm(Object.fromEntries(UTM_KEYS.map(k => [k, p.get(k)])));
  return hasUtm(u) ? u : null;
}

// Capture on arrival — first touch wins: an existing stored record is never overwritten. No storage → no attribution.
export function captureUtm(search, storage) {
  try {
    if (!storage || storage.getItem(UTM_STORAGE_KEY)) return;
    const u = utmFromSearch(search);
    if (u) storage.setItem(UTM_STORAGE_KEY, JSON.stringify(u));
  } catch { /* storage blocked or full — no attribution, never an error */ }
}

// The stored values for the request body; all-null when nothing is stored or storage is unavailable.
export function readStoredUtm(storage) {
  try {
    const raw = storage?.getItem(UTM_STORAGE_KEY);
    return cleanUtm(raw ? JSON.parse(raw) : null);
  } catch {
    return cleanUtm(null);
  }
}
