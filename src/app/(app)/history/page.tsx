"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, getLocalUser } from "@/lib/supabase/client";
import { kvGet, kvSet } from "@/lib/offline";
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
  const supabase = createClient();
  const router = useRouter();

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

    const gymMap = new Map(
      (gymsRes.data || []).map((g) => [g.id, g.name])
    );

    const ws = workoutsRes.data || [];

    if (ws.length) {
      const workoutIds = ws.map((w) => w.id);
      const { data: wes } = await supabase
        .from("workout_exercises")
        .select("*")
        .in("workout_id", workoutIds)
        .order("sort_order");

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
            }),
        exerciseIds.length
          ? supabase
              .from("exercise_definitions")
              .select("id, name")
              .in("id", exerciseIds)
          : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      ]);

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
            name: defMap.get(we.exercise_id) || "Unknown",
            mode: we.mode,
            sets: (setsByWe.get(we.id) || []).map((s) => {
              const prs: PrType[] = [];
              if (s.is_pr_weight) prs.push("WEIGHT");
              if (s.is_pr_1rm) prs.push("1RM");
              if (s.is_pr_volume) prs.push("VOL");
              if (s.is_pr_reps) prs.push("REPS");
              if (s.is_pr_duration) prs.push("DURATION");
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
    setWorkouts(computedWorkouts);

    // Run sessions
    const { data: runs } = await supabase
      .from("run_sessions")
      .select("*")
      .not("duration_seconds", "is", null)
      .order("started_at", { ascending: false })
      .limit(50);

    setRunSessions(runs || []);

    networkLoadedRef.current = true;
    kvSet("history", { workouts: computedWorkouts, runSessions: runs || [] });
    } catch {
      // Offline — snapshot hydration has already painted what we have
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Instant paint from the last snapshot
  useEffect(() => {
    kvGet<{ workouts: WorkoutWithDetails[]; runSessions: RunSession[] }>(
      "history"
    ).then((snap) => {
      if (!snap || networkLoadedRef.current) return;
      setWorkouts(snap.workouts);
      setRunSessions(snap.runSessions);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
    await supabase
      .from("workouts")
      .update({ title: editTitle.trim() })
      .eq("id", menuWorkout.id);
    setEditOpen(false);
    setMenuWorkout(null);
    load();
  }

  async function handleDelete() {
    if (!menuWorkout) return;

    await supabase.from("pr_snapshots").delete().eq("workout_id", menuWorkout.id);
    await supabase.from("personal_records").delete().eq("workout_id", menuWorkout.id);

    const { data: wes } = await supabase
      .from("workout_exercises")
      .select("id")
      .eq("workout_id", menuWorkout.id);

    if (wes?.length) {
      const weIds = wes.map((we) => we.id);
      await supabase.from("sets").delete().in("workout_exercise_id", weIds);
      await supabase
        .from("workout_exercises")
        .delete()
        .eq("workout_id", menuWorkout.id);
    }

    await supabase.from("workouts").delete().eq("id", menuWorkout.id);

    setDeleteConfirmOpen(false);
    setMenuWorkout(null);
    load();
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
    router.push(`/workout/${menuWorkout.id}`);
  }

  async function handleRepeat() {
    if (!menuWorkout) return;

    const { data: inProgress } = await supabase
      .from("workouts")
      .select("id")
      .is("finished_at", null)
      .limit(1);

    if (inProgress?.length) {
      setActiveWorkoutId(inProgress[0].id);
      setMenuWorkout(menuWorkout);
      setConflictOpen(true);
      return;
    }

    await doRepeat();
  }

  async function doRepeat() {
    if (!menuWorkout) return;
    const user = await getLocalUser(supabase);
    if (!user) return;

    const { data: newWorkout } = await supabase
      .from("workouts")
      .insert({
        user_id: user.id,
        gym_id: menuWorkout.gym_id,
        title: menuWorkout.title,
        started_at: new Date().toISOString(),
        workout_type: menuWorkout.workout_type,
      })
      .select()
      .single();

    if (!newWorkout) return;

    const { data: sourceWes } = await supabase
      .from("workout_exercises")
      .select("*")
      .eq("workout_id", menuWorkout.id)
      .order("sort_order");

    if (sourceWes?.length) {
      for (const srcWe of sourceWes) {
        const { data: newWe } = await supabase
          .from("workout_exercises")
          .insert({
            user_id: user.id,
            workout_id: newWorkout.id,
            exercise_id: srcWe.exercise_id,
            sort_order: srcWe.sort_order,
            mode: srcWe.mode,
          })
          .select()
          .single();

        if (!newWe) continue;

        const { data: srcSets } = await supabase
          .from("sets")
          .select("*")
          .eq("workout_exercise_id", srcWe.id)
          .order("set_number");

        if (srcSets?.length) {
          await supabase.from("sets").insert(
            srcSets.map((s) => ({
              user_id: user.id,
              workout_exercise_id: newWe.id,
              set_number: s.set_number,
              reps: s.reps,
              weight: s.weight,
              duration_seconds: s.duration_seconds,
              is_warmup: s.is_warmup,
              note: s.note,
            }))
          );
        }
      }
    }

    setMenuWorkout(null);
    setConflictOpen(false);
    router.push(`/workout/${newWorkout.id}`);
  }

  async function handleDiscardAndRepeat() {
    if (!activeWorkoutId) return;

    await supabase.from("pr_snapshots").delete().eq("workout_id", activeWorkoutId);
    await supabase.from("personal_records").delete().eq("workout_id", activeWorkoutId);

    const { data: wes } = await supabase
      .from("workout_exercises")
      .select("id")
      .eq("workout_id", activeWorkoutId);

    if (wes?.length) {
      const weIds = wes.map((we) => we.id);
      await supabase.from("sets").delete().in("workout_exercise_id", weIds);
      await supabase.from("workout_exercises").delete().in("id", weIds);
    }
    await supabase.from("workouts").delete().eq("id", activeWorkoutId);
    setActiveWorkoutId(null);

    await doRepeat();
  }

  async function handleRunEditName() {
    if (!menuRun || !runEditName.trim()) return;
    await supabase.from("run_sessions").update({ name: runEditName.trim() }).eq("id", menuRun.id);
    setRunEditOpen(false);
    setMenuRun(null);
    load();
  }

  async function handleRunDelete() {
    if (!menuRun) return;
    await supabase.from("run_sessions").delete().eq("id", menuRun.id);
    setRunDeleteOpen(false);
    setMenuRun(null);
    load();
  }

  async function handleRunRepeat() {
    if (!menuRun) return;
    const user = await getLocalUser(supabase);
    if (!user) return;

    const rawData = menuRun.raw_data as Record<string, unknown> | null;
    const { data: session } = await supabase
      .from("run_sessions")
      .insert({
        user_id: user.id,
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
      })
      .select().single();

    setMenuRun(null);
    if (session) router.push(`/run/${session.id}`);
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
                        onClick={() => router.push(`/run/${r.id}`)}
                        onKeyDown={(e) => e.key === "Enter" && router.push(`/run/${r.id}`)}
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
                      onClick={() => router.push(`/workout/${w.id}/summary`)}
                      onKeyDown={(e) =>
                        e.key === "Enter" && router.push(`/workout/${w.id}/summary`)
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
              onClick={() => { if (menuRun) router.push(`/run/${menuRun.id}`); setMenuRun(null); }}
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
                router.push(`/workout/${activeWorkoutId}`);
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
