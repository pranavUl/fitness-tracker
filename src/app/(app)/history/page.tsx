"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, getUserId } from "@/lib/supabase/client";
import {
  WorkoutRecord,
  getActiveLocalWorkout,
  hasUnsyncedChanges,
  kvGet,
  kvSet,
  listWorkoutRecords,
  loadCachedWorkout,
  markWorkoutDeleted,
  mergePendingRows,
  queueDelete,
  queueUpdate,
  queueUpsert,
  saveWorkoutLocal,
} from "@/lib/offline";
import { getCachedExercises, getCachedGyms, refreshLibrary } from "@/lib/reference-data";
import { WorkoutExerciseState, setPrTypes } from "@/lib/workout-state";
import { Database, TrackingMode, PrType } from "@/types/database.types";
import { PR_BADGE_STYLES, PR_BADGE_LABELS } from "@/lib/pr-constants";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from "@/components/ui/drawer";
import { useRouter } from "next/navigation";
import {
  Calendar,
  MapPin,
  Timer,
  Dumbbell,
  MoreVertical,
  Pencil,
  Trash2,
  Share,
  Weight,
  SquarePen,
  Repeat,
  Zap,
  Footprints,
  Gauge,
  Trophy,
  Goal,
} from "lucide-react";

type Workout = Database["public"]["Tables"]["workouts"]["Row"];

