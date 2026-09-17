// labelVocabulary.mjs — batch 153. Which panels a lot can be labelled on, shared by the labelling sheet (S2)
// and the accuracy scorer (S3) so both count the same vocabulary. Dev tooling only.
// Needs the alias loader (imports the route for its body-class allow-sets).
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { PANEL, PANEL_BEHAVIOUR, PANEL_CLASS, isElectricFuelType } from '../../lib/panelEnum.mjs';

// Pairs carry a count of damaged units (brief S1).
export const PAIRS = new Set([PANEL.HEADLAMP, PANEL.FOG_LAMP]);

// Lots with no fixture.json: body class and fuel stated from the listing (CK75ONW = Hyundai Ioniq 5,
// lot 50898496; HV25ODX = Hyundai i20 T-GDI hatchback, lot 54237976).
const NO_FIXTURE = {
  CK75ONW: { make: 'HYUNDAI', model: 'IONIQ 5', bodyStyle: 'Hatchback', fuelType: 'ELECTRICITY', bodyClass: 'car' },
  HV25ODX: { make: 'HYUNDAI', model: 'I20 ADVANCE T-GDI AUTO', bodyStyle: 'Hatchback', fuelType: 'PETROL', bodyClass: 'car' },
};
const PICKUP_RE = /pick-?up/i;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

export function listLots(root) {
  return readdirSync(resolve(root, 'fixtures')).filter((d) => /^[A-Z0-9]+$/.test(d)).sort();
}

export async function lotInfo(root, lot) {
  const { ELIGIBLE_PANELS } = await import('@/app/api/salvage/assess/route.js');
  const dir = resolve(root, 'fixtures', lot);
  const fx = existsSync(resolve(dir, 'fixture.json')) ? JSON.parse(readFileSync(resolve(dir, 'fixture.json'), 'utf8')) : null;
  const vd = fx?.vehicleDetails || NO_FIXTURE[lot] || {};
  const bodyClass = NO_FIXTURE[lot]?.bodyClass || (PICKUP_RE.test(`${vd.bodyStyle || ''} ${vd.model || ''}`) ? 'pickup' : 'car');
  // EV panels: a BEV by the engine's DVLA rule, or any electrified fuel (the engine can still flag EV panels on a
  // hybrid via the HV-sticker fallback — AMZ3790 carries an EV_BATTERY_PRESENCE flag). Showing them costs nothing.
  const ev = isElectricFuelType(vd.fuelType) || /electric/i.test(vd.fuelType || '');
  const imgDir = resolve(dir, 'images');
  const photos = existsSync(imgDir) ? readdirSync(imgDir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort(natural) : [];
  const gtPath = resolve(dir, 'ground-truth.json');
  const gt = existsSync(gtPath) ? JSON.parse(readFileSync(gtPath, 'utf8')) : null;
  const panels = [...(ELIGIBLE_PANELS[bodyClass] || ELIGIBLE_PANELS.car)]
    .filter((p) => p !== PANEL.OTHER)
    .filter((p) => ev || PANEL_BEHAVIOUR[p] !== PANEL_CLASS.EV_CONDITIONAL);
  return { lot, dir, vd, bodyClass, ev, photos, gt, panels,
    hasFixture: !!fx, hasCassette: existsSync(resolve(dir, 'model-cassette.json')) };
}
