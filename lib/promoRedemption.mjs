// A promo code's uses_so_far must increment EXACTLY ONCE per session, however many times the paid
// report is re-opened (BUILD_StoredReports §3a). Since verify is no longer an access gate, the same
// session_id now reaches verify on every re-open — so the counting can no longer lean on "verify runs
// once".
//
// The atomic used_sessions insert is the once-guard: session_id is the PK (schema.sql), so the FIRST
// open inserts cleanly and every later open collides (23505). A CLEAN insert (no error) is the first
// redemption and the only time we count. Any error — 23505 (already counted) or a transient failure —
// means DO NOT count again: undercounting a promo is the safe direction; double-counting is not.
export function isFirstRedemption(insertError) {
  return !insertError;
}
