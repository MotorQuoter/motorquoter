import { toMiles, normUnit } from '@/lib/mileageCheck';

const DVSA_API_BASE = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration';

let tokenCache = { token: null, expiresAt: 0 };

async function getDvsaToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.DVSA_CLIENT_ID,
    client_secret: process.env.DVSA_CLIENT_SECRET,
    scope: process.env.DVSA_SCOPE_URL,
  });

  const res = await fetch(process.env.DVSA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`DVSA token error: ${res.status} ${await res.text()}`);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  tokenCache = {
    token: data.access_token,
    // Subtract 60s to avoid using a token that's just about to expire
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  return tokenCache.token;
}

// DVSA dates come as "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS", or "YYYY-MM-DDTHH:MM:SS.000Z"
function formatDate(str) {
  if (!str) return str;
  const [y, m, d] = str.split(/[ T]/)[0].split('-');
  return d ? `${d}/${m}/${y}` : str;
}

// FAILED / abandoned MOT tests carry no genuine expiry. DVSA represents that as a
// 1900-01-01 sentinel (occasionally a blank), which must never surface as
// "Expires 01/01/1900". Return null so every render surface (report page + PDF)
// simply omits the expiry for those rows.
function formatExpiry(str) {
  if (!str) return null;
  if (str.split(/[ T]/)[0] === '1900-01-01') return null;
  return formatDate(str);
}

export async function getDvsaMotHistory(vrm) {
  const token = await getDvsaToken();

  const res = await fetch(`${DVSA_API_BASE}/${vrm}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-api-key': process.env.DVSA_API_KEY,
    },
  });

  if (!res.ok) {
    throw new Error(`DVSA MOT history error: ${res.status} ${await res.text()}`);
  }

  const text = await res.text();
  const data = (text && text.trim()) ? JSON.parse(text) : {};

  if (data.motTests) {
    // ── Odometer UNIT is a property of the DATA, normalised HERE, once. ──────────────
    // DVSA records each test's unit ('MI'/'KM', uppercase) and mixed units within one vehicle's
    // history are real (e.g. GY67LLD — two km readings among four mi). Every downstream reader (the
    // valuation input, the headline mileage, the PDF MOT table) previously took odometerValue raw and
    // assumed miles, so a km-latest import was priced ~61% too high. Resolve to miles at this seam so
    // no consumer can reach an unit-ambiguous value. odometerValue / odometerUnit are KEPT unchanged —
    // the screen MOT card renders them directly and cached rows depend on them.
    data.motTests = data.motTests.map((test) => ({
      ...test,
      completedDate: formatDate(test.completedDate),
      expiryDate: formatExpiry(test.expiryDate),
      odometerMiles: toMiles(test.odometerValue, test.odometerUnit),   // int miles, or null (absent/0)
      odometerRecordedValue: test.odometerValue ?? null,               // as DVSA gave it
      odometerRecordedUnit: normUnit(test.odometerUnit),               // 'mi' | 'km', resolved
    }));
  }

  // Normalise: only treat as a confirmed recall if DVSA returned explicit boolean true.
  // "Unknown", null, undefined, false, or any non-boolean truthy string → false.
  data.hasOutstandingRecall = data.hasOutstandingRecall === true;

  return data;
}
