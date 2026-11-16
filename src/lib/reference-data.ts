/**
 * Read-mostly data the workout screen needs with zero signal: gyms, the
 * exercise library, and last-session ("ghost") values per gym. Refreshed
 * in the background whenever the app is open with a connection, so it's
 * already on the phone before you walk into a dead zone.
 */
import { SupabaseClient } from "@supabase/supabase-js";
import { Database } from "@/types/database.types";
import type { SetData } from "@/components/workout/set-row";
import {
  kvGet,
  kvSet,
  listWorkoutRecords,
  mergePendingRows,
} from "@/lib/offline";
import type {
  PreviousSession,
  Workout,
  WorkoutExerciseState,
} from "@/lib/workout-state";

type Supabase = SupabaseClient<Database>;
export type Gym = Database["public"]["Tables"]["gyms"]["Row"];
export type Exercise = Database["public"]["Tables"]["exercise_definitions"]["Row"];
export type Pool = Database["public"]["Tables"]["exercise_pools"]["Row"];
type SetRow = Database["public"]["Tables"]["sets"]["Row"];

/** exerciseId -> most recent sessions at one gym, newest first (max 2). */
export type PrevMap = Record<string, PreviousSession[]>;

const KEYS = {
  gyms: "ref:gyms",
  exercises: "ref:exercises",
  pools: "ref:pools",
} as const;
type RefKind = keyof typeof KEYS;
type RefRow = { gyms: Gym; exercises: Exercise; pools: Pool };

const prevKey = (gymId: string) => `prev:${gymId}`;

function sortRows<K extends RefKind>(kind: K, rows: RefRow[K][]): RefRow[K][] {
  const copy = [...rows];
  if (kind === "gyms") {
    (copy as Gym[]).sort(
      (a, b) =>
        Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name)
    );
  } else if (kind === "exercises") {
    (copy as Exercise[]).sort((a, b) => a.name.localeCompare(b.name));
  } else {
    (copy as Pool[]).sort((a, b) => a.sort_order - b.sort_order);
  }
  return copy;
}

export function getCachedGyms() {
  return kvGet<Gym[]>(KEYS.gyms);
}
export function getCachedExercises() {
  return kvGet<Exercise[]>(KEYS.exercises);
}
export function getCachedPools() {
  return kvGet<Pool[]>(KEYS.pools);
}

/** Write-through for a row created or edited on this device. */
export async function putCachedRow<K extends RefKind>(kind: K, row: RefRow[K]) {
  const list = (await kvGet<RefRow[K][]>(KEYS[kind])) ?? [];
  const next = list.some((r) => r.id === row.id)
    ? list.map((r) => (r.id === row.id ? row : r))
    : [...list, row];
  await kvSet(KEYS[kind], sortRows(kind, next));
}

export async function removeCachedRow(kind: RefKind, id: string) {
  const list = (await kvGet<{ id: string }[]>(KEYS[kind])) ?? [];
  await kvSet(KEYS[kind], list.filter((r) => r.id !== id));
}

export async function refreshGyms(supabase: Supabase): Promise<Gym[] | null> {
  const res = await supabase.from("gyms").select("*");
  if (res.error) return null;
  const rows = sortRows("gyms", await mergePendingRows("gyms", res.data));
  await kvSet(KEYS.gyms, rows);
  return rows;
}

export async function refreshLibrary(
  supabase: Supabase
): Promise<{ exercises: Exercise[]; pools: Pool[] } | null> {
  const [exRes, poolRes] = await Promise.all([
    supabase.from("exercise_definitions").select("*"),
    supabase.from("exercise_pools").select("*"),
  ]);
  if (exRes.error || poolRes.error) return null;
  const exercises = sortRows(
    "exercises",
    await mergePendingRows("exercise_definitions", exRes.data)
  );
  const pools = sortRows("pools", await mergePendingRows("exercise_pools", poolRes.data));
  await Promise.all([kvSet(KEYS.exercises, exercises), kvSet(KEYS.pools, pools)]);
  return { exercises, pools };
}

// ---- Previous-session values per gym ----

function toGhostSet(s: SetRow | SetData): SetData {
  return {
    id: s.id,
    set_number: s.set_number,
    reps: s.reps,
    weight: s.weight,
    duration_seconds: s.duration_seconds,
    is_warmup: s.is_warmup,
    note: s.note,
    completed_at: s.completed_at,
  };
}

