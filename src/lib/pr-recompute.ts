import { SupabaseClient } from "@supabase/supabase-js";
import { Database, Equipment, PrType } from "@/types/database.types";
import { getEquipmentScope } from "./pr-detection";
import { PR_FLAG_MAP } from "./pr-constants";

type SetsUpdate = Database["public"]["Tables"]["sets"]["Update"];

/**
 * Revoke PR contributions from the given sets, then restore each affected
 * pr_type's personal_record from the best remaining snapshot in history.
 *
 * Returns a map of setId -> PrTypes restored to that set, so callers can
 * update in-memory badge state for sets in the current workout.
 */
export async function revokeAndRecomputePRs(params: {
  supabase: SupabaseClient<Database>;
  userId: string;
  exerciseId: string;
  equipment: Equipment | null;
  gymId: string | null;
  removedSetIds: string[];
}): Promise<Record<string, PrType[]>> {
  const { supabase, userId, exerciseId, equipment, gymId, removedSetIds } = params;
  if (removedSetIds.length === 0) return {};

  const scope = getEquipmentScope(equipment);

  // 1. Revoke: remove snapshots and current-best records owned by these sets.
  //    Must happen before the sets themselves are deleted (FK is SET NULL).
  const { error: snapDelErr } = await supabase
    .from("pr_snapshots")
    .delete()
    .in("set_id", removedSetIds);
  if (snapDelErr) console.error("[PR] snapshot revoke failed:", snapDelErr.message);

  const { error: recDelErr } = await supabase
    .from("personal_records")
    .delete()
    .in("set_id", removedSetIds);
  if (recDelErr) console.error("[PR] record revoke failed:", recDelErr.message);

  // 2. Gather remaining history for this exercise at this scope.
  let query = supabase
    .from("pr_snapshots")
    .select("*")
    .eq("user_id", userId)
    .eq("exercise_id", exerciseId)
    .eq("pr_scope", scope)
    .not("set_id", "is", null);
  if (scope === "per_gym" && gymId) query = query.eq("gym_id", gymId);

  const { data: snaps, error: snapErr } = await query;
  if (snapErr) {
    console.error("[PR] snapshot query failed:", snapErr.message);
    return {};
  }

  // 3. Best remaining snapshot per pr_type (highest value; latest on tie).
  type Snap = NonNullable<typeof snaps>[number];
  const best = new Map<string, Snap>();
  for (const s of snaps || []) {
    const cur = best.get(s.pr_type);
    if (
      !cur ||
      s.value > cur.value ||
      (s.value === cur.value && s.achieved_at > cur.achieved_at)
    ) {
      best.set(s.pr_type, s);
    }
  }

  // 4. Restore records for pr_types whose current-best was revoked.
  const restored: Record<string, PrType[]> = {};
  for (const [prType, snap] of best) {
    let recQuery = supabase
      .from("personal_records")
      .select("id")
      .eq("user_id", userId)
      .eq("exercise_id", exerciseId)
      .eq("pr_type", prType)
      .eq("pr_scope", scope);
    if (scope === "per_gym" && gymId) recQuery = recQuery.eq("gym_id", gymId);

    const { data: existing } = await recQuery.limit(1);
    if (existing && existing.length > 0) continue; // record survived, nothing to do

    const { error: insErr } = await supabase.from("personal_records").insert({
      user_id: userId,
      exercise_id: exerciseId,
      pr_type: snap.pr_type,
      is_primary: snap.is_primary,
      value: snap.value,
      value_unit: snap.value_unit,
      previous_value: snap.previous_value,
      set_id: snap.set_id,
      workout_id: snap.workout_id,
      gym_id: snap.gym_id,
      pr_scope: snap.pr_scope,
      achieved_at: snap.achieved_at,
      context_json: snap.context_json,
    });
    if (insErr) {
      console.error("[PR] record restore failed:", insErr.message);
      continue;
    }

    // Re-flag the set that owns the restored record.
    if (snap.set_id) {
      const flag = PR_FLAG_MAP[prType as PrType];
      const update: SetsUpdate = {};
      (update as Record<string, boolean>)[flag] = true;
      await supabase.from("sets").update(update).eq("id", snap.set_id);
      (restored[snap.set_id] ||= []).push(prType as PrType);
    }
  }

  return restored;
}
