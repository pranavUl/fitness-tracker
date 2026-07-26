import { SupabaseClient } from "@supabase/supabase-js";
import { Database } from "@/types/database.types";
import { WorkoutExerciseState } from "@/lib/hooks/use-workout";
import { PrType } from "@/types/database.types";

const DB_NAME = "fitness-offline";
const DB_VERSION = 2;
const STORE = "workout_cache";
const KV_STORE = "kv_cache";

export interface CachedWorkout {
  workout: Database["public"]["Tables"]["workouts"]["Row"];
  exercises: WorkoutExerciseState[];
  prs: Record<string, PrType[]>;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no indexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function cacheWorkout(
  workoutId: string,
  data: CachedWorkout
): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(data, workoutId);
    await txDone(tx);
  } catch {}
}

export async function loadCachedWorkout(
  workoutId: string
): Promise<CachedWorkout | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(workoutId);
    return new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function clearCachedWorkout(workoutId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(workoutId);
    await txDone(tx);
  } catch {}
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Generic key-value cache (stale-while-revalidate page data) ----

export async function kvGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(KV_STORE, "readonly");
    const req = tx.objectStore(KV_STORE).get(key);
    return new Promise((resolve) => {
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(KV_STORE, "readwrite");
    tx.objectStore(KV_STORE).put(value, key);
    await txDone(tx);
  } catch {}
}

export async function syncToSupabase(
  supabase: SupabaseClient<Database>,
  cached: Pick<CachedWorkout, "workout" | "exercises">
): Promise<boolean> {
  try {
    const { workout, exercises } = cached;

    const { data: remoteWEs } = await supabase
      .from("workout_exercises")
      .select("id")
      .eq("workout_id", workout.id);

    const remoteWeIds = new Set((remoteWEs || []).map((we) => we.id));

    for (const ex of exercises) {
      const we = ex.workoutExercise;
      const { error: weErr } = await supabase.from("workout_exercises").upsert({
        id: we.id,
        user_id: we.user_id,
        workout_id: we.workout_id,
        exercise_id: we.exercise_id,
        sort_order: we.sort_order,
        mode: we.mode,
      });
      if (weErr) { console.warn("[sync] upsert we failed:", weErr.message); return false; }
      remoteWeIds.delete(we.id);

      const { data: remoteSets } = await supabase
        .from("sets")
        .select("id")
        .eq("workout_exercise_id", we.id);

      const remoteSetIds = new Set((remoteSets || []).map((s) => s.id));

      for (const set of ex.sets) {
        if (!set.id) continue;
        const { error: setErr } = await supabase.from("sets").upsert({
          id: set.id,
          user_id: we.user_id,
          workout_exercise_id: we.id,
          set_number: set.set_number,
          reps: set.reps,
          weight: set.weight,
          duration_seconds: set.duration_seconds,
          is_warmup: set.is_warmup,
          completed_at: set.completed_at,
          note: set.note,
          e1rm: set.e1rm ?? null,
          rest_seconds: set.rest_seconds ?? null,
        });
        if (setErr) { console.warn("[sync] upsert set failed:", setErr.message); return false; }
        remoteSetIds.delete(set.id);
      }

      for (const id of remoteSetIds) {
        await supabase.from("sets").delete().eq("id", id);
      }
    }

    for (const id of remoteWeIds) {
      await supabase.from("sets").delete().eq("workout_exercise_id", id);
      await supabase.from("workout_exercises").delete().eq("id", id);
    }

    return true;
  } catch {
    return false;
  }
}
