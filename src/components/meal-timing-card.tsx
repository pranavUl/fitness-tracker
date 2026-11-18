"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Clock } from "lucide-react";
import {
  finalOf,
  formatMinute,
  halfwayMinute,
  mean,
  median,
  pastCurves,
  shareAfter,
  useIntakeEvents,
  valueAt,
  WINDOW_DAYS,
  type IntakeField,
  type Point,
} from "@/lib/intake";
import { computeOpenDay } from "@/lib/nutrition-day";
import { cn } from "@/lib/utils";

const FIELDS: Record<IntakeField, { label: string; color: string }> = {
  protein: { label: "Protein", color: "#ea580c" },
  carbs: { label: "Carbs", color: "#d97706" },
};
const BEFORE_COLOR = "rgba(255,255,255,0.35)";
const GRID_STROKE = "rgba(255,255,255,0.06)";
const TICK_STYLE = { fontSize: 10, fill: "rgba(255,255,255,0.45)" };
const TOOLTIP_STYLE = {
  background: "#1c2420",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "0.75rem",
  fontSize: "12px",
};

// 6 AM → 3 AM the next morning (a day stays open past midnight until finished)
const START = 6 * 60;
const END = 27 * 60;
const STEP = 30;
const TICKS = [6, 9, 12, 15, 18, 21, 24, 27].map((h) => h * 60);
const LATE = 21 * 60;
const MIDNIGHT = 24 * 60;

function tickLabel(m: number): string {
  const h = Math.floor(m / 60) % 24;
  return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`;
}

interface Stats {
  half: number;
  late: number;
  afterMidnight: number;
}

function stats(curves: Point[][]): Stats | null {
  if (curves.length === 0) return null;
  return {
    half: median(curves.map(halfwayMinute)),
    late: mean(curves.map((c) => shareAfter(c, LATE))),
    afterMidnight: mean(curves.map((c) => shareAfter(c, MIDNIGHT))),
  };
}

/** Average share of the day's total eaten by each time of day. */
function shareCurve(curves: Point[][], m: number): number | null {
  if (curves.length === 0) return null;
  return Math.round(mean(curves.map((c) => (valueAt(c, m) / finalOf(c)) * 100)));
}

function fmtDuration(mins: number): string {
  const m = Math.round(Math.abs(mins) / 5) * 5;
  const h = Math.floor(m / 60);
  return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`;
}

