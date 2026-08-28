"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { Equipment, PrType } from "@/types/database.types";
import { getEquipmentScope } from "@/lib/pr-detection";
import { kvGet, kvSet } from "@/lib/offline";
import { cn } from "@/lib/utils";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
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
  Trophy,
  Zap,
  Layers,
  Sparkles,
} from "lucide-react";

// Entity colors — validated for dark surface (lightness band, CVD, contrast)
const COLOR_LIFT = "#059669";
const COLOR_WEIGHT = "#3b82f6";
const COLOR_PROTEIN = "#ea580c";
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

type Unit = "lb" | "reps" | "s";

interface DayCell {
  date: string;
  score: number; // completed working sets that day; -1 = no training
  items: string[];
}

interface VolumePoint {
  label: string;
  volume: number;
}

type StrengthRow = { label: string; iso: string; [key: string]: string | number | null };

interface StrengthExercise {
  name: string;
  gyms: string[]; // series keys — gym names, or ["All"] for free-weight lifts
  rows: StrengthRow[];
}

interface StrongLift {
  exerciseName: string;
  value: number;
  unit: Unit;
  kind: string; // "e1RM" | "hold" | "volume" | ""
  set: string | null;
  sortValue: number;
  trendPct: number | null;
}

interface Spotlight {
  exerciseName: string;
  metric: string;
  previous: number;
  value: number;
  unit: Unit;
  pct: number;
}

interface SplitBar {
  pool: string;
  sets: number;
}

interface TrendPoint {
  label: string;
  value: number;
}

interface WeightPoint {
  label: string;
  iso: string;
  value: number;
  trend: number;
}

interface InsightsSnapshot {
  sessionsThisWeek: number;
  setsThisWeek: number;
  avgLiftsPerWeek: number;
  avgRunsPerWeek: number;
  spotlight: Spotlight | null;
  heatmap: DayCell[];
  strength: StrengthExercise[];
  strongLifts: StrongLift[];
  split: SplitBar[];
  volumePoints: VolumePoint[];
  weightData: WeightPoint[];
  weightRate: number | null; // lb per week, from the trend line
  proteinData: TrendPoint[];
}

const EMPTY: InsightsSnapshot = {
  sessionsThisWeek: 0,
  setsThisWeek: 0,
  avgLiftsPerWeek: 0,
  avgRunsPerWeek: 0,
  spotlight: null,
  heatmap: [],
  strength: [],
  strongLifts: [],
  split: [],
  volumePoints: [],
  weightData: [],
  weightRate: null,
  proteinData: [],
};

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shortLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

interface SetContext {
  weight?: number | null;
  reps?: number | null;
  duration_seconds?: number | null;
  display_value?: number;
  display_previous?: number;
}

function setString(ctx: SetContext | null): string | null {
  if (!ctx) return null;
  if (ctx.weight && ctx.reps) return `${ctx.weight} × ${ctx.reps}`;
  if (ctx.weight && ctx.duration_seconds) return `${ctx.weight} lb · ${ctx.duration_seconds}s`;
  if (ctx.duration_seconds) return `${ctx.duration_seconds}s`;
  if (ctx.reps) return `${ctx.reps} reps`;
  return null;
}

function metricInfo(type: PrType): { label: string; unit: Unit } {
  switch (type) {
    case "1RM":
      return { label: "e1RM", unit: "lb" };
    case "WEIGHT":
      return { label: "Top weight", unit: "lb" };
    case "VOL":
      return { label: "Volume", unit: "lb" };
    case "REPS":
      return { label: "Reps", unit: "reps" };
    case "DURATION":
      return { label: "Hold", unit: "s" };
  }
}

function fmtVal(value: number, unit: Unit): string {
  if (unit === "lb") return `${value.toLocaleString()} lb`;
  if (unit === "reps") return `${value} reps`;
  return `${value}s`;
}

// Headline priority — never lead with VOL unless it's the only record.
const TYPE_ORDER: PrType[] = ["1RM", "WEIGHT", "REPS", "DURATION", "VOL"];

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

