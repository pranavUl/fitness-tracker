"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { Database, PrType } from "@/types/database.types";
import { SetData } from "@/components/workout/set-row";
import { computeE1rm } from "@/lib/pr-detection";
import { haptic, HAPTIC } from "@/lib/haptics";
import {
  hasUnsyncedChanges,
  loadCachedWorkout,
  saveWorkoutLocal,
} from "@/lib/offline";
import { requestSync, subscribeWorkoutPrs } from "@/lib/sync";
import {
  PrevMap,
  getPrevMap,
  pickPrevious,
  recordFinishedWorkout,
  refreshPrevMap,
} from "@/lib/reference-data";
import {
  ExerciseDefinition,
  PreviousSession,
  PrOp,
  Workout,
  WorkoutExercise,
  WorkoutExerciseState,
  WorkoutSnapshot,
  applyPrPatch,
  setPrTypes,
} from "@/lib/workout-state";

export type { WorkoutExerciseState } from "@/lib/workout-state";

/** Why a workout can't be shown: gone, or never saved to this phone and no signal. */
export type WorkoutUnavailable = "not-found" | "offline" | null;

const ACTIVE_KEY = "active_workout_id";

function setActivePointer(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

/** Preload every completed set from the last session at this gym, unchecked. */
function setsFromPrevious(prev: PreviousSession | null): SetData[] {
  const prevSets = (prev?.sets || []).filter((s) => s.completed_at);
  const templates = prevSets.length > 0 ? prevSets : [null];
  return templates.map((p, i) => ({
    id: crypto.randomUUID(),
    set_number: i + 1,
    reps: p?.reps ?? null,
    weight: p?.weight ?? null,
    duration_seconds: p?.duration_seconds ?? null,
    is_warmup: p?.is_warmup ?? false,
    note: p?.note ?? null,
    completed_at: null,
  }));
}

function isPristine(sets: SetData[]): boolean {
  return (
    sets.length === 1 &&
    !sets[0].completed_at &&
    sets[0].reps == null &&
    sets[0].weight == null &&
    sets[0].duration_seconds == null &&
    !sets[0].note
  );
}

async function fetchWorkout(
  supabase: SupabaseClient<Database>,
  workoutId: string
): Promise<WorkoutSnapshot | null | "offline"> {
  const wRes = await supabase
    .from("workouts")
    .select("*")
    .eq("id", workoutId)
    .maybeSingle();
  if (wRes.error) return "offline";
  if (!wRes.data) return null;

  const weRes = await supabase
    .from("workout_exercises")
    .select("*")
    .eq("workout_id", workoutId)
    .order("sort_order");
  if (weRes.error) return "offline";
  const wes = weRes.data;
  if (!wes.length) return { workout: wRes.data, exercises: [], prs: {} };

  const [defsRes, setsRes] = await Promise.all([
    supabase
      .from("exercise_definitions")
      .select("*")
      .in("id", [...new Set(wes.map((we) => we.exercise_id))]),
    supabase
      .from("sets")
      .select("*")
      .in(
        "workout_exercise_id",
        wes.map((we) => we.id)
      )
      .order("set_number"),
  ]);
  if (defsRes.error || setsRes.error) return "offline";

  const defMap = new Map(defsRes.data.map((d) => [d.id, d]));
  const setsByWe = new Map<string, SetData[]>();
  const prs: Record<string, PrType[]> = {};
  for (const s of setsRes.data) {
    const arr = setsByWe.get(s.workout_exercise_id) || [];
    arr.push({
      id: s.id,
      set_number: s.set_number,
      reps: s.reps,
      weight: s.weight,
      duration_seconds: s.duration_seconds,
      is_warmup: s.is_warmup,
      note: s.note,
      completed_at: s.completed_at,
      e1rm: s.e1rm,
      rest_seconds: s.rest_seconds,
      is_pr_weight: s.is_pr_weight,
      is_pr_1rm: s.is_pr_1rm,
      is_pr_volume: s.is_pr_volume,
      is_pr_reps: s.is_pr_reps,
      is_pr_duration: s.is_pr_duration,
    });
    setsByWe.set(s.workout_exercise_id, arr);
    const types = setPrTypes(s);
    if (types.length > 0) prs[s.id] = types;
  }

  const exercises = wes
    .filter((we) => defMap.has(we.exercise_id))
    .map((we) => ({
      workoutExercise: we,
      definition: defMap.get(we.exercise_id)!,
      sets: setsByWe.get(we.id) || [],
      previous: null,
    }));
  return { workout: wRes.data, exercises, prs };
}

export function useWorkout(workoutId: string | null) {
  const [workout, setWorkout] = useState<Workout | null>(null);
  const [exercises, setExercises] = useState<WorkoutExerciseState[]>([]);
  const [prs, setPrs] = useState<Record<string, PrType[]>>({});
  const [loadingState, setLoading] = useState(true);
  const [unavailableState, setUnavailable] = useState<WorkoutUnavailable>(null);
  const [now, setNow] = useState(() => Date.now());
  const loading = workoutId ? loadingState : false;
  const unavailable: WorkoutUnavailable = workoutId ? unavailableState : "not-found";

  const workoutRef = useRef<Workout | null>(null);
  const exercisesRef = useRef<WorkoutExerciseState[]>([]);
  const prsRef = useRef<Record<string, PrType[]>>({});
  const prevMapRef = useRef<PrevMap | null>(null);
  // Once the user edits anything, a late server response must not clobber it
  const editedRef = useRef(false);
  // Exercises added before their ghost data was available; filled in if it arrives
  const awaitingPrefillRef = useRef<Set<string>>(new Set());

  /**
   * The single write path: refs, React state, and the on-device mirror move
   * together. Dirty writes get picked up by the sync engine automatically.
   */
  const commit = useCallback(
    (
      next: Partial<WorkoutSnapshot>,
      opts: { dirty: boolean; prOps?: PrOp[]; deleted?: boolean }
    ): Promise<void> => {
      if (next.workout !== undefined) {
        workoutRef.current = next.workout;
        setWorkout(next.workout);
      }
      if (next.exercises !== undefined) {
        exercisesRef.current = next.exercises;
        setExercises(next.exercises);
      }
      if (next.prs !== undefined) {
        prsRef.current = next.prs;
        setPrs(next.prs);
      }
      if (opts.dirty) editedRef.current = true;
      const w = workoutRef.current;
      if (!w || !workoutId) return Promise.resolve();
      return saveWorkoutLocal(
        workoutId,
        { workout: w, exercises: exercisesRef.current, prs: prsRef.current },
        opts
      );
    },
    [workoutId]
  );

  const fillPrevious = useCallback(
    (map: PrevMap | null) => {
      if (!map || !workoutId) return;
      prevMapRef.current = map;
      let changed = false;
      let prefilled = false;
      const next = exercisesRef.current.map((e) => {
        const prev = pickPrevious(map, e.definition.id, workoutId);
        if (!prev) return e;
        const weId = e.workoutExercise.id;
        if (awaitingPrefillRef.current.has(weId)) {
          awaitingPrefillRef.current.delete(weId);
          if (isPristine(e.sets)) {
            prefilled = true;
            changed = true;
            return { ...e, previous: prev, sets: setsFromPrevious(prev) };
          }
        }
        if (e.previous?.workoutId === prev.workoutId && e.previous?.date === prev.date) {
          return e;
        }
        changed = true;
        return { ...e, previous: prev };
      });
      if (changed) commit({ exercises: next }, { dirty: prefilled });
    },
    [workoutId, commit]
  );

  // Load: phone first, then reconcile with the server if the phone has nothing
  // unsynced. Callers remount per workout id (key={id}), so state starts clean.
  useEffect(() => {
    if (!workoutId) return;
    let cancelled = false;
    (async () => {
      const cached = await loadCachedWorkout(workoutId);
      if (cancelled) return;
      if (cached?.deleted) {
        setUnavailable("not-found");
        setLoading(false);
        return;
      }
      if (cached) {
        workoutRef.current = cached.workout;
        exercisesRef.current = cached.exercises;
        prsRef.current = cached.prs;
        setWorkout(cached.workout);
        setExercises(cached.exercises);
        setPrs(cached.prs);
        setLoading(false);
      }

      if (cached && hasUnsyncedChanges(cached)) {
        // The phone has edits the server hasn't seen — it's the source of truth
        requestSync(0);
        return;
      }

      const server = await fetchWorkout(createClient(), workoutId);
      if (cancelled || editedRef.current) return;
      if (server === "offline" || server === null) {
        // Keep whatever the phone has; only complain if it has nothing
        if (!cached) {
          setUnavailable(server === null ? "not-found" : "offline");
          setLoading(false);
        }
        return;
      }
      // Carry over ghost data already on screen
      const prevByWe = new Map(
        exercisesRef.current.map((e) => [e.workoutExercise.id, e.previous])
      );
      await commit(
        {
          ...server,
          exercises: server.exercises.map((e) => ({
            ...e,
            previous: prevByWe.get(e.workoutExercise.id) ?? null,
          })),
        },
        { dirty: false }
      );
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [workoutId, commit]);

  const gymId = workout?.gym_id ?? null;
  const unfinished = !!workout && !workout.finished_at;

  // Track the in-progress workout so Home can offer "Resume"
  useEffect(() => {
    if (unfinished && workoutId) setActivePointer(workoutId);
  }, [unfinished, workoutId]);

  // Ghost values: instantly from the phone, then refreshed if there's signal
  useEffect(() => {
    if (!gymId) return;
    let cancelled = false;
    getPrevMap(gymId).then((map) => {
      if (!cancelled) fillPrevious(map);
    });
    refreshPrevMap(createClient(), gymId)
      .then((map) => {
        if (!cancelled) fillPrevious(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gymId, fillPrevious]);

  // PR results computed by the sync engine (possibly long after the set was logged)
  useEffect(() => {
    if (!workoutId) return;
    return subscribeWorkoutPrs(workoutId, (patch) => {
      const before = patch.kind === "detected" ? prsRef.current[patch.setId] || [] : [];
      commit(
        applyPrPatch({ exercises: exercisesRef.current, prs: prsRef.current }, patch),
        { dirty: false }
      );
      if (patch.kind === "detected" && patch.types.some((t) => !before.includes(t))) {
        haptic(HAPTIC.pr);
      }
    });
  }, [workoutId, commit]);

  useEffect(() => {
    if (!unfinished) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [unfinished]);

  const elapsed = workout
    ? Math.max(
        0,
        Math.floor(
          ((workout.finished_at ? new Date(workout.finished_at).getTime() : now) -
            new Date(workout.started_at).getTime()) /
            1000
        )
      )
    : 0;

  // ---- Mutations: all synchronous against local state ----

  const findEx = (weId: string) =>
    exercisesRef.current.find((e) => e.workoutExercise.id === weId);

  const mapEx = (
    weId: string,
    fn: (e: WorkoutExerciseState) => WorkoutExerciseState
  ) =>
    exercisesRef.current.map((e) => (e.workoutExercise.id === weId ? fn(e) : e));

  const revokeOp = (ex: WorkoutExerciseState, setIds: string[]): PrOp => ({
    id: crypto.randomUUID(),
    kind: "revoke",
    setIds,
    exerciseId: ex.definition.id,
    equipment: ex.definition.equipment,
    gymId: workoutRef.current?.gym_id ?? null,
  });

  const detectOp = (weId: string, setId: string): PrOp => ({
    id: crypto.randomUUID(),
    kind: "detect",
    setId,
    weId,
  });

  const withoutPrs = (setIds: string[]) => {
    if (!setIds.some((id) => prsRef.current[id])) return prsRef.current;
    const next = { ...prsRef.current };
    for (const id of setIds) delete next[id];
    return next;
  };

  const addExercise = useCallback(
    (definition: ExerciseDefinition) => {
      const w = workoutRef.current;
      if (!w) return;
      const weId = crypto.randomUUID();
      const prev = pickPrevious(prevMapRef.current, definition.id, w.id);
      if (!prev) awaitingPrefillRef.current.add(weId);

      const weRow: WorkoutExercise = {
        id: weId,
        user_id: w.user_id,
        workout_id: w.id,
        exercise_id: definition.id,
        sort_order: exercisesRef.current.length,
        mode: definition.default_mode,
        is_warmup_group: false,
        notes: null,
        started_at: null,
        created_at: new Date().toISOString(),
      };

      commit(
        {
          exercises: [
            ...exercisesRef.current,
            {
              workoutExercise: weRow,
              definition,
              sets: setsFromPrevious(prev),
              previous: prev,
            },
          ],
        },
        { dirty: true }
      );
    },
    [commit]
  );

  const addSet = useCallback(
    (weId: string) => {
      const ex = findEx(weId);
      if (!ex) return;
      awaitingPrefillRef.current.delete(weId);
      const nextNum =
        ex.sets.length > 0 ? Math.max(...ex.sets.map((s) => s.set_number)) + 1 : 1;
      const prefill = ex.previous?.sets[ex.sets.length];
      const setRow: SetData = {
        id: crypto.randomUUID(),
        set_number: nextNum,
        reps: prefill?.reps ?? null,
        weight: prefill?.weight ?? null,
        duration_seconds: prefill?.duration_seconds ?? null,
        is_warmup: false,
        note: prefill?.note ?? null,
        completed_at: null,
      };
      commit(
        { exercises: mapEx(weId, (e) => ({ ...e, sets: [...e.sets, setRow] })) },
        { dirty: true }
      );
    },
    [commit]
  );

  const updateSet = useCallback(
    (weId: string, set: SetData) => {
      const setId = set.id;
      const ex = findEx(weId);
      if (!setId || !ex) return;
      awaitingPrefillRef.current.delete(weId);
      const old = ex.sets.find((s) => s.id === setId);
      const e1rm =
        ex.workoutExercise.mode === "reps_weight" && set.weight && set.reps
          ? computeE1rm(set.weight, set.reps)
          : null;
      let updated: SetData = { ...set, e1rm };

      // Editing a logged set re-evaluates its PRs once there's signal
      const prOps: PrOp[] = [];
      let nextPrs = prsRef.current;
      if (
        old?.completed_at &&
        (old.reps !== set.reps ||
          old.weight !== set.weight ||
          old.duration_seconds !== set.duration_seconds ||
          old.is_warmup !== set.is_warmup)
      ) {
        prOps.push(revokeOp(ex, [setId]));
        if (set.is_warmup) {
          nextPrs = withoutPrs([setId]);
          updated = {
            ...updated,
            is_pr_weight: false,
            is_pr_1rm: false,
            is_pr_volume: false,
            is_pr_reps: false,
            is_pr_duration: false,
          };
        } else {
          prOps.push(detectOp(weId, setId));
        }
      }

      commit(
        {
          exercises: mapEx(weId, (e) => ({
            ...e,
            sets: e.sets.map((s) => (s.id === setId ? updated : s)),
          })),
          prs: nextPrs,
        },
        { dirty: true, prOps }
      );
    },
    [commit]
  );

  const completeSet = useCallback(
    (weId: string, setId: string) => {
      const ex = findEx(weId);
      const set = ex?.sets.find((s) => s.id === setId);
      if (!ex || !set) return;
      awaitingPrefillRef.current.delete(weId);
      const now = new Date().toISOString();

      // Rest = time since the most recent completed set anywhere in this
      // workout. Passive data — stamped once, editable afterwards.
      let lastCompletedMs = 0;
      for (const e of exercisesRef.current) {
        for (const s of e.sets) {
          if (s.id !== setId && s.completed_at) {
            const t = new Date(s.completed_at).getTime();
            if (t > lastCompletedMs) lastCompletedMs = t;
          }
        }
      }
      const restSeconds =
        lastCompletedMs > 0
          ? Math.max(0, Math.round((Date.now() - lastCompletedMs) / 1000))
          : null;
      // Prefilled sets that were checked without editing never got one
      const e1rm =
        ex.workoutExercise.mode === "reps_weight" && set.weight && set.reps
          ? computeE1rm(set.weight, set.reps)
          : (set.e1rm ?? null);

      commit(
        {
          exercises: mapEx(weId, (e) => ({
            ...e,
            sets: e.sets.map((s) =>
              s.id === setId
                ? { ...s, completed_at: now, rest_seconds: restSeconds, e1rm }
                : s
            ),
          })),
        },
        { dirty: true, prOps: set.is_warmup ? [] : [detectOp(weId, setId)] }
      );
    },
    [commit]
  );

  const uncompleteSet = useCallback(
    (weId: string, setId: string) => {
      const ex = findEx(weId);
      const set = ex?.sets.find((s) => s.id === setId);
      if (!ex || !set) return;
      commit(
        {
          exercises: mapEx(weId, (e) => ({
            ...e,
            sets: e.sets.map((s) =>
              s.id === setId
                ? {
                    ...s,
                    completed_at: null,
                    rest_seconds: null,
                    is_pr_weight: false,
                    is_pr_1rm: false,
                    is_pr_volume: false,
                    is_pr_reps: false,
                    is_pr_duration: false,
                  }
                : s
            ),
          })),
          prs: withoutPrs([setId]),
        },
        // Revoke its PRs and restore whatever it had superseded
        { dirty: true, prOps: set.is_warmup ? [] : [revokeOp(ex, [setId])] }
      );
    },
    [commit]
  );

  const deleteSet = useCallback(
    (weId: string, setId: string) => {
      const ex = findEx(weId);
      if (!ex) return;
      const deleted = ex.sets.find((s) => s.id === setId);
      // Deleting the last set removes the exercise
      const next =
        ex.sets.length === 1
          ? exercisesRef.current.filter((e) => e.workoutExercise.id !== weId)
          : mapEx(weId, (e) => ({ ...e, sets: e.sets.filter((s) => s.id !== setId) }));
      commit(
        { exercises: next, prs: withoutPrs([setId]) },
        {
          dirty: true,
          prOps:
            deleted?.completed_at && !deleted.is_warmup ? [revokeOp(ex, [setId])] : [],
        }
      );
    },
    [commit]
  );

  const removeExercise = useCallback(
    (weId: string) => {
      const ex = findEx(weId);
      if (!ex) return;
      const completedSetIds = ex.sets
        .filter((s) => s.id && s.completed_at)
        .map((s) => s.id!);
      commit(
        {
          exercises: exercisesRef.current.filter((e) => e.workoutExercise.id !== weId),
          prs: withoutPrs(completedSetIds),
        },
        {
          dirty: true,
          prOps: completedSetIds.length ? [revokeOp(ex, completedSetIds)] : [],
        }
      );
    },
    [commit]
  );

  const reorderExercises = useCallback(
    (fromIndex: number, toIndex: number) => {
      const next = [...exercisesRef.current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      commit(
        {
          exercises: next.map((e, i) =>
            e.workoutExercise.sort_order === i
              ? e
              : { ...e, workoutExercise: { ...e.workoutExercise, sort_order: i } }
          ),
        },
        { dirty: true }
      );
    },
    [commit]
  );

  const renameWorkout = useCallback(
    (title: string) => {
      const w = workoutRef.current;
      if (!w) return;
      commit({ workout: { ...w, title } }, { dirty: true });
    },
    [commit]
  );

  const finishWorkout = useCallback(async () => {
    const w = workoutRef.current;
    if (!w) return;
    const finished = { ...w, finished_at: new Date().toISOString() };
    setActivePointer(null);
    await commit({ workout: finished }, { dirty: true });
    // Next workout at this gym ghosts off this one, even before it syncs
    await recordFinishedWorkout(finished, exercisesRef.current);
  }, [commit]);

  const cancelWorkout = useCallback(async () => {
    setActivePointer(null);
    // Tombstone: the sync engine revokes its PRs and deletes it server-side
    await commit({}, { dirty: false, deleted: true });
  }, [commit]);

  return {
    workout,
    exercises,
    loading,
    unavailable,
    elapsed,
    prs,
    addExercise,
    addSet,
    updateSet,
    completeSet,
    uncompleteSet,
    deleteSet,
    removeExercise,
    finishWorkout,
    renameWorkout,
    reorderExercises,
    cancelWorkout,
  };
}