/** When in the day food gets eaten: last 7 days vs the weeks before. */
export function MealTimingCard() {
  const events = useIntakeEvents();
  const [field, setField] = useState<IntakeField>("protein");
  const [openDay, setOpenDay] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setOpenDay(computeOpenDay()), 0);
    return () => clearTimeout(t);
  }, []);

  const view = useMemo(() => {
    if (!events || !openDay) return null;
    const recent = pastCurves(events, field, openDay, 1, 7);
    const before = pastCurves(events, field, openDay, 8, WINDOW_DAYS);
    const showBefore = before.length >= 2;
    const rows = [];
    for (let m = START; m <= END; m += STEP) {
      rows.push({
        m,
        recent: shareCurve(recent, m),
        before: showBefore ? shareCurve(before, m) : null,
      });
    }
    return {
      days: recent.length + before.length,
      recentDays: recent.length,
      rows,
      showBefore,
      now: stats(recent),
      then: showBefore ? stats(before) : null,
    };
  }, [events, field, openDay]);

  const { color, label } = FIELDS[field];

  return (
    <div className="rounded-2xl border border-border bg-card p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Meal Timing</h2>
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/40 border border-border p-0.5 mb-3">
        {(Object.keys(FIELDS) as IntakeField[]).map((f) => (
          <button
            key={f}
            onClick={() => setField(f)}
            className={cn(
              "h-8 rounded-md text-sm transition-colors",
              field === f ? "bg-background font-medium" : "text-muted-foreground"
            )}
          >
            {FIELDS[f].label}
          </button>
        ))}
      </div>

      {!view ? (
        <div className="h-[230px] rounded-lg bg-muted/30 animate-pulse" />
      ) : view.recentDays === 0 ? (
        <div className="h-[170px] flex items-center justify-center rounded-lg border border-dashed border-border">
          <p className="text-xs text-muted-foreground text-center px-6">
            {view.days === 0
              ? `Fills in as you log ${label.toLowerCase()} through the day on Home. Log food as you eat it and finish the day when you're done.`
              : `No ${label.toLowerCase()} timing in the last 7 days. Log it as you eat on Home.`}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <StatTile
              label="Half by"
              value={formatMinute(view.now!.half)}
              delta={view.then ? view.now!.half - view.then.half : null}
              format={(d) => `${fmtDuration(d)} ${d < 0 ? "earlier" : "later"}`}
            />
            <StatTile
              label="After 9 PM"
              value={`${Math.round(view.now!.late * 100)}%`}
              delta={view.then ? (view.now!.late - view.then.late) * 100 : null}
              format={(d) => `${d > 0 ? "+" : "−"}${Math.round(Math.abs(d))} pts`}
            />
            <StatTile
              label="After midnight"
              value={`${Math.round(view.now!.afterMidnight * 100)}%`}
              delta={view.then ? (view.now!.afterMidnight - view.then.afterMidnight) * 100 : null}
              format={(d) => `${d > 0 ? "+" : "−"}${Math.round(Math.abs(d))} pts`}
            />
          </div>

          <ResponsiveContainer width="100%" height={170}>
            <LineChart data={view.rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="m"
                type="number"
                domain={[START, END]}
                ticks={TICKS}
                tickFormatter={tickLabel}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 50, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={36}
              />
              <ReferenceLine y={50} stroke="rgba(255,255,255,0.15)" strokeDasharray="2 4" />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as (typeof view.rows)[number];
                  return (
                    <div style={TOOLTIP_STYLE} className="px-3 py-2 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground">{`By ${formatMinute(row.m)}`}</p>
                      {row.recent != null && (
                        <p className="text-sm font-semibold" style={{ color }}>
                          {`${row.recent}% · last 7 days`}
                        </p>
                      )}
                      {row.before != null && (
                        <p className="text-xs text-muted-foreground">{`${row.before}% · before`}</p>
                      )}
                    </div>
                  );
                }}
              />
              {view.showBefore && (
                <Line
                  type="linear"
                  dataKey="before"
                  stroke={BEFORE_COLOR}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                />
              )}
              <Line
                type="linear"
                dataKey="recent"
                stroke={color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
          <p className="mt-2 text-[10px] text-muted-foreground/60">
            {`Share of each day's ${label.toLowerCase()} eaten by that time. Line further left = eating earlier. `}
            {view.showBefore
              ? `Solid = last 7 days (${view.recentDays}), dashed = the ${WINDOW_DAYS / 7 - 1} weeks before.`
              : `Last ${view.recentDays} day${view.recentDays === 1 ? "" : "s"}; a comparison line appears after another week.`}
          </p>
        </>
      )}
    </div>
  );
}

/** Lower is better for every stat here (earlier / less late eating). */
function StatTile({
  label,
  value,
  delta,
  format,
}: {
  label: string;
  value: string;
  delta: number | null;
  format: (d: number) => string;
}) {
  const shown = delta != null && Math.abs(delta) >= 1;
  return (
    <div className="rounded-lg bg-muted/30 px-2.5 py-2">
      <p className="text-base font-bold tabular-nums leading-tight">{value}</p>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      {shown && (
        <p
          className={cn(
            "text-[10px] font-medium tabular-nums mt-0.5",
            delta! < 0 ? "text-emerald-400" : "text-amber-400"
          )}
        >
          {format(delta!)}
        </p>
      )}
    </div>
  );
}
