/**
 * Background sync: pushes everything saved on the phone (lib/offline.ts)
 * to Supabase whenever a connection works, and retries with backoff when
 * it doesn't. Nothing in the UI ever waits on this.
 *
 * Workouts sync as whole snapshots (upsert every row, delete what's gone),
 * so any sequence of offline edits converges without replaying them one
 * by one. PR detection runs here too, against the pushed data.
 */
import { SupabaseClient, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { Database } from "@/types/database.types";
import { createClient, rememberUserId } from "@/lib/supabase/client";
import {
  LOCAL_CHANGE_EVENT,
  OutboxEntry,
  OutboxTable,
  WorkoutRecord,
  completeOutboxEntry,
  deleteWorkoutRecord,
  hasUnsyncedChanges,
  listOutbox,
  listWorkoutRecords,
  loadCachedWorkout,
  recordOutboxFailure,
  resetOutboxFailures,
  updateWorkoutRecord,
} from "@/lib/offline";
import { detectPRs, savePRs } from "@/lib/pr-detection";
import { revokeAndRecomputePRs } from "@/lib/pr-recompute";
import { PR_FLAG_MAP } from "@/lib/pr-constants";
import { SyncError, check, isRetryable, softCheck } from "@/lib/sync-errors";
import { PrOp, PrPatch, applyPrPatch } from "@/lib/workout-state";

type Supabase = SupabaseClient<Database>;

// ---- Status (drives the sync indicator) ----

export interface SyncStatus {
  /** Workouts / rows the server hasn't confirmed yet. */
  pending: number;
  /** Changes the server rejected; kept on the phone. */
  failed: number;
  syncing: boolean;
  /** Browser reports online and the last request actually got through. */
  online: boolean;
  /** Session is gone for good — sync resumes after signing in again. */
  needsSignIn: boolean;
}

export const INITIAL_SYNC_STATUS: SyncStatus = {
  pending: 0,
  failed: 0,
  syncing: false,
  online: true,
  needsSignIn: false,
};

let status = INITIAL_SYNC_STATUS;
const statusListeners = new Set<() => void>();

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

function setStatus(patch: Partial<SyncStatus>) {
  const next = { ...status, ...patch };
  if ((Object.keys(next) as (keyof SyncStatus)[]).every((k) => next[k] === status[k])) {
    return;
  }
  status = next;
  for (const fn of statusListeners) fn();
}

function setNetwork(ok: boolean) {
  setStatus({ online: ok && navigator.onLine });
  // Lets the service worker skip doomed network attempts on navigation
  navigator.serviceWorker?.controller?.postMessage({ type: "network", ok });
}

async function refreshCounts() {
  const [records, outbox] = await Promise.all([listWorkoutRecords(), listOutbox()]);
  setStatus({
    pending:
      records.filter(hasUnsyncedChanges).length +
      outbox.filter((e) => !e.failed).length,
    failed:
      records.filter((r) => r.syncError).length +
      outbox.filter((e) => e.failed).length,
  });
}

// ---- PR results -> the open workout screen ----

const workoutListeners = new Map<string, (patch: PrPatch) => void>();

/** The workout screen applies PR results itself so its state stays authoritative. */
export function subscribeWorkoutPrs(
  workoutId: string,
  fn: (patch: PrPatch) => void
): () => void {
  workoutListeners.set(workoutId, fn);
  return () => {
    if (workoutListeners.get(workoutId) === fn) workoutListeners.delete(workoutId);
  };
}

async function applyWorkoutPatch(workoutId: string, patch: PrPatch) {
  const listener = workoutListeners.get(workoutId);
  if (listener) {
    listener(patch);
  } else {
    await updateWorkoutRecord(workoutId, (rec) => ({
      ...rec,
      ...applyPrPatch(rec, patch),
    }));
  }
}

function removePrOps(workoutId: string, ids: string[]) {
  return updateWorkoutRecord(workoutId, (rec) => ({
    ...rec,
    prOps: rec.prOps.filter((o) => !ids.includes(o.id)),
  }));
}

// ---- Scheduling ----

let running = false;
let rerun = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 0;

export function requestSync(delayMs = 400) {
  if (typeof window === "undefined") return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runSync();
  }, delayMs);
}

async function runSync() {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  setStatus({ syncing: true });
  let outcome: "done" | "retry" = "done";
  try {
    do {
      rerun = false;
      outcome = await syncOnce();
    } while (outcome === "done" && rerun);
  } catch (err) {
    console.error("[sync] run failed:", err);
    outcome = "retry";
  } finally {
    running = false;
  }
  await refreshCounts();
  setStatus({ syncing: false });
  if (outcome === "retry") {
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 5000, 60000);
    requestSync(retryDelay);
  } else {
    retryDelay = 0;
    if (rerun) requestSync(0);
  }
}

