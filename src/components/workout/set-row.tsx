"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TrackingMode, PrType } from "@/types/database.types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Check, MessageSquare, X, Timer, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { PR_BADGE_STYLES, PR_BADGE_LABELS } from "@/lib/pr-constants";
import { computeE1rm } from "@/lib/pr-detection";
import { haptic, HAPTIC } from "@/lib/haptics";

export interface SetData {
  id?: string;
  set_number: number;
  reps: number | null;
  weight: number | null;
  duration_seconds: number | null;
  is_warmup: boolean;
  note: string | null;
  completed_at: string | null;
  e1rm?: number | null;
  rest_seconds?: number | null;
  is_pr_weight?: boolean;
  is_pr_1rm?: boolean;
  is_pr_volume?: boolean;
  is_pr_reps?: boolean;
  is_pr_duration?: boolean;
}

interface GhostSet {
  reps: number | null;
  weight: number | null;
  duration_seconds: number | null;
  note: string | null;
}

function formatRest(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

interface SetRowProps {
  set: SetData;
  mode: TrackingMode;
  ghostSet?: GhostSet | null;
  prs?: PrType[];
  onChange: (set: SetData) => void;
  onComplete: () => void;
  onUncomplete: () => void;
  onDelete: () => void;
}

export function SetRow({
  set,
  mode,
  ghostSet,
  prs,
  onChange,
  onComplete,
  onUncomplete,
  onDelete,
}: SetRowProps) {
  const [showNote, setShowNote] = useState(!!set.note);
  const [editingRest, setEditingRest] = useState(false);
  const [stopwatchStart, setStopwatchStart] = useState<number | null>(null);
  const [stopwatchElapsed, setStopwatchElapsed] = useState(0);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const isCompleted = !!set.completed_at;
  const stopwatchRunning = stopwatchStart != null;

  // Auto-grow the note textarea to fit its content
  useEffect(() => {
    const el = noteRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [set.note, showNote]);

  // Tick the stopwatch while running
  useEffect(() => {
    if (stopwatchStart == null) return;
    const t = setInterval(
      () => setStopwatchElapsed(Math.floor((Date.now() - stopwatchStart) / 1000)),
      250
    );
    return () => clearInterval(t);
  }, [stopwatchStart]);

  function toggleStopwatch() {
    haptic(HAPTIC.tap);
    if (stopwatchStart == null) {
      setStopwatchElapsed(0);
      setStopwatchStart(Date.now());
    } else {
      const secs = Math.max(1, Math.round((Date.now() - stopwatchStart) / 1000));
      setStopwatchStart(null);
      updateField("duration_seconds", secs);
    }
  }

  const e1rm =
    mode === "reps_weight" && set.weight && set.reps
      ? computeE1rm(set.weight, set.reps)
      : null;

  function updateField<K extends keyof SetData>(field: K, value: SetData[K]) {
    onChange({ ...set, [field]: value });
  }

  return (
    <div
      className={cn(
        "space-y-2 rounded-xl border p-3 transition-colors",
        isCompleted
          ? "border-green-600/30 bg-green-600/5"
          : set.is_warmup
            ? "border-yellow-500/30 bg-yellow-500/5"
            : "border-border bg-card"
      )}
    >
      {/* Set header */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => updateField("is_warmup", !set.is_warmup)}
          className={cn(
            "rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
            set.is_warmup
              ? "bg-yellow-500/20 text-yellow-500"
              : "text-muted-foreground hover:bg-muted"
          )}
        >
          {set.is_warmup ? "W" : set.set_number}
        </button>

        {set.is_warmup && (
          <span className="text-[10px] text-yellow-500/70">warmup</span>
        )}

        <div className="flex-1" />

        {/* Note toggle */}
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8", set.note && "text-primary")}
          onClick={() => setShowNote(!showNote)}
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </Button>

        {/* Delete */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Input fields based on mode */}
      <div className="flex items-center gap-2">
        {(mode === "reps_weight" || mode === "time_weight") && (
          <div className="flex items-center gap-1.5 flex-1">
            <Input
              type="number"
              inputMode="decimal"
              placeholder={ghostSet?.weight?.toString() || "0"}
              value={set.weight ?? ""}
              onChange={(e) =>
                updateField(
                  "weight",
                  e.target.value ? parseFloat(e.target.value) : null
                )
              }
              className="h-11 text-center text-lg font-mono"
            />
            <span className="text-xs text-muted-foreground shrink-0">lb</span>
          </div>
        )}

        {mode === "reps_assisted" && (
          <div className="flex items-center gap-1.5 flex-1">
            <Input
              type="number"
              inputMode="decimal"
              placeholder="0"
              value={set.weight ?? ""}
              onChange={(e) =>
                updateField(
                  "weight",
                  e.target.value ? parseFloat(e.target.value) : null
                )
              }
              className="h-11 text-center text-lg font-mono"
            />
            <span className="text-xs text-muted-foreground shrink-0">
              lb assist
            </span>
          </div>
        )}

        {(mode === "reps_weight" ||
          mode === "reps_only" ||
          mode === "reps_assisted") && (
          <div className="flex items-center gap-1.5 flex-1">
            <Input
              type="number"
              inputMode="numeric"
              placeholder={ghostSet?.reps?.toString() || "0"}
              value={set.reps ?? ""}
              onChange={(e) =>
                updateField(
                  "reps",
                  e.target.value ? parseInt(e.target.value) : null
                )
              }
              className="h-11 text-center text-lg font-mono"
            />
            <span className="text-xs text-muted-foreground shrink-0">reps</span>
          </div>
        )}

        {(mode === "time_weight" || mode === "time_only") && (
          <div className="flex items-center gap-1.5 flex-1">
            <Input
              type="number"
              inputMode="numeric"
              placeholder={ghostSet?.duration_seconds?.toString() || "0"}
              value={stopwatchRunning ? stopwatchElapsed : set.duration_seconds ?? ""}
              readOnly={stopwatchRunning}
              onChange={(e) =>
                updateField(
                  "duration_seconds",
                  e.target.value ? parseInt(e.target.value) : null
                )
              }
              className={cn(
                "h-11 text-center text-lg font-mono",
                stopwatchRunning && "text-blue-400 border-blue-500/40"
              )}
            />
            <span className="text-xs text-muted-foreground shrink-0">sec</span>
            <Button
              variant="outline"
              size="icon"
              onClick={toggleStopwatch}
              className={cn(
                "h-11 w-11 shrink-0",
                stopwatchRunning &&
                  "bg-blue-600/20 border-blue-500/50 text-blue-400 animate-pulse"
              )}
            >
              {stopwatchRunning ? (
                <Square className="h-4 w-4 fill-current" />
              ) : (
                <Timer className="h-5 w-5" />
              )}
            </Button>
          </div>
        )}

        {mode === "presence" && (
          <div className="flex-1 text-center text-sm text-muted-foreground">
            Tap ✓ to log
          </div>
        )}

        {/* Complete / Uncomplete button */}
        <Button
          variant={isCompleted ? "default" : "outline"}
          size="icon"
          className={cn(
            "h-11 w-11 shrink-0",
            isCompleted && "bg-green-600 hover:bg-green-700 border-green-600"
          )}
          onClick={() => {
            if (!isCompleted) haptic(HAPTIC.success);
            (isCompleted ? onUncomplete : onComplete)();
          }}
        >
          <Check className="h-5 w-5" />
        </Button>
      </div>

      {/* e1RM + rest + PR badges */}
      {(e1rm ||
        (prs && prs.length > 0) ||
        (isCompleted && set.rest_seconds != null)) && (
        <div className="flex items-center gap-2 flex-wrap">
          {e1rm && mode === "reps_weight" && (
            <span className="text-[10px] text-muted-foreground font-mono">
              e1RM: {Math.round(e1rm)}
            </span>
          )}
          {isCompleted && set.rest_seconds != null && !editingRest && (
            <button
              onClick={() => setEditingRest(true)}
              className="text-[10px] text-muted-foreground/60 font-mono"
            >
              rest {formatRest(set.rest_seconds)}
            </button>
          )}
          {isCompleted && editingRest && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
              rest
              <input
                type="number"
                inputMode="numeric"
                autoFocus
                defaultValue={set.rest_seconds ?? 0}
                onBlur={(e) => {
                  const v = parseInt(e.target.value);
                  updateField("rest_seconds", isNaN(v) || v < 0 ? null : v);
                  setEditingRest(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="w-14 h-6 rounded border border-input bg-transparent px-1 text-center outline-none"
              />
              s
            </span>
          )}
          <AnimatePresence>
            {prs?.map((pr) => (
              <motion.span
                key={pr}
                initial={{ scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className={cn(
                  "text-[10px] font-bold px-2 py-0.5 rounded-full border",
                  PR_BADGE_STYLES[pr]
                )}
              >
                {PR_BADGE_LABELS[pr]}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Note input */}
      {showNote && (
        <textarea
          ref={noteRef}
          placeholder="Set note..."
          value={set.note || ""}
          rows={1}
          onChange={(e) => updateField("note", e.target.value || null)}
          className="w-full resize-none overflow-hidden rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        />
      )}
    </div>
  );
}
