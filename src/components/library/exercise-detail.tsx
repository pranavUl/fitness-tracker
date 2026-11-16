"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { queueDelete, queueUpdate } from "@/lib/offline";
import { putCachedRow, removeCachedRow } from "@/lib/reference-data";
import { Database, TrackingMode, Equipment } from "@/types/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from "@/components/ui/drawer";
import { ArrowLeft, Pencil, Trash2, MapPin } from "lucide-react";

type Exercise = Database["public"]["Tables"]["exercise_definitions"]["Row"];
type Pool = Database["public"]["Tables"]["exercise_pools"]["Row"];

const MODE_LABELS: Record<TrackingMode, string> = {
  reps_weight: "Reps + Weight",
  time_weight: "Time + Weight",
  time_only: "Time",
  reps_only: "Reps",
  reps_assisted: "Assisted",
  presence: "Presence",
};

const EQUIPMENT_LABELS: Record<Equipment, string> = {
  barbell: "Barbell",
  dumbbell: "Dumbbell",
  cable: "Cable",
  machine: "Machine",
  smith_machine: "Smith Machine",
  bodyweight: "Bodyweight",
  band: "Band",
  kettlebell: "Kettlebell",
  plate: "Plate",
  other: "Other",
};

interface HistoryEntry {
  gym_name: string;
  date: string;
  sets: {
    set_number: number;
    reps: number | null;
    weight: number | null;
    duration_seconds: number | null;
    is_warmup: boolean;
  }[];
}

function formatSetValue(
  mode: TrackingMode,
  set: { reps: number | null; weight: number | null; duration_seconds: number | null }
): string {
  switch (mode) {
    case "reps_weight":
      return `${set.weight ?? 0}lb × ${set.reps ?? 0}`;
    case "time_weight":
      return `${set.weight ?? 0}lb × ${set.duration_seconds ?? 0}s`;
    case "time_only":
      return `${set.duration_seconds ?? 0}s`;
    case "reps_only":
    case "reps_assisted":
      return `${set.reps ?? 0} reps`;
    case "presence":
      return "done";
  }
}

interface ExerciseDetailProps {
  exercise: Exercise;
  pools: Pool[];
  onBack: () => void;
}

