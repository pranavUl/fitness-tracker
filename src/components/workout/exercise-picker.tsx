"use client";

import { useState, useEffect } from "react";
import { createClient, getUserId } from "@/lib/supabase/client";
import { Database, Equipment, TrackingMode } from "@/types/database.types";
import { queueUpsert } from "@/lib/offline";
import {
  getCachedExercises,
  getCachedPools,
  putCachedRow,
  refreshLibrary,
} from "@/lib/reference-data";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from "@/components/ui/drawer";
import { Search, Dumbbell, Plus, ArrowLeft } from "lucide-react";

type Exercise = Database["public"]["Tables"]["exercise_definitions"]["Row"];
type Pool = Database["public"]["Tables"]["exercise_pools"]["Row"];

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

const EQUIPMENT_OPTIONS: { value: Equipment; label: string }[] = [
  { value: "barbell", label: "Barbell" },
  { value: "dumbbell", label: "Dumbbell" },
  { value: "machine", label: "Machine" },
  { value: "cable", label: "Cable" },
  { value: "smith_machine", label: "Smith Machine" },
  { value: "bodyweight", label: "Bodyweight" },
  { value: "kettlebell", label: "Kettlebell" },
  { value: "band", label: "Band" },
  { value: "plate", label: "Plate" },
  { value: "other", label: "Other" },
];

const MODE_LABELS: Record<TrackingMode, string> = {
  reps_weight: "Reps + Weight",
  time_weight: "Time + Weight",
  time_only: "Time",
  reps_only: "Reps",
  reps_assisted: "Assisted",
  presence: "Presence",
};

const MODE_OPTIONS: TrackingMode[] = [
  "reps_weight",
  "time_weight",
  "time_only",
  "reps_only",
  "reps_assisted",
  "presence",
];

interface ExercisePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (exercise: Exercise) => void;
  excludeIds?: string[];
}

