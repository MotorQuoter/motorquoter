export function getMileageForValuation({ photoOdometer = null, formMileage, listingOdometer, dvsaMileage, vehicleYear, formMileageSource = 'copart_listed' }) {
  // Step 1a: user-entered Copart mileage (already an integer from the form)
  const form = formMileage != null ? parseInt(formMileage, 10) : NaN;
  if (!isNaN(form) && form >= 1 && form <= 999999) {
    return { mileage: form, source: formMileageSource };
  }
  // Step 1b: odometer parsed from Copart listing description text
  const listingNum = listingOdometer != null
    ? (() => { const m = String(listingOdometer).replace(/,/g, '').match(/\d+/); return m ? parseInt(m[0], 10) : NaN; })()
    : NaN;
  if (!isNaN(listingNum) && listingNum >= 1 && listingNum <= 999999) {
    return { mileage: listingNum, source: 'listing_odometer' };
  }
  // Step 2: photo odometer (caller is responsible for sanity-check before passing)
  const photo = photoOdometer != null ? parseInt(photoOdometer, 10) : NaN;
  if (!isNaN(photo) && photo >= 1 && photo <= 999999) {
    return { mileage: photo, source: 'photo_odometer' };
  }
  // Step 3: DVSA last MOT mileage
  const dvsa = dvsaMileage != null ? parseInt(String(dvsaMileage).replace(/,/g, ''), 10) : NaN;
  if (!isNaN(dvsa) && dvsa >= 1) {
    return { mileage: dvsa, source: 'dvsa_mot' };
  }
  // Step 4/5: age-based estimate — ≤4yr is normal estimate; >4yr is anomaly (log and flag heavily)
  const currentYear = new Date().getFullYear();
  const year = vehicleYear != null ? parseInt(String(vehicleYear), 10) : NaN;
  if (!isNaN(year) && year >= 1970 && year <= currentYear) {
    const ageYears = currentYear - year;
    const estimated = ageYears < 1 ? 5000 : Math.min(ageYears * 15000, 999999);
    return { mileage: estimated, source: ageYears <= 4 ? 'age_estimate' : 'age_anomaly', ageYears };
  }
  return { mileage: 50000, source: 'default_fallback' };
}
