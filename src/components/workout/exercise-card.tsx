"use client";

import { useState } from "react";
import { Database, TrackingMode, Equipment, PrType } from "@/types/database.types";
import { SetRow, SetData } from "./set-row";
import { ExerciseHistorySheet } from "./exercise-history-sheet";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  GripVertical,
} from "lucide-react";
import { cn } from "@/lib/utils";

type ExerciseDefinition =
  Database["public"]["Tables"]["exercise_definitions"]["Row"];

interface GhostSet {
  reps: number | null;
  weight: number | null;
  duration_seconds: number | null;
  note: string | null;
}

interface PreviousSession {
  sets: GhostSet[];
  note: string | null;
  date: string;
}

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

interface ExerciseCardProps {
  definition: ExerciseDefinition;
  mode: TrackingMode;
  sets: SetData[];
  previous: PreviousSession | null;
  prs?: Record<string, PrType[]>;
  onAddSet: () => void;
  onUpdateSet: (set: SetData) => void;
  onCompleteSet: (setId: string) => void;
  onUncompleteSet: (setId: string) => void;
  onDeleteSet: (setId: string) => void;
  onRemoveExercise: () => void;
  dragHandleProps?: Record<string, any>;
}

export function ExerciseCard({
  definition,
  mode,
  sets,
  previous,
  prs,
  onAddSet,
  onUpdateSet,
  onCompleteSet,
  onUncompleteSet,
  onDeleteSet,
  onRemoveExercise,
  dragHandleProps,
}: ExerciseCardProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showPrevNote, setShowPrevNote] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const completedCount = sets.filter((s) => s.completed_at).length;

  return (
    <div className="rounded-2xl border border-border bg-card/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-1 p-4 pb-2">
        {dragHandleProps && (
          <div
            {...dragHandleProps}
            className="touch-none p-1 -ml-1 cursor-grab active:cursor-grabbing text-muted-foreground"
          >
            <GripVertical className="h-4 w-4" />
          </div>
        )}
        <button
          onClick={() => setHistoryOpen(true)}
          className="flex-1 min-w-0 text-left"
        >
          <h3 className="font-semibold truncate text-primary">
            {definition.name}
          </h3>
          <div className="flex items-center gap-1.5 mt-0.5">
            {definition.equipment && (
              <span className="text-xs text-muted-foreground">
                {EQUIPMENT_LABELS[definition.equipment] ||
                  definition.equipment}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {completedCount}/{sets.length} sets
            </span>
          </div>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground shrink-0"
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronUp className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
          onClick={onRemoveExercise}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Previous session note */}
      {previous?.note && !collapsed && (
        <div className="mx-4 mb-2">
          <button
            onClick={() => setShowPrevNote(!showPrevNote)}
            className="flex items-center gap-1.5 text-xs text-amber-500"
          >
            <MessageSquare className="h-3 w-3" />
            Note from{" "}
            {new Date(previous.date).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}
          </button>
          {showPrevNote && (
            <p className="mt-1 text-xs text-muted-foreground bg-amber-500/5 border border-amber-500/20 rounded-lg p-2">
              {previous.note}
            </p>
          )}
        </div>
      )}

      {/* Sets */}
      {!collapsed && (
        <div className="space-y-2 p-4 pt-2">
          {sets.map((set, idx) => (
            <SetRow
              key={set.id || idx}
              set={set}
              mode={mode}
              ghostSet={
                previous?.sets[idx]
                  ? {
                      reps: previous.sets[idx].reps,
                      weight: previous.sets[idx].weight,
                      duration_seconds: previous.sets[idx].duration_seconds,
                      note: previous.sets[idx].note,
                    }
                  : null
              }
              prs={set.id ? prs?.[set.id] : undefined}
              onChange={onUpdateSet}
              onComplete={() => set.id && onCompleteSet(set.id)}
              onUncomplete={() => set.id && onUncompleteSet(set.id)}
              onDelete={() => set.id && onDeleteSet(set.id)}
            />
          ))}

          <Button
            variant="ghost"
            onClick={onAddSet}
            className="w-full h-10 text-sm text-muted-foreground"
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add Set
          </Button>
        </div>
      )}

      <ExerciseHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        exerciseId={definition.id}
        exerciseName={definition.name}
      />
    </div>
  );
}
