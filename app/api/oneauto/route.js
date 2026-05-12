import { NextResponse } from 'next/server';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const vrm = searchParams.get('vrm');
  const endpoint = searchParams.get('endpoint') || 'vehicle-and-mot';

  if (!vrm) {
    return NextResponse.json({ error: 'No registration provided' }, { status: 400 });
  }

  try {
    const response = await fetch(
      `https://api.oneautoapi.com/v1/${endpoint}?vrm=${vrm.toUpperCase().replace(/\s/g, '')}`,
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