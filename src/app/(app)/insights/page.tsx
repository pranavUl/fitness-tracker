"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { Equipment } from "@/types/database.types";
import { getEquipmentScope } from "@/lib/pr-detection";
import { kvGet, kvSet, listOutbox } from "@/lib/offline";
import { cn } from "@/lib/utils";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  TrendingUp,
  Dumbbell,
  Weight,
  Flame,
  Wheat,
  Zap,
} from "lucide-react";

// Entity colors — validated for dark surface (lightness band, CVD, contrast)
const COLOR_LIFT = "#059669";
const COLOR_WEIGHT = "#3b82f6";
const COLOR_PROTEIN = "#ea580c";
const COLOR_CARBS = "#d97706";
const GYM_COLORS = [COLOR_LIFT, COLOR_WEIGHT, COLOR_PROTEIN, "#a855f7"];

const GRID_STROKE = "rgba(255,255,255,0.06)";
const TICK_STYLE = { fontSize: 10, fill: "rgba(255,255,255,0.45)" };
const TOOLTIP_STYLE = {
  background: "#1c2420",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "0.75rem",
  fontSize: "12px",
};

const ALL_GYMS = "All gyms";

interface DayCell {
  date: string;
  score: number; // completed working sets that day; -1 = no training
  items: string[];
}

type StrengthRow = { label: string; iso: string; [key: string]: string | number | null };

interface StrengthExercise {
  name: string;
  gyms: string[]; // series keys — gym names, or ["All"] for free-weight lifts
  rows: StrengthRow[];
}

/** One logged day from daily_tracking. */
interface DailyEntry {
  date: string; // YYYY-MM-DD
  protein: number | null;
  carbs: number | null;
  weight: number | null;
}

interface InsightsSnapshot {
  sessionsThisWeek: number;
  setsThisWeek: number;
  avgLiftsPerWeek: number;
  avgRunsPerWeek: number;
  heatmap: DayCell[];
  strength: StrengthExercise[];
  daily: DailyEntry[];
}

const EMPTY: InsightsSnapshot = {
  sessionsThisWeek: 0,
  setsThisWeek: 0,
  avgLiftsPerWeek: 0,
  avgRunsPerWeek: 0,
  heatmap: [],
  strength: [],
  daily: [],
};

