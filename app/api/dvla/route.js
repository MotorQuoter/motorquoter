import { NextResponse } from 'next/server';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const reg = searchParams.get('reg');

  if (!reg) {
    return NextResponse.json({ error: 'No registration provided' }, { status: 400 });
  }

  try {
    const response = await fetch(
      `https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles`,
      {
        method: 'POST',
        headers: {
          'x-api-key': process.env.DVLA_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          registrationNumber: reg.toUpperCase().replace(/\s/g, '')
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json({ error: data.message || 'DVLA lookup failed' }, { status: response.status });
    }

    return NextResponse.json(data);

  } catch (err) {
    console.error('DVLA error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}