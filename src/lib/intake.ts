// Meal timing: every time protein/carbs is entered on the open day we keep a
// timestamped snapshot of the running totals. A day's snapshots form a
// step curve ("by 2 PM I'd had 60g"), and past days' curves give the
// "usually by now" pace. Local-first like everything else.

import { useEffect, useState } from "react";
import { createClient, getUserId } from "@/lib/supabase/client";
import { kvGet, kvSet, LOCAL_CHANGE_EVENT, mergePendingRows, queueUpsert } from "@/lib/offline";
import { dayKey, dayStart, shiftDay } from "@/lib/nutrition-day";

export type IntakeField = "protein" | "carbs";

export interface IntakeEvent {
  id: string;
  date: string;
  logged_at: string;
  protein_grams: number | null;
  carbs_grams: number | null;
}

/** [minutes since the day's midnight (can pass 24h), running total] */
export type Point = [number, number];

const LOCAL_KEY = "intake:local"; // snapshots made on this phone
const SERVER_KEY = "intake:server"; // last copy from the server
export const WINDOW_DAYS = 28;
const PACE_DAYS = 14;
export const MIN_DAYS = 3;
/** Edits this close together are one entry (fixing a typo, adding a side). */
const MERGE_MS = 10 * 60 * 1000;
/** Ignore stamps more than this far past the day's midnight. */
const MAX_MINUTE = 36 * 60;

function oldestKept(): string {
  return shiftDay(dayKey(new Date()), -(WINDOW_DAYS + 2));
}

function clean(e: IntakeEvent): IntakeEvent {
  return {
    id: e.id,
    date: e.date,
    logged_at: e.logged_at,
    protein_grams: e.protein_grams ?? null,
    carbs_grams: e.carbs_grams ?? null,
  };
}

/** Stamp the open day's running totals. Call after protein or carbs is saved. */
export async function recordIntake(
  date: string,
  protein: number | null,
  carbs: number | null
): Promise<void> {
  try {
    const userId = await getUserId(createClient());
    if (!userId) return;
    const local = (await kvGet<IntakeEvent[]>(LOCAL_KEY)) ?? [];
    const last = local
      .filter((e) => e.date === date)
      .sort((a, b) => a.logged_at.localeCompare(b.logged_at))
      .at(-1);
    if (last && last.protein_grams === protein && last.carbs_grams === carbs) return;

    const now = Date.now();
    const merge = !!last && now - Date.parse(last.logged_at) < MERGE_MS;
    const ev: IntakeEvent = {
      id: merge ? last!.id : crypto.randomUUID(),
      date,
      logged_at: merge ? last!.logged_at : new Date(now).toISOString(),
      protein_grams: protein,
      carbs_grams: carbs,
    };
    const keep = oldestKept();
    await kvSet(LOCAL_KEY, [...local.filter((e) => e.id !== ev.id && e.date >= keep), ev]);
    await queueUpsert("intake_log", { ...ev, user_id: userId });
  } catch (err) {
    console.error("[intake] record failed:", err);
  }
}

/** Everything known on this phone: server copy + local stamps + unsynced writes. */
export async function loadIntakeEvents(): Promise<IntakeEvent[]> {
  const [server, local] = await Promise.all([
    kvGet<IntakeEvent[]>(SERVER_KEY),
    kvGet<IntakeEvent[]>(LOCAL_KEY),
  ]);
  const byId = new Map<string, IntakeEvent>();
  for (const e of server ?? []) byId.set(e.id, e);
  for (const e of local ?? []) byId.set(e.id, e);
  const merged = await mergePendingRows("intake_log", [...byId.values()]);
  const keep = oldestKept();
  return merged.filter((e) => e.date >= keep).map(clean);
}

/** Refresh the server copy. Resolves false with no signal. */
export async function fetchIntakeEvents(): Promise<boolean> {
  const { data, error } = await createClient()
    .from("intake_log")
    .select("id, date, logged_at, protein_grams, carbs_grams")
    .gte("date", oldestKept())
    .order("logged_at", { ascending: true });
  if (error || !data) return false;
  await kvSet(SERVER_KEY, data);
  return true;
}

