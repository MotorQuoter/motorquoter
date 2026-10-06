// batch 225 — what /salvage does with a free-report token on load. Pure (fetch injected) so the validator can drive it.
// Returns { keep: true } to change nothing, or { keep: false, notice: 'alreadyUsed' | 'linkFailed' } to clear the token.
// A failed status call (network, non-2xx, bad JSON) changes nothing: checkout's 403 is still the final gate.
export async function checkFreeReportToken(token, fetchFn = fetch) {
  try {
    const res = await fetchFn(`/api/salvage/free-report/status?token=${encodeURIComponent(token)}`);
    if (!res.ok) return { keep: true };
    const { state } = await res.json();
    if (state === 'used') return { keep: false, notice: 'alreadyUsed' };
    if (state === 'unknown') return { keep: false, notice: 'linkFailed' };
    return { keep: true };
  } catch {
    return { keep: true };
  }
}
