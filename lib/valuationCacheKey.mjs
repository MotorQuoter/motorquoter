// Finding 2 (audit): a cached VALUATION is computed at the entered mileage, so two customers looking
// up the same reg at DIFFERENT mileages must NOT share it. This normalises the entered mileage into a
// cache-key fragment — a different mileage becomes a different key (a repeat lookup at the SAME mileage
// still legitimately hits). Absent/blank/invalid → 'def', matching the valuation's own blank→default
// behaviour, so every default-mileage lookup of a reg still shares one entry.
export function mileageCacheKeyPart(mileage) {
  const digits = String(mileage || '').replace(/[^0-9]/g, '');
  return digits && Number(digits) >= 1 ? digits : 'def';
}
