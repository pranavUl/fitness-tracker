"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, getUserId } from "@/lib/supabase/client";
import { getPendingRow, kvGet, kvSet, queueUpsert } from "@/lib/offline";
import { Input } from "@/components/ui/input";
import { Check, ChevronLeft, ChevronRight, Flame, Weight, Wheat } from "lucide-react";
import { cn } from "@/lib/utils";
import { computeOpenDay, dayKey, FINISHED_KEY, readFinished, shiftDay } from "@/lib/nutrition-day";
import { recordIntake } from "@/lib/intake";
import { IntakePace } from "@/components/intake-pace";

type Values = { protein: number | null; carbs: number | null; weight: number | null };
const EMPTY: Values = { protein: null, carbs: null, weight: null };
const FIELD: Record<keyof Values, "protein_grams" | "carbs_grams" | "morning_weight"> = {
  protein: "protein_grams",
  carbs: "carbs_grams",
  weight: "morning_weight",
};

const MAX_DAYS_BACK = 90;

function dayLabel(key: string): string {
  const today = dayKey(new Date());
  if (key === today) return "Today";
  if (key === shiftDay(today, -1)) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function shortDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Protein / carbs / weight for one day, with a day picker and "Finish day". */
export function DailyTracker() {
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const [values, setValues] = useState<Values>(EMPTY);
  // Fields typed into since this day loaded — a late server answer must not overwrite them
  const editedRef = useRef<Set<keyof Values>>(new Set());
  const dayRef = useRef<string | null>(null);
  const openDayRef = useRef<string | null>(null);
  const valuesRef = useRef<Values>(EMPTY);
  useEffect(() => {
    valuesRef.current = values;
  }, [values]);

  // Follow the open day (on load, at midnight, and when reopened), unless
  // the user has paged to a different day on purpose
  useEffect(() => {
    const sync = () => {
      const next = computeOpenDay();
      const prevOpen = openDayRef.current;
      openDayRef.current = next;
      setFinished(readFinished());
      setOpenDay(next);
      setDay((cur) => (cur == null || cur === prevOpen ? next : cur));
    };
    sync();
    const now = new Date();
    const msToMidnight =
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
    const timer = setTimeout(sync, msToMidnight + 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", sync);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", sync);
    };
  }, []);

  // Load the shown day: phone first (unsynced edits, then last copy), then server
  useEffect(() => {
    if (!day) return;
    dayRef.current = day;
    editedRef.current = new Set();
    let cancelled = false;
    const apply = (v: Partial<Values>) => {
      if (cancelled) return;
      setValues((cur) => {
        const next = { ...cur };
        for (const k of Object.keys(v) as (keyof Values)[]) {
          if (!editedRef.current.has(k)) next[k] = v[k] ?? null;
        }
        return next;
      });
    };
    const fromPending = (row: Record<string, unknown> | null): Partial<Values> => {
      const out: Partial<Values> = {};
      if (!row) return out;
      for (const k of Object.keys(FIELD) as (keyof Values)[]) {
        if (FIELD[k] in row) out[k] = (row[FIELD[k]] as number | null) ?? null;
      }
      return out;
    };

    (async () => {
      const [cached, pending] = await Promise.all([
        kvGet<Values>(`daily:${day}`),
        getPendingRow("daily_tracking", day),
      ]);
      // Fresh day: start from the phone's copy (blank if none)
      apply({ ...EMPTY, ...(cached ?? {}), ...fromPending(pending) });

      const { data, error } = await createClient()
        .from("daily_tracking")
        .select("protein_grams, carbs_grams, morning_weight")
        .eq("date", day)
        .maybeSingle();
      if (error || cancelled) return; // no signal: keep the phone's copy
      const server: Values = {
        protein: data?.protein_grams ?? null,
        carbs: data?.carbs_grams ?? null,
        weight: data?.morning_weight ?? null,
      };
      kvSet(`daily:${day}`, server);
      // Anything still waiting to sync is newer than the server
      apply({ ...server, ...fromPending(await getPendingRow("daily_tracking", day)) });
    })();
    return () => {
      cancelled = true;
    };
  }, [day]);

  const save = useCallback(
    async (field: keyof Values, value: number | null) => {
      const d = dayRef.current;
      if (!d) return;
      const userId = await getUserId(createClient());
      if (!userId) return;
      // One row per day; merged with any other unsynced edit to it
      await queueUpsert(
        "daily_tracking",
        { user_id: userId, date: d, [FIELD[field]]: value, updated_at: new Date().toISOString() },
        { onConflict: "user_id,date", key: d }
      );
      const cached = (await kvGet<Values>(`daily:${d}`)) ?? EMPTY;
      await kvSet(`daily:${d}`, { ...cached, [field]: value });
      // Timestamp the running totals for meal pacing — only for food being
      // logged now, not fixes to past days
      if (field !== "weight" && d === openDayRef.current) {
        const cur = { ...valuesRef.current, [field]: value };
        await recordIntake(d, cur.protein, cur.carbs);
      }
    },
    []
  );

  const change = (field: keyof Values, raw: string) => {
    editedRef.current.add(field);
    const value = raw ? (field === "weight" ? parseFloat(raw) : parseInt(raw)) : null;
    setValues((v) => ({ ...v, [field]: value != null && isNaN(value) ? null : value }));
  };

  function finishDay() {
    if (!day) return;
    try {
      localStorage.setItem(FINISHED_KEY, day);
    } catch {}
    const next = computeOpenDay();
    openDayRef.current = next;
    setFinished(day);
    setOpenDay(next);
    setDay(next);
  }

  function reopenDay() {
    if (!day) return;
    try {
      localStorage.setItem(FINISHED_KEY, shiftDay(day, -1));
    } catch {}
    setFinished(shiftDay(day, -1));
    openDayRef.current = day;
    setOpenDay(day);
  }

  if (!day || !openDay) {
    return <div className="h-[150px] rounded-2xl bg-muted animate-pulse" />;
  }

  const today = dayKey(new Date());
  const oldest = shiftDay(today, -MAX_DAYS_BACK);
  const isOpenDay = day === openDay;
  const isFinished = !!finished && day <= finished;
  const carriedOver = isOpenDay && day < today && !isFinished;

  const cards: { field: keyof Values; label: string; unit: string; Icon: typeof Flame; color: string; mode: "numeric" | "decimal" }[] = [
    { field: "protein", label: "Protein", unit: "g", Icon: Flame, color: "text-orange-400", mode: "numeric" },
    { field: "carbs", label: "Carbs", unit: "g", Icon: Wheat, color: "text-amber-400", mode: "numeric" },
    { field: "weight", label: "Weight", unit: "lb", Icon: Weight, color: "text-blue-400", mode: "decimal" },
  ];

  return (
    <div className="space-y-2">
      {/* Day picker */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => setDay(shiftDay(day, -1))}
          disabled={day <= oldest}
          className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-accent disabled:opacity-30"
          aria-label="Previous day"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <p className="text-sm font-semibold min-w-[7.5rem] text-center">{dayLabel(day)}</p>
        <button
          onClick={() => setDay(shiftDay(day, 1))}
          disabled={day >= today}
          className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-accent disabled:opacity-30"
          aria-label="Next day"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <div className="flex-1" />
        {!isOpenDay ? (
          <button
            onClick={() => setDay(openDay)}
            className="text-xs font-medium text-primary px-2 py-1 rounded-lg hover:bg-accent"
          >
            Back to {dayLabel(openDay).toLowerCase() === "today" ? "today" : dayLabel(openDay)}
          </button>
        ) : isFinished ? (
          <button
            onClick={reopenDay}
            className="flex items-center gap-1 text-xs font-medium text-green-500 bg-green-500/10 px-2.5 py-1 rounded-full"
          >
            <Check className="h-3 w-3" />
            Finished
          </button>
        ) : (
          <button
            onClick={finishDay}
            className="text-xs font-semibold bg-primary text-primary-foreground px-3 py-1.5 rounded-lg active:scale-[0.97] transition-transform"
          >
            Finish day
          </button>
        )}
      </div>

      {carriedOver && (
        <p className="text-[11px] text-amber-400/90 px-1">
          {`Still logging ${shortDate(day)} — tap Finish day when you're done eating.`}
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        {cards.map(({ field, label, unit, Icon, color, mode }) => (
          <div
            key={field}
            className={cn(
              "rounded-2xl border border-border bg-card p-3 space-y-1",
              !isOpenDay && "border-dashed"
            )}
          >
            <div className="flex items-center gap-1.5">
              <Icon className={cn("h-3.5 w-3.5", color)} />
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
            </div>
            <div className="flex items-baseline gap-1">
              <Input
                type="number"
                inputMode={mode}
                placeholder="—"
                value={values[field] ?? ""}
                onChange={(e) => change(field, e.target.value)}
                onBlur={() => {
                  if (editedRef.current.has(field)) save(field, values[field]);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="h-10 min-w-0 text-center text-xl font-bold font-mono border-0 bg-transparent p-0"
              />
              <span className="text-xs text-muted-foreground shrink-0">{unit}</span>
            </div>
          </div>
        ))}
      </div>

      {isOpenDay && <IntakePace openDay={openDay} protein={values.protein} carbs={values.carbs} />}
    </div>
  );
}
