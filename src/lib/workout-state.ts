import { Database, Equipment, PrType } from "@/types/database.types";
import type { SetData } from "@/components/workout/set-row";
import { PR_FLAG_MAP } from "@/lib/pr-constants";

export type Workout = Database["public"]["Tables"]["workouts"]["Row"];
export type WorkoutExercise =
  Database["public"]["Tables"]["workout_exercises"]["Row"];
export type ExerciseDefinition =
  Database["public"]["Tables"]["exercise_definitions"]["Row"];

export interface PreviousSession {
  workoutId?: string;
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

export interface WorkoutSnapshot {
  workout: Workout;
  exercises: WorkoutExerciseState[];
  prs: Record<string, PrType[]>;
}

/**
 * PR work that needs the server (it compares against all-time history).
 * Queued with the local edit that caused it and run by the sync engine,
 * so PRs logged with no signal are still evaluated once it comes back.
 */
export type PrOp =
  | { id: string; kind: "detect"; setId: string; weId: string }
  | {
      id: string;
      kind: "revoke";
      setIds: string[];
      exerciseId: string;
      equipment: Equipment | null;
      gymId: string | null;
    };

export type PrPatch =
  | { kind: "detected"; weId: string; setId: string; types: PrType[] }
  | { kind: "restored"; restored: Record<string, PrType[]> };

type PrState = Pick<WorkoutSnapshot, "exercises" | "prs">;

function withFlags(set: SetData, types: PrType[], value: boolean): SetData {
  const next = { ...set } as SetData & Record<string, unknown>;
  for (const t of types) next[PR_FLAG_MAP[t]] = value;
  return next;
}

const ALL_PR_TYPES = Object.keys(PR_FLAG_MAP) as PrType[];

/**
 * A set's PR badges are exactly what detection just found (possibly none,
 * after an edit), and those types are stripped from its siblings.
 */
function applyDetected(
  state: PrState,
  weId: string,
  setId: string,
  types: PrType[]
): PrState {
  const ex = state.exercises.find((e) => e.workoutExercise.id === weId);
  if (!ex) return state;
  const prs = { ...state.prs };
  if (types.length > 0) prs[setId] = types;
  else delete prs[setId];
  for (const s of ex.sets) {
    if (!s.id || s.id === setId || !prs[s.id]) continue;
    const remaining = prs[s.id].filter((t) => !types.includes(t));
    if (remaining.length === 0) delete prs[s.id];
    else prs[s.id] = remaining;
  }
  const exercises = state.exercises.map((e) =>
    e.workoutExercise.id !== weId
      ? e
      : {
          ...e,
          sets: e.sets.map((s) =>
            s.id === setId
              ? withFlags(
                  withFlags(s, ALL_PR_TYPES, false),
                  types,
                  true
                )
              : s.completed_at
                ? withFlags(s, types, false)
                : s
          ),
        }
  );
  return { exercises, prs };
}

/** Re-badge sets whose PR came back after a newer one was revoked. */
function applyRestored(
  state: PrState,
  restored: Record<string, PrType[]>
): PrState {
  if (Object.keys(restored).length === 0) return state;
  const prs = { ...state.prs };
  for (const [sid, types] of Object.entries(restored)) {
    prs[sid] = [...new Set([...(prs[sid] || []), ...types])];
  }
  const exercises = state.exercises.map((e) => ({
    ...e,
    sets: e.sets.map((s) =>
      s.id && restored[s.id] ? withFlags(s, restored[s.id], true) : s
    ),
  }));
  return { exercises, prs };
}

export function applyPrPatch(state: PrState, patch: PrPatch): PrState {
  return patch.kind === "detected"
    ? applyDetected(state, patch.weId, patch.setId, patch.types)
    : applyRestored(state, patch.restored);
}

export function setPrTypes(s: {
  is_pr_weight?: boolean;
  is_pr_1rm?: boolean;
  is_pr_volume?: boolean;
  is_pr_reps?: boolean;
  is_pr_duration?: boolean;
}): PrType[] {
  const types: PrType[] = [];
  if (s.is_pr_weight) types.push("WEIGHT");
  if (s.is_pr_1rm) types.push("1RM");
  if (s.is_pr_volume) types.push("VOL");
  if (s.is_pr_reps) types.push("REPS");
  if (s.is_pr_duration) types.push("DURATION");
  return types;
}
