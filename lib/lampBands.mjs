// Headlamp band table — the SINGLE owner of the lamp £ figures (unit + fitted, GBP).
//
// batch 114 moved this out of app/api/salvage/assess/route.js so the buyer edit layer
// (lib/ledgerEdits.applyEdits) can price a lamp-type correction from exactly the figures the engine
// used. One owner, no second copy: the engine (resolveLampBand) and the edit layer both import it.
// The VALUES are Vincent's to rule (batch 113 left them open) — change them here and nowhere else.

export const HEADLAMP_BANDS = Object.freeze({
  halogen: 150, // S/H unit + fitted, GBP
  hid:     250, // HID / projector unit + fitted
  led:     350, // LED / adaptive / matrix unit + fitted
});

export const HEADLAMP_BAND_DEFAULT = 'led'; // conservative high — used only when neither the photograph nor the spec resolves a type

// The closed enum a buyer may correct the lamp type to (the edits API validates against it).
export const LAMP_TYPES = Object.freeze(Object.keys(HEADLAMP_BANDS));