interface WorkoutWithDetails extends Workout {
  gym_name: string | null;
  total_volume: number;
  pr_count: number;
  exercises: {
    exercise_id?: string;
    name: string;
    mode: TrackingMode;
    sets: {
      set_number: number;
      reps: number | null;
      weight: number | null;
      duration_seconds: number | null;
      is_warmup: boolean;
      completed_at: string | null;
      note: string | null;
      prs: PrType[];
    }[];
  }[];
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function formatSetValue(
  mode: TrackingMode,
  set: {
    reps: number | null;
    weight: number | null;
    duration_seconds: number | null;
  }
): string {
  switch (mode) {
    case "reps_weight":
      return `${set.weight ?? 0}lb × ${set.reps ?? 0}`;
    case "time_weight":
      return `${set.weight ?? 0}lb × ${set.duration_seconds ?? 0}s`;
    case "time_only":
      return `${set.duration_seconds ?? 0}s`;
    case "reps_only":
    case "reps_assisted":
      return `${set.reps ?? 0} reps`;
    case "presence":
      return "done";
  }
}

function workoutToText(w: WorkoutWithDetails): string {
  const date = new Date(w.started_at).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const dur = w.finished_at
    ? formatDuration(w.started_at, w.finished_at)
    : "?";
  const lines = [
    `${w.title || "Workout"} — ${date}`,
    w.gym_name ? `Gym: ${w.gym_name}` : null,
    `Duration: ${dur}`,
    w.total_volume > 0 ? `Total volume: ${w.total_volume.toLocaleString()} lb` : null,
    "",
  ].filter((l) => l !== null);

  for (const ex of w.exercises) {
    lines.push(ex.name);
    for (const set of ex.sets) {
      const prefix = set.is_warmup ? "  W" : `  ${set.set_number}`;
      lines.push(`${prefix}. ${formatSetValue(ex.mode, set)}${set.note ? ` — ${set.note}` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

type RunSession = Database["public"]["Tables"]["run_sessions"]["Row"];

interface HistorySnapshot {
  workouts: WorkoutWithDetails[];
  runSessions: RunSession[];
}

// v2 adds exercise ids, which offline "repeat workout" needs
const HISTORY_KEY = "history:v2";

function toWorkoutRow(w: WorkoutWithDetails): Workout {
  return {
    id: w.id,
    user_id: w.user_id,
    gym_id: w.gym_id,
    title: w.title,
    started_at: w.started_at,
    finished_at: w.finished_at,
    notes: w.notes,
    workout_type: w.workout_type,
    created_at: w.created_at,
  };
}

function recordToDetails(
  r: WorkoutRecord,
  gymName: (id: string | null) => string | null
): WorkoutWithDetails {
  let totalVolume = 0;
  let prCount = 0;
  const exercises = r.exercises.map((e) => ({
    exercise_id: e.definition.id,
    name: e.definition.name,
    mode: e.workoutExercise.mode,
    sets: e.sets.map((s) => {
      const prs = (s.id && r.prs[s.id]) || [];
      if (!s.is_warmup && s.weight && s.reps) totalVolume += s.weight * s.reps;
      prCount += prs.length;
      return {
        set_number: s.set_number,
        reps: s.reps,
        weight: s.weight,
        duration_seconds: s.duration_seconds,
        is_warmup: s.is_warmup,
        completed_at: s.completed_at,
        note: s.note,
        prs,
      };
    }),
  }));
  return {
    ...r.workout,
    gym_name: gymName(r.workout.gym_id),
    total_volume: totalVolume,
    pr_count: prCount,
    exercises,
  };
}

interface HistoryItem {
  id: string;
  type: "lift" | "run";
  title: string;
  started_at: string;
  data: WorkoutWithDetails | RunSession;
}

const RUN_POOL_STYLE: Record<string, { Icon: typeof Zap; color: string; bg: string }> = {
  speed: { Icon: Zap, color: "text-red-400", bg: "bg-red-500/15" },
  easy: { Icon: Footprints, color: "text-green-400", bg: "bg-green-500/15" },
  threshold: { Icon: Gauge, color: "text-amber-400", bg: "bg-amber-500/15" },
  soccer: { Icon: Goal, color: "text-sky-400", bg: "bg-sky-500/15" },
};

export default function HistoryPage() {
  const [workouts, setWorkouts] = useState<WorkoutWithDetails[]>([]);
  const [runSessions, setRunSessions] = useState<RunSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuWorkout, setMenuWorkout] = useState<WorkoutWithDetails | null>(
    null
  );
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [activeWorkoutId, setActiveWorkoutId] = useState<string | null>(null);
  const [menuRun, setMenuRun] = useState<RunSession | null>(null);
  const [runEditOpen, setRunEditOpen] = useState(false);
  const [runEditName, setRunEditName] = useState("");
  const [runDeleteOpen, setRunDeleteOpen] = useState(false);
  const networkLoadedRef = useRef(false);
  const serverRef = useRef<HistorySnapshot>({ workouts: [], runSessions: [] });
  const renderSeqRef = useRef(0);
  const supabase = createClient();
  const router = useRouter();

  /** Server view plus everything saved on this phone that it may not have yet. */
  const render = useCallback(async (snap: HistorySnapshot) => {
    serverRef.current = snap;
    const seq = ++renderSeqRef.current;
    const [records, gyms, runs] = await Promise.all([
      listWorkoutRecords(),
      getCachedGyms(),
      mergePendingRows("run_sessions", snap.runSessions),
    ]);
    // A newer paint (e.g. fresh network data) started while this one was reading
    if (seq !== renderSeqRef.current) return;
    const byId = new Map(records.map((r) => [r.workout.id, r]));
    const gymName = (id: string | null) => gyms?.find((g) => g.id === id)?.name ?? null;
    const unsynced = (r: WorkoutRecord) => !!r.workout.finished_at && hasUnsyncedChanges(r);
    const local = records
      .filter((r) => !r.deleted && unsynced(r))
      .map((r) => recordToDetails(r, gymName));
    setWorkouts(
      [
        ...snap.workouts.filter((w) => {
          const r = byId.get(w.id);
          return !r || (!r.deleted && !unsynced(r));
        }),
        ...local,
      ].sort((a, b) => b.started_at.localeCompare(a.started_at))
    );
    setRunSessions(
      runs
        .filter((r) => r.duration_seconds != null)
        .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
    );
  }, []);

  const load = useCallback(async () => {
    let computedWorkouts: WorkoutWithDetails[] = [];
    try {
    const [workoutsRes, gymsRes] = await Promise.all([
      supabase
        .from("workouts")
        .select("*")
        .not("finished_at", "is", null)
        .order("started_at", { ascending: false })
        .limit(50),
      supabase.from("gyms").select("*"),
    ]);
    // Supabase reports "no signal" as an error, not an exception
    if (workoutsRes.error || gymsRes.error) throw new Error("offline");

    const gymMap = new Map(
      (gymsRes.data || []).map((g) => [g.id, g.name])
    );

    const ws = workoutsRes.data || [];

    if (ws.length) {
      const workoutIds = ws.map((w) => w.id);
      const { data: wes, error: wesErr } = await supabase
        .from("workout_exercises")
        .select("*")
        .in("workout_id", workoutIds)
        .order("sort_order");
      if (wesErr) throw new Error("offline");

      const weIds = (wes || []).map((we) => we.id);
      const exerciseIds = [
        ...new Set((wes || []).map((we) => we.exercise_id)),
      ];

      const [setsRes, defsRes] = await Promise.all([
        weIds.length
          ? supabase
              .from("sets")
              .select("*")
              .in("workout_exercise_id", weIds)
              .order("set_number")
          : Promise.resolve({
              data: [] as Database["public"]["Tables"]["sets"]["Row"][],
              error: null,
            }),
        exerciseIds.length
          ? supabase
              .from("exercise_definitions")
              .select("id, name")
              .in("id", exerciseIds)
          : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
      ]);
      if (setsRes.error || defsRes.error) throw new Error("offline");

      const defMap = new Map(
        (defsRes.data || []).map((d) => [d.id, d.name])
      );

      const setsByWe = new Map<
        string,
        Database["public"]["Tables"]["sets"]["Row"][]
      >();
      for (const s of setsRes.data || []) {
        const arr = setsByWe.get(s.workout_exercise_id) || [];
        arr.push(s);
        setsByWe.set(s.workout_exercise_id, arr);
      }

      const wesByWorkout = new Map<
        string,
        Database["public"]["Tables"]["workout_exercises"]["Row"][]
      >();
      for (const we of wes || []) {
        const arr = wesByWorkout.get(we.workout_id) || [];
        arr.push(we);
        wesByWorkout.set(we.workout_id, arr);
      }

      computedWorkouts = ws.map((w) => {
          const exs = (wesByWorkout.get(w.id) || []).map((we) => ({
            exercise_id: we.exercise_id,
            name: defMap.get(we.exercise_id) || "Unknown",
            mode: we.mode,
            sets: (setsByWe.get(we.id) || []).map((s) => ({
              set_number: s.set_number,
              reps: s.reps,
              weight: s.weight,
              duration_seconds: s.duration_seconds,
              is_warmup: s.is_warmup,
              completed_at: s.completed_at,
              note: s.note,
              prs: setPrTypes(s),
            })),
          }));

          let totalVolume = 0;
          let prCount = 0;
          for (const ex of exs) {
            for (const set of ex.sets) {
              if (!set.is_warmup && set.weight && set.reps) {
                totalVolume += set.weight * set.reps;
              }
              prCount += set.prs.length;
            }
          }

          return {
            ...w,
            gym_name: w.gym_id ? gymMap.get(w.gym_id) || null : null,
            total_volume: totalVolume,
            pr_count: prCount,
            exercises: exs,
          };
        });
    }

    // Run sessions
    const { data: runs, error: runsErr } = await supabase
      .from("run_sessions")
      .select("*")
      .not("duration_seconds", "is", null)
      .order("started_at", { ascending: false })
      .limit(50);
    if (runsErr) throw new Error("offline");

    networkLoadedRef.current = true;
    const snap = { workouts: computedWorkouts, runSessions: runs || [] };
    kvSet(HISTORY_KEY, snap);
    await render(snap);
    } catch {
      // No signal — show the last snapshot plus whatever is saved on this phone
      await render(serverRef.current);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render]);

  // Instant paint from the last snapshot
  useEffect(() => {
    kvGet<HistorySnapshot>(HISTORY_KEY).then(async (snap) => {
      if (!snap || networkLoadedRef.current) return;
      await render(snap);
      setLoading(false);
    });
  }, [render]);

  useEffect(() => {
    load();
  }, [load]);

  /** Apply a local edit to the cached server view too, so it survives an offline reopen. */
  async function patchHistory(fn: (s: HistorySnapshot) => HistorySnapshot) {
    const next = fn(serverRef.current);
    await kvSet(HISTORY_KEY, next);
    await render(next);
  }

  const allItems: HistoryItem[] = [
    ...workouts.map((w) => ({
      id: w.id,
      type: "lift" as const,
      title: w.title || "Workout",
      started_at: w.started_at,
      data: w,
    })),
    ...runSessions.filter((r) => r.started_at).map((r) => ({
      id: r.id,
      type: "run" as const,
      title: r.name || "Run",
      started_at: r.started_at!,
      data: r,
    })),
  ].sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

  const grouped = allItems.reduce(
    (acc, item) => {
      const date = new Date(item.started_at);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const key = weekStart.toISOString().split("T")[0];
      const label = weekStart.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      if (!acc.has(key))
        acc.set(key, { label: `Week of ${label}`, items: [] });
      acc.get(key)!.items.push(item);
      return acc;
    },
    new Map<string, { label: string; items: HistoryItem[] }>()
  );

  async function handleEditTitle() {
    if (!menuWorkout || !editTitle.trim()) return;
    const id = menuWorkout.id;
    const title = editTitle.trim();
    const rec = await loadCachedWorkout(id);
    if (rec && !rec.deleted) {
      // A copy on this phone would overwrite the server on its next sync — edit it too
      await saveWorkoutLocal(
        id,
        { workout: { ...rec.workout, title }, exercises: rec.exercises, prs: rec.prs },
        { dirty: true }
      );
    } else {
      await queueUpdate("workouts", id, { title });
    }
    setEditOpen(false);
    setMenuWorkout(null);
    await patchHistory((s) => ({
      ...s,
      workouts: s.workouts.map((w) => (w.id === id ? { ...w, title } : w)),
    }));
  }

  async function handleDelete() {
    if (!menuWorkout) return;
    const id = menuWorkout.id;
    // Tombstone: the sync engine revokes its PRs and deletes it server-side
    await markWorkoutDeleted(toWorkoutRow(menuWorkout));
    setDeleteConfirmOpen(false);
    setMenuWorkout(null);
    await patchHistory((s) => ({ ...s, workouts: s.workouts.filter((w) => w.id !== id) }));
  }

  async function handleExport() {
    if (!menuWorkout) return;
    const text = workoutToText(menuWorkout);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(menuWorkout.title || "workout").replace(/\s+/g, "-")}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    }
    setMenuWorkout(null);
  }

  function handleEdit() {
    if (!menuWorkout) return;
    setMenuWorkout(null);
    router.push(`/workout?id=${menuWorkout.id}`);
  }

  async function handleRepeat() {
    if (!menuWorkout) return;
    const active = await getActiveLocalWorkout();
    if (active) {
      setActiveWorkoutId(active.id);
      setConflictOpen(true);
      return;
    }
    await doRepeat();
  }

  async function doRepeat() {
    if (!menuWorkout) return;
    const source = menuWorkout;
    const userId = await getUserId(supabase);
    if (!userId) return;

    let defs = await getCachedExercises();
    const missing = source.exercises.some(
      (ex) => ex.exercise_id && !defs?.some((d) => d.id === ex.exercise_id)
    );
    if (!defs || missing) defs = (await refreshLibrary(supabase))?.exercises ?? defs ?? [];
    const defMap = new Map(defs.map((d) => [d.id, d]));

    // Built on the phone — works with zero signal, syncs later
    const workoutId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const workout: Workout = {
      id: workoutId,
      user_id: userId,
      gym_id: source.gym_id,
      title: source.title,
      started_at: startedAt,
      finished_at: null,
      notes: null,
      workout_type: source.workout_type,
      created_at: startedAt,
    };
    const exercises: WorkoutExerciseState[] = source.exercises
      .filter((ex) => ex.exercise_id && defMap.has(ex.exercise_id))
      .map((ex, i) => ({
        workoutExercise: {
          id: crypto.randomUUID(),
          user_id: userId,
          workout_id: workoutId,
          exercise_id: ex.exercise_id!,
          sort_order: i,
          mode: ex.mode,
          is_warmup_group: false,
          notes: null,
          started_at: null,
          created_at: startedAt,
        },
        definition: defMap.get(ex.exercise_id!)!,
        sets: ex.sets.map((s) => ({
          id: crypto.randomUUID(),
          set_number: s.set_number,
          reps: s.reps,
          weight: s.weight,
          duration_seconds: s.duration_seconds,
          is_warmup: s.is_warmup,
          note: s.note,
          completed_at: null,
        })),
        previous: null,
      }));

    await saveWorkoutLocal(workoutId, { workout, exercises, prs: {} }, { dirty: true });
    try { localStorage.setItem("active_workout_id", workoutId); } catch {}

    setMenuWorkout(null);
    setConflictOpen(false);
    router.push(`/workout?id=${workoutId}`);
  }

  async function handleDiscardAndRepeat() {
    if (!activeWorkoutId) return;
    const rec = await loadCachedWorkout(activeWorkoutId);
    if (rec) await markWorkoutDeleted(rec.workout);
    try { localStorage.removeItem("active_workout_id"); } catch {}
    setActiveWorkoutId(null);
    await doRepeat();
  }

  async function handleRunEditName() {
    if (!menuRun || !runEditName.trim()) return;
    const id = menuRun.id;
    const name = runEditName.trim();
    await queueUpdate("run_sessions", id, { name });
    setRunEditOpen(false);
    setMenuRun(null);
    await patchHistory((s) => ({
      ...s,
      runSessions: s.runSessions.map((r) => (r.id === id ? { ...r, name } : r)),
    }));
  }

  async function handleRunDelete() {
    if (!menuRun) return;
    const id = menuRun.id;
    await queueDelete("run_sessions", id);
    setRunDeleteOpen(false);
    setMenuRun(null);
    await patchHistory((s) => ({ ...s, runSessions: s.runSessions.filter((r) => r.id !== id) }));
  }

  async function handleRunRepeat() {
    if (!menuRun) return;
    const userId = await getUserId(supabase);
    if (!userId) return;

    const rawData = menuRun.raw_data as Record<string, unknown> | null;
    const id = crypto.randomUUID();
    await queueUpsert("run_sessions", {
      id,
      user_id: userId,
      source: "manual",
      name: menuRun.name,
      run_pool: menuRun.run_pool,
      run_workout: menuRun.run_workout,
      started_at: new Date().toISOString(),
      completed: false,
      raw_data: {
        templateId: rawData?.templateId || menuRun.run_workout,
        ...(rawData?.variantId ? { variantId: rawData.variantId } : {}),
      },
    });

    setMenuRun(null);
    router.push(`/run?id=${id}`);
  }

  function handleRunExport() {
    if (!menuRun) return;
    const date = menuRun.started_at
      ? new Date(menuRun.started_at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
      : "Unknown date";
    const dur = menuRun.duration_seconds != null ? `${Math.floor(menuRun.duration_seconds / 60)}m ${menuRun.duration_seconds % 60}s` : "—";
    const rawData = menuRun.raw_data as Record<string, unknown> | null;
    const savedSplits = (rawData?.splits as Record<string, string>) || {};
    const lines = [
      `${menuRun.name} — ${date}`,
      `Duration: ${dur}`,
      menuRun.completed ? "Completed" : "Partial",
      rawData?.tier ? `Tier: ${rawData.tier}` : null,
      "",
    ].filter((l) => l !== null);

    if (Object.keys(savedSplits).length > 0) {
      lines.push("Splits:");
      for (const [key, val] of Object.entries(savedSplits)) {
        lines.push(`  ${key}: ${val}`);
      }
      lines.push("");
    }

    if (menuRun.notes) lines.push(`Notes: ${menuRun.notes}`);

    const text = lines.join("\n");
    navigator.clipboard.writeText(text).catch(() => {
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(menuRun.name || "run").replace(/\s+/g, "-")}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    });
    setMenuRun(null);
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-lg px-4 pt-8 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 pt-6 pb-24">
      <h1 className="text-2xl font-bold tracking-tight mb-6">History</h1>

      {allItems.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center">
          <Dumbbell className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            No completed workouts yet. Finish your first workout to see it here.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {[...grouped.entries()].map(
            ([key, { label, items }]) => (
              <div key={key} className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                  {label}
                </h2>
                {items.map((item) => {
                  if (item.type === "run") {
                    const r = item.data as RunSession;
                    const style = RUN_POOL_STYLE[r.run_pool || "speed"] || RUN_POOL_STYLE.speed;
                    return (
                      <div
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => router.push(`/run?id=${r.id}`)}
                        onKeyDown={(e) => e.key === "Enter" && router.push(`/run?id=${r.id}`)}
                        className="rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent active:scale-[0.99] cursor-pointer"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div className={`h-9 w-9 rounded-xl ${style.bg} flex items-center justify-center shrink-0`}>
                              <style.Icon className={`h-4 w-4 ${style.color}`} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="font-semibold truncate">{r.name}</p>
                                {r.completed === false && (
                                  <span className="text-[10px] text-amber-400 bg-amber-400/10 px-1.5 rounded">Partial</span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
                                <span className="flex items-center gap-1">
                                  <Calendar className="h-3 w-3" />
                                  {new Date(item.started_at).toLocaleDateString("en-US", {
                                    weekday: "short",
                                    month: "short",
                                    day: "numeric",
                                  })}
                                </span>
                                {r.duration_seconds != null && (
                                  <span className="flex items-center gap-1">
                                    <Timer className="h-3 w-3" />
                                    {Math.floor(r.duration_seconds / 60)}m
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuRun(r);
                            }}
                            className="p-1 -mr-1 text-muted-foreground hover:text-foreground"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  }

                  const w = item.data as WorkoutWithDetails;
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => router.push(`/workout/summary?id=${w.id}`)}
                      onKeyDown={(e) =>
                        e.key === "Enter" && router.push(`/workout/summary?id=${w.id}`)
                      }
                      className="rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent active:scale-[0.99] cursor-pointer"
                    >
                      <div className="flex items-start justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold truncate">
                            {w.title || "Workout"}
                          </p>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {new Date(w.started_at).toLocaleDateString(
                                "en-US",
                                {
                                  weekday: "short",
                                  month: "short",
                                  day: "numeric",
                                }
                              )}
                            </span>
                            {w.finished_at && (
                              <span className="flex items-center gap-1">
                                <Timer className="h-3 w-3" />
                                {formatDuration(w.started_at, w.finished_at)}
                              </span>
                            )}
                            {w.gym_name && (
                              <span className="flex items-center gap-1">
                                <MapPin className="h-3 w-3" />
                                {w.gym_name}
                              </span>
                            )}
                            {w.total_volume > 0 && (
                              <span className="flex items-center gap-1">
                                <Weight className="h-3 w-3" />
                                {w.total_volume.toLocaleString()} lb
                              </span>
                            )}
                            {w.pr_count > 0 && (
                              <span className="flex items-center gap-1 text-amber-400">
                                <Trophy className="h-3 w-3" />
                                {w.pr_count} PR{w.pr_count !== 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuWorkout(w);
                          }}
                          className="p-1 -mr-1 text-muted-foreground hover:text-foreground"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {w.exercises.map((ex, i) => (
                          <span
                            key={i}
                            className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-md"
                          >
                            {ex.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      )}

      {/* Workout Menu Drawer */}
      <Drawer
        open={!!menuWorkout && !editOpen && !deleteConfirmOpen}
        onOpenChange={(open) => !open && setMenuWorkout(null)}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{menuWorkout?.title || "Workout"}</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 space-y-1 pb-4">
            <button
              onClick={handleEdit}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent transition-colors"
            >
              <SquarePen className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Edit Workout</span>
            </button>
            <button
              onClick={handleRepeat}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent transition-colors"
            >
              <Repeat className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Repeat Workout</span>
            </button>
            <button
              onClick={() => {
                setEditTitle(menuWorkout?.title || "");
                setEditOpen(true);
              }}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent transition-colors"
            >
              <Pencil className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Edit Title</span>
            </button>
            <button
              onClick={handleExport}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent transition-colors"
            >
              <Share className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">
                Copy to Clipboard
              </span>
            </button>
            <button
              onClick={() => setDeleteConfirmOpen(true)}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent transition-colors text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              <span className="text-sm font-medium">Delete Workout</span>
            </button>
          </div>
        </DrawerContent>
      </Drawer>

      {/* Edit Title Drawer */}
      <Drawer open={editOpen} onOpenChange={setEditOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Edit Workout Title</DrawerTitle>
          </DrawerHeader>
          <div className="px-4">
            <Input
              placeholder="Workout title"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="h-12"
              autoFocus
            />
          </div>
          <DrawerFooter>
            <Button
              onClick={handleEditTitle}
              disabled={!editTitle.trim()}
              className="h-12"
            >
              Save
            </Button>
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              className="h-12"
            >
              Cancel
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      {/* Delete Confirm Drawer */}
      <Drawer open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Delete Workout?</DrawerTitle>
          </DrawerHeader>
          <div className="px-4">
            <p className="text-sm text-muted-foreground">
              This will permanently delete &ldquo;{menuWorkout?.title || "this workout"}&rdquo; and
              all its sets. This cannot be undone.
            </p>
          </div>
          <DrawerFooter>
            <Button
              onClick={handleDelete}
              variant="destructive"
              className="h-12"
            >
              Delete Permanently
            </Button>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="h-12"
            >
              Cancel
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      {/* Run Menu Drawer */}
      <Drawer
        open={!!menuRun && !runEditOpen && !runDeleteOpen}
        onOpenChange={(open) => !open && setMenuRun(null)}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{menuRun?.name || "Run"}</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 space-y-1 pb-4">
            <button
              onClick={() => { if (menuRun) router.push(`/run?id=${menuRun.id}`); setMenuRun(null); }}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent transition-colors"
            >
              <SquarePen className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">View Details</span>
            </button>
            <button
              onClick={handleRunRepeat}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent transition-colors"
            >
              <Repeat className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Repeat Run</span>
            </button>
            <button
              onClick={() => { setRunEditName(menuRun?.name || ""); setRunEditOpen(true); }}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent transition-colors"
            >
              <Pencil className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Edit Name</span>
            </button>
            <button
              onClick={handleRunExport}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent transition-colors"
            >
              <Share className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Copy to Clipboard</span>
            </button>
            <button
              onClick={() => setRunDeleteOpen(true)}
              className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-accent transition-colors text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              <span className="text-sm font-medium">Delete Run</span>
            </button>
          </div>
        </DrawerContent>
      </Drawer>

      {/* Run Edit Name Drawer */}
      <Drawer open={runEditOpen} onOpenChange={setRunEditOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Edit Run Name</DrawerTitle>
          </DrawerHeader>
          <div className="px-4">
            <Input
              placeholder="Run name"
              value={runEditName}
              onChange={(e) => setRunEditName(e.target.value)}
              className="h-12"
              autoFocus
            />
          </div>
          <DrawerFooter>
            <Button onClick={handleRunEditName} disabled={!runEditName.trim()} className="h-12">
              Save
            </Button>
            <Button variant="outline" onClick={() => setRunEditOpen(false)} className="h-12">
              Cancel
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      {/* Run Delete Confirm Drawer */}
      <Drawer open={runDeleteOpen} onOpenChange={setRunDeleteOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Delete Run?</DrawerTitle>
          </DrawerHeader>
          <div className="px-4">
            <p className="text-sm text-muted-foreground">
              This will permanently delete &ldquo;{menuRun?.name || "this run"}&rdquo;. This cannot be undone.
            </p>
          </div>
          <DrawerFooter>
            <Button onClick={handleRunDelete} variant="destructive" className="h-12">
              Delete Permanently
            </Button>
            <Button variant="outline" onClick={() => setRunDeleteOpen(false)} className="h-12">
              Cancel
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      {/* Active Workout Conflict Drawer */}
      <Drawer open={conflictOpen} onOpenChange={setConflictOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Workout In Progress</DrawerTitle>
          </DrawerHeader>
          <div className="px-4">
            <p className="text-sm text-muted-foreground text-center">
              You have an active workout. What would you like to do?
            </p>
          </div>
          <DrawerFooter>
            <Button
              onClick={() => {
                setConflictOpen(false);
                setMenuWorkout(null);
                router.push(`/workout?id=${activeWorkoutId}`);
              }}
              variant="outline"
              className="h-12"
            >
              Resume Current Workout
            </Button>
            <Button
              onClick={handleDiscardAndRepeat}
              variant="destructive"
              className="h-12"
            >
              Discard & Start New
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConflictOpen(false);
                setMenuWorkout(null);
              }}
              className="h-12"
            >
              Cancel
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
