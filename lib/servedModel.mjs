// batch 246 — FAIL LOUD ON THE WRONG MODEL. The API reply's own `model` field is the only authority on which model
// served a call (BATCH 243/244 rule). After the swap to Fable 5.2, a reply from any other model on an assessPrimary
// call means the run is not what was tested, so it must not pass silently.
//
// checkServedModel(tag, apiData) — call once per assessPrimary reply, right after its TOKEN LOG line:
//   • served === configured, or the configured id's dated snapshot ("<id>-YYYYMMDD") → ok, silent;
//   • reply carries no `model` (a test stub) → ok, silent (nothing to compare);
//   • anything else → `[MODEL MISMATCH] call=<tag> configured=<id> served=<id>` on EVERY occurrence, plus ONE ops alert
//     per run (beginRun() resets it; sendOpsAlert's own 60-minute throttle by kind applies on top).
// Never throws, never changes the reply: the run carries on, loudly.
import { sendOpsAlert } from './opsAlert.mjs';
import { MODELS } from '../config/models.js';
import { noteMismatch } from './runFacts.mjs';   // batch 252 A2: _runFacts.mismatchCount

let _run = 0;
let _alertedRun = -1;
export function beginRun() { _run += 1; }

export function servedModelMatches(configured, served) {
  if (!served) return true;
  if (served === configured) return true;
  return typeof served === 'string' && served.startsWith(`${configured}-`) && /^\d{8}$/.test(served.slice(configured.length + 1));
}

export async function checkServedModel(tag, apiData, { configured = MODELS.assessPrimary, log = console.error, alert = sendOpsAlert } = {}) {
  try {
    const served = apiData?.model;
    if (servedModelMatches(configured, served)) return true;
    log(`[MODEL MISMATCH] call=${tag} configured=${configured} served=${served}`);
    noteMismatch();
    if (_alertedRun !== _run) {
      _alertedRun = _run;
      await alert('model-mismatch', 'MotorQuoter: assessment served by the wrong model',
        `call ${tag}: configured ${configured}, the API reply says ${served}. A run with any mismatched call is not the tested configuration. Check config/models.js and the API key's organisation.`);
    }
    return false;
  } catch (err) {
    log(`[MODEL MISMATCH] check failed (${tag}): ${err?.message || err}`);
    return true;
  }
}
