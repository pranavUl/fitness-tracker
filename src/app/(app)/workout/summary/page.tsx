"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { loadCachedWorkout } from "@/lib/offline";
import { getCachedGyms } from "@/lib/reference-data";
import { Database, TrackingMode, PrType } from "@/types/database.types";
import { Button } from "@/components/ui/button";
import {
  Trophy,
  Timer,
  Dumbbell,
  Weight,
  MapPin,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";
import { PR_BADGE_STYLES, PR_BADGE_LABELS } from "@/lib/pr-constants";
import { cn } from "@/lib/utils";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface SetSummary {
  id: string;
  reps: number | null;
  weight: number | null;
  duration_seconds: number | null;
  is_warmup: boolean;
  completed_at: string | null;
  e1rm: number | null;
}

interface ExerciseSummary {
  name: string;
  mode: TrackingMode;
  sets: SetSummary[];
  volume: number;
  topSet: string;
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

function SummarySkeleton() {
  return (
    <div className="mx-auto max-w-lg px-4 pt-12">
      <div className="space-y-4">
        <div className="h-10 w-48 animate-pulse rounded-lg bg-muted mx-auto" />
        <div className="h-32 animate-pulse rounded-2xl bg-muted" />
      </div>
    </div>
  );
}

export default function WorkoutSummaryPage() {
  return (
    <Suspense fallback={<SummarySkeleton />}>
      <WorkoutSummary />
    </Suspense>
  );
}

function WorkoutSummary() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const workoutId = searchParams.get("id") ?? "";
  const justFinished = searchParams.get("finished") === "1";

  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [gymName, setGymName] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [totalVolume, setTotalVolume] = useState(0);
  const [totalSets, setTotalSets] = useState(0);
  const [completedSets, setCompletedSets] = useState(0);
  const [exerciseSummaries, setExerciseSummaries] = useState<
    ExerciseSummary[]
  >([]);
  const [prCount, setPrCount] = useState(0);
  const [prsBySet, setPrsBySet] = useState<Map<string, PrType[]>>(new Map());
  const supabase = createClient();

  useEffect(() => {
    // The phone's copy is always at least as new as the server's, and
    // needs no signal — use it whenever it exists.
    async function loadFromCache(): Promise<boolean> {
      const cached = await loadCachedWorkout(workoutId);
      if (!cached || cached.deleted) return false;

      setTitle(cached.workout.title || "Workout");
      setStartedAt(cached.workout.started_at);
      if (cached.workout.gym_id) {
        const gyms = await getCachedGyms();
        const gym = gyms?.find((g) => g.id === cached.workout.gym_id);
        if (gym) setGymName(gym.name);
      }
      if (cached.workout.finished_at) {
        const ms =
          new Date(cached.workout.finished_at).getTime() -
          new Date(cached.workout.started_at).getTime();
        setDuration(Math.floor(ms / 1000));
      }

      let vol = 0;
      let total = 0;
      let completed = 0;
      const summaries: ExerciseSummary[] = cached.exercises.map((ex) => {
        let exVol = 0;
        let bestWeight = 0;
        let bestSetStr = "";
        for (const s of ex.sets) {
          total++;
          if (s.completed_at) completed++;
          if (!s.is_warmup && s.weight && s.reps) {
            exVol += s.weight * s.reps;
            if (s.weight > bestWeight) {
              bestWeight = s.weight;
              bestSetStr = formatSetValue(ex.workoutExercise.mode, s);
            }
          }
        }
        vol += exVol;
        return {
          name: ex.definition.name,
          mode: ex.workoutExercise.mode,
          sets: ex.sets.map((s) => ({
            id: s.id || "",
            reps: s.reps,
            weight: s.weight,
            duration_seconds: s.duration_seconds,
            is_warmup: s.is_warmup,
            completed_at: s.completed_at,
            e1rm: s.e1rm ?? null,
          })),
          volume: exVol,
          topSet: bestSetStr,
        };
      });

      setTotalVolume(vol);
      setTotalSets(total);
      setCompletedSets(completed);
      setExerciseSummaries(summaries);
      const prMap = new Map(Object.entries(cached.prs));
      setPrsBySet(prMap);
      setPrCount([...prMap.values()].reduce((a, v) => a + v.length, 0));
      setLoading(false);
      return true;
    }

    async function load() {
      if (!workoutId) {
        router.push("/");
        return;
      }
      if (await loadFromCache()) return;

      const { data: workout, error } = await supabase
        .from("workouts")
        .select("*")
        .eq("id", workoutId)
        .maybeSingle();
      if (error) {
        // No signal and not on this phone — show an empty summary
        setTitle("Workout");
        setLoading(false);
        return;
      }
      if (!workout) {
        router.push("/");
        return;
      }

      setTitle(workout.title || "Workout");
      setStartedAt(workout.started_at);

      if (workout.gym_id) {
        const { data: gym } = await supabase
          .from("gyms")
          .select("name")
          .eq("id", workout.gym_id)
          .single();
        if (gym) setGymName(gym.name);
      }

      if (workout.finished_at) {
        const ms =
          new Date(workout.finished_at).getTime() -
          new Date(workout.started_at).getTime();
        setDuration(Math.floor(ms / 1000));
      }

      const { data: wes } = await supabase
        .from("workout_exercises")
        .select("*")
        .eq("workout_id", workoutId)
        .order("sort_order");

      if (!wes?.length) {
        setLoading(false);
        return;
      }

      const exerciseIds = [...new Set(wes.map((we) => we.exercise_id))];
      const weIds = wes.map((we) => we.id);

      const [defsRes, setsRes] = await Promise.all([
        supabase
          .from("exercise_definitions")
          .select("id, name")
          .in("id", exerciseIds),
        supabase
          .from("sets")
          .select("*")
          .in("workout_exercise_id", weIds)
          .order("set_number"),
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

      let vol = 0;
      let total = 0;
      let completed = 0;

      const summaries: ExerciseSummary[] = wes.map((we) => {
        const sets = setsByWe.get(we.id) || [];
        let exVol = 0;
        let bestWeight = 0;
        let bestSetStr = "";

        for (const s of sets) {
          total++;
          if (s.completed_at) completed++;
          if (!s.is_warmup && s.weight && s.reps) {
            const setVol = s.weight * s.reps;
            exVol += setVol;
            if (s.weight > bestWeight) {
              bestWeight = s.weight;
              bestSetStr = formatSetValue(we.mode, s);
            }
          }
        }

        vol += exVol;

        return {
          name: defMap.get(we.exercise_id) || "Unknown",
          mode: we.mode,
          sets: sets.map((s) => ({
            id: s.id,
            reps: s.reps,
            weight: s.weight,
            duration_seconds: s.duration_seconds,
            is_warmup: s.is_warmup,
            completed_at: s.completed_at,
            e1rm: s.e1rm ?? null,
          })),
          volume: exVol,
          topSet: bestSetStr,
        };
      });

      setTotalVolume(vol);
      setTotalSets(total);
      setCompletedSets(completed);
      setExerciseSummaries(summaries);

      // Fetch PRs for this workout — map to sets
      const { data: prSnapshots } = await supabase
        .from("pr_snapshots")
        .select("set_id, pr_type")
        .eq("workout_id", workoutId);

      if (prSnapshots?.length) {
        setPrCount(prSnapshots.length);
        const map = new Map<string, PrType[]>();
        for (const pr of prSnapshots) {
          if (!pr.set_id) continue;
          const arr = map.get(pr.set_id) || [];
          arr.push(pr.pr_type as PrType);
          map.set(pr.set_id, arr);
        }
        setPrsBySet(map);
      }

      setLoading(false);
    }

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workoutId, router]);

  if (loading) return <SummarySkeleton />;

  return (
    <div className="mx-auto max-w-lg px-4 pt-8 pb-24">
      {/* Header */}
      {justFinished ? (
        <div className="text-center space-y-2 mb-8">
          <div className="mx-auto w-16 h-16 rounded-full bg-green-600/20 flex items-center justify-center">
            <Trophy className="h-8 w-8 text-green-500" />
          </div>
          <h1 className="text-2xl font-bold">Workout Complete!</h1>
          <p className="text-sm text-muted-foreground">{title}</p>
          {startedAt && (
            <p className="text-xs text-muted-foreground">
              {new Date(startedAt).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}{" "}
              at{" "}
              {new Date(startedAt).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })}
            </p>
          )}
          {gymName && (
            <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
              <MapPin className="h-3 w-3" />
              {gymName}
            </p>
          )}
        </div>
      ) : (
        <div className="mb-6">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-1 text-sm text-muted-foreground mb-3 hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <h1 className="text-2xl font-bold">{title}</h1>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            {startedAt && (
              <span>
                {new Date(startedAt).toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </span>
            )}
            {gymName && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {gymName}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="rounded-2xl border border-border bg-card p-4 text-center">
          <Timer className="h-5 w-5 mx-auto text-muted-foreground mb-1" />
          <p className="text-2xl font-bold font-mono">{formatTime(duration)}</p>
          <p className="text-xs text-muted-foreground">Duration</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 text-center">
          <Weight className="h-5 w-5 mx-auto text-muted-foreground mb-1" />
          <p className="text-2xl font-bold">
            {totalVolume.toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">Volume (lb)</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 text-center">
          <Dumbbell className="h-5 w-5 mx-auto text-muted-foreground mb-1" />
          <p className="text-2xl font-bold">{exerciseSummaries.length}</p>
          <p className="text-xs text-muted-foreground">Exercises</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 text-center">
          <Trophy className={cn("h-5 w-5 mx-auto mb-1", prCount > 0 ? "text-amber-400" : "text-muted-foreground")} />
          <p className="text-2xl font-bold">{prCount}</p>
          <p className="text-xs text-muted-foreground">PRs</p>
        </div>
      </div>

      {/* Exercise Breakdown with inline PRs */}
      <div className="space-y-3 mb-8">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Exercise Breakdown
        </h2>
        {exerciseSummaries.map((ex, i) => {
          const showE1rm = ex.mode === "reps_weight";
          return (
            <div
              key={i}
              className="rounded-xl border border-border bg-card p-3 space-y-2"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm">{ex.name}</h3>
                {showE1rm ? (
                  <span className="text-xs text-muted-foreground">e1RM</span>
                ) : ex.volume > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {ex.volume.toLocaleString()} lb
                  </span>
                ) : null}
              </div>
              <div className="space-y-1">
                {ex.sets.map((set, j) => {
                  const setPrs = prsBySet.get(set.id) || [];
                  return (
                    <div key={set.id}>
                      <div className="flex items-center gap-2 text-sm">
                        <span
                          className={`w-4 text-xs text-center shrink-0 ${
                            set.is_warmup
                              ? "text-yellow-500"
                              : "text-muted-foreground"
                          }`}
                        >
                          {set.is_warmup ? "W" : j + 1}
                        </span>
                        <span
                          className={cn(
                            "flex-1",
                            set.completed_at
                              ? "text-foreground"
                              : "text-muted-foreground/50 line-through"
                          )}
                        >
                          {formatSetValue(ex.mode, set)}
                          {setPrs.length > 0 && (
                            <>
                              {" "}
                              {setPrs.map((pt) => (
                                <span
                                  key={pt}
                                  className={cn(
                                    "inline-block font-bold px-1.5 py-0 rounded-full border text-[9px] ml-1 align-middle",
                                    PR_BADGE_STYLES[pt]
                                  )}
                                >
                                  {PR_BADGE_LABELS[pt]}
                                </span>
                              ))}
                            </>
                          )}
                        </span>
                        {showE1rm && set.e1rm && !set.is_warmup && (
                          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                            {Math.round(set.e1rm)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {ex.topSet && (
                <p className="text-xs text-primary">Top set: {ex.topSet}</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Done button */}
      {justFinished && (
        <Button
          onClick={() => router.push("/")}
          className="w-full h-14 text-lg"
        >
          Done
          <ArrowRight className="ml-2 h-5 w-5" />
        </Button>
      )}
    </div>
  );
}
