"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Database, TrackingMode, PrType } from "@/types/database.types";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { MapPin, MessageSquare } from "lucide-react";
import { PR_BADGE_STYLES, PR_BADGE_LABELS } from "@/lib/pr-constants";
import { cn } from "@/lib/utils";

type SetRow = Database["public"]["Tables"]["sets"]["Row"];

interface HistorySession {
  workoutExerciseId: string;
  workoutId: string;
  date: string;
  gymName: string | null;
  mode: TrackingMode;
  sessionNote: string | null;
  sets: SetRow[];
}

interface ExerciseHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exerciseId: string;
  exerciseName: string;
}

function formatSet(mode: TrackingMode, s: SetRow): string {
  switch (mode) {
    case "reps_weight":
      return `${s.weight ?? 0} lb × ${s.reps ?? 0}`;
    case "time_weight":
      return `${s.weight ?? 0} lb × ${s.duration_seconds ?? 0}s`;
    case "time_only":
      return `${s.duration_seconds ?? 0}s`;
    case "reps_only":
      return `${s.reps ?? 0} reps`;
    case "reps_assisted":
      return `${s.reps ?? 0} reps (${s.weight ?? 0} lb assist)`;
    case "presence":
      return "done";
  }
}

function setPrTypes(s: SetRow): PrType[] {
  const types: PrType[] = [];
  if (s.is_pr_weight) types.push("WEIGHT");
  if (s.is_pr_1rm) types.push("1RM");
  if (s.is_pr_volume) types.push("VOL");
  if (s.is_pr_reps) types.push("REPS");
  if (s.is_pr_duration) types.push("DURATION");
  return types;
}

export function ExerciseHistorySheet({
  open,
  onOpenChange,
  exerciseId,
  exerciseName,
}: ExerciseHistorySheetProps) {
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const supabase = createClient();

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const { data: wes } = await supabase
        .from("workout_exercises")
        .select("id, workout_id, notes, mode, created_at")
        .eq("exercise_id", exerciseId)
        .order("created_at", { ascending: false })
        .limit(30);

      if (!wes?.length) {
        setSessions([]);
        return;
      }

      const workoutIds = [...new Set(wes.map((we) => we.workout_id))];
      const { data: workouts } = await supabase
        .from("workouts")
        .select("id, started_at, finished_at, gym_id")
        .in("id", workoutIds)
        .not("finished_at", "is", null);

      const workoutMap = new Map((workouts || []).map((w) => [w.id, w]));

      const gymIds = [
        ...new Set((workouts || []).map((w) => w.gym_id).filter(Boolean)),
      ] as string[];
      const { data: gyms } = gymIds.length
        ? await supabase.from("gyms").select("id, name").in("id", gymIds)
        : { data: [] as { id: string; name: string }[] };
      const gymMap = new Map((gyms || []).map((g) => [g.id, g.name]));

      const finishedWes = wes.filter((we) => workoutMap.has(we.workout_id));
      const weIds = finishedWes.map((we) => we.id);
      const { data: allSets } = weIds.length
        ? await supabase
            .from("sets")
            .select("*")
            .in("workout_exercise_id", weIds)
            .not("completed_at", "is", null)
            .order("set_number")
        : { data: [] as SetRow[] };

      const setsByWe = new Map<string, SetRow[]>();
      for (const s of allSets || []) {
        const arr = setsByWe.get(s.workout_exercise_id) || [];
        arr.push(s);
        setsByWe.set(s.workout_exercise_id, arr);
      }

      const result: HistorySession[] = finishedWes
        .map((we) => {
          const w = workoutMap.get(we.workout_id)!;
          return {
            workoutExerciseId: we.id,
            workoutId: we.workout_id,
            date: w.started_at,
            gymName: w.gym_id ? gymMap.get(w.gym_id) || null : null,
            mode: we.mode,
            sessionNote: we.notes,
            sets: setsByWe.get(we.id) || [],
          };
        })
        .filter((s) => s.sets.length > 0)
        .slice(0, 15);

      setSessions(result);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseId]);

  useEffect(() => {
    if (open && !loaded) loadHistory();
  }, [open, loaded, loadHistory]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{exerciseName}</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-8 space-y-3 max-h-[65vh] overflow-y-auto">
          {loading && (
            <div className="space-y-3">
              <div className="h-24 animate-pulse rounded-xl bg-muted" />
              <div className="h-24 animate-pulse rounded-xl bg-muted" />
            </div>
          )}

          {!loading && sessions.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No past sessions for this exercise yet.
            </p>
          )}

          {sessions.map((session) => (
            <div
              key={session.workoutExerciseId}
              className="rounded-xl border border-border bg-card p-3 space-y-2"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  {new Date(session.date).toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
                {session.gymName && (
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <MapPin className="h-3 w-3" />
                    {session.gymName}
                  </span>
                )}
              </div>

              <div className="space-y-1">
                {session.sets.map((s, i) => {
                  const prTypes = setPrTypes(s);
                  return (
                    <div key={s.id} className="space-y-0.5">
                      <div className="flex items-center gap-2 text-sm">
                        <span
                          className={cn(
                            "w-4 text-xs text-center shrink-0",
                            s.is_warmup
                              ? "text-yellow-500"
                              : "text-muted-foreground"
                          )}
                        >
                          {s.is_warmup ? "W" : i + 1}
                        </span>
                        <span className="font-mono">
                          {formatSet(session.mode, s)}
                        </span>
                        {prTypes.map((pt) => (
                          <span
                            key={pt}
                            className={cn(
                              "text-[9px] font-bold px-1.5 rounded-full border",
                              PR_BADGE_STYLES[pt]
                            )}
                          >
                            {PR_BADGE_LABELS[pt]}
                          </span>
                        ))}
                      </div>
                      {s.note && (
                        <p className="ml-6 text-xs text-muted-foreground whitespace-pre-wrap">
                          {s.note}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {session.sessionNote && (
                <div className="flex items-start gap-1.5 rounded-lg bg-amber-500/5 border border-amber-500/20 p-2">
                  <MessageSquare className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                    {session.sessionNote}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