let started = false;

/** Idempotent; called once from the root layout. */
export function startSyncEngine() {
  if (started || typeof window === "undefined") return;
  started = true;
  setStatus({ online: navigator.onLine });

  let countTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener(LOCAL_CHANGE_EVENT, () => {
    // Debounced: typing into a set fires this on every keystroke
    if (countTimer) clearTimeout(countTimer);
    countTimer = setTimeout(() => void refreshCounts(), 300);
    requestSync();
  });
  window.addEventListener("online", () => {
    retryDelay = 0;
    setStatus({ online: true });
    requestSync(0);
  });
  window.addEventListener("offline", () => setNetwork(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestSync(0);
  });
  window.setInterval(() => {
    if (status.pending > 0 && !running) requestSync(0);
  }, 30000);

  void resetOutboxFailures().then(() => {
    void refreshCounts();
    requestSync(0);
  });
}

// ---- One pass over everything pending ----

const TABLE_PRIORITY: Record<OutboxTable, number> = {
  gyms: 0,
  exercise_pools: 0,
  exercise_definitions: 1,
  workouts: 2,
  daily_tracking: 2,
  run_sessions: 2,
};

async function syncOnce(): Promise<"done" | "retry"> {
  const [records, outbox] = await Promise.all([listWorkoutRecords(), listOutbox()]);
  const entries = outbox
    .filter((e) => !e.failed)
    .sort(
      (a, b) => TABLE_PRIORITY[a.table] - TABLE_PRIORITY[b.table] || a.seq - b.seq
    );
  const workouts = records
    .filter(hasUnsyncedChanges)
    .sort((a, b) => b.savedAt - a.savedAt);
  if (entries.length === 0 && workouts.length === 0) return "done";

  const supabase = createClient();
  // Offline with an expired token this comes back null — wait for signal.
  const { data, error } = await supabase.auth.getSession();
  if (!data.session) {
    const offline =
      !navigator.onLine || (!!error && isAuthRetryableFetchError(error));
    if (offline) setNetwork(false);
    setStatus({ needsSignIn: !offline });
    return "retry";
  }
  setStatus({ needsSignIn: false });
  rememberUserId(data.session.user.id);

  try {
    // Library rows first: workouts may reference exercises created offline
    for (const entry of entries) await syncOutboxEntry(supabase, entry);
    for (const rec of workouts) await syncWorkoutSafely(supabase, rec.workout.id);
  } catch (err) {
    if (err instanceof SyncError && err.retryable) {
      if (err.offline) setNetwork(false);
      console.warn("[sync] will retry:", err.message);
      return "retry";
    }
    throw err;
  }
  setNetwork(true);
  await pruneMirrors();
  return "done";
}

async function syncOutboxEntry(supabase: Supabase, e: OutboxEntry) {
  // Payloads are checked when queued; the untyped client avoids a union of
  // every table's Insert type here.
  const db = supabase as unknown as SupabaseClient;
  const res =
    e.op === "delete"
      ? await db.from(e.table).delete().eq("id", e.id)
      : e.op === "update"
        ? await db.from(e.table).update(e.row!).eq("id", e.id)
        : await db
            .from(e.table)
            .upsert(e.row!, e.onConflict ? { onConflict: e.onConflict } : undefined);

  if (!res.error) {
    await completeOutboxEntry(e.key, e.rev);
    return;
  }
  if (isRetryable(res)) {
    await recordOutboxFailure(e.key, e.rev, res.error.message, false);
    throw new SyncError(`${e.key}: ${res.error.message}`, true, res.status === 0);
  }
  console.error(`[sync] ${e.key} rejected:`, res.error.message);
  await recordOutboxFailure(e.key, e.rev, res.error.message, true);
}

async function syncWorkoutSafely(supabase: Supabase, workoutId: string) {
  try {
    await syncWorkout(supabase, workoutId);
    await updateWorkoutRecord(workoutId, (r) =>
      r.syncError ? { ...r, syncError: undefined } : undefined
    );
  } catch (err) {
    if (err instanceof SyncError && err.retryable) throw err;
    // Server rejected the data itself. Keep it on the phone, flag it, and
    // move on so one bad workout can't block the rest.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sync] workout ${workoutId} rejected:`, message);
    await updateWorkoutRecord(workoutId, (r) =>
      r.legacy
        ? { ...r, legacy: false, syncedVersion: r.version } // best-effort recovery only
        : { ...r, syncError: message }
    );
  }
}