// v8: dropped strongest lifts / spotlight / split / volume, added raw daily entries
const SNAPSHOT_KEY = "insights:v8";
const DAILY_DAYS = 90;

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shortLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// Deeper green = more sets. Pale mint (few) → rich emerald (many).
function heatFill(score: number, max: number): string {
  if (score < 0) return "rgba(255,255,255,0.05)";
  const ratio = max > 0 ? Math.min(1, score / max) : 0;
  const t = score === 0 ? 0.08 : 0.2 + 0.8 * ratio;
  const pale = [167, 243, 208]; // #a7f3d0
  const deep = [5, 150, 105]; // #059669
  const c = pale.map((p, i) => Math.round(p + t * (deep[i] - p)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

type BodyMetric = "protein" | "carbs" | "weight";

const BODY_METRICS: Record<
  BodyMetric,
  { label: string; unit: string; color: string; Icon: typeof Flame }
> = {
  protein: { label: "Protein", unit: "g", color: COLOR_PROTEIN, Icon: Flame },
  carbs: { label: "Carbs", unit: "g", color: COLOR_CARBS, Icon: Wheat },
  weight: { label: "Weight", unit: "lb", color: COLOR_WEIGHT, Icon: Weight },
};

const RANGES = [
  { days: 7, label: "1W" },
  { days: 14, label: "2W" },
  { days: 30, label: "1M" },
  { days: 90, label: "3M" },
] as const;

interface BodyRow {
  iso: string;
  label: string;
  value: number | null;
  trend: number | null;
}

function isoNoon(iso: string): Date {
  return new Date(iso + "T12:00:00");
}

/**
 * Gap-aware exponential moving average of scale weight: smooths daily
 * water/sodium noise into a "true weight" line. Keyed by date.
 */
function weightTrend(daily: DailyEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  let prev: number | null = null;
  let prevDate: Date | null = null;
  for (const d of daily) {
    if (d.weight == null) continue;
    const date = isoNoon(d.date);
    let trend: number;
    if (prev == null || prevDate == null) {
      trend = d.weight;
    } else {
      const gapDays = Math.max(1, (date.getTime() - prevDate.getTime()) / 86400000);
      trend = prev + (1 - Math.pow(0.85, gapDays)) * (d.weight - prev);
    }
    prev = trend;
    prevDate = date;
    out.set(d.date, Math.round(trend * 10) / 10);
  }
  return out;
}

/** Unsynced Home edits (e.g. logged offline or seconds ago) win over the server copy. */
async function withPendingDaily(daily: DailyEntry[]): Promise<DailyEntry[]> {
  const pending = (await listOutbox()).filter(
    (e) => e.table === "daily_tracking" && e.op !== "delete" && e.row?.date
  );
  if (pending.length === 0) return daily;
  const byDate = new Map(daily.map((d) => [d.date, { ...d }]));
  for (const e of pending) {
    const row = e.row!;
    const date = row.date as string;
    const cur = byDate.get(date) ?? { date, protein: null, carbs: null, weight: null };
    if ("protein_grams" in row) cur.protein = (row.protein_grams as number | null) ?? null;
    if ("carbs_grams" in row) cur.carbs = (row.carbs_grams as number | null) ?? null;
    if ("morning_weight" in row) cur.weight = (row.morning_weight as number | null) ?? null;
    byDate.set(date, cur);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export default function InsightsPage() {
  const [data, setData] = useState<InsightsSnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  const [selectedGym, setSelectedGym] = useState<string>(ALL_GYMS);
  const [selectedDay, setSelectedDay] = useState<DayCell | null>(null);
  const [bodyMetric, setBodyMetric] = useState<BodyMetric>("protein");
  const [bodyRange, setBodyRange] = useState<number>(7);
  const networkLoadedRef = useRef(false);
  const supabase = createClient();

  const load = useCallback(async () => {
    try {
      const now = new Date();
      const dailyStart = new Date(now);
      dailyStart.setDate(dailyStart.getDate() - DAILY_DAYS);

      const [trackingRes, workoutsRes, gymsRes, runsRes] =
        await Promise.all([
          supabase
            .from("daily_tracking")
            .select("date, protein_grams, carbs_grams, morning_weight")
            .gte("date", dateKey(dailyStart))
            .order("date"),
          supabase
            .from("workouts")
            .select("id, title, started_at, finished_at, gym_id")
            .not("finished_at", "is", null)
            .order("started_at", { ascending: false })
            .limit(150),
          supabase.from("gyms").select("id, name"),
          supabase
            .from("run_sessions")
            .select("name, run_pool, started_at, duration_seconds, distance_meters")
            .not("duration_seconds", "is", null)
            .order("started_at", { ascending: false })
            .limit(150),
        ]);

      // Supabase reports "no signal" as an error, not an exception — bail
      // out before an empty result overwrites the cached snapshot
      if ([trackingRes, workoutsRes, gymsRes, runsRes].some((r) => r.error)) {
        throw new Error("offline");
      }

      const workouts = workoutsRes.data || [];
      const runs = runsRes.data || [];
      const gymMap = new Map((gymsRes.data || []).map((g) => [g.id, g.name]));

      const workoutDate = new Map(workouts.map((w) => [w.id, w.started_at]));
      const gymByWorkout = new Map(
        workouts.map((w) => [w.id, w.gym_id ? gymMap.get(w.gym_id) || "Other gym" : "Other gym"])
      );

      // ---- Sets + exercises ----
      const workoutIds = workouts.map((w) => w.id);
      const { data: wes, error: wesErr } = workoutIds.length
        ? await supabase
            .from("workout_exercises")
            .select("id, workout_id, exercise_id")
            .in("workout_id", workoutIds)
        : { data: [], error: null };
      if (wesErr) throw new Error("offline");

      const weIds = (wes || []).map((we) => we.id);
      const { data: allSets, error: setsErr } = weIds.length
        ? await supabase
            .from("sets")
            .select("workout_exercise_id, weight, reps, e1rm, is_warmup")
            .in("workout_exercise_id", weIds)
            .not("completed_at", "is", null)
        : { data: [], error: null };
      if (setsErr) throw new Error("offline");

      const exerciseIds = [...new Set((wes || []).map((we) => we.exercise_id))];
      const { data: defs, error: defsErr } = exerciseIds.length
        ? await supabase
            .from("exercise_definitions")
            .select("id, name, equipment")
            .in("id", exerciseIds)
        : { data: [], error: null };
      if (defsErr) throw new Error("offline");
      const nameMap = new Map((defs || []).map((d) => [d.id, d.name]));
      const equipMap = new Map<string, Equipment | null>(
        (defs || []).map((d) => [d.id, d.equipment])
      );

      // ---- Aggregate sets ----
      const weMeta = new Map(
        (wes || []).map((we) => [
          we.id,
          { workoutId: we.workout_id, exerciseId: we.exercise_id },
        ])
      );
      const setsByWorkout = new Map<string, number>();
      type BestSet = { e1rm: number; weight: number | null; reps: number | null };
      const e1rmByExercise = new Map<string, Map<string, BestSet>>();

      for (const s of allSets || []) {
        const meta = weMeta.get(s.workout_exercise_id);
        if (!meta) continue;
        if (!s.is_warmup) {
          setsByWorkout.set(meta.workoutId, (setsByWorkout.get(meta.workoutId) || 0) + 1);
        }
        if (s.e1rm && !s.is_warmup) {
          let byWorkout = e1rmByExercise.get(meta.exerciseId);
          if (!byWorkout) {
            byWorkout = new Map();
            e1rmByExercise.set(meta.exerciseId, byWorkout);
          }
          const cur = byWorkout.get(meta.workoutId);
          if (!cur || s.e1rm > cur.e1rm) {
            byWorkout.set(meta.workoutId, { e1rm: s.e1rm, weight: s.weight, reps: s.reps });
          }
        }
      }

      // ---- Hero stats ----
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);

      let sessionsThisWeek = 0;
      for (const w of workouts)
        if (new Date(w.started_at) >= weekStart) sessionsThisWeek++;
      for (const r of runs)
        if (r.started_at && new Date(r.started_at) >= weekStart) sessionsThisWeek++;

      let setsThisWeek = 0;
      for (const [wId, count] of setsByWorkout) {
        const iso = workoutDate.get(wId);
        if (iso && new Date(iso) >= weekStart) setsThisWeek += count;
      }

      // Average over the weeks the user has actually been active (capped at 8)
      // so a new account's empty pre-signup weeks don't dilute the number.
      const earliestActivityMs = Math.min(
        ...workouts.map((w) => new Date(w.started_at).getTime()),
        ...runs.filter((r) => r.started_at).map((r) => new Date(r.started_at!).getTime()),
        now.getTime()
      );
      const weeksActive = Math.max(1, (now.getTime() - earliestActivityMs) / (7 * 86400000));
      const weeksForAvg = Math.min(8, weeksActive);
      const avgCutoff = new Date(now.getTime() - weeksForAvg * 7 * 86400000);
      const liftsInWindow = workouts.filter((w) => new Date(w.started_at) >= avgCutoff).length;
      const runsInWindow = runs.filter(
        (r) =>
          r.started_at &&
          new Date(r.started_at) >= avgCutoff &&
          r.run_pool !== "soccer"
      ).length;
      const avgLiftsPerWeek = Math.round(liftsInWindow / weeksForAvg);
      const avgRunsPerWeek = Math.round(runsInWindow / weeksForAvg);

      // ---- Heatmap: last 16 weeks (lifts + runs), intensity = working sets ----
      const heatmap: DayCell[] = [];
      const heatStart = new Date(weekStart);
      heatStart.setDate(heatStart.getDate() - 15 * 7);
      const setsByDay = new Map<string, number>();
      const itemsByDay = new Map<string, string[]>();
      for (const w of workouts) {
        const key = dateKey(new Date(w.started_at));
        const sets = setsByWorkout.get(w.id) || 0;
        setsByDay.set(key, (setsByDay.get(key) || 0) + sets);
        const arr = itemsByDay.get(key) || [];
        arr.push(sets > 0 ? `${w.title || "Workout"} — ${sets} sets` : w.title || "Workout");
        itemsByDay.set(key, arr);
      }
      for (const r of runs) {
        if (!r.started_at) continue;
        const key = dateKey(new Date(r.started_at));
        if (!setsByDay.has(key)) setsByDay.set(key, 0);
        const arr = itemsByDay.get(key) || [];
        const mins = Math.round((r.duration_seconds || 0) / 60);
        const miles = r.distance_meters
          ? ` · ${(r.distance_meters / 1609.34).toFixed(1)} mi`
          : "";
        arr.push(`${r.name || "Run"} — ${mins}m${miles}`);
        itemsByDay.set(key, arr);
      }
      for (let i = 0; i < 16 * 7; i++) {
        const d = new Date(heatStart);
        d.setDate(heatStart.getDate() + i);
        if (d > now) break;
        const key = dateKey(d);
        heatmap.push({
          date: key,
          score: setsByDay.has(key) ? setsByDay.get(key)! : -1,
          items: itemsByDay.get(key) || [],
        });
      }

      // ---- Strength progression (per exercise, split by gym for machines) ----
      const strength: StrengthExercise[] = [];

      for (const [exId, byWorkout] of e1rmByExercise) {
        const name = nameMap.get(exId);
        if (!name) continue;
        const scope = getEquipmentScope(equipMap.get(exId) ?? null);
        const pts = [...byWorkout.entries()]
          .map(([wId, best]) => ({
            iso: workoutDate.get(wId) || "",
            gym: scope === "per_gym" ? gymByWorkout.get(wId) || "Other gym" : "All",
            best,
          }))
          .filter((p) => p.iso)
          .sort((a, b) => a.iso.localeCompare(b.iso));

        const byGym = new Map<string, typeof pts>();
        for (const p of pts) {
          const arr = byGym.get(p.gym) || [];
          arr.push(p);
          byGym.set(p.gym, arr);
        }
        const gyms = [...byGym.keys()].filter((g) => byGym.get(g)!.length >= 2);
        if (gyms.length === 0) continue;

        const rowMap = new Map<string, StrengthRow>();
        for (const g of gyms) {
          for (const p of byGym.get(g)!) {
            let row = rowMap.get(p.iso);
            if (!row) {
              row = { label: shortLabel(p.iso), iso: p.iso };
              rowMap.set(p.iso, row);
            }
            const cur = row[g];
            if (cur == null || p.best.e1rm > (cur as number)) {
              row[g] = Math.round(p.best.e1rm);
              row[`${g}__set`] =
                p.best.weight && p.best.reps ? `${p.best.weight} × ${p.best.reps}` : null;
            }
          }
        }
        const rows = [...rowMap.values()].sort((a, b) => a.iso.localeCompare(b.iso));
        strength.push({ name, gyms, rows });
      }
      strength.sort((a, b) => b.rows.length - a.rows.length);

      // ---- Body & nutrition: raw daily entries, charted client-side ----
      const daily: DailyEntry[] = (trackingRes.data || []).map((t) => ({
        date: t.date,
        protein: t.protein_grams,
        carbs: t.carbs_grams,
        weight: t.morning_weight,
      }));

      const snapshot: InsightsSnapshot = {
        sessionsThisWeek,
        setsThisWeek,
        avgLiftsPerWeek,
        avgRunsPerWeek,
        heatmap,
        strength,
        daily,
      };

      networkLoadedRef.current = true;
      kvSet(SNAPSHOT_KEY, snapshot);
      setData({ ...snapshot, daily: await withPendingDaily(daily) });
    } catch {
      // Offline — snapshot hydration has already painted what we have
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    kvGet<InsightsSnapshot>(SNAPSHOT_KEY).then(async (snap) => {
      if (networkLoadedRef.current) return;
      // Even with no snapshot, show anything logged on this phone
      const base = snap ?? EMPTY;
      const daily = await withPendingDaily(base.daily);
      if (networkLoadedRef.current) return;
      setData({ ...base, daily });
      if (snap || daily.length > 0) setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const activeStrength =
    data.strength.find((s) => s.name === selectedExercise) ?? data.strength[0] ?? null;
  const gymSplit = !!activeStrength && activeStrength.gyms.length > 1;
  const shownGyms =
    gymSplit && selectedGym !== ALL_GYMS && activeStrength!.gyms.includes(selectedGym)
      ? [selectedGym]
      : (activeStrength?.gyms ?? []);

  const maxHeatScore = Math.max(
    1,
    ...data.heatmap.filter((c) => c.score > 0).map((c) => c.score)
  );

  const body = useMemo(() => {
    const trend = weightTrend(data.daily);
    const byDate = new Map(data.daily.map((d) => [d.date, d]));
    const today = new Date();
    const rows: BodyRow[] = [];
    for (let i = bodyRange - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const iso = dateKey(d);
      const entry = byDate.get(iso);
      rows.push({
        iso,
        label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        value: entry ? entry[bodyMetric] : null,
        trend: bodyMetric === "weight" ? (trend.get(iso) ?? null) : null,
      });
    }
    const logged = rows.filter((r) => r.value != null);
    const todayValue = rows[rows.length - 1].value;
    const last7 = rows.slice(-7).filter((r) => r.value != null);
    const avg7 = last7.length
      ? Math.round(last7.reduce((a, r) => a + r.value!, 0) / last7.length)
      : null;

    // Weight: latest trend + weekly rate over up to the last 14 days
    let latestTrend: number | null = null;
    let ratePerWeek: number | null = null;
    const trendPts = [...trend.entries()];
    if (trendPts.length) {
      const [lastIso, lastTrend] = trendPts[trendPts.length - 1];
      latestTrend = lastTrend;
      const lastDate = isoNoon(lastIso);
      let base = trendPts[0];
      for (const p of trendPts) {
        if ((lastDate.getTime() - isoNoon(p[0]).getTime()) / 86400000 >= 14) base = p;
      }
      const span = (lastDate.getTime() - isoNoon(base[0]).getTime()) / 86400000;
      if (span >= 5) ratePerWeek = Math.round(((lastTrend - base[1]) / span) * 7 * 10) / 10;
    }
    return { rows, logged: logged.length, todayValue, avg7, latestTrend, ratePerWeek };
  }, [data.daily, bodyMetric, bodyRange]);

  if (loading) {
    return (
      <div className="mx-auto max-w-lg px-4 pt-8 space-y-4">
        <div className="h-8 w-32 animate-pulse rounded-lg bg-muted" />
        <div className="grid grid-cols-4 gap-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-44 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
    );
  }

  const hasAnything =
    data.heatmap.some((c) => c.score >= 0) ||
    data.strength.length > 0 ||
    data.daily.length > 0;
  const metric = BODY_METRICS[bodyMetric];

  return (
    <div className="mx-auto max-w-lg px-4 pt-6 pb-24">
      <h1 className="text-2xl font-bold tracking-tight mb-5">Insights</h1>

      {/* Hero stats */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        <div className="rounded-xl border border-border bg-card px-2 py-3 text-center">
          <p className="text-xl font-bold tabular-nums">{data.sessionsThisWeek}</p>
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide mt-0.5">
            This week
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card px-2 py-3 text-center">
          <p className="text-xl font-bold tabular-nums">{data.setsThisWeek}</p>
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide mt-0.5">
            Sets
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card px-2 py-3 text-center">
          <p className="text-xl font-bold tabular-nums">{data.avgLiftsPerWeek}</p>
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide mt-0.5">
            Lifts / wk
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card px-2 py-3 text-center">
          <p className="text-xl font-bold tabular-nums">{data.avgRunsPerWeek}</p>
          <p className="text-[9px] text-muted-foreground uppercase tracking-wide mt-0.5">
            Runs / wk
          </p>
        </div>
      </div>

      {!hasAnything && (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center mb-4">
          <TrendingUp className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            Charts appear as you log workouts, protein, carbs, and weight.
          </p>
        </div>
      )}

      {/* Consistency heatmap */}
      {data.heatmap.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Dumbbell className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Consistency</h2>
            <span className="text-[10px] text-muted-foreground ml-auto">16 weeks</span>
          </div>
          <div className="flex gap-[3px] justify-between">
            {Array.from({ length: 16 }, (_, week) => (
              <div key={week} className="flex flex-col gap-[3px] flex-1">
                {Array.from({ length: 7 }, (_, day) => {
                  const cell = data.heatmap[week * 7 + day];
                  if (!cell)
                    return <div key={day} className="aspect-square rounded-[3px]" />;
                  const isSelected = selectedDay?.date === cell.date;
                  return (
                    <button
                      key={day}
                      onClick={() => setSelectedDay(isSelected ? null : cell)}
                      className={cn(
                        "aspect-square rounded-[3px] transition-transform",
                        isSelected && "ring-1 ring-white/70 scale-110"
                      )}
                      style={{ backgroundColor: heatFill(cell.score, maxHeatScore) }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {selectedDay && (
            <div className="mt-3 rounded-lg bg-muted/40 border border-border px-3 py-2">
              <p className="text-xs font-semibold mb-1">
                {new Date(selectedDay.date + "T12:00:00").toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </p>
              {selectedDay.items.length > 0 ? (
                <div className="space-y-0.5">
                  {selectedDay.items.map((item, i) => (
                    <p key={i} className="text-xs text-muted-foreground">
                      {item}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground/60">Rest day</p>
              )}
            </div>
          )}
          <p className="mt-2 text-[10px] text-muted-foreground/60">
            Deeper green = more sets. Tap a square for details.
          </p>
        </div>
      )}

      {/* Strength progression */}
      {activeStrength && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Strength (e1RM)</h2>
          </div>
          <div className={cn("grid gap-2 mb-3", gymSplit ? "grid-cols-2" : "grid-cols-1")}>
            <select
              value={activeStrength.name}
              onChange={(e) => {
                setSelectedExercise(e.target.value);
                setSelectedGym(ALL_GYMS);
              }}
              className="h-9 rounded-lg bg-muted/40 border border-border px-3 text-sm outline-none"
            >
              {data.strength.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            {gymSplit && (
              <select
                value={selectedGym}
                onChange={(e) => setSelectedGym(e.target.value)}
                className="h-9 rounded-lg bg-muted/40 border border-border px-3 text-sm outline-none"
              >
                <option value={ALL_GYMS}>{ALL_GYMS}</option>
                {activeStrength.gyms.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            )}
          </div>
          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={activeStrength.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="label"
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={["dataMin - 5", "dataMax + 5"]}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as StrengthRow;
                  return (
                    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-1">
                      <p className="text-[10px] text-muted-foreground">{row.label}</p>
                      {payload.map((item) => {
                        const key = String(item.dataKey);
                        const setV = row[`${key}__set`];
                        return (
                          <div key={key}>
                            <p className="text-sm font-semibold" style={{ color: item.color }}>
                              {key === "All" ? "e1RM" : key}: {item.value} lb
                            </p>
                            {setV && <p className="text-xs text-muted-foreground">set: {setV}</p>}
                          </div>
                        );
                      })}
                    </div>
                  );
                }}
              />
              {shownGyms.map((g) => {
                const colorIdx = activeStrength.gyms.indexOf(g);
                const color = GYM_COLORS[colorIdx % GYM_COLORS.length];
                return (
                  <Line
                    key={g}
                    type="monotone"
                    dataKey={g}
                    stroke={color}
                    strokeWidth={2}
                    dot={{ r: 3, fill: color, strokeWidth: 0 }}
                    activeDot={{ r: 6 }}
                    connectNulls
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
          {shownGyms.length > 1 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
              {shownGyms.map((g) => {
                const colorIdx = activeStrength.gyms.indexOf(g);
                return (
                  <span
                    key={g}
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: GYM_COLORS[colorIdx % GYM_COLORS.length] }}
                    />
                    {g}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Body & nutrition */}
      <div className="rounded-2xl border border-border bg-card p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <metric.Icon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Body &amp; Nutrition</h2>
          <div className="ml-auto flex rounded-lg bg-muted/40 border border-border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setBodyRange(r.days)}
                className={cn(
                  "px-2 py-0.5 text-[11px] rounded-md tabular-nums",
                  bodyRange === r.days
                    ? "bg-background text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/40 border border-border p-0.5 mb-3">
          {(Object.keys(BODY_METRICS) as BodyMetric[]).map((m) => (
            <button
              key={m}
              onClick={() => setBodyMetric(m)}
              className={cn(
                "h-8 rounded-md text-sm transition-colors",
                bodyMetric === m ? "bg-background font-medium" : "text-muted-foreground"
              )}
            >
              {BODY_METRICS[m].label}
            </button>
          ))}
        </div>

        {/* Headline numbers */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          {bodyMetric === "weight" ? (
            <>
              <div className="rounded-lg bg-muted/30 px-3 py-2">
                <p className="text-lg font-bold tabular-nums">
                  {body.latestTrend != null ? `${body.latestTrend} lb` : "—"}
                </p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Trend weight
                </p>
              </div>
              <div className="rounded-lg bg-muted/30 px-3 py-2">
                <p
                  className={cn(
                    "text-lg font-bold tabular-nums",
                    body.ratePerWeek != null && body.ratePerWeek > 0 && "text-emerald-400",
                    body.ratePerWeek != null && body.ratePerWeek < 0 && "text-red-400"
                  )}
                >
                  {body.ratePerWeek != null
                    ? `${body.ratePerWeek > 0 ? "+" : ""}${body.ratePerWeek} lb`
                    : "—"}
                </p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Per week
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg bg-muted/30 px-3 py-2">
                <p className="text-lg font-bold tabular-nums">
                  {body.todayValue != null ? `${body.todayValue}${metric.unit}` : "—"}
                </p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Today
                </p>
              </div>
              <div className="rounded-lg bg-muted/30 px-3 py-2">
                <p className="text-lg font-bold tabular-nums">
                  {body.avg7 != null ? `${body.avg7}${metric.unit}` : "—"}
                </p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  7-day avg
                </p>
              </div>
            </>
          )}
        </div>

        {body.logged === 0 ? (
          <div className="h-[170px] flex items-center justify-center rounded-lg border border-dashed border-border">
            <p className="text-xs text-muted-foreground text-center px-6">
              No {metric.label.toLowerCase()} logged in this range yet. Add it on Home and
              it shows up here right away.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={body.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="label"
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={28}
              />
              <YAxis
                domain={
                  bodyMetric === "weight"
                    ? ["dataMin - 2", "dataMax + 2"]
                    : [
                        (min: number) => Math.max(0, Math.floor((min * 0.85) / 10) * 10),
                        (max: number) => Math.ceil((max * 1.1) / 10) * 10,
                      ]
                }
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={36}
                allowDecimals={false}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as BodyRow;
                  if (row.value == null && row.trend == null) return null;
                  return (
                    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground">{row.label}</p>
                      {bodyMetric === "weight" ? (
                        <>
                          {row.trend != null && (
                            <p className="text-sm font-semibold" style={{ color: metric.color }}>
                              trend {row.trend} lb
                            </p>
                          )}
                          {row.value != null && (
                            <p className="text-xs text-muted-foreground">scale {row.value} lb</p>
                          )}
                        </>
                      ) : (
                        <p className="text-sm font-semibold" style={{ color: metric.color }}>
                          {row.value}
                          {metric.unit} {metric.label.toLowerCase()}
                        </p>
                      )}
                    </div>
                  );
                }}
              />
              {bodyMetric === "weight" ? (
                <>
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="rgba(59,130,246,0.35)"
                    strokeWidth={1.5}
                    dot={{ r: 2, fill: "rgba(59,130,246,0.35)", strokeWidth: 0 }}
                    activeDot={{ r: 4 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="trend"
                    stroke={COLOR_WEIGHT}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 5 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                </>
              ) : (
                <Line
                  type="linear"
                  dataKey="value"
                  stroke={metric.color}
                  strokeWidth={2}
                  dot={{ r: 3, fill: metric.color, strokeWidth: 0 }}
                  activeDot={{ r: 6 }}
                  connectNulls
                  isAnimationActive={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
        {body.logged > 0 && (
          <p className="mt-2 text-[10px] text-muted-foreground/60">
            {bodyMetric === "weight"
              ? "Faint line = scale weight, bold = smoothed trend."
              : `Logged ${body.logged} of ${bodyRange} days. Tap a point for details.`}
          </p>
        )}
      </div>
    </div>
  );
}
