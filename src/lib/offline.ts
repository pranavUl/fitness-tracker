/**
 * On-device store. Every edit lands here first; the sync engine
 * (lib/sync.ts) pushes it to Supabase whenever a connection works.
 *
 *  - workout_cache: one mirror per workout (full state + sync bookkeeping)
 *  - outbox:        pending row writes for everything that isn't a workout
 *  - kv_cache:      read-through snapshots for screens and pickers
 */
import type {
  PrOp,
  Workout,
  WorkoutSnapshot,
} from "@/lib/workout-state";

const DB_NAME = "fitness-offline";
const DB_VERSION = 3;
const WORKOUT_STORE = "workout_cache";
const KV_STORE = "kv_cache";
const OUTBOX_STORE = "outbox";

/** Fired after any local write that the server hasn't seen yet. */
export const LOCAL_CHANGE_EVENT = "fitness:local-change";

function notifyLocalChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
  }
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
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WORKOUT_STORE)) {
        db.createObjectStore(WORKOUT_STORE);
      } else if (event.oldVersion < 3) {
        // Mirrors from before versioned sync may hold sets that never reached
        // the server (failed writes were silently dropped). Flag them for a
        // one-time, upsert-only recovery push.
        const store = req.transaction!.objectStore(WORKOUT_STORE);
        store.openCursor().onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>)
            .result;
          if (!cursor) return;
          const rec = cursor.value;
          if (rec && rec.workout && rec.version === undefined) {
            cursor.update({
              ...rec,
              version: 1,
              syncedVersion: 0,
              prOps: [],
              legacy: true,
            });
          }
          cursor.continue();
        };
      }
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE);
      }
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function getOne<T>(storeName: string, key: string): Promise<T | null> {
  try {
    const db = await openDB();
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    return await new Promise((resolve) => {
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function getAll<T>(storeName: string): Promise<T[]> {
  try {
    const db = await openDB();
    const req = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    return await new Promise((resolve) => {
      req.onsuccess = () => resolve((req.result as T[]) ?? []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

/**
 * Atomic read-modify-write of one key. `fn` returns the new value, null to
 * delete, or undefined to leave it untouched.
 */
async function modify<T>(
  storeName: string,
  key: string,
  fn: (old: T | undefined) => T | null | undefined
): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const next = fn(getReq.result as T | undefined);
      if (next === null) store.delete(key);
      else if (next !== undefined) store.put(next, key);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---- Workout mirrors ----

export interface WorkoutRecord extends WorkoutSnapshot {
  savedAt: number;
  /** Bumps on every local edit. */
  version: number;
  /** Highest version confirmed on the server. */
  syncedVersion: number;
  prOps: PrOp[];
  /** Tombstone: delete on the server, then drop the mirror. */
  deleted?: boolean;
  /** Pre-versioning mirror awaiting its one-time recovery push. */
  legacy?: boolean;
  /** Last error the server rejected this workout with (not a network error). */
  syncError?: string;
}

/** Kept for existing imports. */
export type CachedWorkout = WorkoutRecord;

function normalize(rec: WorkoutRecord): WorkoutRecord {
  return {
    ...rec,
    exercises: rec.exercises ?? [],
    prs: rec.prs ?? {},
    version: rec.version ?? 0,
    syncedVersion: rec.syncedVersion ?? 0,
    prOps: rec.prOps ?? [],
  };
}

/** True when the mirror holds anything the server hasn't confirmed. */
export function hasUnsyncedChanges(rec: WorkoutRecord): boolean {
  return (
    !!rec.deleted ||
    !!rec.legacy ||
    rec.version > rec.syncedVersion ||
    rec.prOps.length > 0
  );
}

function addPrOp(ops: PrOp[], op: PrOp): PrOp[] {
  if (op.kind === "detect") {
    return [
      ...ops.filter((o) => !(o.kind === "detect" && o.setId === op.setId)),
      op,
    ];
  }
  // A revoke makes pending detects for the same sets moot, and an earlier
  // pending revoke already covers any set it lists.
  const covered = new Set(
    ops.flatMap((o) => (o.kind === "revoke" ? o.setIds : []))
  );
  const kept = ops.filter(
    (o) => !(o.kind === "detect" && op.setIds.includes(o.setId))
  );
  const setIds = op.setIds.filter((id) => !covered.has(id));
  return setIds.length ? [...kept, { ...op, setIds }] : kept;
}

/**
 * Persist the full workout state. `dirty` marks it for upload; PR ops are
 * written in the same transaction so the engine never sees one without
 * the edit that caused it.
 */
export async function saveWorkoutLocal(
  workoutId: string,
  snap: WorkoutSnapshot,
  opts: { dirty: boolean; prOps?: PrOp[]; deleted?: boolean }
): Promise<void> {
  try {
    await modify<WorkoutRecord>(WORKOUT_STORE, workoutId, (raw) => {
      const old = raw ? normalize(raw) : undefined;
      let prOps = old?.prOps ?? [];
      for (const op of opts.prOps ?? []) prOps = addPrOp(prOps, op);
      return {
        ...snap,
        savedAt: Date.now(),
        version: (old?.version ?? 0) + (opts.dirty ? 1 : 0),
        syncedVersion: old?.syncedVersion ?? 0,
        prOps,
        deleted: opts.deleted ?? old?.deleted ?? false,
        legacy: old?.legacy,
        syncError: old?.syncError,
      };
    });
    if (opts.dirty || opts.prOps?.length || opts.deleted) notifyLocalChange();
  } catch (err) {
    console.error("[offline] save failed:", err);
  }
}

export async function loadCachedWorkout(
  workoutId: string
): Promise<WorkoutRecord | null> {
  const rec = await getOne<WorkoutRecord>(WORKOUT_STORE, workoutId);
  return rec?.workout ? normalize(rec) : null;
}

export async function listWorkoutRecords(): Promise<WorkoutRecord[]> {
  const all = await getAll<WorkoutRecord>(WORKOUT_STORE);
  return all.filter((r) => r?.workout).map(normalize);
}

/** Engine-side edits (sync bookkeeping, PR results) that must not bump the version. */
export async function updateWorkoutRecord(
  workoutId: string,
  fn: (rec: WorkoutRecord) => WorkoutRecord | null | undefined
): Promise<void> {
  try {
    await modify<WorkoutRecord>(WORKOUT_STORE, workoutId, (raw) =>
      raw?.workout ? fn(normalize(raw)) : undefined
    );
  } catch (err) {
    console.error("[offline] update failed:", err);
  }
}

/** Queue a workout for deletion on the server (works for never-opened workouts too). */
export async function markWorkoutDeleted(workout: Workout): Promise<void> {
  try {
    await modify<WorkoutRecord>(WORKOUT_STORE, workout.id, (raw) => {
      const old = raw?.workout ? normalize(raw) : undefined;
      return {
        workout: old?.workout ?? workout,
        exercises: old?.exercises ?? [],
        prs: old?.prs ?? {},
        savedAt: Date.now(),
        version: (old?.version ?? 0) + 1,
        syncedVersion: old?.syncedVersion ?? 0,
        prOps: [],
        deleted: true,
      };
    });
    notifyLocalChange();
  } catch (err) {
    console.error("[offline] delete failed:", err);
  }
}

export async function deleteWorkoutRecord(workoutId: string): Promise<void> {
  try {
    await modify(WORKOUT_STORE, workoutId, () => null);
  } catch {}
}

/**
 * The in-progress workout on this device. Legacy mirrors only count if the
 * old active-workout pointer still names them.
 */
export async function getActiveLocalWorkout(): Promise<Workout | null> {
  let pointer: string | null = null;
  try {
    pointer = localStorage.getItem("active_workout_id");
  } catch {}
  const records = await listWorkoutRecords();
  const active = records
    .filter(
      (r) =>
        !r.deleted &&
        !r.workout.finished_at &&
        (!r.legacy || r.workout.id === pointer)
    )
    .sort((a, b) => b.workout.started_at.localeCompare(a.workout.started_at));
  return active[0]?.workout ?? null;
}

// ---- Generic key-value cache (stale-while-revalidate page data) ----

export async function kvGet<T>(key: string): Promise<T | null> {
  return getOne<T>(KV_STORE, key);
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    await modify(KV_STORE, key, () => value);
  } catch {}
}

// ---- Outbox: pending writes for non-workout rows ----

export type OutboxTable =
  | "gyms"
  | "exercise_pools"
  | "exercise_definitions"
  | "daily_tracking"
  | "intake_log"
  | "run_sessions"
  | "workouts";

export interface OutboxEntry {
  key: string;
  /** Kept across merges so a parent row always syncs before its children. */
  seq: number;
  table: OutboxTable;
  op: "upsert" | "update" | "delete";
  id: string;
  row?: Record<string, unknown>;
  onConflict?: string;
  /** Bumps on every merge so the engine can tell if a row changed mid-flight. */
  rev: number;
  attempts: number;
  failed?: boolean;
  error?: string;
}

let lastSeq = 0;
function nextSeq() {
  lastSeq = Math.max(Date.now(), lastSeq + 1);
  return lastSeq;
}

/**
 * Insert-or-merge a row. `key` overrides the identity for tables upserted
 * on a natural key (daily_tracking is one row per date).
 */
export async function queueUpsert(
  table: OutboxTable,
  row: Record<string, unknown>,
  opts?: { onConflict?: string; key?: string }
): Promise<void> {
  const id = opts?.key ?? (row.id as string);
  const key = `${table}:${id}`;
  try {
    await modify<OutboxEntry>(OUTBOX_STORE, key, (old) => {
      if (old && old.op !== "delete") {
        return {
          ...old,
          op: "upsert",
          row: { ...old.row, ...row },
          onConflict: opts?.onConflict ?? old.onConflict,
          rev: old.rev + 1,
          failed: false,
          error: undefined,
        };
      }
      return {
        key,
        seq: nextSeq(),
        table,
        op: "upsert",
        id,
        row,
        onConflict: opts?.onConflict,
        rev: (old?.rev ?? 0) + 1,
        attempts: 0,
      };
    });
    notifyLocalChange();
  } catch (err) {
    console.error("[offline] queue upsert failed:", err);
  }
}

export async function queueUpdate(
  table: OutboxTable,
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  const key = `${table}:${id}`;
  try {
    await modify<OutboxEntry>(OUTBOX_STORE, key, (old) => {
      if (old?.op === "delete") return undefined;
      if (old) {
        return {
          ...old,
          row: { ...old.row, ...patch },
          rev: old.rev + 1,
          failed: false,
          error: undefined,
        };
      }
      return {
        key,
        seq: nextSeq(),
        table,
        op: "update",
        id,
        row: patch,
        rev: 1,
        attempts: 0,
      };
    });
    notifyLocalChange();
  } catch (err) {
    console.error("[offline] queue update failed:", err);
  }
}

export async function queueDelete(table: OutboxTable, id: string): Promise<void> {
  const key = `${table}:${id}`;
  try {
    await modify<OutboxEntry>(OUTBOX_STORE, key, (old) => ({
      key,
      seq: nextSeq(),
      table,
      op: "delete",
      id,
      rev: (old?.rev ?? 0) + 1,
      attempts: 0,
    }));
    notifyLocalChange();
  } catch (err) {
    console.error("[offline] queue delete failed:", err);
  }
}

export async function listOutbox(): Promise<OutboxEntry[]> {
  return getAll<OutboxEntry>(OUTBOX_STORE);
}

/** The unsynced write queued for this row, if any. */
export async function getPendingRow(
  table: OutboxTable,
  id: string
): Promise<Record<string, unknown> | null> {
  const e = await getOne<OutboxEntry>(OUTBOX_STORE, `${table}:${id}`);
  return e && e.op !== "delete" ? (e.row ?? null) : null;
}

/** Drop a synced entry — unless it was edited again while in flight. */
export async function completeOutboxEntry(key: string, rev: number): Promise<void> {
  try {
    await modify<OutboxEntry>(OUTBOX_STORE, key, (old) =>
      old && old.rev === rev ? null : undefined
    );
  } catch {}
}

export async function recordOutboxFailure(
  key: string,
  rev: number,
  error: string,
  permanent: boolean
): Promise<void> {
  try {
    await modify<OutboxEntry>(OUTBOX_STORE, key, (old) => {
      if (!old || old.rev !== rev) return undefined;
      const attempts = old.attempts + 1;
      return {
        ...old,
        attempts,
        error,
        failed: permanent || attempts >= 25,
      };
    });
  } catch {}
}

/** Give previously failed entries another chance (called once per app start). */
export async function resetOutboxFailures(): Promise<void> {
  const entries = await listOutbox();
  for (const e of entries.filter((e) => e.failed)) {
    try {
      await modify<OutboxEntry>(OUTBOX_STORE, e.key, (old) =>
        old ? { ...old, failed: false, attempts: 0 } : undefined
      );
    } catch {}
  }
}

/**
 * Overlay not-yet-synced local writes onto rows fetched from the server,
 * so a background refresh never hides something created offline.
 */
export async function mergePendingRows<T extends { id: string }>(
  table: OutboxTable,
  rows: T[]
): Promise<T[]> {
  const pending = (await listOutbox())
    .filter((e) => e.table === table)
    .sort((a, b) => a.seq - b.seq);
  if (pending.length === 0) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const e of pending) {
    if (e.op === "delete") byId.delete(e.id);
    else if (e.op === "upsert") byId.set(e.id, { ...byId.get(e.id), ...e.row } as T);
    else if (byId.has(e.id)) byId.set(e.id, { ...byId.get(e.id)!, ...e.row });
  }
  return [...byId.values()];
}