async function syncWorkout(supabase: Supabase, workoutId: string) {
  let rec = await loadCachedWorkout(workoutId);
  if (!rec) return;

  if (rec.deleted) {
    await deleteWorkoutRemote(supabase, rec);
    await deleteWorkoutRecord(workoutId);
    return;
  }

  // 1. PR revokes look records up by set id, so they must run before the
  //    snapshot push deletes those sets.
  for (;;) {
    const revokes = rec.prOps.filter((o) => o.kind === "revoke");
    if (revokes.length === 0) break;
    for (const op of revokes) await runRevoke(supabase, rec, op);
    rec = await loadCachedWorkout(workoutId);
    if (!rec || rec.deleted) return; // cancelled meanwhile — next pass deletes it
  }

  // 2. Push the snapshot
  if (rec.legacy || rec.version > rec.syncedVersion) {
    const exists = await pushSnapshot(supabase, rec);
    if (!exists) {
      // Legacy mirror of a workout deleted on the server — don't resurrect it
      await deleteWorkoutRecord(workoutId);
      return;
    }
    const version = rec.version;
    await updateWorkoutRecord(workoutId, (r) => ({
      ...r,
      syncedVersion: Math.max(r.syncedVersion, version),
      legacy: false,
    }));
  }

  // 3. PR detection against what was just pushed
  for (const op of rec.prOps) {
    if (op.kind !== "detect") continue;
    try {
      await runDetect(supabase, rec, op);
    } catch (err) {
      if (!(err instanceof SyncError) || err.retryable) throw err;
      console.error("[sync] PR detection skipped:", err.message);
    }
    await removePrOps(workoutId, [op.id]);
  }
}

/** Returns false if a legacy mirror's workout no longer exists on the server. */
async function pushSnapshot(supabase: Supabase, rec: WorkoutRecord): Promise<boolean> {
  const w = rec.workout;

  if (rec.legacy) {
    const found = check(
      await supabase.from("workouts").select("id").eq("id", w.id).maybeSingle(),
      "workout lookup"
    );
    if (!found.data) return false;
  }

  check(
    await supabase.from("workouts").upsert({
      id: w.id,
      user_id: w.user_id,
      gym_id: w.gym_id,
      title: w.title,
      started_at: w.started_at,
      finished_at: w.finished_at,
      notes: w.notes,
      workout_type: w.workout_type,
    }),
    "workout upsert"
  );

  const wes = rec.exercises.map((e, i) => ({
    id: e.workoutExercise.id,
    user_id: w.user_id,
    workout_id: w.id,
    exercise_id: e.workoutExercise.exercise_id,
    sort_order: i,
    mode: e.workoutExercise.mode,
    is_warmup_group: e.workoutExercise.is_warmup_group ?? false,
    notes: e.workoutExercise.notes ?? null,
    started_at: e.workoutExercise.started_at ?? null,
  }));
  if (wes.length) {
    check(await supabase.from("workout_exercises").upsert(wes), "exercises upsert");
  }

  // PR flags are deliberately left out: the PR steps own them server-side.
  const sets = rec.exercises.flatMap((e) =>
    e.sets
      .filter((s) => s.id)
      .map((s) => ({
        id: s.id!,
        user_id: w.user_id,
        workout_exercise_id: e.workoutExercise.id,
        set_number: s.set_number,
        reps: s.reps,
        weight: s.weight,
        duration_seconds: s.duration_seconds,
        is_warmup: s.is_warmup,
        completed_at: s.completed_at,
        note: s.note,
        e1rm: s.e1rm ?? null,
        rest_seconds: s.rest_seconds ?? null,
      }))
  );
  if (sets.length) {
    check(await supabase.from("sets").upsert(sets), "sets upsert");
  }

  // Legacy recovery only adds what the server is missing; normal pushes also
  // remove what was deleted on the phone.
  if (!rec.legacy) {
    let weCleanup = supabase.from("workout_exercises").delete().eq("workout_id", w.id);
    if (wes.length) weCleanup = weCleanup.not("id", "in", `(${wes.map((x) => x.id).join(",")})`);
    check(await weCleanup, "exercise cleanup");

    if (wes.length) {
      let setCleanup = supabase
        .from("sets")
        .delete()
        .in(
          "workout_exercise_id",
          wes.map((x) => x.id)
        );
      if (sets.length) setCleanup = setCleanup.not("id", "in", `(${sets.map((s) => s.id).join(",")})`);
      check(await setCleanup, "set cleanup");
    }
  }
  return true;
}

