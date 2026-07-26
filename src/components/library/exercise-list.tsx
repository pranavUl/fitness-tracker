"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient, getLocalUser } from "@/lib/supabase/client";
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
import { Plus, Search, Dumbbell, ChevronRight, ChevronDown } from "lucide-react";
import { ExerciseDetail } from "./exercise-detail";

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

const MODE_OPTIONS: TrackingMode[] = [
  "reps_weight",
  "time_weight",
  "time_only",
  "reps_only",
  "reps_assisted",
  "presence",
];

const EQUIPMENT_OPTIONS: { value: Equipment; label: string }[] = [
  { value: "barbell", label: "Barbell" },
  { value: "dumbbell", label: "Dumbbell" },
  { value: "cable", label: "Cable" },
  { value: "machine", label: "Machine" },
  { value: "smith_machine", label: "Smith Machine" },
  { value: "bodyweight", label: "Bodyweight" },
  { value: "band", label: "Band" },
  { value: "kettlebell", label: "Kettlebell" },
  { value: "plate", label: "Plate" },
  { value: "other", label: "Other" },
];

export function ExerciseList() {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedExercise, setSelectedExercise] = useState<Exercise | null>(
    null
  );

  // Create form state
  const [name, setName] = useState("");
  const [poolId, setPoolId] = useState<string | null>(null);
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [supportsModes, setSupportsModes] = useState<TrackingMode[]>([
    "reps_weight",
  ]);
  const [defaultMode, setDefaultMode] = useState<TrackingMode>("reps_weight");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  // Pool create
  const [newPoolOpen, setNewPoolOpen] = useState(false);
  const [newPoolName, setNewPoolName] = useState("");

  // Collapsed pools
  const [collapsedPools, setCollapsedPools] = useState<Set<string>>(new Set());

  const supabase = createClient();

  const loadData = useCallback(async () => {
    const [exercisesRes, poolsRes] = await Promise.all([
      supabase.from("exercise_definitions").select("*").order("name"),
      supabase.from("exercise_pools").select("*").order("sort_order"),
    ]);
    setExercises(exercisesRes.data || []);
    setPools(poolsRes.data || []);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function resetForm() {
    setName("");
    setPoolId(null);
    setEquipment(null);
    setSupportsModes(["reps_weight"]);
    setDefaultMode("reps_weight");
    setNotes("");
  }

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

  const canSave = name.trim() && poolId && equipment;

  async function handleCreate() {
    if (!canSave) return;
    setSaving(true);
    const user = await getLocalUser(supabase);
    if (!user) return;

    const { error } = await supabase.from("exercise_definitions").insert({
      user_id: user.id,
      name: name.trim(),
      pool_id: poolId,
      equipment,
      supports_modes: supportsModes,
      default_mode: defaultMode,
      notes: notes || null,
    });

    if (error) {
      console.error("Failed to create exercise:", error);
    }

    setSaving(false);
    setCreateOpen(false);
    resetForm();
    loadData();
  }

  async function handleCreatePool() {
    const user = await getLocalUser(supabase);
    if (!user) return;

    const { data } = await supabase
      .from("exercise_pools")
      .insert({
        user_id: user.id,
        name: newPoolName,
        sort_order: pools.length,
      })
      .select()
      .single();

    if (data) {
      setPools((prev) => [...prev, data]);
      setPoolId(data.id);
    }
    setNewPoolName("");
    setNewPoolOpen(false);
  }

  const filtered = exercises.filter((e) =>
    e.name.toLowerCase().includes(search.toLowerCase())
  );

  const grouped = pools.reduce(
    (acc, pool) => {
      const poolExercises = filtered.filter((e) => e.pool_id === pool.id);
      if (poolExercises.length > 0) {
        acc.push({ pool, exercises: poolExercises });
      }
      return acc;
    },
    [] as { pool: Pool; exercises: Exercise[] }[]
  );

  const uncategorized = filtered.filter((e) => !e.pool_id);
  if (uncategorized.length > 0) {
    grouped.push({
      pool: {
        id: "",
        name: "Uncategorized",
        user_id: "",
        parent_pool_id: null,
        sort_order: 999,
        created_at: "",
      },
      exercises: uncategorized,
    });
  }

  if (selectedExercise) {
    return (
      <ExerciseDetail
        exercise={selectedExercise}
        pools={pools}
        onBack={() => {
          setSelectedExercise(null);
          loadData();
        }}
      />
    );
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    );
  }

  const equipmentLabel = (eq: Equipment | null) =>
    eq ? EQUIPMENT_OPTIONS.find((o) => o.value === eq)?.label || eq : null;

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search exercises..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-12 pl-10"
        />
      </div>

      {/* Add Exercise Button */}
      <Button
        onClick={() => {
          resetForm();
          setCreateOpen(true);
        }}
        className="w-full h-12"
      >
        <Plus className="mr-2 h-4 w-4" />
        Add Exercise
      </Button>

      {/* Exercise List grouped by pool */}
      {grouped.length === 0 && !loading ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Dumbbell className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            {search
              ? "No exercises match your search."
              : "No exercises yet. Add your first exercise to get started."}
          </p>
        </div>
      ) : (
        grouped.map(({ pool, exercises: poolExercises }) => {
          const isCollapsed = collapsedPools.has(pool.id);
          return (
            <div key={pool.id} className="space-y-1">
              <button
                onClick={() =>
                  setCollapsedPools((prev) => {
                    const next = new Set(prev);
                    if (next.has(pool.id)) next.delete(pool.id);
                    else next.add(pool.id);
                    return next;
                  })
                }
                className="flex w-full items-center gap-1.5 px-1 py-1 text-left"
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                    isCollapsed ? "-rotate-90" : ""
                  }`}
                />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {pool.name}
                </h3>
                <span className="text-[10px] text-muted-foreground/60">
                  {poolExercises.length}
                </span>
              </button>
              {!isCollapsed &&
                poolExercises.map((exercise) => (
                  <button
                    key={exercise.id}
                    onClick={() => setSelectedExercise(exercise)}
                    className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{exercise.name}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {exercise.equipment && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {equipmentLabel(exercise.equipment)}
                          </Badge>
                        )}
                        {exercise.supports_modes.map((mode) => (
                          <Badge
                            key={mode}
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0"
                          >
                            {MODE_LABELS[mode]}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
            </div>
          );
        })
      )}

      {/* Create Exercise Drawer */}
      <Drawer open={createOpen} onOpenChange={setCreateOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Add Exercise</DrawerTitle>
          </DrawerHeader>
          <div className="space-y-4 px-4 max-h-[60vh] overflow-y-auto">
            <Input
              placeholder="Exercise name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-12"
              autoFocus
            />

            {/* Pool selector (required) */}
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Category <span className="text-destructive">*</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {pools.map((pool) => (
                  <button
                    key={pool.id}
                    onClick={() =>
                      setPoolId(poolId === pool.id ? null : pool.id)
                    }
                    className={`rounded-full px-3 py-1.5 text-sm border transition-colors ${
                      poolId === pool.id
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card hover:bg-accent"
                    }`}
                  >
                    {pool.name}
                  </button>
                ))}
                <button
                  onClick={() => setNewPoolOpen(true)}
                  className="rounded-full px-3 py-1.5 text-sm border border-dashed border-border hover:bg-accent"
                >
                  <Plus className="inline h-3 w-3 mr-1" />
                  New
                </button>
              </div>
              {!poolId && (
                <p className="text-xs text-muted-foreground">
                  Pick a category or create one
                </p>
              )}
            </div>

            {/* Equipment selector (required) */}
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Equipment <span className="text-destructive">*</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {EQUIPMENT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setEquipment(opt.value)}
                    className={`rounded-full px-3 py-1.5 text-sm border transition-colors ${
                      equipment === opt.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card hover:bg-accent"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Tracking modes */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Tracking Modes</label>
              <p className="text-xs text-muted-foreground">
                Select all modes this exercise supports
              </p>
              <div className="flex flex-wrap gap-2">
                {MODE_OPTIONS.map((mode) => (
                  <button
                    key={mode}
                    onClick={() => toggleMode(mode)}
                    className={`rounded-full px-3 py-1.5 text-sm border transition-colors ${
                      supportsModes.includes(mode)
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card hover:bg-accent"
                    }`}
                  >
                    {MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            </div>

            {/* Default mode */}
            {supportsModes.length > 1 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Default Mode</label>
                <div className="flex flex-wrap gap-2">
                  {supportsModes.map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setDefaultMode(mode)}
                      className={`rounded-full px-3 py-1.5 text-sm border transition-colors ${
                        defaultMode === mode
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
              placeholder="Notes (form cues, technique tips...)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
          <DrawerFooter>
            <Button
              onClick={handleCreate}
              disabled={!canSave || saving}
              className="h-12"
            >
              {saving ? "Saving..." : "Add Exercise"}
            </Button>
            <DrawerClose asChild>
              <Button variant="outline" className="h-12">
                Cancel
              </Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

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
              autoFocus
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
