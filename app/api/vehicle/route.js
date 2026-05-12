import { NextResponse } from 'next/server';

const ONE_AUTO_BASE = 'https://api.oneautoapi.com';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const vrm = searchParams.get('vrm');
  const tier = searchParams.get('tier') || 'free';
  const mileage = searchParams.get('mileage') || '50000';
  const cleanMileage = mileage.replace(/,/g, '');

  if (!vrm) {
    return NextResponse.json({ error: 'No registration provided' }, { status: 400 });
  }

  const cleanVrm = vrm.toUpperCase().replace(/\s/g, '');

  try {
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
            'x-api-key': process.env.ONE_AUTO_API_KEY
          }
        }
      )
    ]);

    const dvla = await dvlaRes.json();
    const mot = await motRes.json();

    if (!dvlaRes.ok) {
      return NextResponse.json({ error: dvla.message || 'DVLA lookup failed' }, { status: dvlaRes.status });
    }

    const motTests = mot?.result?.dvsa_data?.mot_tests || [];
    const latestMot = motTests[0] || null;

    let autocheck = null;
    let valuation = null;

    if (tier === 'standard' || tier === 'pro') {
      const [autocheckRes, bregoRes] = await Promise.all([
        fetch(
          `${ONE_AUTO_BASE}/experian/autocheck/v3?vehicle_registration_mark=${cleanVrm}`,
          { headers: { 'x-api-key': process.env.ONE_AUTO_API_KEY } }
        ),
        fetch(
          `${ONE_AUTO_BASE}/brego/valuationfromvrm/v2?vehicle_registration_mark=${cleanVrm}&current_mileage=${cleanMileage}`,
          { headers: { 'x-api-key': process.env.ONE_AUTO_API_KEY } }
        )
      ]);

      autocheck = await autocheckRes.json();
      valuation = await bregoRes.json();
    }

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
      autocheck: autocheck?.result || null,
      valuation: valuation?.result || null,
    });

  } catch (err) {
    console.error('Vehicle lookup error:', err);
    return NextResponse.json({ error: err.message || 'Lookup failed' }, { status: 500 });
  }
}