export function ExercisePicker({
  open,
  onOpenChange,
  onSelect,
  excludeIds = [],
}: ExercisePickerProps) {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  // Create form state
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEquipment, setNewEquipment] = useState<Equipment | null>(null);
  const [newPoolId, setNewPoolId] = useState<string | null>(null);
  const [supportsModes, setSupportsModes] = useState<TrackingMode[]>(["reps_weight"]);
  const [defaultMode, setDefaultMode] = useState<TrackingMode>("reps_weight");
  const [newNotes, setNewNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // New pool mini-form
  const [newPoolOpen, setNewPoolOpen] = useState(false);
  const [newPoolName, setNewPoolName] = useState("");

  const supabase = createClient();

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setCreating(false);
    let cancelled = false;
    // Library from the phone instantly; refresh behind it if there's signal
    Promise.all([getCachedExercises(), getCachedPools()]).then(([ex, pl]) => {
      if (cancelled || !ex) return;
      setExercises(ex);
      setPools(pl || []);
      setLoading(false);
    });
    refreshLibrary(supabase).then((fresh) => {
      if (cancelled) return;
      if (fresh) {
        setExercises(fresh.exercises);
        setPools(fresh.pools);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  function toggleMode(mode: TrackingMode) {
    setSupportsModes((prev) => {
      if (prev.includes(mode)) {
        if (prev.length === 1) return prev;
        const next = prev.filter((m) => m !== mode);
        if (defaultMode === mode) setDefaultMode(next[0]);
        return next;
      }
      return [...prev, mode];
    });
  }

  async function handleCreate() {
    if (!newName.trim() || !newEquipment || !newPoolId) return;
    setSaving(true);
    try {
      const userId = await getUserId(supabase);
      if (!userId) return;

      // Created on the phone; syncs before any workout that uses it
      const exercise: Exercise = {
        id: crypto.randomUUID(),
        user_id: userId,
        name: newName.trim(),
        equipment: newEquipment,
        pool_id: newPoolId,
        default_mode: defaultMode,
        supports_modes: supportsModes,
        notes: newNotes || null,
        created_at: new Date().toISOString(),
      };
      await queueUpsert("exercise_definitions", exercise);
      await putCachedRow("exercises", exercise);
      setExercises((prev) => [...prev, exercise]);
      onSelect(exercise);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreatePool() {
    const userId = await getUserId(supabase);
    if (!userId) return;

    const pool: Pool = {
      id: crypto.randomUUID(),
      user_id: userId,
      name: newPoolName.trim(),
      parent_pool_id: null,
      sort_order: pools.length,
      created_at: new Date().toISOString(),
    };
    await queueUpsert("exercise_pools", pool);
    await putCachedRow("pools", pool);
    setPools((prev) => [...prev, pool]);
    setNewPoolId(pool.id);
    setNewPoolName("");
    setNewPoolOpen(false);
  }

  if (creating) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} modal={true}>
        <DrawerContent>
          <DrawerHeader>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCreating(false)}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <DrawerTitle>Create Exercise</DrawerTitle>
            </div>
          </DrawerHeader>
          <div className="px-4 space-y-4 max-h-[85vh] overflow-y-auto">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Exercise name"
              className="h-12"
              autoFocus={false}
            />

            {/* Category */}
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Category <span className="text-destructive">*</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {pools.map((pool) => (
                  <button
                    key={pool.id}
                    onClick={() =>
                      setNewPoolId(newPoolId === pool.id ? null : pool.id)
                    }
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      newPoolId === pool.id
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {pool.name}
                  </button>
                ))}
                <button
                  onClick={() => setNewPoolOpen(true)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-dashed border-border hover:bg-accent text-muted-foreground"
                >
                  <Plus className="inline h-3 w-3 mr-1" />
                  New
                </button>
              </div>
            </div>

            {/* Equipment */}
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Equipment <span className="text-destructive">*</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {EQUIPMENT_OPTIONS.map((eq) => (
                  <button
                    key={eq.value}
                    onClick={() => setNewEquipment(eq.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      newEquipment === eq.value
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {eq.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tracking Modes */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Tracking Modes</label>
              <p className="text-xs text-muted-foreground">
                Select all modes this exercise supports
              </p>
              <div className="flex flex-wrap gap-1.5">
                {MODE_OPTIONS.map((mode) => (
                  <button
                    key={mode}
                    onClick={() => toggleMode(mode)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      supportsModes.includes(mode)
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            </div>

            {/* Default Mode */}
            {supportsModes.length > 1 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Default Mode</label>
                <div className="flex flex-wrap gap-1.5">
                  {supportsModes.map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setDefaultMode(mode)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        defaultMode === mode
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      {MODE_LABELS[mode]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Notes */}
            <Textarea
              placeholder="Notes (form cues, technique tips...)"
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              rows={2}
            />
          </div>
          <DrawerFooter>
            <Button
              onClick={handleCreate}
              disabled={!newName.trim() || !newEquipment || !newPoolId || saving}
              className="h-12"
            >
              {saving ? "Creating..." : "Create & Add"}
            </Button>
          </DrawerFooter>
        </DrawerContent>

        {/* New Pool mini-drawer */}
        <Drawer open={newPoolOpen} onOpenChange={setNewPoolOpen}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>New Category</DrawerTitle>
            </DrawerHeader>
            <div className="px-4">
              <Input
                placeholder="Category name (e.g. Legs, Upper Push)"
                value={newPoolName}
                onChange={(e) => setNewPoolName(e.target.value)}
                className="h-12"
                autoFocus={false}
              />
            </div>
            <DrawerFooter>
              <Button
                onClick={handleCreatePool}
                disabled={!newPoolName.trim()}
                className="h-12"
              >
                Create
              </Button>
              <Button
                variant="outline"
                onClick={() => setNewPoolOpen(false)}
                className="h-12"
              >
                Cancel
              </Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </Drawer>
    );
  }

  const available = exercises.filter(
    (e) =>
      !excludeIds.includes(e.id) &&
      e.name.toLowerCase().includes(search.toLowerCase())
  );

  const grouped = pools.reduce(
    (acc, pool) => {
      const poolExercises = available.filter((e) => e.pool_id === pool.id);
      if (poolExercises.length > 0) {
        acc.push({ pool, exercises: poolExercises });
      }
      return acc;
    },
    [] as { pool: Pool; exercises: Exercise[] }[]
  );

  const uncategorized = available.filter((e) => !e.pool_id);
  if (uncategorized.length > 0) {
    grouped.push({
      pool: { id: "", name: "Uncategorized", user_id: "", parent_pool_id: null, sort_order: 999, created_at: "" },
      exercises: uncategorized,
    });
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} modal={true}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Add Exercise</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 space-y-3 max-h-[85vh] overflow-y-auto">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search exercises..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-12 pl-10"
              autoFocus={false}
            />
          </div>

          {/* Create New Exercise button */}
          <button
            onClick={() => {
              setNewName(search);
              setNewEquipment(null);
              setNewPoolId(null);
              setSupportsModes(["reps_weight"]);
              setDefaultMode("reps_weight");
              setNewNotes("");
              setCreating(true);
            }}
            className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border p-3 text-left transition-colors hover:bg-accent active:scale-[0.98]"
          >
            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Plus className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="font-medium text-sm">Create New Exercise</p>
              <p className="text-xs text-muted-foreground">
                {search ? `"${search}"` : "Add to your library"}
              </p>
            </div>
          </button>

          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />
              ))}
            </div>
          ) : grouped.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center">
              <Dumbbell className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                {search
                  ? "No exercises match your search."
                  : "No exercises yet. Create one above!"}
              </p>
            </div>
          ) : (
            grouped.map(({ pool, exercises: poolExercises }) => (
              <div key={pool.id} className="space-y-1">
                <h3 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {pool.name}
                </h3>
                {poolExercises.map((exercise) => (
                  <button
                    key={exercise.id}
                    onClick={() => {
                      onSelect(exercise);
                      onOpenChange(false);
                    }}
                    className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent active:scale-[0.98]"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{exercise.name}</p>
                      {exercise.equipment && (
                        <Badge variant="outline" className="mt-0.5 text-[10px] px-1.5 py-0">
                          {EQUIPMENT_LABELS[exercise.equipment] || exercise.equipment}
                        </Badge>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <DrawerFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="h-12">
            Cancel
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
