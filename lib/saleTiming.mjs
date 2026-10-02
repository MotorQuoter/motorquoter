// Single owner of "has the sale taken place?" (Vincent, 2 Oct 2026).
// Copart's "Sale date" is the LANE START time, not when the lot runs — a lot can come to the block
// hours later the same day. So a lot counts as sold only after the END OF ITS SALE DAY, in the
// sale's own time zone (offsetH). Until then a report can be bought and must not say the sale has
// taken place.
//
// saleDate is the parser's shape: { ms (UTC epoch of the lane start), offsetH (GMT±N) }.
// Null / unparseable → never passed (unchanged behaviour).

// 23:59:59.999 on the sale's local date, as a UTC epoch. null when there is no usable date.
export function saleDayEndMs(saleDate) {
  const ms = saleDate?.ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const offMs = (Number.isFinite(saleDate.offsetH) ? saleDate.offsetH : 0) * 3600000;
  const local = new Date(ms + offMs);   // UTC fields of this Date = the sale's local wall clock
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 23, 59, 59, 999) - offMs;
}

export function isSalePassed(saleDate, now = Date.now()) {
  const end = saleDayEndMs(saleDate);
  return end != null && now > end;
}
