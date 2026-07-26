import { SupabaseClient } from "@supabase/supabase-js";
import {
  Database,
  Equipment,
  TrackingMode,
  PrType,
  PrScope,
} from "@/types/database.types";
import { SetData } from "@/components/workout/set-row";
import { PR_FLAG_MAP } from "./pr-constants";

export interface DetectedPR {
  prType: PrType;
  isPrimary: boolean;
  value: number;
  previousValue: number | null;
  valueUnit: string;
}

interface PrCheckParams {
  supabase: SupabaseClient<Database>;
  setData: SetData;
  exerciseId: string;
  equipment: Equipment | null;
  mode: TrackingMode;
  gymId: string | null;
  workoutId: string;
  setId: string;
  userId: string;
}

export function getEquipmentScope(equipment: Equipment | null): PrScope {
  switch (equipment) {
    case "cable":
    case "machine":
    case "smith_machine":
    case "other":
      return "per_gym";
    default:
      return "global";
  }
}

export function computeE1rm(
  weight: number,
  reps: number
): number | null {
  if (reps <= 0 || weight <= 0) return null;
  if (reps === 1) return weight;
  if (reps > 10) return null;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

export function getApplicablePrTypes(
  mode: TrackingMode
): { type: PrType; isPrimary: boolean }[] {
  switch (mode) {
    case "reps_weight":
      return [
        { type: "1RM", isPrimary: true },
        { type: "WEIGHT", isPrimary: false },
        { type: "VOL", isPrimary: false },
      ];
    case "reps_only":
      return [{ type: "REPS", isPrimary: true }];
    case "time_only":
      return [{ type: "DURATION", isPrimary: true }];
    case "time_weight":
      return [
        { type: "WEIGHT", isPrimary: true },
        { type: "DURATION", isPrimary: false },
      ];
    case "reps_assisted":
      return [
        { type: "WEIGHT", isPrimary: true },
        { type: "REPS", isPrimary: false },
      ];
    case "presence":
      return [];
    default:
      return [];
  }
}

function computePrValue(
  prType: PrType,
  set: SetData,
  mode: TrackingMode
): number | null {
  switch (prType) {
    case "WEIGHT":
      if (set.weight == null) return null;
      if (mode === "reps_assisted") return -set.weight;
      return set.weight;
    case "1RM":
      if (set.weight == null || set.reps == null) return null;
      return computeE1rm(set.weight, set.reps);
    case "VOL":
      if (set.weight == null || set.reps == null) return null;
      if (set.weight <= 0 || set.reps <= 0) return null;
      return set.weight * set.reps;
    case "REPS":
      return set.reps;
    case "DURATION":
      return set.duration_seconds;
    default:
      return null;
  }
}

function getValueUnit(prType: PrType, mode: TrackingMode): string {
  switch (prType) {
    case "WEIGHT":
      return "lb";
    case "1RM":
      return "lb";
    case "VOL":
      return "lb";
    case "REPS":
      return "reps";
    case "DURATION":
      return "sec";
    default:
      return "";
  }
}

export async function detectPRs(
  params: PrCheckParams
): Promise<DetectedPR[]> {
  const { supabase, setData, exerciseId, equipment, mode, gymId, userId } =
    params;

  if (setData.is_warmup) return [];

  const scope = getEquipmentScope(equipment);
  const applicableTypes = getApplicablePrTypes(mode);
  if (applicableTypes.length === 0) return [];

  let query = supabase
    .from("personal_records")
    .select("pr_type, value, pr_scope, gym_id")
    .eq("user_id", userId)
    .eq("exercise_id", exerciseId);

  if (scope === "per_gym" && gymId) {
    query = query.eq("gym_id", gymId).eq("pr_scope", "per_gym");
  } else {
    query = query.eq("pr_scope", "global");
  }

  const { data: currentPRs, error: prError } = await query;
  if (prError) {
    throw new Error(`personal_records query: ${prError.message}`);
  }
  const prMap = new Map<string, number>();
  if (currentPRs) {
    for (const pr of currentPRs) {
      prMap.set(pr.pr_type, pr.value);
    }
  }

  const detected: DetectedPR[] = [];

  for (const { type, isPrimary } of applicableTypes) {
    const newValue = computePrValue(type, setData, mode);
    if (newValue == null) continue;

    const currentBest = prMap.get(type);

    if (currentBest == null || newValue > currentBest) {
      detected.push({
        prType: type,
        isPrimary: isPrimary,
        value: newValue,
        previousValue: currentBest ?? null,
        valueUnit: getValueUnit(type, mode),
      });
    }
  }

  return detected;
}

export async function savePRs(params: {
  supabase: SupabaseClient<Database>;
  detectedPRs: DetectedPR[];
  exerciseId: string;
  equipment: Equipment | null;
  setId: string;
  workoutId: string;
  gymId: string | null;
  userId: string;
  setData: SetData;
  mode: TrackingMode;
}): Promise<void> {
  const {
    supabase,
    detectedPRs,
    exerciseId,
    equipment,
    setId,
    workoutId,
    gymId,
    userId,
    setData,
    mode,
  } = params;

  if (detectedPRs.length === 0) return;

  const scope = getEquipmentScope(equipment);
  const now = new Date().toISOString();

  const flagUpdates: Record<string, boolean> = {};
  for (const pr of detectedPRs) {
    const flag = PR_FLAG_MAP[pr.prType];
    if (flag) flagUpdates[flag] = true;
  }

  const e1rm =
    mode === "reps_weight" && setData.weight && setData.reps
      ? computeE1rm(setData.weight, setData.reps)
      : null;

  const { error: setUpdateErr } = await supabase
    .from("sets")
    .update({ ...flagUpdates, e1rm })
    .eq("id", setId);
  if (setUpdateErr) {
    console.error("[PR] sets update failed:", setUpdateErr.message);
  }

  const contextJson = {
    weight: setData.weight,
    reps: setData.reps,
    duration_seconds: setData.duration_seconds,
    e1rm,
    set_number: setData.set_number,
  };

  for (const pr of detectedPRs) {
    const displayValue =
      pr.prType === "WEIGHT" && mode === "reps_assisted"
        ? Math.abs(pr.value)
        : pr.value;
    const displayPrevious =
      pr.previousValue != null && pr.prType === "WEIGHT" && mode === "reps_assisted"
        ? Math.abs(pr.previousValue)
        : pr.previousValue;

    const recordData = {
      pr_type: pr.prType,
      is_primary: pr.isPrimary,
      value: pr.value,
      value_unit: pr.valueUnit,
      previous_value: pr.previousValue,
      set_id: setId,
      workout_id: workoutId,
      gym_id: scope === "per_gym" ? gymId : null,
      pr_scope: scope,
      achieved_at: now,
      context_json: {
        ...contextJson,
        display_value: displayValue,
        display_previous: displayPrevious,
      },
    };

    // Find existing PR record for this exercise+type+scope
    let existingQuery = supabase
      .from("personal_records")
      .select("id")
      .eq("user_id", userId)
      .eq("exercise_id", exerciseId)
      .eq("pr_type", pr.prType)
      .eq("pr_scope", scope);

    if (scope === "per_gym" && gymId) {
      existingQuery = existingQuery.eq("gym_id", gymId);
    }

    const { data: existing, error: lookupErr } = await existingQuery.limit(1);
    if (lookupErr) {
      console.error("[PR] lookup failed:", lookupErr.message);
      continue;
    }

    if (existing && existing.length > 0) {
      const { error: updateErr } = await supabase
        .from("personal_records")
        .update(recordData)
        .eq("id", existing[0].id);
      if (updateErr) console.error("[PR] update personal_records failed:", updateErr.message);
    } else {
      const { error: insertErr } = await supabase.from("personal_records").insert({
        user_id: userId,
        exercise_id: exerciseId,
        ...recordData,
      });
      if (insertErr) console.error("[PR] insert personal_records failed:", insertErr.message);
    }

    const { error: snapErr } = await supabase.from("pr_snapshots").insert({
      user_id: userId,
      exercise_id: exerciseId,
      ...recordData,
    });
    if (snapErr) console.error("[PR] insert pr_snapshots failed:", snapErr.message);
  }
}
