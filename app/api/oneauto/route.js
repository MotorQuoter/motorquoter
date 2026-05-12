import { NextResponse } from 'next/server';

const BASE_URL = 'https://sandbox.oneautoapi.com';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const vrm = searchParams.get('vrm');
  const endpoint = searchParams.get('endpoint');

  if (!vrm || !endpoint) {
    return NextResponse.json({ error: 'vrm and endpoint required' }, { status: 400 });
  }

  // Build query params — pass through all except vrm and endpoint
  const params = new URLSearchParams();
  params.set('vehicle_registration_mark', vrm.toUpperCase().replace(/\s/g, ''));
  searchParams.forEach((value, key) => {
    if (key !== 'vrm' && key !== 'endpoint') {
      params.set(key, value);
    }
  });

  try {
    const response = await fetch(
      `${BASE_URL}/${endpoint}?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'x-api-key': process.env.ONE_AUTO_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json({ error: data.message || 'One Auto API error' }, { status: response.status });
    }

    return NextResponse.json(data);

  } catch (err) {
    console.error('One Auto API error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}