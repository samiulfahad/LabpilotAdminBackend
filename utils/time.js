// ── utils/time.js ─────────────────────────────────────────────────────────────
// All timestamps stored as UTC milliseconds.
// BST (Bangladesh Standard Time) = UTC+6, no DST — ever.
// Conversion happens ONLY at the boundary: when computing human-facing deadlines.

const BST_OFFSET_MS = 6 * 60 * 60 * 1000; // 6 hours in ms

/**
 * Current time broken down in BST.
 * Use this instead of `new Date()` whenever you need BST year/month/day.
 */
export function nowBST() {
  const bstMs = Date.now() + BST_OFFSET_MS;
  const d = new Date(bstMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1, // 1-indexed
    day: d.getUTCDate(),
    ms: Date.now(), // raw UTC — handy to have alongside
  };
}

/**
 * Given any UTC ms timestamp, returns 23:59:59.999 BST of that same BST day,
 * expressed as a UTC ms timestamp.
 *
 * Example:
 *   endOfDayBST(Date.now())  →  tonight at 23:59:59.999 BST (= 17:59:59.999 UTC)
 */
export function endOfDayBST(utcMs) {
  // Step into BST to find the BST date
  const bstMs = utcMs + BST_OFFSET_MS;
  const d = new Date(bstMs);

  // Build 23:59:59.999 for that BST date, then shift back to UTC
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999) - BST_OFFSET_MS;
}

/**
 * Returns the UTC ms for the very start (00:00:00.000 BST) of the 1st day
 * of the given BST year/month.  month is 1-indexed.
 *
 * Example: startOfMonthBST(2026, 3)
 *   → 2026-03-01 00:00:00.000 BST = 2026-02-28 18:00:00.000 UTC
 */
export function startOfMonthBST(year, month) {
  return Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - BST_OFFSET_MS;
}

/**
 * Returns the UTC ms for the very end (23:59:59.999 BST) of the last day
 * of the given BST year/month.  month is 1-indexed.
 *
 * Example: endOfMonthBST(2026, 3)
 *   → 2026-03-31 23:59:59.999 BST = 2026-03-31 17:59:59.999 UTC
 */
export function endOfMonthBST(year, month) {
  // Last calendar day of month: Date.UTC with day=0 of next month rolls back
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Date.UTC(year, month - 1, lastDay, 23, 59, 59, 999) - BST_OFFSET_MS;
}

/**
 * Parses a "YYYY-MM-DD" string as a BST date and returns end-of-day UTC ms.
 * Safe to call with user-supplied strings from the admin UI.
 *
 * Throws if the string is not a valid date (including non-existent
 * calendar dates like "2026-02-30", which used to silently roll over
 * to March instead of throwing).
 */
export function parseDateStringToBSTEndOfDay(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) throw new Error(`Invalid date string: "${dateStr}". Expected YYYY-MM-DD.`);

  const [, y, mo, d] = match.map(Number);

  // Verify the date actually exists (catches Feb 30, month 13, day 0, etc.)
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new Error(`Invalid date: "${dateStr}".`);
  }

  return Date.UTC(y, mo - 1, d, 23, 59, 59, 999) - BST_OFFSET_MS;
}
