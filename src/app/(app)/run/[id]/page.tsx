"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Database } from "@/types/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Zap, Timer, Check, ChevronLeft, Footprints, Gauge, Pencil } from "lucide-react";
import { RUN_TEMPLATES_MAP, getTierForBacktracker, getIntervalsFor, humanizeTag, type RunTemplate, type IntervalInput } from "@/lib/run-workout-structures";
import { cn } from "@/lib/utils";

type RunSession = Database["public"]["Tables"]["run_sessions"]["Row"];

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const POOL_ICON: Record<string, { Icon: typeof Zap; color: string; bg: string }> = {
  speed: { Icon: Zap, color: "text-red-400", bg: "bg-red-500/20" },
  easy: { Icon: Footprints, color: "text-green-400", bg: "bg-green-500/20" },
  threshold: { Icon: Gauge, color: "text-amber-400", bg: "bg-amber-500/20" },
};

export default function RunSessionPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;
  const supabase = createClient();

  const [session, setSession] = useState<RunSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [notes, setNotes] = useState("");
  const [splits, setSplits] = useState<Record<string, string>>({});
  const [finishing, setFinishing] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    async function load() {
      const { data: sess } = await supabase
        .from("run_sessions")
        .select("*")
        .eq("id", sessionId)
        .single();

      if (!sess) {
        router.push("/");
        return;
      }

      setSession(sess);
      setNotes(sess.notes || "");

      const saved = sess.raw_data as Record<string, unknown> | null;
      if (saved?.splits) setSplits(saved.splits as Record<string, string>);

      const isFinished = sess.duration_seconds != null;
      if (sess.started_at && !isFinished) {
        const startMs = new Date(sess.started_at).getTime();
        setElapsed(Math.floor((Date.now() - startMs) / 1000));
      }
      if (isFinished) {
        setElapsed(sess.duration_seconds!);
      }

      setLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const isFinished = session?.duration_seconds != null;
    if (session && !isFinished) {
      timerRef.current = setInterval(() => {
        if (session.started_at) {
          const startMs = new Date(session.started_at).getTime();
          setElapsed(Math.floor((Date.now() - startMs) / 1000));
        }
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [session]);

  const rawData = session?.raw_data as Record<string, unknown> | null;
  const templateId = (rawData?.templateId as string) || session?.run_workout || "";
  const variantId = (rawData?.variantId as string) || "";
  const template = RUN_TEMPLATES_MAP[templateId];

  const intervals =
    template?.trackingMode === "manual_splits"
      ? getIntervalsFor(template, variantId)
      : [];

  const poolKey = template?.pools[0] || (session?.run_pool as string) || "speed";
  const iconStyle = POOL_ICON[poolKey] || POOL_ICON.speed;

  function updateSplit(id: string, value: string) {
    setSplits((prev) => ({ ...prev, [id]: value }));
  }

  function computeTier() {
    if (templateId !== "backtracker" || !splits.return) return null;
    const parts = splits.return.split(":");
    let minutes = 0;
    if (parts.length === 2) {
      minutes = parseInt(parts[0]) + parseInt(parts[1]) / 60;
    } else {
      minutes = parseFloat(splits.return);
    }
    if (isNaN(minutes)) return null;
    return getTierForBacktracker(minutes);
  }

  async function handleFinish(completed: boolean) {
    setFinishing(true);
    const duration = session?.started_at
      ? Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000)
      : null;

    const tier = computeTier();

    await supabase
      .from("run_sessions")
      .update({
        completed,
        duration_seconds: duration,
        notes: notes || null,
        raw_data: {
          ...(rawData || {}),
          splits,
          ...(tier ? { tier: tier.label, tierPool: tier.pool } : {}),
        },
      })
      .eq("id", sessionId);

    router.push("/");
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-lg px-4 pt-12">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-muted mx-auto" />
      </div>
    );
  }

  const sessionFinished = session?.duration_seconds != null;

  if (sessionFinished) {
    return (
      <FinishedRunView
        session={session!}
        rawData={rawData}
        templateId={templateId}
        variantId={variantId}
        template={template}
        intervals={intervals}
        supabase={supabase}
        onUpdate={(updated) => setSession(updated)}
      />
    );
  }

  const tier = computeTier();

  return (
    <div className="mx-auto max-w-lg px-4 pt-8 pb-24">
      {/* Header */}
      <div className="text-center space-y-1 mb-6">
        <div className={cn("mx-auto w-14 h-14 rounded-full flex items-center justify-center", iconStyle.bg)}>
          <iconStyle.Icon className={cn("h-7 w-7", iconStyle.color)} />
        </div>
        <h1 className="text-xl font-bold">{session?.name || template?.name}</h1>
        {variantId && (
          <p className="text-xs text-muted-foreground">{variantId}</p>
        )}
        {template && (
          <p className="text-xs text-muted-foreground uppercase tracking-wider">
            {humanizeTag(template.surface)} · {humanizeTag(template.footwear)}
          </p>
        )}
      </div>

      {/* Timer */}
      <div className="text-center mb-6">
        <div className="flex items-center justify-center gap-2 text-muted-foreground mb-1">
          <Timer className="h-4 w-4" />
          <span className="text-xs font-medium">Elapsed</span>
        </div>
        <p className="text-5xl font-bold font-mono tracking-tight">
          {formatElapsed(elapsed)}
        </p>
      </div>

      {/* Manual split inputs (backtracker, track intervals) */}
      {intervals.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Splits
          </p>
          <div className="space-y-2">
            {intervals.map((interval) => (
              <div key={interval.id} className="flex items-center gap-2 py-1">
                <span className="text-sm text-muted-foreground flex-1 min-w-0 truncate">
                  {interval.label}
                </span>
                <span className="text-[10px] text-muted-foreground/50 shrink-0">
                  {interval.target}
                </span>
                <Input
                  type="text"
                  inputMode="numeric"
                  placeholder="m:ss"
                  value={splits[interval.id] || ""}
                  onChange={(e) => updateSplit(interval.id, e.target.value)}
                  className="h-8 w-16 text-center text-sm font-mono border-border bg-background p-1"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tier indicator for backtracker */}
      {tier && (
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-3 mb-4 text-center">
          <span className="text-xs text-muted-foreground">Tier: </span>
          <span className="text-sm font-bold text-primary">{tier.label}</span>
          <span className="text-xs text-muted-foreground ml-2">({tier.target})</span>
        </div>
      )}

      {/* Tiers reference (for backtracker and ladder) */}
      {template?.tiers && !tier && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Benchmarks
          </p>
          <div className="space-y-1">
            {template.tiers.map((t) => (
              <div key={t.label} className="flex items-center justify-between text-sm">
                <span className="font-medium">{t.label}</span>
                <span className="text-xs text-muted-foreground">{t.target}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Description (for timer-only workouts without splits) */}
      {intervals.length === 0 && template?.description && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Workout
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {template.description}
          </p>
        </div>
      )}

      {/* Notes */}
      <div className="mb-6">
        <Textarea
          placeholder="Notes — how did it feel?"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="resize-none"
        />
      </div>

      {/* Finish Buttons */}
      <div className="space-y-2">
        <Button
          onClick={() => handleFinish(true)}
          disabled={finishing}
          className="w-full h-12 text-base"
        >
          <Check className="h-5 w-5 mr-2" />
          {finishing ? "Saving..." : "Complete Workout"}
        </Button>
        <Button
          variant="outline"
          onClick={() => handleFinish(false)}
          disabled={finishing}
          className="w-full h-12"
        >
          End Early (Partial)
        </Button>
      </div>
    </div>
  );
}

function parseDurationInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length === 3) {
    const [h, m, s] = parts.map(Number);
    if ([h, m, s].some(isNaN)) return null;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const [m, s] = parts.map(Number);
    if ([m, s].some(isNaN)) return null;
    return m * 60 + s;
  }
  const n = Number(trimmed);
  if (isNaN(n)) return null;
  return Math.round(n * 60);
}

function FinishedRunView({
  session,
  rawData,
  templateId,
  variantId,
  template,
  intervals,
  supabase,
  onUpdate,
}: {
  session: RunSession;
  rawData: Record<string, unknown> | null;
  templateId: string;
  variantId: string;
  template: RunTemplate | undefined;
  intervals: IntervalInput[];
  supabase: ReturnType<typeof createClient>;
  onUpdate: (s: RunSession) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editDuration, setEditDuration] = useState(
    session.duration_seconds != null ? formatElapsed(session.duration_seconds) : ""
  );
  const [editSplits, setEditSplits] = useState<Record<string, string>>(
    () => (rawData?.splits as Record<string, string>) || {}
  );
  const [editNotes, setEditNotes] = useState(session.notes || "");

  const savedTier = rawData?.tier as string | undefined;
  const savedSplits = (rawData?.splits as Record<string, string>) || {};

  function computeEditTier() {
    if (templateId !== "backtracker" || !editSplits.return) return null;
    const parts = editSplits.return.split(":");
    let minutes = 0;
    if (parts.length === 2) {
      minutes = parseInt(parts[0]) + parseInt(parts[1]) / 60;
    } else {
      minutes = parseFloat(editSplits.return);
    }
    if (isNaN(minutes)) return null;
    return getTierForBacktracker(minutes);
  }

  async function handleSave() {
    setSaving(true);
    const parsedDuration = parseDurationInput(editDuration);
    const tier = computeEditTier();

    const { data: updated } = await supabase
      .from("run_sessions")
      .update({
        duration_seconds: parsedDuration ?? session.duration_seconds,
        notes: editNotes || null,
        raw_data: {
          ...(rawData || {}),
          splits: editSplits,
          ...(tier ? { tier: tier.label, tierPool: tier.pool } : {}),
        },
      })
      .eq("id", session.id)
      .select()
      .single();

    setSaving(false);
    setEditing(false);
    if (updated) onUpdate(updated);
  }

  return (
    <div className="mx-auto max-w-lg px-4 pt-8 pb-24">
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1 text-sm text-muted-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </button>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </button>
        )}
      </div>

      <div className="text-center space-y-2 mb-6">
        <div className={cn("mx-auto w-14 h-14 rounded-full flex items-center justify-center", session.completed ? "bg-green-600/20" : "bg-amber-500/20")}>
          <Check className={cn("h-7 w-7", session.completed ? "text-green-500" : "text-amber-400")} />
        </div>
        <h1 className="text-xl font-bold">{session.name}</h1>
        {variantId && <p className="text-xs text-muted-foreground">{variantId}</p>}
        <p className="text-sm text-muted-foreground">
          {session.started_at &&
            new Date(session.started_at).toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
        </p>

        {editing ? (
          <div className="pt-1">
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Duration (m:ss or h:mm:ss)</label>
            <Input
              type="text"
              inputMode="numeric"
              value={editDuration}
              onChange={(e) => setEditDuration(e.target.value)}
              placeholder="m:ss"
              className="h-12 text-center text-2xl font-bold font-mono mt-1"
            />
          </div>
        ) : (
          <>
            {session.duration_seconds != null && (
              <p className="text-2xl font-bold font-mono">
                {formatElapsed(session.duration_seconds)}
              </p>
            )}
          </>
        )}

        {!editing && savedTier && (
          <span className="inline-block text-xs bg-primary/15 text-primary px-2 py-0.5 rounded-full font-medium">
            {savedTier}
          </span>
        )}
        {editing && computeEditTier() && (
          <span className="inline-block text-xs bg-primary/15 text-primary px-2 py-0.5 rounded-full font-medium">
            {computeEditTier()!.label}
          </span>
        )}
      </div>

      {/* Splits */}
      {intervals.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Splits</p>
          <div className="space-y-2">
            {intervals.map((interval) => (
              <div key={interval.id} className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground flex-1 min-w-0 truncate">{interval.label}</span>
                <span className="text-[10px] text-muted-foreground/50 shrink-0">{interval.target}</span>
                {editing ? (
                  <Input
                    type="text"
                    inputMode="numeric"
                    placeholder="m:ss"
                    value={editSplits[interval.id] || ""}
                    onChange={(e) => setEditSplits((prev) => ({ ...prev, [interval.id]: e.target.value }))}
                    className="h-8 w-16 text-center text-sm font-mono border-border bg-background p-1"
                  />
                ) : (
                  <span className="font-mono font-medium text-sm w-16 text-right">
                    {savedSplits[interval.id] || "—"}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {editing ? (
        <div className="mb-6">
          <Textarea
            placeholder="Notes — how did it feel?"
            value={editNotes}
            onChange={(e) => setEditNotes(e.target.value)}
            rows={3}
            className="resize-none"
          />
        </div>
      ) : session.notes ? (
        <div className="rounded-2xl border border-border bg-card p-4 mb-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Notes</p>
          <p className="text-sm text-muted-foreground">{session.notes}</p>
        </div>
      ) : null}

      {/* Edit actions */}
      {editing && (
        <div className="space-y-2">
          <Button onClick={handleSave} disabled={saving} className="w-full h-12 text-base">
            {saving ? "Saving..." : "Save Changes"}
          </Button>
          <Button variant="outline" onClick={() => {
            setEditing(false);
            setEditDuration(session.duration_seconds != null ? formatElapsed(session.duration_seconds) : "");
            setEditSplits((rawData?.splits as Record<string, string>) || {});
            setEditNotes(session.notes || "");
          }} className="w-full h-12">
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
