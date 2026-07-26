"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient, getLocalUser } from "@/lib/supabase/client";
import { Database, TrackingMode, PrType } from "@/types/database.types";
import { SetData } from "@/components/workout/set-row";
import { detectPRs, savePRs, computeE1rm } from "@/lib/pr-detection";
import { PR_FLAG_MAP } from "@/lib/pr-constants";
import { revokeAndRecomputePRs } from "@/lib/pr-recompute";
import { haptic, HAPTIC } from "@/lib/haptics";
import {
  cacheWorkout,
  loadCachedWorkout,
  clearCachedWorkout,
  syncToSupabase,
  CachedWorkout,
} from "@/lib/offline";

type Workout = Database["public"]["Tables"]["workouts"]["Row"];
type WorkoutExercise = Database["public"]["Tables"]["workout_exercises"]["Row"];
type ExerciseDefinition =
  Database["public"]["Tables"]["exercise_definitions"]["Row"];

interface PreviousSession {
  sets: SetData[];
  note: string | null;
  date: string;
}

export interface WorkoutExerciseState {
  workoutExercise: WorkoutExercise;
  definition: ExerciseDefinition;
  sets: SetData[];
  previous: PreviousSession | null;
}

export function useWorkout(workoutId: string) {
  const [workout, setWorkout] = useState<Workout | null>(null);
  const [exercises, setExercises] = useState<WorkoutExerciseState[]>([]);
  const [loading, setLoading] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [prs, setPrs] = useState<Record<string, PrType[]>>({});
  const [isOffline, setIsOffline] = useState(false);
  const [pendingSync, setPendingSync] = useState(false);
  const supabase = createClient();
  const userIdRef = useRef<string | null>(null);
  const exercisesRef = useRef<WorkoutExerciseState[]>([]);
  const workoutRef = useRef<Workout | null>(null);
  const prsRef = useRef<Record<string, PrType[]>>({});
  // All PR reads/writes run through this chain so rapid set completions,
  // unchecks, and deletes can never interleave and race each other.
  const prOpChainRef = useRef<Promise<void>>(Promise.resolve());
  // True once the user mutates anything — a late-arriving network load
  // must not clobber their local changes.
  const dirtyRef = useRef(false);
  // Debounced set-value writes: state updates are instant, the network
  // write fires after typing settles (one request instead of one per key).
  const writeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingWritesRef = useRef<Map<string, SetData>>(new Map());
  useEffect(() => { exercisesRef.current = exercises; }, [exercises]);
  useEffect(() => { workoutRef.current = workout; }, [workout]);
  useEffect(() => { prsRef.current = prs; }, [prs]);

  const queuePrOp = useCallback((op: () => Promise<void>) => {
    prOpChainRef.current = prOpChainRef.current
      .then(op)
      .catch((err) => console.error("[PR] op failed:", err));
  }, []);

  // Merge restored PR badges (from recompute) into local state.
  const applyRestoredBadges = useCallback((restored: Record<string, PrType[]>) => {
    const ids = Object.keys(restored);
    if (ids.length === 0) return;
    setPrs((prev) => {
      const next = { ...prev };
      for (const [sid, types] of Object.entries(restored)) {
        next[sid] = [...new Set([...(next[sid] || []), ...types])];
      }
      return next;
    });
    setExercises((prev) =>
      prev.map((e) => ({
        ...e,
        sets: e.sets.map((s) => {
          const types = s.id ? restored[s.id] : undefined;
          if (!types) return s;
          const updated = { ...s };
          for (const t of types) {
            if (t === "WEIGHT") updated.is_pr_weight = true;
            else if (t === "1RM") updated.is_pr_1rm = true;
            else if (t === "VOL") updated.is_pr_volume = true;
            else if (t === "REPS") updated.is_pr_reps = true;
            else if (t === "DURATION") updated.is_pr_duration = true;
          }
          return updated;
        }),
      }))
    );
  }, []);

  // Cache to IndexedDB on every state change + track active workout in localStorage
  useEffect(() => {
    if (!workout || loading) return;
    if (!workout.finished_at) {
      try { localStorage.setItem("active_workout_id", workoutId); } catch {}
    }
    const data: CachedWorkout = {
      workout,
      exercises,
      prs,
      savedAt: Date.now(),
    };
    cacheWorkout(workoutId, data);
  }, [workout, exercises, prs, workoutId, loading]);

  // Online/offline detection + sync on reconnect
  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = async () => {
      setIsOffline(false);
      const w = workoutRef.current;
      if (!w || !pendingSync) return;
      const synced = await syncToSupabase(supabase, {
        workout: w,
        exercises: exercisesRef.current,
      });
      if (synced) setPendingSync(false);
    };

    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    if (!navigator.onLine) setIsOffline(true);

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSync]);

  const loadWorkout = useCallback(async () => {
    // 1. Paint instantly from the local mirror if we have one
    const cached = await loadCachedWorkout(workoutId);
    if (cached && !dirtyRef.current) {
      setWorkout(cached.workout);
      setExercises(cached.exercises);
      setPrs(cached.prs);
      setLoading(false);
    }

    const user = await getLocalUser(supabase);
    userIdRef.current = user?.id ?? null;

    // 2. Reconcile with the server in the background
    try {
      const { data: w } = await supabase
        .from("workouts")
        .select("*")
        .eq("id", workoutId)
        .single();

      if (!w) throw new Error("not found");
      if (dirtyRef.current) return; // user is already editing — local wins
      setWorkout(w);

      const { data: wes } = await supabase
        .from("workout_exercises")
        .select("*")
        .eq("workout_id", workoutId)
        .order("sort_order");

      if (dirtyRef.current) return;

      if (!wes?.length) {
        setExercises([]);
        setLoading(false);
        return;
      }

      const exerciseIds = [...new Set(wes.map((we) => we.exercise_id))];
      const { data: defs } = await supabase
        .from("exercise_definitions")
        .select("*")
        .in("id", exerciseIds);

      const defMap = new Map((defs || []).map((d) => [d.id, d]));

      const weIds = wes.map((we) => we.id);
      const { data: allSets } = await supabase
        .from("sets")
        .select("*")
        .in("workout_exercise_id", weIds)
        .order("set_number");

      const setsByWe = new Map<string, SetData[]>();
      const initialPrs: Record<string, PrType[]> = {};
      for (const s of allSets || []) {
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

        const setPrs: PrType[] = [];
        if (s.is_pr_weight) setPrs.push("WEIGHT");
        if (s.is_pr_1rm) setPrs.push("1RM");
        if (s.is_pr_volume) setPrs.push("VOL");
        if (s.is_pr_reps) setPrs.push("REPS");
        if (s.is_pr_duration) setPrs.push("DURATION");
        if (setPrs.length > 0) initialPrs[s.id] = setPrs;
      }
      const exerciseStates = wes
        .map((we) => ({
          workoutExercise: we,
          definition: defMap.get(we.exercise_id)!,
          sets: setsByWe.get(we.id) || [],
          previous: null as PreviousSession | null,
        }))
        .filter((e) => e.definition);

      if (dirtyRef.current) return;
      setPrs(initialPrs);
      setExercises(exerciseStates);
      setLoading(false);

      if (w.gym_id) {
        for (const ex of exerciseStates) {
          fetchPrevious(ex.definition.id, w.gym_id, workoutId).then((prev) => {
            if (prev) {
              setExercises((current) =>
                current.map((e) =>
                  e.workoutExercise.id === ex.workoutExercise.id
                    ? { ...e, previous: prev }
                    : e
                )
              );
            }
          });
        }
      }
    } catch {
      // Supabase unreachable — cached data (if any) is already painted
      if (cached) {
        setPendingSync(true);
        setIsOffline(true);
      }
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workoutId]);

  async function fetchPrevious(
    exerciseId: string,
    gymId: string,
    currentWorkoutId: string
  ): Promise<PreviousSession | null> {
    try {
      const { data: workouts } = await supabase
        .from("workouts")
        .select("id, started_at")
        .eq("gym_id", gymId)
        .not("finished_at", "is", null)
        .neq("id", currentWorkoutId)
        .order("started_at", { ascending: false })
        .limit(20);

      if (!workouts?.length) return null;

      const workoutIds = workouts.map((w) => w.id);

      const { data: wes } = await supabase
        .from("workout_exercises")
        .select("id, workout_id, notes")
        .eq("exercise_id", exerciseId)
        .in("workout_id", workoutIds);

      if (!wes?.length) return null;

      // workouts are ordered newest-first; take the most recent one
      // that actually contained this exercise
      let match: (typeof wes)[number] | null = null;
      let wo: (typeof workouts)[number] | null = null;
      for (const w of workouts) {
        const found = wes.find((x) => x.workout_id === w.id);
        if (found) {
          match = found;
          wo = w;
          break;
        }
      }
      if (!match) return null;

      const weId = match.id;

      const { data: sets } = await supabase
        .from("sets")
        .select("*")
        .eq("workout_exercise_id", weId)
        .order("set_number");

      return {
        sets: (sets || []).map((s) => ({
          id: s.id,
          set_number: s.set_number,
          reps: s.reps,
          weight: s.weight,
          duration_seconds: s.duration_seconds,
          is_warmup: s.is_warmup,
          note: s.note,
          completed_at: s.completed_at,
        })),
        note: match.notes,
        date: wo?.started_at || "",
      };
    } catch {
      return null;
    }
  }

  useEffect(() => {
    loadWorkout();
  }, [loadWorkout]);

  useEffect(() => {
    if (!workout) return;

    const start = new Date(workout.started_at).getTime();

    if (workout.finished_at) {
      const end = new Date(workout.finished_at).getTime();
      setElapsed(Math.floor((end - start) / 1000));
      return;
    }

    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [workout]);

  const addExercise = useCallback(
    async (definition: ExerciseDefinition) => {
      if (!userIdRef.current || !workout) return;
      dirtyRef.current = true;

      const sortOrder = exercisesRef.current.length;
      const weId = crypto.randomUUID();

      let prev: PreviousSession | null = null;
      if (workout.gym_id) {
        try {
          prev = await fetchPrevious(definition.id, workout.gym_id, workoutId);
        } catch {}
      }

      const weRow: WorkoutExercise = {
        id: weId,
        user_id: userIdRef.current,
        workout_id: workoutId,
        exercise_id: definition.id,
        sort_order: sortOrder,
        mode: definition.default_mode,
        is_warmup_group: false,
        notes: null,
        started_at: null,
        created_at: new Date().toISOString(),
      };

      // Preload every set from the previous session at this gym —
      // values, warmup flags, and notes — all unchecked.
      const prevSets = (prev?.sets || []).filter((s) => s.completed_at);
      const templates = prevSets.length > 0 ? prevSets : [null];
      const setRows: SetData[] = templates.map((p, i) => ({
        id: crypto.randomUUID(),
        set_number: i + 1,
        reps: p?.reps ?? null,
        weight: p?.weight ?? null,
        duration_seconds: p?.duration_seconds ?? null,
        is_warmup: p?.is_warmup ?? false,
        note: p?.note ?? null,
        completed_at: null,
      }));

      setExercises((current) => [
        ...current,
        {
          workoutExercise: weRow,
          definition,
          sets: setRows,
          previous: prev,
        },
      ]);

      try {
        await supabase.from("workout_exercises").insert({
          id: weId,
          user_id: userIdRef.current,
          workout_id: workoutId,
          exercise_id: definition.id,
          sort_order: sortOrder,
          mode: definition.default_mode,
        });
        await supabase.from("sets").insert(
          setRows.map((s) => ({
            id: s.id,
            user_id: userIdRef.current!,
            workout_exercise_id: weId,
            set_number: s.set_number,
            reps: s.reps,
            weight: s.weight,
            duration_seconds: s.duration_seconds,
            is_warmup: s.is_warmup,
            note: s.note,
          }))
        );
      } catch {
        setPendingSync(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workoutId, workout]
  );

  const addSet = useCallback(
    async (workoutExerciseId: string) => {
      if (!userIdRef.current) return;
      dirtyRef.current = true;
      const ex = exercisesRef.current.find(
        (e) => e.workoutExercise.id === workoutExerciseId
      );
      if (!ex) return;

      const nextNum =
        ex.sets.length > 0
          ? Math.max(...ex.sets.map((s) => s.set_number)) + 1
          : 1;

      const prefill = ex.previous?.sets[ex.sets.length];
      const setId = crypto.randomUUID();

      const setRow: SetData = {
        id: setId,
        set_number: nextNum,
        reps: prefill?.reps ?? null,
        weight: prefill?.weight ?? null,
        duration_seconds: prefill?.duration_seconds ?? null,
        is_warmup: false,
        note: prefill?.note ?? null,
        completed_at: null,
      };

      setExercises((prev) =>
        prev.map((e) =>
          e.workoutExercise.id === workoutExerciseId
            ? { ...e, sets: [...e.sets, setRow] }
            : e
        )
      );

      try {
        await supabase.from("sets").insert({
          id: setId,
          user_id: userIdRef.current,
          workout_exercise_id: workoutExerciseId,
          set_number: nextNum,
          reps: prefill?.reps ?? null,
          weight: prefill?.weight ?? null,
          duration_seconds: prefill?.duration_seconds ?? null,
          note: prefill?.note ?? null,
        });
      } catch {
        setPendingSync(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const flushSetWrite = useCallback(async (setId: string) => {
    const timer = writeTimersRef.current.get(setId);
    if (timer) {
      clearTimeout(timer);
      writeTimersRef.current.delete(setId);
    }
    const data = pendingWritesRef.current.get(setId);
    if (!data) return;
    pendingWritesRef.current.delete(setId);
    try {
      await supabase
        .from("sets")
        .update({
          reps: data.reps,
          weight: data.weight,
          duration_seconds: data.duration_seconds,
          is_warmup: data.is_warmup,
          note: data.note,
          e1rm: data.e1rm ?? null,
          rest_seconds: data.rest_seconds ?? null,
        })
        .eq("id", setId);
    } catch {
      setPendingSync(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushAllSetWrites = useCallback(async () => {
    const ids = [...pendingWritesRef.current.keys()];
    await Promise.all(ids.map((id) => flushSetWrite(id)));
  }, [flushSetWrite]);

  const updateSet = useCallback(
    (workoutExerciseId: string, set: SetData) => {
      if (!set.id) return;
      dirtyRef.current = true;

      const ex = exercisesRef.current.find(
        (e) => e.workoutExercise.id === workoutExerciseId
      );
      const e1rm =
        ex?.workoutExercise.mode === "reps_weight" && set.weight && set.reps
          ? computeE1rm(set.weight, set.reps)
          : null;

      const updatedSet = { ...set, e1rm };

      setExercises((prev) =>
        prev.map((e) =>
          e.workoutExercise.id === workoutExerciseId
            ? {
                ...e,
                sets: e.sets.map((s) => (s.id === set.id ? updatedSet : s)),
              }
            : e
        )
      );

      // Debounce the network write until typing settles
      const setId = set.id;
      pendingWritesRef.current.set(setId, updatedSet);
      const existing = writeTimersRef.current.get(setId);
      if (existing) clearTimeout(existing);
      writeTimersRef.current.set(
        setId,
        setTimeout(() => flushSetWrite(setId), 600)
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flushSetWrite]
  );

  const completeSet = useCallback(
    async (workoutExerciseId: string, setId: string) => {
      dirtyRef.current = true;
      // Make sure the set's typed values are persisted before flagging PRs on it
      flushSetWrite(setId);
      const now = new Date().toISOString();

      // Capture set data before state update to avoid stale closure
      const ex = exercisesRef.current.find(
        (e) => e.workoutExercise.id === workoutExerciseId
      );
      const setData = ex?.sets.find((s) => s.id === setId);

      // Rest = time since the most recent completed set anywhere in this
      // workout. Passive data — stamped once, editable afterwards.
      let restSeconds: number | null = null;
      let lastCompletedMs = 0;
      for (const e of exercisesRef.current) {
        for (const s of e.sets) {
          if (s.id !== setId && s.completed_at) {
            const t = new Date(s.completed_at).getTime();
            if (t > lastCompletedMs) lastCompletedMs = t;
          }
        }
      }
      if (lastCompletedMs > 0) {
        restSeconds = Math.max(0, Math.round((Date.now() - lastCompletedMs) / 1000));
      }

      setExercises((prev) =>
        prev.map((e) =>
          e.workoutExercise.id === workoutExerciseId
            ? {
                ...e,
                sets: e.sets.map((s) =>
                  s.id === setId
                    ? { ...s, completed_at: now, rest_seconds: restSeconds }
                    : s
                ),
              }
            : e
        )
      );

      try {
        await supabase
          .from("sets")
          .update({ completed_at: now, rest_seconds: restSeconds })
          .eq("id", setId);
      } catch {
        setPendingSync(true);
      }
      if (
        ex &&
        setData &&
        !setData.is_warmup &&
        userIdRef.current &&
        workout
      ) {
        const userId = userIdRef.current;
        const gymId = workout.gym_id;
        queuePrOp(async () => {
          const detected = await detectPRs({
            supabase,
            setData,
            exerciseId: ex.definition.id,
            equipment: ex.definition.equipment,
            mode: ex.workoutExercise.mode,
            gymId,
            workoutId,
            setId,
            userId,
          });
          if (detected.length === 0) return;

          haptic(HAPTIC.pr);
          const detectedTypes = detected.map((d) => d.prType);
          setPrs((prev) => {
            const next = { ...prev, [setId]: detectedTypes };
            // Read current sets from the ref so rapid completions see fresh state
            const curEx = exercisesRef.current.find(
              (e) => e.workoutExercise.id === workoutExerciseId
            );
            for (const s of curEx?.sets || []) {
              if (!s.id || s.id === setId || !s.completed_at || !prev[s.id]) continue;
              const remaining = prev[s.id].filter((t: PrType) => !detectedTypes.includes(t));
              if (remaining.length === 0) delete next[s.id];
              else next[s.id] = remaining;
            }
            return next;
          });

          await savePRs({
            supabase,
            detectedPRs: detected,
            exerciseId: ex.definition.id,
            equipment: ex.definition.equipment,
            setId,
            workoutId,
            gymId,
            userId,
            setData,
            mode: ex.workoutExercise.mode,
          });

          // Clear superseded flags on this exercise's other sets in DB
          const clearFlags: Database["public"]["Tables"]["sets"]["Update"] = {};
          for (const t of detectedTypes) {
            const flag = PR_FLAG_MAP[t] as keyof typeof clearFlags;
            (clearFlags as Record<string, boolean>)[flag] = false;
          }
          const curEx = exercisesRef.current.find(
            (e) => e.workoutExercise.id === workoutExerciseId
          );
          const supersededIds = (curEx?.sets || [])
            .filter((s) => s.id && s.id !== setId && s.completed_at)
            .map((s) => s.id!);
          if (supersededIds.length > 0) {
            await supabase.from("sets").update(clearFlags).in("id", supersededIds);
          }
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workoutId, workout]
  );

  const uncompleteSet = useCallback(
    async (workoutExerciseId: string, setId: string) => {
      dirtyRef.current = true;
      const ex = exercisesRef.current.find(
        (e) => e.workoutExercise.id === workoutExerciseId
      );

      setExercises((prev) =>
        prev.map((e) =>
          e.workoutExercise.id === workoutExerciseId
            ? {
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
              }
            : e
        )
      );

      setPrs((prev) => {
        const next = { ...prev };
        delete next[setId];
        return next;
      });

      try {
        await supabase
          .from("sets")
          .update({
            completed_at: null,
            rest_seconds: null,
            is_pr_weight: false,
            is_pr_1rm: false,
            is_pr_volume: false,
            is_pr_reps: false,
            is_pr_duration: false,
          })
          .eq("id", setId);
      } catch {
        setPendingSync(true);
      }

      // Revoke this set's PR contributions and restore whatever it superseded
      if (ex && userIdRef.current && workoutRef.current) {
        const userId = userIdRef.current;
        const gymId = workoutRef.current.gym_id;
        queuePrOp(async () => {
          const restored = await revokeAndRecomputePRs({
            supabase,
            userId,
            exerciseId: ex.definition.id,
            equipment: ex.definition.equipment,
            gymId,
            removedSetIds: [setId],
          });
          applyRestoredBadges(restored);
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const deleteSet = useCallback(
    async (workoutExerciseId: string, setId: string) => {
      dirtyRef.current = true;
      // Cancel any pending debounced write — it would resurrect the row
      const timer = writeTimersRef.current.get(setId);
      if (timer) clearTimeout(timer);
      writeTimersRef.current.delete(setId);
      pendingWritesRef.current.delete(setId);
      const ex = exercisesRef.current.find(
        (e) => e.workoutExercise.id === workoutExerciseId
      );
      const isLastSet = ex && ex.sets.length === 1;
      const deletedSet = ex?.sets.find((s) => s.id === setId);

      if (isLastSet) {
        setExercises((prev) =>
          prev.filter((e) => e.workoutExercise.id !== workoutExerciseId)
        );
      } else {
        setExercises((prev) =>
          prev.map((e) =>
            e.workoutExercise.id === workoutExerciseId
              ? { ...e, sets: e.sets.filter((s) => s.id !== setId) }
              : e
          )
        );
      }
      setPrs((prev) => {
        if (!prev[setId]) return prev;
        const next = { ...prev };
        delete next[setId];
        return next;
      });

      const userId = userIdRef.current;
      const gymId = workoutRef.current?.gym_id ?? null;
      queuePrOp(async () => {
        try {
          // Revoke PRs BEFORE deleting the set — the FK nulls on delete
          if (ex && userId && deletedSet?.completed_at) {
            const restored = await revokeAndRecomputePRs({
              supabase,
              userId,
              exerciseId: ex.definition.id,
              equipment: ex.definition.equipment,
              gymId,
              removedSetIds: [setId],
            });
            applyRestoredBadges(restored);
          }
          await supabase.from("sets").delete().eq("id", setId);
          if (isLastSet) {
            await supabase.from("workout_exercises").delete().eq("id", workoutExerciseId);
          }
        } catch {
          setPendingSync(true);
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const removeExercise = useCallback(
    async (workoutExerciseId: string) => {
      dirtyRef.current = true;
      const ex = exercisesRef.current.find(
        (e) => e.workoutExercise.id === workoutExerciseId
      );
      const completedSetIds = (ex?.sets || [])
        .filter((s) => s.id && s.completed_at)
        .map((s) => s.id!);

      setExercises((prev) =>
        prev.filter((e) => e.workoutExercise.id !== workoutExerciseId)
      );
      if (completedSetIds.length > 0) {
        setPrs((prev) => {
          const next = { ...prev };
          for (const sid of completedSetIds) delete next[sid];
          return next;
        });
      }

      const userId = userIdRef.current;
      const gymId = workoutRef.current?.gym_id ?? null;
      queuePrOp(async () => {
        try {
          if (ex && userId && completedSetIds.length > 0) {
            const restored = await revokeAndRecomputePRs({
              supabase,
              userId,
              exerciseId: ex.definition.id,
              equipment: ex.definition.equipment,
              gymId,
              removedSetIds: completedSetIds,
            });
            applyRestoredBadges(restored);
          }
          await supabase
            .from("sets")
            .delete()
            .eq("workout_exercise_id", workoutExerciseId);
          await supabase
            .from("workout_exercises")
            .delete()
            .eq("id", workoutExerciseId);
        } catch {
          setPendingSync(true);
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const finishWorkout = useCallback(async () => {
    const now = new Date().toISOString();
    setWorkout((prev) => (prev ? { ...prev, finished_at: now } : prev));

    await flushAllSetWrites();

    let allSynced = !pendingSync;
    try {
      await supabase
        .from("workouts")
        .update({ finished_at: now })
        .eq("id", workoutId);

      if (pendingSync) {
        const w = workoutRef.current;
        if (w) {
          const synced = await syncToSupabase(supabase, {
            workout: { ...w, finished_at: now },
            exercises: exercisesRef.current,
          });
          if (synced) {
            setPendingSync(false);
            allSynced = true;
          }
        }
      }
    } catch {
      setPendingSync(true);
      allSynced = false;
    }

    // Only drop the local mirror once everything made it to the server —
    // the offline summary view depends on it otherwise
    if (allSynced) {
      clearCachedWorkout(workoutId);
    }
    try { localStorage.removeItem("active_workout_id"); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workoutId, pendingSync]);

  const renameWorkout = useCallback(
    async (title: string) => {
      dirtyRef.current = true;
      setWorkout((prev) => (prev ? { ...prev, title } : prev));
      try {
        await supabase
          .from("workouts")
          .update({ title })
          .eq("id", workoutId);
      } catch {
        setPendingSync(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workoutId]
  );

  const reorderExercises = useCallback(
    async (fromIndex: number, toIndex: number) => {
      dirtyRef.current = true;
      setExercises((prev) => {
        const updated = [...prev];
        const [moved] = updated.splice(fromIndex, 1);
        updated.splice(toIndex, 0, moved);
        return updated;
      });

      const currentExercises = [...exercisesRef.current];
      const [moved] = currentExercises.splice(fromIndex, 1);
      currentExercises.splice(toIndex, 0, moved);

      try {
        for (let i = 0; i < currentExercises.length; i++) {
          await supabase
            .from("workout_exercises")
            .update({ sort_order: i })
            .eq("id", currentExercises[i].workoutExercise.id);
        }
      } catch {
        setPendingSync(true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const cancelWorkout = useCallback(async () => {
    // Drop any pending debounced writes — everything is being deleted
    for (const timer of writeTimersRef.current.values()) clearTimeout(timer);
    writeTimersRef.current.clear();
    pendingWritesRef.current.clear();
    clearCachedWorkout(workoutId);
    try { localStorage.removeItem("active_workout_id"); } catch {}

    try {
      // Revoke each exercise's PR contributions and restore superseded records
      const userId = userIdRef.current;
      const gymId = workoutRef.current?.gym_id ?? null;
      if (userId) {
        for (const ex of exercisesRef.current) {
          const setIds = ex.sets.filter((s) => s.id).map((s) => s.id!);
          if (setIds.length === 0) continue;
          await revokeAndRecomputePRs({
            supabase,
            userId,
            exerciseId: ex.definition.id,
            equipment: ex.definition.equipment,
            gymId,
            removedSetIds: setIds,
          });
        }
      }
      // Safety net for anything not covered above
      await supabase.from("pr_snapshots").delete().eq("workout_id", workoutId);
      await supabase.from("personal_records").delete().eq("workout_id", workoutId);

      const weIds = exercisesRef.current.map((e) => e.workoutExercise.id);
      if (weIds.length) {
        await supabase.from("sets").delete().in("workout_exercise_id", weIds);
        await supabase.from("workout_exercises").delete().in("id", weIds);
      }
      await supabase.from("workouts").delete().eq("id", workoutId);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workoutId]);

  return {
    workout,
    exercises,
    loading,
    elapsed,
    prs,
    isOffline,
    pendingSync,
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
