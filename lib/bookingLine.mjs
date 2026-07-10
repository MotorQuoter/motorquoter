// Single owner of the Copart £10 inspection booking reminder.
// Holds: the computed-deadline state machine, the model-prose suppression when the
// window is shut, and the checklist-header suffix. Shared by web (success/page.js) and
// PDF (pdf/route.js) so both surfaces speak with one voice on inspection timing.
//
// State is TIME-RELATIVE (Date.now()) — computed at render, never frozen at assess time:
// a report assessed while the window was open can be viewed after it closes. The inputs
// (_saleDateMs / _saleDateOffsetH) are stamped server-side (route.js) and persisted.
//
// computeBookingLine is impure (Date.now()); NEVER call it in a React render/effect body —
// call it in a handler and store the {line, state}. suppressBookingSentence and
// bookingHeaderSuffix ARE pure (state in, string out) and are render-safe.

// States: 'deadline' (window open, book-by date), 'window-closed' (sale <48h away),
// 'past-generic' (sale already passed), 'absent-generic' / 'unparseable-generic' (no
// computable sale date → generic 48h wording, window status UNKNOWN, not shut).
export function computeBookingLine(assessment) {
  const GEN = 'Physical inspection: £10, ~10 min — must be booked at least 48 hours before the sale.';
  const ms = assessment?._saleDateMs;
  const offH = assessment?._saleDateOffsetH;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return { line: GEN, state: (ms == null ? 'absent' : 'unparseable') + '-generic' };
  }
  const now = Date.now();
  const deadline = ms - 48 * 3600 * 1000;
  if (ms > now && now < deadline) {
    const d = new Date(deadline + (offH || 0) * 3600000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let h = d.getUTCHours(); const mnt = d.getUTCMinutes();
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    const when = `${days[d.getUTCDay()]} ${d.getUTCDate()} ${mons[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h}:${String(mnt).padStart(2, '0')} ${ap} GMT${offH >= 0 ? '+' : ''}${offH}`;
    return { line: `Physical inspection: £10, ~10 min — book by ${when} at the latest (48h before the sale).`, state: 'deadline' };
  }
  if (ms > now) {
    return { line: 'Physical inspection: £10, ~10 min — the 48-hour booking window has closed; do not factor an inspection into your bid.', state: 'window-closed' };
  }
  return { line: 'Physical inspection: £10, ~10 min — the sale has already taken place, so an inspection is no longer possible.', state: 'past-generic' };
}

// True only when the booking window is DEFINITIVELY shut (sale <48h away, or already
// passed). The generic states (deadline unknown) are NOT shut — model advice stays intact.
export function isBookingShut(state) {
  return state === 'window-closed' || state === 'past-generic';
}

// Suppress the model's "book a WhatsApp / physical inspection" recommendation ONLY when the
// window is shut — the code booking line is then the single authority on inspection timing.
// Sentence-level DROP (never a partial rewrite); never blanks the field.
export function suppressBookingSentence(text, state) {
  if (!text || !isBookingShut(state)) return text;
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  const kept = sentences.filter(s => !(/\b(book|arrange|order)\b/i.test(s) && /(whats\s?app|inspection)/i.test(s)));
  const out = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  return out || text; // never blank — if suppression emptied the field, keep the original
}

// Checklist-header suffix (no "£10", no separator — each surface formats around it).
// State-specific so the header never contradicts the booking line beneath it: a past sale
// reads "sale has taken place", a still-future-but-<48h sale reads "booking window closed",
// everything else (open / deadline unknown) reads the book-by note.
export function bookingHeaderSuffix(state) {
  if (state === 'window-closed') return '48-hour booking window closed';
  if (state === 'past-generic')  return 'sale has taken place';
  return 'book 48hrs before sale';
}