export default function InsightsPage() {
  const [data, setData] = useState<InsightsSnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  const [selectedGym, setSelectedGym] = useState<string>(ALL_GYMS);
  const [selectedDay, setSelectedDay] = useState<DayCell | null>(null);
  const networkLoadedRef = useRef(false);
  const supabase = createClient();

  const load = useCallback(async () => {
    try {
      const now = new Date();
      const sixtyDaysAgo = new Date(now);
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

      const [trackingRes, workoutsRes, recordsRes, gymsRes, poolsRes, runsRes] =
        await Promise.all([
          supabase
            .from("daily_tracking")
            .select("*")
            .gte("date", dateKey(sixtyDaysAgo))
            .order("date"),
          supabase
            .from("workouts")
            .select("id, title, started_at, finished_at, gym_id")
            .not("finished_at", "is", null)
            .order("started_at", { ascending: false })
            .limit(150),
          supabase
            .from("personal_records")
            .select("*")
            .order("achieved_at", { ascending: false }),
          supabase.from("gyms").select("id, name"),
          supabase.from("exercise_pools").select("id, name"),
          supabase
            .from("run_sessions")
            .select("name, run_pool, started_at, duration_seconds, distance_meters")
            .not("duration_seconds", "is", null)
            .order("started_at", { ascending: false })
            .limit(150),
        ]);

      const workouts = workoutsRes.data || [];
      const records = recordsRes.data || [];
      const runs = runsRes.data || [];
      const gymMap = new Map((gymsRes.data || []).map((g) => [g.id, g.name]));
      const poolMap = new Map((poolsRes.data || []).map((p) => [p.id, p.name]));

      const workoutDate = new Map(workouts.map((w) => [w.id, w.started_at]));
      const gymByWorkout = new Map(
        workouts.map((w) => [w.id, w.gym_id ? gymMap.get(w.gym_id) || "Other gym" : "Other gym"])
      );

      // ---- Sets + exercises ----
      const workoutIds = workouts.map((w) => w.id);
      const { data: wes } = workoutIds.length
        ? await supabase
            .from("workout_exercises")
            .select("id, workout_id, exercise_id")
            .in("workout_id", workoutIds)
        : { data: [] };

      const weIds = (wes || []).map((we) => we.id);
      const { data: allSets } = weIds.length
        ? await supabase
            .from("sets")
            .select("workout_exercise_id, weight, reps, e1rm, is_warmup, completed_at")
            .in("workout_exercise_id", weIds)
            .not("completed_at", "is", null)
        : { data: [] };

      const exerciseIds = [
        ...new Set([
          ...(wes || []).map((we) => we.exercise_id),
          ...records.map((r) => r.exercise_id),
        ]),
      ];
      const { data: defs } = exerciseIds.length
        ? await supabase
            .from("exercise_definitions")
            .select("id, name, equipment, pool_id")
            .in("id", exerciseIds)
        : { data: [] };
      const nameMap = new Map((defs || []).map((d) => [d.id, d.name]));
      const equipMap = new Map<string, Equipment | null>(
        (defs || []).map((d) => [d.id, d.equipment])
      );
      const poolByExercise = new Map((defs || []).map((d) => [d.id, d.pool_id]));

      // ---- Aggregate sets ----
      const weMeta = new Map(
        (wes || []).map((we) => [
          we.id,
          { workoutId: we.workout_id, exerciseId: we.exercise_id },
        ])
      );
      const volumeByWorkout = new Map<string, number>();
      const setsByWorkout = new Map<string, number>();
      type BestSet = { e1rm: number; weight: number | null; reps: number | null };
      const e1rmByExercise = new Map<string, Map<string, BestSet>>();

      const cutoff28 = new Date(now);
      cutoff28.setDate(cutoff28.getDate() - 28);
      const setsByPool = new Map<string, number>();

      for (const s of allSets || []) {
        const meta = weMeta.get(s.workout_exercise_id);
        if (!meta) continue;
        if (!s.is_warmup) {
          setsByWorkout.set(meta.workoutId, (setsByWorkout.get(meta.workoutId) || 0) + 1);
          const iso = workoutDate.get(meta.workoutId);
          if (iso && new Date(iso) >= cutoff28) {
            const poolId = poolByExercise.get(meta.exerciseId);
            const poolName = poolId ? poolMap.get(poolId) || "Other" : "Other";
            setsByPool.set(poolName, (setsByPool.get(poolName) || 0) + 1);
          }
        }
        if (!s.is_warmup && s.weight && s.reps) {
          volumeByWorkout.set(
            meta.workoutId,
            (volumeByWorkout.get(meta.workoutId) || 0) + s.weight * s.reps
          );
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

      // ---- PR Spotlight: standout improvement, biased toward core lifts ----
      // A raw %-jump favors brand-new or light accessory lifts (fast early
      // gains). Instead, score = % improvement × importance, where importance
      // rewards lifts you train often and compound free-weight movements.
      const sessionsByExercise = new Map<string, Set<string>>();
      for (const we of wes || []) {
        const set = sessionsByExercise.get(we.exercise_id) ?? new Set<string>();
        set.add(we.workout_id);
        sessionsByExercise.set(we.exercise_id, set);
      }
      const equipWeight = (eq: Equipment | null): number => {
        switch (eq) {
          case "barbell":
            return 1.4;
          case "dumbbell":
            return 1.2;
          case "bodyweight":
            return 1.15;
          case "kettlebell":
            return 1.1;
          case "smith_machine":
            return 1.05;
          default:
            return 1.0;
        }
      };
      const spotCutoff = new Date(now);
      spotCutoff.setDate(spotCutoff.getDate() - 30);
      let spotlight: Spotlight | null = null;
      let spotScore = -1;
      let spotFallback: Spotlight | null = null;
      let spotFallbackScore = -1;
      for (const r of records) {
        if (new Date(r.achieved_at) < spotCutoff) continue;
        const ctx = r.context_json as SetContext | null;
        const value = ctx?.display_value ?? r.value;
        const previous = ctx?.display_previous ?? r.previous_value;
        if (previous == null || previous <= 0) continue;
        const pct = ((value - previous) / previous) * 100;
        if (pct <= 0) continue;
        const sessions = sessionsByExercise.get(r.exercise_id)?.size ?? 1;
        const importance =
          Math.min(sessions, 12) * equipWeight(equipMap.get(r.exercise_id) ?? null);
        const score = pct * importance;
        const info = metricInfo(r.pr_type as PrType);
        const candidate: Spotlight = {
          exerciseName: nameMap.get(r.exercise_id) || "Unknown",
          metric: info.label,
          previous: Math.round(previous),
          value: Math.round(value),
          unit: info.unit,
          pct,
        };
        // Prefer established lifts (>= 3 sessions); fall back if none qualify
        if (sessions >= 3) {
          if (score > spotScore) {
            spotScore = score;
            spotlight = candidate;
          }
        } else if (score > spotFallbackScore) {
          spotFallbackScore = score;
          spotFallback = candidate;
        }
      }
      if (!spotlight) spotlight = spotFallback;

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
      const trendByExercise = new Map<string, number | null>();
      const bestE1rmByExercise = new Map<string, number>();

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

        bestE1rmByExercise.set(exId, Math.max(...pts.map((p) => p.best.e1rm)));
        if (pts.length >= 2) {
          const latest = pts[pts.length - 1];
          const cutoff = new Date(latest.iso);
          cutoff.setDate(cutoff.getDate() - 28);
          let baseline = pts[0];
          for (const p of pts) if (new Date(p.iso) <= cutoff) baseline = p;
          trendByExercise.set(
            exId,
            baseline.iso !== latest.iso && baseline.best.e1rm > 0
              ? ((latest.best.e1rm - baseline.best.e1rm) / baseline.best.e1rm) * 100
              : null
          );
        }

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

      // ---- Strongest lifts (one headline per exercise, VOL never leads) ----
      const recordsByExercise = new Map<string, typeof records>();
      for (const r of records) {
        const arr = recordsByExercise.get(r.exercise_id) || [];
        arr.push(r);
        recordsByExercise.set(r.exercise_id, arr);
      }
      const strongLifts: StrongLift[] = [];
      for (const [exId, recs] of recordsByExercise) {
        const name = nameMap.get(exId) || "Unknown";
        const bestByType = new Map<PrType, { value: number; ctx: SetContext | null }>();
        for (const r of recs) {
          const t = r.pr_type as PrType;
          const ctx = r.context_json as SetContext | null;
          const v = ctx?.display_value ?? r.value;
          const cur = bestByType.get(t);
          if (!cur || v > cur.value) bestByType.set(t, { value: v, ctx });
        }
        const headlineType = TYPE_ORDER.find((t) => bestByType.has(t));
        if (!headlineType) continue;
        const h = bestByType.get(headlineType)!;
        const info = metricInfo(headlineType);
        const e1 = bestE1rmByExercise.get(exId);
        const showSet =
          headlineType === "1RM" || headlineType === "WEIGHT" || headlineType === "VOL";
        strongLifts.push({
          exerciseName: name,
          value: Math.round(h.value),
          unit: info.unit,
          kind:
            headlineType === "1RM"
              ? "e1RM"
              : headlineType === "DURATION"
                ? "hold"
                : headlineType === "VOL"
                  ? "volume"
                  : "",
          set: showSet ? setString(h.ctx) : null,
          sortValue: e1 ?? 0,
          trendPct: trendByExercise.get(exId) ?? null,
        });
      }
      strongLifts.sort((a, b) => b.sortValue - a.sortValue || b.value - a.value);
      const topLifts = strongLifts.slice(0, 10);

      // ---- Training split (last 28 days) ----
      const split = [...setsByPool.entries()]
        .map(([p, sets]) => ({ pool: p, sets }))
        .sort((a, b) => b.sets - a.sets);

      // ---- Volume per workout ----
      const volumePoints: VolumePoint[] = workouts
        .slice(0, 15)
        .reverse()
        .map((w) => ({ label: shortLabel(w.started_at), volume: volumeByWorkout.get(w.id) || 0 }));

      // ---- Body weight + protein ----
      // Trend = gap-aware exponential moving average over logged entries,
      // smoothing out daily water/sodium noise into a "true weight" line.
      const weightData: WeightPoint[] = [];
      const proteinData: TrendPoint[] = [];
      let emaPrev: number | null = null;
      let emaPrevDate: Date | null = null;
      for (const t of trackingRes.data || []) {
        const label = new Date(t.date + "T12:00:00").toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        if (t.morning_weight) {
          const d = new Date(t.date + "T12:00:00");
          let trend: number;
          if (emaPrev == null || emaPrevDate == null) {
            trend = t.morning_weight;
          } else {
            const gapDays = Math.max(
              1,
              (d.getTime() - emaPrevDate.getTime()) / 86400000
            );
            const alpha = 1 - Math.pow(0.85, gapDays);
            trend = emaPrev + alpha * (t.morning_weight - emaPrev);
          }
          emaPrev = trend;
          emaPrevDate = d;
          weightData.push({
            label,
            iso: t.date,
            value: t.morning_weight,
            trend: Math.round(trend * 10) / 10,
          });
        }
        if (t.protein_grams) proteinData.push({ label, value: t.protein_grams });
      }

      // Weekly rate of change from the trend line (needs >= 5 days of span)
      let weightRate: number | null = null;
      if (weightData.length >= 2) {
        const last = weightData[weightData.length - 1];
        const lastDate = new Date(last.iso + "T12:00:00");
        // baseline: the entry closest to 14 days before the latest
        let baseline = weightData[0];
        for (const p of weightData) {
          const days =
            (lastDate.getTime() - new Date(p.iso + "T12:00:00").getTime()) / 86400000;
          if (days >= 14) baseline = p;
        }
        const spanDays =
          (lastDate.getTime() - new Date(baseline.iso + "T12:00:00").getTime()) /
          86400000;
        if (spanDays >= 5) {
          weightRate =
            Math.round(((last.trend - baseline.trend) / spanDays) * 7 * 10) / 10;
        }
      }

      const snapshot: InsightsSnapshot = {
        sessionsThisWeek,
        setsThisWeek,
        avgLiftsPerWeek,
        avgRunsPerWeek,
        spotlight,
        heatmap,
        strength,
        strongLifts: topLifts,
        split,
        volumePoints,
        weightData,
        weightRate,
        proteinData: proteinData.slice(-14),
      };

      setData(snapshot);
      networkLoadedRef.current = true;
      kvSet("insights:v7", snapshot);
    } catch {
      // Offline — snapshot hydration has already painted what we have
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    kvGet<InsightsSnapshot>("insights:v7").then((snap) => {
      if (!snap || networkLoadedRef.current) return;
      setData(snap);
      setLoading(false);
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
  const maxSplit = Math.max(1, ...data.split.map((s) => s.sets));

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
    data.strongLifts.length > 0 ||
    data.weightData.length > 0;

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
            Charts appear as you log workouts, weight, and protein.
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

      {/* Strongest lifts */}
      {data.strongLifts.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Trophy className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-semibold">Strongest Lifts</h2>
          </div>
          <div className="divide-y divide-border/60">
            {data.strongLifts.map((lift) => (
              <div key={lift.exerciseName} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{lift.exerciseName}</p>
                  {lift.set && (
                    <p className="text-[11px] text-muted-foreground tabular-nums">{lift.set}</p>
                  )}
                </div>
                {lift.trendPct != null && Math.abs(lift.trendPct) >= 1 && (
                  <span
                    className={cn(
                      "text-[11px] font-medium tabular-nums shrink-0",
                      lift.trendPct > 0 ? "text-emerald-400" : "text-red-400"
                    )}
                  >
                    {lift.trendPct > 0 ? "↑" : "↓"}
                    {Math.abs(Math.round(lift.trendPct))}%
                  </span>
                )}
                <div className="text-right shrink-0 w-20">
                  <p className="text-sm font-semibold tabular-nums">
                    {fmtVal(lift.value, lift.unit)}
                  </p>
                  {lift.kind && (
                    <p className="text-[10px] text-muted-foreground">{lift.kind}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[10px] text-muted-foreground/60">
            ↑↓ vs 28 days ago · sorted by estimated 1RM
          </p>
        </div>
      )}

      {/* PR Spotlight */}
      {data.spotlight && (
        <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-transparent p-4 mb-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
              PR Spotlight
            </p>
            <span className="ml-auto text-[10px] text-muted-foreground">last 30 days</span>
          </div>
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="text-base font-bold truncate">{data.spotlight.exerciseName}</p>
              <p className="text-xs text-muted-foreground tabular-nums mt-0.5">
                {data.spotlight.metric} {fmtVal(data.spotlight.previous, data.spotlight.unit)} →{" "}
                {fmtVal(data.spotlight.value, data.spotlight.unit)}
              </p>
            </div>
            <p className="text-2xl font-bold text-emerald-400 tabular-nums shrink-0">
              +{Math.round(data.spotlight.pct)}%
            </p>
          </div>
        </div>
      )}

      {/* Training split */}
      {data.split.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Training Split</h2>
            <span className="text-[10px] text-muted-foreground ml-auto">last 28 days</span>
          </div>
          <div className="space-y-2">
            {data.split.map((s) => (
              <div key={s.pool} className="flex items-center gap-2">
                <span className="text-xs w-20 shrink-0 truncate">{s.pool}</span>
                <div className="flex-1 h-4 rounded bg-muted/40 overflow-hidden">
                  <div
                    className="h-full rounded"
                    style={{ width: `${(s.sets / maxSplit) * 100}%`, backgroundColor: COLOR_LIFT }}
                  />
                </div>
                <span className="text-xs tabular-nums text-muted-foreground w-10 text-right shrink-0">
                  {s.sets}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Volume per workout */}
      {data.volumePoints.length > 1 && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Volume per Workout</h2>
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={data.volumePoints} barCategoryGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="label"
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={32}
                tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value) => [`${Number(value).toLocaleString()} lb`, "Volume"]}
              />
              <Bar dataKey="volume" fill={COLOR_LIFT} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Body weight */}
      {data.weightData.length > 1 && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Weight className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Body Weight</h2>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {data.weightData[data.weightData.length - 1].trend} lb
              {data.weightRate != null && (
                <span
                  className={cn(
                    "ml-1.5",
                    data.weightRate > 0
                      ? "text-emerald-400"
                      : data.weightRate < 0
                        ? "text-red-400"
                        : ""
                  )}
                >
                  {data.weightRate > 0 ? "+" : ""}
                  {data.weightRate}/wk
                </span>
              )}
            </span>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={data.weightData}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="label"
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={["dataMin - 2", "dataMax + 2"]}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as WeightPoint;
                  return (
                    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground">{p.label}</p>
                      <p className="text-sm font-semibold">trend {p.trend} lb</p>
                      <p className="text-xs text-muted-foreground">scale {p.value} lb</p>
                    </div>
                  );
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="rgba(59,130,246,0.35)"
                strokeWidth={1.5}
                dot={{ r: 2, fill: "rgba(59,130,246,0.35)", strokeWidth: 0 }}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="trend"
                stroke={COLOR_WEIGHT}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="flex gap-x-3 mt-2">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: COLOR_WEIGHT }} />
              Trend
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: "rgba(59,130,246,0.35)" }}
              />
              Scale weight
            </span>
          </div>
        </div>
      )}

      {/* Protein */}
      {data.proteinData.length > 1 && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Flame className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Protein</h2>
            <span className="ml-auto text-xs text-muted-foreground">last 14 days</span>
          </div>
          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={data.proteinData} barCategoryGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="label"
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis tick={TICK_STYLE} tickLine={false} axisLine={false} width={32} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value) => [`${value}g`, "Protein"]}
              />
              <Bar dataKey="value" fill={COLOR_PROTEIN} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
