import { NextResponse } from 'next/server';

export async function POST(request) {
  try {
    const { imageData, mediaType } = await request.json();

    if (!imageData) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }

    const base64Data = imageData.includes(',') ? imageData.split(',')[1] : imageData;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType || 'image/jpeg',
                data: base64Data
              }
            },
            {
              type: 'text',
              text: 'Look at this image and extract the vehicle registration number from the number plate. Return ONLY the registration number with no spaces, no punctuation, no explanation. If you cannot find a registration plate, return NONE.'
            }
          ]
        }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json({ error: data.error?.message || 'API error' }, { status: 500 });
    }

    const reg = data.content?.[0]?.text?.trim().toUpperCase().replace(/\s/g, '');

    if (!reg || reg === 'NONE' || reg.length < 2) {
      return NextResponse.json({ error: 'No registration plate found' }, { status: 422 });
    }

    return NextResponse.json({ reg });

  } catch (err) {
    console.error('Plate scan error:', err);
    return NextResponse.json({ error: err.message || 'Scan failed' }, { status: 500 });
  }
}