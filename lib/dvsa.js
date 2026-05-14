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

  const data = await res.json();
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

  const data = await res.json();

  if (data.motTests) {
    data.motTests = data.motTests.map((test) => ({
      ...test,
      completedDate: formatDate(test.completedDate),
      expiryDate: formatDate(test.expiryDate),
    }));
  }

  return data;
}
