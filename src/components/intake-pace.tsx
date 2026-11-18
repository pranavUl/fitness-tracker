"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import {
  computePace,
  formatMinute,
  MIN_DAYS,
  useIntakeEvents,
  type IntakeField,
  type Pace,
} from "@/lib/intake";
import { dayStart } from "@/lib/nutrition-day";
import { cn } from "@/lib/utils";

const ROWS: { field: IntakeField; label: string; bar: string }[] = [
  { field: "protein", label: "Protein", bar: "bg-orange-400" },
  { field: "carbs", label: "Carbs", bar: "bg-amber-400" },
];

/** "By now you usually have X" for the open day, from past days' meal timing. */
export function IntakePace({
  openDay,
  protein,
  carbs,
}: {
  openDay: string;
  protein: number | null;
  carbs: number | null;
}) {
  const events = useIntakeEvents();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  if (!events || now == null) return null;

  const minute = (now - dayStart(openDay).getTime()) / 60000;
  const today = { protein: protein ?? 0, carbs: carbs ?? 0 };
  const results = ROWS.map((r) => ({ ...r, ...computePace(events, r.field, openDay, minute) }));
  const ready = results.filter((r) => r.pace);

  if (ready.length === 0) {
    const days = Math.max(...results.map((r) => r.days));
    return (
      <div className="flex items-start gap-2 rounded-2xl border border-dashed border-border px-3 py-2.5">
        <Clock className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
        <p className="text-[11px] text-muted-foreground leading-snug">
          {`Learning when you eat — log food as you eat it. Pacing shows up after ${MIN_DAYS} days (${days} so far).`}
        </p>
      </div>
    );
  }

  const times = ready.map((r) => ({ name: r.label.toLowerCase(), at: formatMinute(r.pace!.halfway) }));
  const halfway =
    times.length === 2 && times[0].at === times[1].at
      ? `half your protein and carbs are in by ${times[0].at}`
      : times.map((t, i) => `${i === 0 ? "half your " : ""}${t.name} ${i === 0 ? "is in " : ""}by ${t.at}`).join(", ");

  return (
    <div className="rounded-2xl border border-border bg-card px-3 py-2.5 space-y-2.5">
      <div className="flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground">
          {`Usual by ${formatMinute(minute)}`}
        </p>
      </div>
      {ready.map((r) => (
        <PaceRow key={r.field} label={r.label} bar={r.bar} today={today[r.field]} pace={r.pace!} />
      ))}
      <p className="text-[11px] text-muted-foreground/80 leading-snug">
        {`On a usual day, ${halfway}.`}
      </p>
    </div>
  );
}

function PaceRow({
  label,
  bar,
  today,
  pace,
}: {
  label: string;
  bar: string;
  today: number;
  pace: Pace;
}) {
  const scale = Math.max(pace.usualTotal, pace.usualNow, today, 1);
  const diff = Math.round(today - pace.usualNow);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  return (
    <div>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-muted-foreground w-14">{label}</span>
        <span className="font-semibold tabular-nums">{`${Math.round(today)}g`}</span>
        <span className="text-muted-foreground tabular-nums">{`/ ${pace.usualNow}g usual`}</span>
        <span
          className={cn(
            "ml-auto font-medium tabular-nums",
            diff >= 0 ? "text-emerald-400" : "text-amber-400"
          )}
        >
          {diff >= 0 ? `+${diff}g` : `−${Math.abs(diff)}g`}
        </span>
      </div>
      <div className="relative mt-1 h-1.5 rounded-full bg-muted">
        <div className={cn("absolute inset-y-0 left-0 rounded-full", bar)} style={{ width: pct(today) }} />
        <div
          className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-foreground/70"
          style={{ left: pct(pace.usualNow) }}
          title="Usual by now"
        />
      </div>
    </div>
  );
}