export function getPrevMap(gymId: string) {
  return kvGet<PrevMap>(prevKey(gymId));
}

/** Last session of this exercise at this gym, skipping the workout being edited. */
export function pickPrevious(
  map: PrevMap | null,
  exerciseId: string,
  excludeWorkoutId: string
): PreviousSession | null {
  return map?.[exerciseId]?.find((p) => p.workoutId !== excludeWorkoutId) ?? null;
}

export function addWorkoutToPrevMap(
  map: PrevMap,
  workout: Workout,
  exercises: WorkoutExerciseState[]
): PrevMap {
  const next = { ...map };
  for (const ex of exercises) {
    const exId = ex.definition.id;
    const session: PreviousSession = {
      workoutId: workout.id,
      date: workout.started_at,
      note: ex.workoutExercise.notes,
      sets: ex.sets.map(toGhostSet),
    };
    next[exId] = [
      ...(next[exId] || []).filter((p) => p.workoutId !== workout.id),
      session,
    ]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 2);
  }
  return next;
}

/** Make a just-finished workout the ghost source right away, even offline. */
export async function recordFinishedWorkout(
  workout: Workout,
  exercises: WorkoutExerciseState[]
) {
  if (!workout.gym_id) return;
  const map = (await getPrevMap(workout.gym_id)) ?? {};
  await kvSet(prevKey(workout.gym_id), addWorkoutToPrevMap(map, workout, exercises));
}

export async function refreshPrevMap(
  supabase: Supabase,
  gymId: string
): Promise<PrevMap | null> {
  const wRes = await supabase
    .from("workouts")
    .select("id, started_at")
    .eq("gym_id", gymId)
    .not("finished_at", "is", null)
    .order("started_at", { ascending: false })
    .limit(20);
  if (wRes.error) return null;

  let map: PrevMap = {};
  const workouts = wRes.data;
  if (workouts.length) {
    const weRes = await supabase
      .from("workout_exercises")
      .select("id, workout_id, exercise_id, notes")
      .in(
        "workout_id",
        workouts.map((w) => w.id)
      );
    if (weRes.error) return null;

    const weIds = weRes.data.map((we) => we.id);
    const setsByWe = new Map<string, SetRow[]>();
    for (let i = 0; i < weIds.length; i += 100) {
      const sRes = await supabase
        .from("sets")
        .select("*")
        .in("workout_exercise_id", weIds.slice(i, i + 100))
        .order("set_number");
      if (sRes.error) return null;
      for (const s of sRes.data) {
        const arr = setsByWe.get(s.workout_exercise_id) || [];
        arr.push(s);
        setsByWe.set(s.workout_exercise_id, arr);
      }
    }

    for (const w of workouts) {
      for (const we of weRes.data.filter((x) => x.workout_id === w.id)) {
        const list = (map[we.exercise_id] ||= []);
        if (list.length >= 2 || list.some((p) => p.workoutId === w.id)) continue;
        list.push({
          workoutId: w.id,
          date: w.started_at,
          note: we.notes,
          sets: (setsByWe.get(we.id) || []).map(toGhostSet),
        });
      }
    }
  }

  // Workouts finished on this phone may not have reached the server yet
  const local = (await listWorkoutRecords()).filter(
    (r) => !r.deleted && r.workout.gym_id === gymId && r.workout.finished_at
  );
  for (const r of local) map = addWorkoutToPrevMap(map, r.workout, r.exercises);

  await kvSet(prevKey(gymId), map);
  return map;
}

let inflight: Promise<void> | null = null;
let lastRefreshAt = 0;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Background refresh of everything above. Cheap to call often — it throttles itself. */
export function refreshReferenceData(
  supabase: Supabase,
  opts: { force?: boolean } = {}
): Promise<void> {
  if (inflight) return inflight;
  if (!opts.force && Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS) {
    return Promise.resolve();
  }
  inflight = (async () => {
    const gyms = await refreshGyms(supabase);
    if (!gyms) return;
    await refreshLibrary(supabase);
    for (const g of gyms) await refreshPrevMap(supabase, g.id);
    lastRefreshAt = Date.now();
  })()
    .catch((err) => console.warn("[reference] refresh failed:", err))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
