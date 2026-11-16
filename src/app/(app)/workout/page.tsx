"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWorkout } from "@/lib/hooks/use-workout";
import { ExerciseCard } from "@/components/workout/exercise-card";
import { ExercisePicker } from "@/components/workout/exercise-picker";
import { SyncIndicator } from "@/components/sync-indicator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from "@/components/ui/drawer";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus, Timer, CheckCircle2, Pencil, X, ArrowLeft } from "lucide-react";
import { WorkoutExerciseState } from "@/lib/hooks/use-workout";
import { PrType } from "@/types/database.types";
import { SetData } from "@/components/workout/set-row";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function SortableExercise({
  ex,
  prs,
  addSet,
  updateSet,
  completeSet,
  uncompleteSet,
  deleteSet,
  removeExercise,
}: {
  ex: WorkoutExerciseState;
  prs?: Record<string, PrType[]>;
  addSet: (weId: string) => void;
  updateSet: (weId: string, set: SetData) => void;
  completeSet: (weId: string, setId: string) => void;
  uncompleteSet: (weId: string, setId: string) => void;
  deleteSet: (weId: string, setId: string) => void;
  removeExercise: (weId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ex.workoutExercise.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <ExerciseCard
        definition={ex.definition}
        mode={ex.workoutExercise.mode}
        sets={ex.sets}
        previous={ex.previous}
        prs={prs}
        onAddSet={() => addSet(ex.workoutExercise.id)}
        onUpdateSet={(set) => updateSet(ex.workoutExercise.id, set)}
        onCompleteSet={(setId) => completeSet(ex.workoutExercise.id, setId)}
        onUncompleteSet={(setId) => uncompleteSet(ex.workoutExercise.id, setId)}
        onDeleteSet={(setId) => deleteSet(ex.workoutExercise.id, setId)}
        onRemoveExercise={() => removeExercise(ex.workoutExercise.id)}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

function WorkoutSkeleton() {
  return (
    <div className="mx-auto max-w-lg px-4 pt-8">
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-muted" />
        <div className="h-48 animate-pulse rounded-2xl bg-muted" />
        <div className="h-48 animate-pulse rounded-2xl bg-muted" />
      </div>
    </div>
  );
}

// The id rides in the query string so one cached copy of this page can
// open any workout with no signal.
export default function WorkoutPage() {
  return (
    <Suspense fallback={<WorkoutSkeleton />}>
      <WorkoutView />
    </Suspense>
  );
}

function WorkoutView() {
  const workoutId = useSearchParams().get("id");
  // Fresh state per workout
  return <WorkoutScreen key={workoutId ?? ""} workoutId={workoutId} />;
}

function WorkoutScreen({ workoutId }: { workoutId: string | null }) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  const {
    workout,
    exercises,
    loading,
    unavailable,
    elapsed,
    prs,
    addExercise,
    addSet,
    updateSet,
    completeSet,
    uncompleteSet,
    deleteSet,
    removeExercise,
    finishWorkout,
    renameWorkout,
    reorderExercises,
    cancelWorkout,
  } = useWorkout(workoutId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  // Keep the screen awake during an active workout
  useEffect(() => {
    if (!workout || workout.finished_at) return;
    let sentinel: WakeLockSentinel | null = null;
    const acquire = async () => {
      try {
        if ("wakeLock" in navigator) {
          sentinel = await navigator.wakeLock.request("screen");
        }
      } catch {
        // denied or unsupported — not worth surfacing
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      sentinel?.release().catch(() => {});
    };
  }, [workout]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = exercises.findIndex(
      (e) => e.workoutExercise.id === active.id
    );
    const newIndex = exercises.findIndex(
      (e) => e.workoutExercise.id === over.id
    );
    if (oldIndex !== -1 && newIndex !== -1) {
      reorderExercises(oldIndex, newIndex);
    }
  }

  function startEditTitle() {
    setTitleDraft(workout?.title || "");
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.focus(), 50);
  }

  function saveTitle() {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== workout?.title) {
      renameWorkout(trimmed);
    }
    setEditingTitle(false);
  }

  async function handleCancel() {
    await cancelWorkout();
    setCancelOpen(false);
    router.push("/");
  }

  if (loading) return <WorkoutSkeleton />;

  if (!workout) {
    return (
      <div className="mx-auto max-w-lg px-4 pt-12 text-center">
        <p className="text-muted-foreground">
          {unavailable === "offline"
            ? "This workout isn't saved on this phone yet. Open it once with signal and it'll be available offline."
            : "Workout not found"}
        </p>
        <Button variant="outline" onClick={() => router.push("/")} className="mt-4">
          Go Home
        </Button>
      </div>
    );
  }

  const isFinished = !!workout.finished_at;
  const totalSets = exercises.reduce((a, e) => a + e.sets.length, 0);
  const completedSets = exercises.reduce(
    (a, e) => a + e.sets.filter((s) => s.completed_at).length,
    0
  );
  const totalVolume = exercises.reduce(
    (a, e) =>
      a +
      e.sets.reduce(
        (sa, s) =>
          sa + (!s.is_warmup && s.weight && s.reps ? s.weight * s.reps : 0),
        0
      ),
    0
  );

  async function handleFinish() {
    await finishWorkout();
    setFinishOpen(false);
    router.push(`/workout/summary?id=${workoutId}&finished=1`);
  }

  return (
    <div className="mx-auto max-w-lg px-4 pb-32">
      {/* Timer header */}
      <div className="sticky top-0 z-10 -mx-4 bg-background/90 backdrop-blur-xl border-b border-border/50 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <Input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                className="h-8 text-lg font-bold border-0 bg-transparent p-0 focus-visible:ring-1"
              />
            ) : (
              <button
                onClick={startEditTitle}
                className="flex items-center gap-1.5 group text-left"
              >
                <h1 className="text-lg font-bold truncate">
                  {workout.title || "Workout"}
                </h1>
                <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 group-active:opacity-100 shrink-0" />
              </button>
            )}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Timer className="h-3.5 w-3.5" />
              <span className="font-mono">{formatTime(elapsed)}</span>
              <span>·</span>
              <span>
                {completedSets}/{totalSets} sets
              </span>
            </div>
          </div>
          {isFinished ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/history")}
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" />
              Done
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => setCancelOpen(true)}
              >
                <X className="h-4 w-4" />
              </Button>
              <Button
                onClick={() => setFinishOpen(true)}
                size="sm"
                className="bg-green-600 hover:bg-green-700"
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                Finish
              </Button>
            </div>
          )}
        </div>
      </div>

      <SyncIndicator className="mt-2" />

      {/* Exercises with drag-and-drop */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={exercises.map((e) => e.workoutExercise.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="mt-4 space-y-4">
            {exercises.map((ex) => (
              <SortableExercise
                key={ex.workoutExercise.id}
                ex={ex}
                prs={prs}
                addSet={addSet}
                updateSet={updateSet}
                completeSet={completeSet}
                uncompleteSet={uncompleteSet}
                deleteSet={deleteSet}
                removeExercise={removeExercise}
              />
            ))}

            {exercises.length === 0 && (
              <div className="rounded-2xl border border-dashed border-border p-8 text-center">
                <p className="text-muted-foreground">
                  No exercises yet. Add your first exercise to get started.
                </p>
              </div>
            )}
          </div>
        </SortableContext>
      </DndContext>

      {/* Add Exercise FAB */}
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-20">
        <Button
          onClick={() => setPickerOpen(true)}
          size="lg"
          className="h-14 rounded-full px-6 shadow-xl"
        >
          <Plus className="mr-2 h-5 w-5" />
          Add Exercise
        </Button>
      </div>

      {/* Exercise Picker */}
      <ExercisePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(def) => {
          addExercise(def);
          setPickerOpen(false);
        }}
        excludeIds={exercises.map((e) => e.definition.id)}
      />

      {/* Finish Confirmation */}
      <Drawer open={finishOpen} onOpenChange={setFinishOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Finish Workout?</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-card p-3 text-center">
                <p className="text-2xl font-bold">{formatTime(elapsed)}</p>
                <p className="text-xs text-muted-foreground">Duration</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-3 text-center">
                <p className="text-2xl font-bold">
                  {totalVolume.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">Volume (lb)</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-3 text-center">
                <p className="text-2xl font-bold">{exercises.length}</p>
                <p className="text-xs text-muted-foreground">Exercises</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-3 text-center">
                <p className="text-2xl font-bold">{completedSets}</p>
                <p className="text-xs text-muted-foreground">Sets</p>
              </div>
            </div>
            {completedSets < totalSets && (
              <p className="text-sm text-amber-500 text-center">
                {totalSets - completedSets} set{totalSets - completedSets !== 1 ? "s" : ""} not completed
              </p>
            )}
          </div>
          <DrawerFooter>
            <Button
              onClick={handleFinish}
              className="h-12 bg-green-600 hover:bg-green-700"
            >
              Finish Workout
            </Button>
            <Button
              variant="outline"
              onClick={() => setFinishOpen(false)}
              className="h-12"
            >
              Keep Going
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>

      {/* Cancel Confirmation */}
      <Drawer open={cancelOpen} onOpenChange={setCancelOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Cancel Workout?</DrawerTitle>
          </DrawerHeader>
          <div className="px-4">
            <p className="text-sm text-muted-foreground text-center">
              This will delete the workout and all logged sets. This can&apos;t be undone.
            </p>
          </div>
          <DrawerFooter>
            <Button
              onClick={handleCancel}
              variant="destructive"
              className="h-12"
            >
              Discard Workout
            </Button>
            <Button
              variant="outline"
              onClick={() => setCancelOpen(false)}
              className="h-12"
            >
              Keep Going
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