export function ExerciseDetail({
  exercise: initialExercise,
  pools,
  onBack,
}: ExerciseDetailProps) {
  const [exercise, setExercise] = useState(initialExercise);
  const [editOpen, setEditOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const [name, setName] = useState(exercise.name);
  const [poolId, setPoolId] = useState(exercise.pool_id);
  const [editEquipment, setEditEquipment] = useState<Equipment | null>(exercise.equipment);
  const [editModes, setEditModes] = useState<TrackingMode[]>(exercise.supports_modes);
  const [editDefaultMode, setEditDefaultMode] = useState<TrackingMode>(exercise.default_mode);
  const [notes, setNotes] = useState(exercise.notes || "");
  const [saving, setSaving] = useState(false);

  const supabase = createClient();

  useEffect(() => {
    async function loadHistory() {
      setHistoryLoading(true);

      const { data: wes } = await supabase
        .from("workout_exercises")
        .select("id, workout_id")
        .eq("exercise_id", exercise.id)
        .order("created_at", { ascending: false })
        .limit(10);

      if (!wes?.length) {
        setHistory([]);
        setHistoryLoading(false);
        return;
      }

      const workoutIds = [...new Set(wes.map((we) => we.workout_id))];
      const weIds = wes.map((we) => we.id);

      const [workoutsRes, setsRes, gymsRes] = await Promise.all([
        supabase
          .from("workouts")
          .select("id, gym_id, started_at, finished_at")
          .in("id", workoutIds)
          .not("finished_at", "is", null),
        supabase
          .from("sets")
          .select("*")
          .in("workout_exercise_id", weIds)
          .order("set_number"),
        supabase.from("gyms").select("id, name"),
      ]);

      const gymMap = new Map(
        (gymsRes.data || []).map((g) => [g.id, g.name])
      );
      const workoutMap = new Map(
        (workoutsRes.data || []).map((w) => [w.id, w])
      );

      const setsByWe = new Map<
        string,
        Database["public"]["Tables"]["sets"]["Row"][]
      >();
      for (const s of setsRes.data || []) {
        const arr = setsByWe.get(s.workout_exercise_id) || [];
        arr.push(s);
        setsByWe.set(s.workout_exercise_id, arr);
      }

      const entries: HistoryEntry[] = [];
      for (const we of wes) {
        const workout = workoutMap.get(we.workout_id);
        if (!workout) continue;
        entries.push({
          gym_name: workout.gym_id
            ? gymMap.get(workout.gym_id) || "Unknown"
            : "No gym",
          date: workout.started_at,
          sets: (setsByWe.get(we.id) || []).map((s) => ({
            set_number: s.set_number,
            reps: s.reps,
            weight: s.weight,
            duration_seconds: s.duration_seconds,
            is_warmup: s.is_warmup,
          })),
        });
      }

      setHistory(entries);
      setHistoryLoading(false);
    }

    loadHistory();
  }, [exercise.id, supabase]);

  function toggleEditMode(mode: TrackingMode) {
    setEditModes((prev) => {
      if (prev.includes(mode)) {
        if (prev.length === 1) return prev;
        const next = prev.filter((m) => m !== mode);
        if (editDefaultMode === mode) setEditDefaultMode(next[0]);
        return next;
      }
      return [...prev, mode];
    });
  }

  async function handleUpdate() {
    setSaving(true);
    const patch = {
      name,
      pool_id: poolId,
      equipment: editEquipment,
      supports_modes: editModes,
      default_mode: editDefaultMode,
      notes: notes || null,
    };
    await queueUpdate("exercise_definitions", exercise.id, patch);
    const updated = { ...exercise, ...patch };
    await putCachedRow("exercises", updated);
    setExercise(updated);
    setSaving(false);
    setEditOpen(false);
  }

  async function handleDelete() {
    await queueDelete("exercise_definitions", exercise.id);
    await removeCachedRow("exercises", exercise.id);
    onBack();
  }

  const poolName = pools.find((p) => p.id === exercise.pool_id)?.name;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="h-10 w-10"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold truncate">{exercise.name}</h2>
          <div className="flex items-center gap-2 mt-0.5">
            {poolName && (
              <span className="text-sm text-muted-foreground">{poolName}</span>
            )}
            {exercise.equipment && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-sm text-muted-foreground">
                  {EQUIPMENT_LABELS[exercise.equipment] || exercise.equipment}
                </span>
              </>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            setName(exercise.name);
            setPoolId(exercise.pool_id);
            setEditEquipment(exercise.equipment);
            setEditModes(exercise.supports_modes);
            setEditDefaultMode(exercise.default_mode);
            setNotes(exercise.notes || "");
            setEditOpen(true);
          }}
          className="h-10 w-10"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleDelete}
          className="h-10 w-10 text-destructive hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Modes */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          Tracking Modes
        </h3>
        <div className="flex flex-wrap gap-2">
          {exercise.supports_modes.map((mode) => (
            <Badge
              key={mode}
              variant={mode === exercise.default_mode ? "default" : "secondary"}
            >
              {MODE_LABELS[mode]}
              {mode === exercise.default_mode && " (default)"}
            </Badge>
          ))}
        </div>
      </div>

      {/* Notes */}
      {exercise.notes && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">Notes</h3>
          <p className="rounded-xl border border-border bg-card p-3 text-sm whitespace-pre-wrap">
            {exercise.notes}
          </p>
        </div>
      )}

      {/* Recent History by Gym */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          Recent History
        </h3>
        {historyLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-xl bg-muted"
              />
            ))}
          </div>
        ) : history.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center">
            <p className="text-xs text-muted-foreground">
              No workout history yet for this exercise.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {history.map((entry, i) => (
              <div
                key={i}
                className="rounded-xl border border-border bg-card p-3 space-y-1.5"
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <MapPin className="h-3 w-3" />
                  <span>{entry.gym_name}</span>
                  <span>·</span>
                  <span>
                    {new Date(entry.date).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>
                <div className="space-y-0.5">
                  {entry.sets.map((set, j) => (
                    <div
                      key={j}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span className="w-4 text-xs text-muted-foreground text-center">
                        {set.is_warmup ? "W" : set.set_number}
                      </span>
                      <span>
                        {formatSetValue(exercise.default_mode, set)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit Drawer */}
      <Drawer open={editOpen} onOpenChange={setEditOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Edit Exercise</DrawerTitle>
          </DrawerHeader>
          <div className="space-y-4 px-4 max-h-[60vh] overflow-y-auto">
            <Input
              placeholder="Exercise name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-12"
            />
            <div className="space-y-2">
              <label className="text-sm font-medium">Category</label>
              <div className="flex flex-wrap gap-2">
                {pools.map((pool) => (
                  <button
                    key={pool.id}
                    onClick={() => setPoolId(pool.id)}
                    className={`rounded-full px-3 py-1.5 text-sm border transition-colors ${
                      poolId === pool.id
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card hover:bg-accent"
                    }`}
                  >
                    {pool.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Equipment</label>
              <div className="flex flex-wrap gap-2">
                {(Object.entries(EQUIPMENT_LABELS) as [Equipment, string][]).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setEditEquipment(value)}
                    className={`rounded-full px-3 py-1.5 text-sm border transition-colors ${
                      editEquipment === value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card hover:bg-accent"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Tracking Modes</label>
              <div className="flex flex-wrap gap-2">
                {(Object.entries(MODE_LABELS) as [TrackingMode, string][]).map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => toggleEditMode(mode)}
                    className={`rounded-full px-3 py-1.5 text-sm border transition-colors ${
                      editModes.includes(mode)
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card hover:bg-accent"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {editModes.length > 1 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Default Mode</label>
                <div className="flex flex-wrap gap-2">
                  {editModes.map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setEditDefaultMode(mode)}
                      className={`rounded-full px-3 py-1.5 text-sm border transition-colors ${
                        editDefaultMode === mode
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-card hover:bg-accent"
                      }`}
                    >
                      {MODE_LABELS[mode]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Textarea
              placeholder="Notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
          <DrawerFooter>
            <Button
              onClick={handleUpdate}
              disabled={!name.trim() || !poolId || saving}
              className="h-12"
            >
              {saving ? "Saving..." : "Update"}
            </Button>
            <DrawerClose asChild>
              <Button variant="outline" className="h-12">
                Cancel
              </Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
