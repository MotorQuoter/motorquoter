import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request) {
  try {
    const { imageData, mediaType } = await request.json();

    if (!imageData) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData }
          },
          {
            type: 'text',
            text: 'Look at this image and extract the vehicle registration number from the number plate. Return ONLY the registration number with no spaces, no punctuation, no explanation. If you cannot find a registration plate, return NONE.'
          }
        ]
      }]
    });

    const reg = response.content?.[0]?.text?.trim().toUpperCase().replace(/\s/g, '');

    if (!reg || reg === 'NONE' || reg.length < 2) {
      return NextResponse.json({ error: 'No plate found' });
    }

    return NextResponse.json({ reg });

  } catch (err) {
    console.error('Plate scan error:', err);
    return NextResponse.json({ error: 'Scan failed' }, { status: 500 });
  }
}