async function runRevoke(
  supabase: Supabase,
  rec: WorkoutRecord,
  op: Extract<PrOp, { kind: "revoke" }>
) {
  const restored = await revokeAndRecomputePRs({
    supabase,
    userId: rec.workout.user_id,
    exerciseId: op.exerciseId,
    equipment: op.equipment,
    gymId: op.gymId,
    removedSetIds: op.setIds,
  });
  await removePrOps(rec.workout.id, [op.id]);
  if (Object.keys(restored).length > 0) {
    await applyWorkoutPatch(rec.workout.id, { kind: "restored", restored });
  }
}

async function runDetect(
  supabase: Supabase,
  rec: WorkoutRecord,
  op: Extract<PrOp, { kind: "detect" }>
) {
  const ex = rec.exercises.find((e) => e.workoutExercise.id === op.weId);
  const set = ex?.sets.find((s) => s.id === op.setId);
  if (!ex || !set?.id || !set.completed_at || set.is_warmup) return;

  const common = {
    supabase,
    exerciseId: ex.definition.id,
    equipment: ex.definition.equipment,
    mode: ex.workoutExercise.mode,
    gymId: rec.workout.gym_id,
    workoutId: rec.workout.id,
    setId: set.id,
    userId: rec.workout.user_id,
    setData: set,
  };
  const detected = await detectPRs(common);
  if (detected.length > 0) {
    await savePRs({ ...common, detectedPRs: detected });
  }

  // The new PR supersedes those types on this exercise's other sets
  const types = detected.map((d) => d.prType);
  const supersededIds = ex.sets
    .filter((s) => s.id && s.id !== set.id && s.completed_at)
    .map((s) => s.id!);
  if (types.length > 0 && supersededIds.length > 0) {
    const clear: Database["public"]["Tables"]["sets"]["Update"] = {};
    for (const t of types) (clear as Record<string, boolean>)[PR_FLAG_MAP[t]] = false;
    softCheck(
      await supabase.from("sets").update(clear).in("id", supersededIds),
      "clear superseded flags"
    );
  }

  await applyWorkoutPatch(rec.workout.id, {
    kind: "detected",
    weId: ex.workoutExercise.id,
    setId: set.id,
    types,
  });
}

/** Full server-side delete, driven by what the server actually has. */
async function deleteWorkoutRemote(supabase: Supabase, rec: WorkoutRecord) {
  const w = rec.workout;
  const wes =
    check(
      await supabase
        .from("workout_exercises")
        .select("id, exercise_id")
        .eq("workout_id", w.id),
      "load exercises"
    ).data ?? [];

  if (wes.length) {
    const weIds = wes.map((x) => x.id);
    const sets =
      check(
        await supabase
          .from("sets")
          .select("id, workout_exercise_id")
          .in("workout_exercise_id", weIds),
        "load sets"
      ).data ?? [];
    const defs =
      check(
        await supabase
          .from("exercise_definitions")
          .select("id, equipment")
          .in("id", [...new Set(wes.map((x) => x.exercise_id))]),
        "load definitions"
      ).data ?? [];

    const equipment = new Map(defs.map((d) => [d.id, d.equipment]));
    const exerciseOf = new Map(wes.map((x) => [x.id, x.exercise_id]));
    const setsByExercise = new Map<string, string[]>();
    for (const s of sets) {
      const exId = exerciseOf.get(s.workout_exercise_id)!;
      setsByExercise.set(exId, [...(setsByExercise.get(exId) || []), s.id]);
    }
    // Revoke each exercise's PRs and restore whatever they had superseded
    for (const [exerciseId, setIds] of setsByExercise) {
      await revokeAndRecomputePRs({
        supabase,
        userId: w.user_id,
        exerciseId,
        equipment: equipment.get(exerciseId) ?? null,
        gymId: w.gym_id,
        removedSetIds: setIds,
      });
    }
    check(
      await supabase.from("sets").delete().in("workout_exercise_id", weIds),
      "delete sets"
    );
  }

  softCheck(
    await supabase.from("pr_snapshots").delete().eq("workout_id", w.id),
    "delete pr_snapshots"
  );
  softCheck(
    await supabase.from("personal_records").delete().eq("workout_id", w.id),
    "delete personal_records"
  );
  check(
    await supabase.from("workout_exercises").delete().eq("workout_id", w.id),
    "delete exercises"
  );
  check(await supabase.from("workouts").delete().eq("id", w.id), "delete workout");
}

/** Drop clean mirrors of workouts finished more than a week ago. */
async function pruneMirrors() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const r of await listWorkoutRecords()) {
    if (hasUnsyncedChanges(r) || r.syncError || !r.workout.finished_at) continue;
    if (r.savedAt < cutoff) await deleteWorkoutRecord(r.workout.id);
  }
}
