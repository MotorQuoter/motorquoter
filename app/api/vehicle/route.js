import { NextResponse } from 'next/server';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const vrm = searchParams.get('vrm');

  if (!vrm) {
    return NextResponse.json({ error: 'Registration number required' }, { status: 400 });
  }

  try {
    const url = `https://api.oneautoapi.com/ukvehicledata/vehicledatafromvrm/v2?vehicle_registration_mark=${vrm.replace(/\s/g, '').toUpperCase()}`;

    const response = await fetch(url, {
      headers: {
        'x-api-key': process.env.ONE_AUTO_API_KEY,
      },
    });

    const data = await response.json();

    if (!data.success) {
      return NextResponse.json({ error: 'Vehicle not found', detail: data }, { status: 404 });
    }

    const v = data.result;

    return NextResponse.json({
      success: true,
      registration: v.vehicle_registration_mark,
      make: v.make,
      model: v.model,
      colour: v.colour,
      fuelType: v.fuel_type,
      engineSize: v.engine_capacity,
      yearOfManufacture: v.year_of_manufacture,
      taxStatus: v.tax_status,
      taxDueDate: v.tax_due_date,
      motStatus: v.mot_status,
      motExpiryDate: v.mot_expiry_date,
    });

  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}