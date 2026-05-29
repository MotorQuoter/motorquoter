export function getMileageForValuation({ formMileage, dvsaMileage, formMileageSource = 'copart_listed' }) {
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
