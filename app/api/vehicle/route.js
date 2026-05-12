import { NextResponse } from 'next/server';

const ONE_AUTO_BASE = 'https://sandbox.oneautoapi.com';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const vrm = searchParams.get('vrm');

  if (!vrm) {
    return NextResponse.json({ error: 'No registration provided' }, { status: 400 });
  }

  const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');

  try {
    // Call DVLA and MOT history in parallel
    const [dvlaRes, motRes] = await Promise.all([
      fetch(
        'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles',
        {
          method: 'POST',
          headers: {
            'x-api-key': process.env.DVLA_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ registrationNumber: cleanVrm })
        }
      ),
      fetch(
        `${ONE_AUTO_BASE}/oneauto/mothistoryandtaxstatus/v2?vehicle_registration_mark=${cleanVrm}`,
        {
          headers: {
            'x-api-key': process.env.ONE_AUTO_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      )
    ]);

    const dvla = await dvlaRes.json();
    const mot = await motRes.json();

    if (!dvlaRes.ok) {
      return NextResponse.json({ error: dvla.message || 'DVLA lookup failed' }, { status: dvlaRes.status });
    }

    // Extract MOT data
    const motTests = mot?.result?.dvsa_data?.mot_tests || [];
    const latestMot = motTests[0] || null;

    return NextResponse.json({
      make: dvla.make,
      colour: dvla.colour,
      fuelType: dvla.fuelType,
      engineSize: dvla.engineCapacity ? `${dvla.engineCapacity}cc` : null,
      yearOfManufacture: dvla.yearOfManufacture,
      taxStatus: dvla.taxStatus,
      taxDueDate: dvla.taxDueDate,
      motStatus: dvla.motStatus,
      motExpiryDate: latestMot?.mot_expiry_date || null,
      motMileage: latestMot?.observation_mileage || null,
      motResult: latestMot?.mot_test_result || null,
      motHistory: motTests,
      co2Emissions: dvla.co2Emissions,
      dateOfLastV5CIssued: dvla.dateOfLastV5CIssued,
      monthOfFirstRegistration: dvla.monthOfFirstRegistration,
    });

  } catch (err) {
    console.error('Vehicle lookup error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}