/** Recent intake snapshots; null until the first local read finishes. */
export function useIntakeEvents(): IntakeEvent[] | null {
  const [events, setEvents] = useState<IntakeEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    const reload = () =>
      loadIntakeEvents()
        .then((e) => {
          if (alive) setEvents(e);
        })
        .catch(() => {});
    const refresh = () =>
      fetchIntakeEvents()
        .then((ok) => {
          if (ok) reload();
        })
        .catch(() => {});
    reload();
    refresh();
    window.addEventListener(LOCAL_CHANGE_EVENT, reload);
    window.addEventListener("online", refresh);
    return () => {
      alive = false;
      window.removeEventListener(LOCAL_CHANGE_EVENT, reload);
      window.removeEventListener("online", refresh);
    };
  }, []);
  return events;
}

// ---- Analysis ----

export function minuteOf(e: IntakeEvent): number {
  return (Date.parse(e.logged_at) - dayStart(e.date).getTime()) / 60000;
}

/**
 * Each day's running-total curve for one nutrient, sorted by time. A lower
 * number entered later is a correction, so it caps the earlier points too.
 * Days with nothing logged for this nutrient are left out.
 */
export function dayCurves(events: IntakeEvent[], field: IntakeField): Map<string, Point[]> {
  const byDay = new Map<string, Point[]>();
  for (const e of events) {
    const m = minuteOf(e);
    if (!(m >= 0 && m <= MAX_MINUTE)) continue;
    const v = (field === "protein" ? e.protein_grams : e.carbs_grams) ?? 0;
    const list = byDay.get(e.date) ?? [];
    list.push([m, v]);
    byDay.set(e.date, list);
  }
  const out = new Map<string, Point[]>();
  for (const [date, pts] of byDay) {
    pts.sort((a, b) => a[0] - b[0]);
    for (let i = pts.length - 2; i >= 0; i--) pts[i][1] = Math.min(pts[i][1], pts[i + 1][1]);
    if (pts[pts.length - 1][1] > 0) out.set(date, pts);
  }
  return out;
}

export function valueAt(curve: Point[], minute: number): number {
  let v = 0;
  for (const [m, val] of curve) {
    if (m > minute) break;
    v = val;
  }
  return v;
}

export function finalOf(curve: Point[]): number {
  return curve[curve.length - 1][1];
}

/** When the day's running total first reached half of its final total. */
export function halfwayMinute(curve: Point[]): number {
  const half = finalOf(curve) / 2;
  return curve.find(([, v]) => v >= half)![0];
}

/** Share of the day's total entered after this minute (0–1). */
export function shareAfter(curve: Point[], minute: number): number {
  const total = finalOf(curve);
  return (total - valueAt(curve, minute)) / total;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Curves for the days `from`..`to` days before `openDay`, newest first. */
export function pastCurves(
  events: IntakeEvent[],
  field: IntakeField,
  openDay: string,
  from: number,
  to: number
): Point[][] {
  const newest = shiftDay(openDay, -from);
  const oldest = shiftDay(openDay, -to);
  return [...dayCurves(events, field)]
    .filter(([d]) => d <= newest && d >= oldest)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([, c]) => c);
}

export interface Pace {
  days: number;
  usualNow: number;
  usualTotal: number;
  halfway: number;
}

/** What a typical recent day looked like at this minute. Null while learning. */
export function computePace(
  events: IntakeEvent[],
  field: IntakeField,
  openDay: string,
  minute: number
): { days: number; pace: Pace | null } {
  const curves = pastCurves(events, field, openDay, 1, WINDOW_DAYS).slice(0, PACE_DAYS);
  if (curves.length < MIN_DAYS) return { days: curves.length, pace: null };
  return {
    days: curves.length,
    pace: {
      days: curves.length,
      usualNow: Math.round(median(curves.map((c) => valueAt(c, minute)))),
      usualTotal: Math.round(median(curves.map(finalOf))),
      halfway: median(curves.map(halfwayMinute)),
    },
  };
}

/** "7:40 PM" for a minute of the day (past midnight wraps to AM). */
export function formatMinute(minute: number): string {
  const m = Math.round(minute / 5) * 5;
  const h24 = Math.floor(m / 60) % 24;
  const mm = m % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}
