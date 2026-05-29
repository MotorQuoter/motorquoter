export function getMileageForValuation({ photoOdometer = null, formMileage, dvsaMileage, formMileageSource = 'copart_listed' }) {
  const photo = photoOdometer != null ? parseInt(photoOdometer, 10) : NaN;
  if (!isNaN(photo) && photo >= 1 && photo <= 999999) {
    return { mileage: photo, source: 'photo_odometer' };
  }
  const form = formMileage != null ? parseInt(formMileage, 10) : NaN;
  if (!isNaN(form) && form >= 1 && form <= 999999) {
    return { mileage: form, source: formMileageSource };
  }
  const dvsa = dvsaMileage != null ? parseInt(String(dvsaMileage).replace(/,/g, ''), 10) : NaN;
  if (!isNaN(dvsa) && dvsa >= 1) {
    return { mileage: dvsa, source: 'dvsa_mot' };
  }
  return { mileage: 50000, source: 'default_fallback' };
}
