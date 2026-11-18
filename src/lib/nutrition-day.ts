// Which calendar day food entries belong to. A nutrition day does NOT end at
// midnight: it stays open until the user taps "Finish day", so late-night
// food still counts toward the day it belongs to.

// Last day the user tapped "Finish day" on (YYYY-MM-DD). Device-local.
export const FINISHED_KEY = "daily_finished_through";

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + delta));
}

/** Local midnight at the start of a YYYY-MM-DD day. */
export function dayStart(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function readFinished(): string | null {
  try {
    return localStorage.getItem(FINISHED_KEY);
  } catch {
    return null;
  }
}

/**
 * The day new entries belong to: the day after the last finished one.
 * Never older than yesterday (so a forgotten "Finish" can't strand entries
 * days back) and never in the future.
 */
export function computeOpenDay(): string {
  const today = dayKey(new Date());
  const yesterday = shiftDay(today, -1);
  const finished = readFinished();
  let open = finished ? shiftDay(finished, 1) : today;
  if (open < yesterday) open = yesterday;
  if (open > today) open = today;
  return open;
}
