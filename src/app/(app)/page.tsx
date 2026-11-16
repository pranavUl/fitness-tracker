"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient, getUserId } from "@/lib/supabase/client";
import { Database } from "@/types/database.types";
import { GymSelector } from "@/components/workout/gym-selector";
import { Input } from "@/components/ui/input";
import { SyncIndicator } from "@/components/sync-indicator";
import { DailyTracker } from "@/components/daily-tracker";
import {
  WorkoutRecord,
  getActiveLocalWorkout,
  kvGet,
  kvSet,
  listWorkoutRecords,
  mergePendingRows,
  queueUpsert,
  saveWorkoutLocal,
} from "@/lib/offline";
import { getCachedGyms } from "@/lib/reference-data";
import {
  Dumbbell,
  Play,
  MapPin,
  Timer,
  Weight,
  Check,
  Zap,
  Footprints,
  Gauge,
  ChevronRight,
  Calendar,
  CalendarX,
  Link2,
  Goal,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { RUN_TEMPLATES, humanizeTag, type RunTemplate } from "@/lib/run-workout-structures";

type Workout = Database["public"]["Tables"]["workouts"]["Row"];
type RunSession = Database["public"]["Tables"]["run_sessions"]["Row"];

interface CalendarEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
}

interface CalendarState {
  events: CalendarEvent[];
  connected: boolean;
  calendarSelected: boolean;
  missedYesterday: CalendarEvent[];
}

interface TodayWorkout {
  id: string;
  title: string | null;
  gym_name: string | null;
  started_at: string;
  finished_at: string | null;
  exercise_count: number;
  set_count: number;
  total_volume: number;
}

/** What the server said last time (cached per day); local changes are layered on top. */
interface HomeSnapshot {
  activeWorkout: Workout | null;
  todayWorkouts: TodayWorkout[];
  todayRuns: RunSession[];
  calendar: CalendarState;
}

type HomeBase = Omit<HomeSnapshot, "calendar">;

const EMPTY_BASE: HomeBase = {
  activeWorkout: null,
  todayWorkouts: [],
  todayRuns: [],
};

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function summarizeRecord(
  r: WorkoutRecord,
  gymName: (id: string | null) => string | null
): TodayWorkout {
  let setCount = 0;
  let volume = 0;
  for (const ex of r.exercises) {
    for (const s of ex.sets) {
      setCount++;
      if (!s.is_warmup && s.weight && s.reps) volume += s.weight * s.reps;
    }
  }
  return {
    id: r.workout.id,
    title: r.workout.title,
    gym_name: gymName(r.workout.gym_id),
    started_at: r.workout.started_at,
    finished_at: r.workout.finished_at,
    exercise_count: r.exercises.length,
    set_count: setCount,
    total_volume: volume,
  };
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

const POOL_ICON: Record<string, { Icon: typeof Zap; color: string; bg: string }> = {
  speed: { Icon: Zap, color: "text-red-400", bg: "bg-red-500/15" },
  easy: { Icon: Footprints, color: "text-green-400", bg: "bg-green-500/15" },
  threshold: { Icon: Gauge, color: "text-amber-400", bg: "bg-amber-500/15" },
};

export default function HomePage() {
  const [workoutTypeOpen, setWorkoutTypeOpen] = useState(false);
  const [gymPickerOpen, setGymPickerOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [soccerOpen, setSoccerOpen] = useState(false);
  const [soccerMinutes, setSoccerMinutes] = useState("");
  const [soccerField, setSoccerField] = useState("");
  const [soccerNotes, setSoccerNotes] = useState("");
  const [savingSoccer, setSavingSoccer] = useState(false);
  const [variantPickerOpen, setVariantPickerOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<RunTemplate | null>(null);
  const [activeWorkout, setActiveWorkout] = useState<Workout | null>(null);
  const [todayWorkouts, setTodayWorkouts] = useState<TodayWorkout[]>([]);
  const [todayRuns, setTodayRuns] = useState<RunSession[]>([]);
  const [loading, setLoading] = useState(true);

  const [, setDayTick] = useState(0);
  const [calendar, setCalendar] = useState<CalendarState>({ events: [], connected: false, calendarSelected: false, missedYesterday: [] });
  const [calendarPickerOpen, setCalendarPickerOpen] = useState(false);
  const [availableCalendars, setAvailableCalendars] = useState<{ id: string; name: string; color?: string }[]>([]);
  const networkLoadedRef = useRef(false);
  const baseRef = useRef<HomeBase>(EMPTY_BASE);
  const renderSeqRef = useRef(0);
  const calendarRef = useRef(calendar);
  useEffect(() => { calendarRef.current = calendar; }, [calendar]);

  const supabase = createClient();
  const router = useRouter();

  const now = new Date();
  const today = dayKey(now);
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterday = dayKey(yesterdayDate);

  // Each day's numbers live in their own row, so a new day starts blank.
  // Roll over at midnight (and when reopened the next morning) even if the
  // app stayed open, so nothing shows or saves into yesterday.
  useEffect(() => {
    const rollover = () => {
      if (dayKey(new Date()) === today) return;
      baseRef.current = EMPTY_BASE;
      networkLoadedRef.current = false;
      setDayTick((t) => t + 1);
    };
    const t = new Date();
    const msToMidnight =
      new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime() - t.getTime();
    const timer = setTimeout(rollover, msToMidnight + 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") rollover();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", rollover);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", rollover);
    };
  }, [today]);

  /** Paint the server's view with everything saved on this phone layered on top. */
  const render = useCallback(async (base: HomeBase) => {
    baseRef.current = base;
    const seq = ++renderSeqRef.current;
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const isToday = (iso: string | null) => {
      const t = iso ? new Date(iso).getTime() : NaN;
      return t >= dayStart && t < dayStart + 24 * 60 * 60 * 1000;
    };
    const [records, gyms, localActive, runs] = await Promise.all([
      listWorkoutRecords(),
      getCachedGyms(),
      getActiveLocalWorkout(),
      mergePendingRows("run_sessions", base.todayRuns),
    ]);
    // A newer paint (e.g. fresh network data) started while this one was
    // reading, or midnight passed and this is yesterday's data
    if (seq !== renderSeqRef.current || dayKey(new Date()) !== today) return;
    const byId = new Map(records.map((r) => [r.workout.id, r]));
    const gymName = (id: string | null) => gyms?.find((g) => g.id === id)?.name ?? null;

    // A server-side in-progress workout doesn't count if this phone finished or discarded it
    let active = localActive ?? base.activeWorkout;
    const activeRec = active && !localActive ? byId.get(active.id) : undefined;
    if (activeRec && (activeRec.deleted || activeRec.workout.finished_at)) active = null;

    const localToday = records
      .filter((r) => !r.deleted && r.workout.finished_at && isToday(r.workout.started_at))
      .map((r) => summarizeRecord(r, gymName));
    const workouts = [
      ...base.todayWorkouts.filter((w) => !byId.has(w.id)),
      ...localToday,
    ].sort((a, b) => b.started_at.localeCompare(a.started_at));

    setActiveWorkout(active);
    setTodayWorkouts(workouts);
    setTodayRuns(
      runs
        .filter((r) => isToday(r.started_at))
        .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  const load = useCallback(async () => {
    try {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();

    const [inProgressRes, todayWsRes, runsRes] = await Promise.all([
      supabase
        .from("workouts")
        .select("*")
        .is("finished_at", null)
        .order("started_at", { ascending: false })
        .limit(1),
      supabase
        .from("workouts")
        .select("*")
        .not("finished_at", "is", null)
        .gte("started_at", startOfDay)
        .lte("started_at", endOfDay)
        .order("started_at", { ascending: false }),
      supabase
        .from("run_sessions")
        .select("*")
        .gte("started_at", startOfDay)
        .lte("started_at", endOfDay)
        .order("started_at", { ascending: false }),
    ]);
    // Supabase reports "no signal" as an error, not an exception
    if (inProgressRes.error || todayWsRes.error || runsRes.error) {
      throw new Error("offline");
    }

    let snapTodayWorkouts: TodayWorkout[] = [];
    const todayWs = todayWsRes.data || [];
    if (todayWs.length) {
      const workoutIds = todayWs.map((w) => w.id);
      const gymIds = [...new Set(todayWs.map((w) => w.gym_id).filter(Boolean))] as string[];

      const [wesRes, gymsRes] = await Promise.all([
        supabase.from("workout_exercises").select("id, workout_id").in("workout_id", workoutIds),
        gymIds.length
          ? supabase.from("gyms").select("id, name").in("id", gymIds)
          : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
      ]);
      if (wesRes.error || gymsRes.error) throw new Error("offline");

      const gymMap = new Map((gymsRes.data || []).map((g) => [g.id, g.name]));
      const weIds = (wesRes.data || []).map((we) => we.id);
      const wesByWorkout = new Map<string, string[]>();
      for (const we of wesRes.data || []) {
        const arr = wesByWorkout.get(we.workout_id) || [];
        arr.push(we.id);
        wesByWorkout.set(we.workout_id, arr);
      }

      let setsData: Database["public"]["Tables"]["sets"]["Row"][] = [];
      if (weIds.length) {
        const { data, error } = await supabase.from("sets").select("*").in("workout_exercise_id", weIds);
        if (error) throw new Error("offline");
        setsData = data || [];
      }

      const setsByWe = new Map<string, Database["public"]["Tables"]["sets"]["Row"][]>();
      for (const s of setsData) {
        const arr = setsByWe.get(s.workout_exercise_id) || [];
        arr.push(s);
        setsByWe.set(s.workout_exercise_id, arr);
      }

      snapTodayWorkouts = todayWs.map((w) => {
        const weList = wesByWorkout.get(w.id) || [];
        let setCount = 0;
        let volume = 0;
        for (const weId of weList) {
          const sets = setsByWe.get(weId) || [];
          setCount += sets.length;
          for (const s of sets) {
            if (!s.is_warmup && s.weight && s.reps) volume += s.weight * s.reps;
          }
        }
        return {
          id: w.id,
          title: w.title,
          gym_name: w.gym_id ? gymMap.get(w.gym_id) || null : null,
          started_at: w.started_at,
          finished_at: w.finished_at,
          exercise_count: weList.length,
          set_count: setCount,
          total_volume: volume,
        };
      });
    }

    const base: HomeBase = {
      activeWorkout: inProgressRes.data?.[0] || null,
      todayWorkouts: snapTodayWorkouts,
      todayRuns: runsRes.data || [],
    };
    networkLoadedRef.current = true;
    await render(base);
    setLoading(false);

    // Fetch calendar events (today + yesterday for missed detection)
    let snapCalendar: CalendarState = {
      events: [],
      connected: false,
      calendarSelected: false,
      missedYesterday: [],
    };
    try {
      const [todayEventsRes, yesterdayEventsRes] = await Promise.all([
        fetch(`/api/google/events?date=${today}`, { signal: AbortSignal.timeout(8000) }),
        fetch(`/api/google/events?date=${yesterday}`, { signal: AbortSignal.timeout(8000) }),
      ]);
      const todayData = await todayEventsRes.json();
      const yesterdayData = await yesterdayEventsRes.json();

      // Check yesterday for missed events: any calendar event on a day with no completed workout
      const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();
      const yesterdayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999).toISOString();
      const { data: yesterdayWorkouts } = await supabase
        .from("workouts")
        .select("id")
        .not("finished_at", "is", null)
        .gte("started_at", yesterdayStart)
        .lte("started_at", yesterdayEnd)
        .limit(1);

      const hadWorkoutYesterday = (yesterdayWorkouts?.length ?? 0) > 0;
      const missedYesterday = hadWorkoutYesterday ? [] : (yesterdayData.events || []);

      snapCalendar = {
        events: todayData.events || [],
        connected: todayData.connected ?? false,
        calendarSelected: todayData.calendarSelected ?? false,
        missedYesterday,
      };
      setCalendar(snapCalendar);
    } catch {
      // Calendar not configured or offline — keep whatever state we had
      snapCalendar = calendarRef.current;
    }

    // Persist snapshot so the next open paints instantly
    kvSet(`home:${today}`, { ...base, calendar: snapCalendar } satisfies HomeSnapshot);
    } catch {
      // No signal — show the last snapshot plus whatever is saved on this phone
      await render(baseRef.current);
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today, render]);

  // Instant paint from the last snapshot while the network load runs
  useEffect(() => {
    kvGet<HomeSnapshot>(`home:${today}`).then(async (snap) => {
      if (networkLoadedRef.current) return;
      if (snap) setCalendar(snap.calendar);
      await render(snap ?? EMPTY_BASE);
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  useEffect(() => {
    load();
    function onVisibilityChange() {
      if (document.visibilityState === "visible") load();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gcal") === "connected") {
      window.history.replaceState({}, "", "/");
      fetch("/api/google/calendars")
        .then((r) => r.json())
        .then((data) => {
          if (data.calendars?.length) {
            setAvailableCalendars(data.calendars);
            setCalendarPickerOpen(true);
          }
        })
        .catch(() => {});
    }
  }, []);

  /** Keep the cached server view in step with a local edit, for the next offline open. */
  async function patchSnapshot(patch: (snap: HomeSnapshot) => HomeSnapshot) {
    const snap = await kvGet<HomeSnapshot>(`home:${today}`);
    await kvSet(`home:${today}`, patch(snap ?? { ...baseRef.current, calendar: calendarRef.current }));
  }

  async function handleStartWorkout(gym: { id: string; name: string }) {
    setGymPickerOpen(false);
    const userId = await getUserId(supabase);
    if (!userId) return;
    const startedAt = new Date().toISOString();
    const workout: Workout = {
      id: crypto.randomUUID(),
      user_id: userId,
      gym_id: gym.id,
      title: `${gym.name} Workout`,
      started_at: startedAt,
      finished_at: null,
      notes: null,
      workout_type: "lifting",
      created_at: startedAt,
    };
    // Created on the phone — works with zero signal, syncs later
    await saveWorkoutLocal(workout.id, { workout, exercises: [], prs: {} }, { dirty: true });
    try { localStorage.setItem("active_workout_id", workout.id); } catch {}
    router.push(`/workout?id=${workout.id}`);
  }

  async function saveSoccer() {
    const minutes = parseInt(soccerMinutes);
    if (isNaN(minutes) || minutes <= 0) return;
    setSavingSoccer(true);
    try {
      const userId = await getUserId(supabase);
      if (!userId) return;
      const insert = {
        id: crypto.randomUUID(),
        user_id: userId,
        source: "manual",
        name: "Soccer",
        run_pool: "soccer",
        started_at: new Date().toISOString(),
        duration_seconds: minutes * 60,
        completed: true,
        notes: soccerNotes.trim() || null,
        raw_data: {
          type: "soccer",
          ...(soccerField.trim() ? { field: soccerField.trim() } : {}),
        },
      };
      await queueUpsert("run_sessions", insert);
      const row: RunSession = {
        strava_id: null,
        run_workout: null,
        distance_meters: null,
        avg_pace: null,
        avg_heart_rate: null,
        polyline: null,
        synced_at: insert.started_at,
        ...insert,
      };
      await patchSnapshot((s) => ({ ...s, todayRuns: [row, ...s.todayRuns.filter((r) => r.id !== row.id)] }));
      setSoccerOpen(false);
      setSoccerMinutes("");
      setSoccerField("");
      setSoccerNotes("");
      await render({ ...baseRef.current, todayRuns: [row, ...baseRef.current.todayRuns] });
    } finally {
      setSavingSoccer(false);
    }
  }

  function handleSelectTemplate(template: RunTemplate) {
    setTemplatePickerOpen(false);
    if (template.variants) {
      setSelectedTemplate(template);
      setVariantPickerOpen(true);
    } else {
      createRunSession(template, null);
    }
  }

  async function createRunSession(template: RunTemplate, variantId: string | null) {
    setVariantPickerOpen(false);
    const userId = await getUserId(supabase);
    if (!userId) return;

    const variant = variantId && template.variants
      ? template.variants.find((v) => v.id === variantId)
      : null;

    const name = variant ? `${template.name} — ${variant.label}` : template.name;

    const id = crypto.randomUUID();
    await queueUpsert("run_sessions", {
      id,
      user_id: userId,
      source: "manual",
      name,
      run_pool: template.pools[0],
      run_workout: template.id,
      started_at: new Date().toISOString(),
      completed: false,
      raw_data: {
        templateId: template.id,
        ...(variantId ? { variantId } : {}),
      },
    });
    router.push(`/run?id=${id}`);
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-lg px-4 pt-12">
        <div className="space-y-6">
          <div className="h-8 w-40 animate-pulse rounded-lg bg-muted" />
          <div className="h-14 animate-pulse rounded-2xl bg-muted" />
          <div className="grid grid-cols-2 gap-3">
            <div className="h-24 animate-pulse rounded-xl bg-muted" />
            <div className="h-24 animate-pulse rounded-xl bg-muted" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 pt-6 pb-24">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {getGreeting()}
          </h1>
          <p className="text-sm text-muted-foreground">
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
        </div>

        <SyncIndicator />

        {activeWorkout ? (
          <button
            onClick={() => router.push(`/workout?id=${activeWorkout.id}`)}
            className="flex h-14 w-full items-center justify-center gap-3 rounded-2xl bg-amber-600 text-white text-lg font-semibold shadow-lg shadow-amber-600/20 transition-all active:scale-[0.97]"
          >
            <Play className="h-5 w-5" />
            Resume Workout
          </button>
        ) : (
          <button
            onClick={() => setWorkoutTypeOpen(true)}
            className="flex h-14 w-full items-center justify-center gap-3 rounded-2xl bg-primary text-primary-foreground text-lg font-semibold shadow-lg shadow-primary/20 transition-all active:scale-[0.97]"
          >
            <Dumbbell className="h-5 w-5" />
            Start Workout
          </button>
        )}

        {/* Today's Plan (Google Calendar) */}
        {calendar.connected && calendar.calendarSelected && calendar.events.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Today&apos;s Plan</h2>
            {calendar.events.map((ev) => {
              const matched = todayWorkouts.length > 0;
              return (
                <div key={ev.id} className={`rounded-2xl border p-4 ${matched ? "border-green-500/30 bg-green-600/5" : "border-border bg-card"}`}>
                  <div className="flex items-center gap-3">
                    <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${matched ? "bg-green-600/15" : "bg-muted"}`}>
                      {matched ? <Check className="h-4 w-4 text-green-500" /> : <Calendar className="h-4 w-4 text-muted-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`font-semibold text-sm truncate ${matched ? "" : "text-muted-foreground"}`}>{ev.title}</p>
                      {!ev.allDay && (
                        <p className="text-[11px] text-muted-foreground">
                          {new Date(ev.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        </p>
                      )}
                    </div>
                    {matched && <span className="text-[10px] font-medium text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full">Done</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Missed Yesterday */}
        {calendar.missedYesterday.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-red-400/80">Missed Yesterday</h2>
            {calendar.missedYesterday.map((ev) => (
              <div key={ev.id} className="rounded-2xl border border-red-500/20 bg-red-600/5 p-4">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-xl bg-red-500/15 flex items-center justify-center shrink-0">
                    <CalendarX className="h-4 w-4 text-red-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate text-red-300/80">{ev.title}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {yesterdayDate.toLocaleDateString("en-US", { weekday: "long" })}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Connect Calendar CTA */}
        {!calendar.connected && (
          <a href="/api/google/connect" className="flex items-center gap-3 rounded-2xl border border-dashed border-border p-4 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors">
            <Link2 className="h-5 w-5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Connect Google Calendar</p>
              <p className="text-xs text-muted-foreground">See your health schedule here</p>
            </div>
          </a>
        )}

        {/* Calendar connected but no calendar selected */}
        {calendar.connected && !calendar.calendarSelected && (
          <button
            onClick={async () => {
              const res = await fetch("/api/google/calendars");
              const data = await res.json();
              if (data.calendars?.length) {
                setAvailableCalendars(data.calendars);
                setCalendarPickerOpen(true);
              }
            }}
            className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-primary/30 p-4 text-left transition-colors hover:bg-accent"
          >
            <Calendar className="h-5 w-5 text-primary shrink-0" />
            <div>
              <p className="text-sm font-medium">Select a calendar</p>
              <p className="text-xs text-muted-foreground">Pick which calendar shows your health schedule</p>
            </div>
          </button>
        )}

        {/* Daily Tracking: protein / carbs / weight, by day */}
        <DailyTracker />

        {/* Today's Workouts + Runs */}
        {(todayWorkouts.length > 0 || todayRuns.length > 0) && (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Today</h2>
            {todayWorkouts.map((w) => (
              <button key={w.id} onClick={() => router.push(`/workout/summary?id=${w.id}`)} className="w-full rounded-2xl border border-border bg-card p-4 text-left transition-all hover:bg-accent active:scale-[0.98]">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-xl bg-green-600/15 flex items-center justify-center shrink-0">
                    <Check className="h-4 w-4 text-green-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">{w.title || "Workout"}</p>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                      {w.gym_name && <span className="flex items-center gap-0.5"><MapPin className="h-2.5 w-2.5" />{w.gym_name}</span>}
                      {w.finished_at && <span className="flex items-center gap-0.5"><Timer className="h-2.5 w-2.5" />{formatDuration(w.started_at, w.finished_at)}</span>}
                      {w.total_volume > 0 && <span className="flex items-center gap-0.5"><Weight className="h-2.5 w-2.5" />{w.total_volume.toLocaleString()} lb</span>}
                    </div>
                  </div>
                </div>
              </button>
            ))}
            {todayRuns.map((r) => {
              const done = r.duration_seconds != null;
              const isSoccer = r.run_pool === "soccer";
              const soccerFieldName = isSoccer
                ? ((r.raw_data as { field?: string } | null)?.field ?? null)
                : null;
              return (
                <button key={r.id} onClick={() => router.push(`/run?id=${r.id}`)} className="w-full rounded-2xl border border-border bg-card p-4 text-left transition-all hover:bg-accent active:scale-[0.98]">
                  <div className="flex items-center gap-3">
                    <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${isSoccer ? "bg-sky-500/15" : done ? "bg-green-600/15" : "bg-amber-500/15"}`}>
                      {isSoccer ? <Goal className="h-4 w-4 text-sky-400" /> : done ? <Check className="h-4 w-4 text-green-500" /> : <Footprints className="h-4 w-4 text-amber-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-sm truncate">{r.name}</p>
                        {done && !r.completed && <span className="text-[10px] text-amber-400 bg-amber-400/10 px-1.5 rounded">Partial</span>}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        {soccerFieldName && <span className="flex items-center gap-0.5"><MapPin className="h-2.5 w-2.5" />{soccerFieldName}</span>}
                        {r.duration_seconds != null && <span className="flex items-center gap-0.5"><Timer className="h-2.5 w-2.5" />{Math.floor(r.duration_seconds / 60)}m</span>}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Workout Type Picker */}
      <Drawer open={workoutTypeOpen} onOpenChange={setWorkoutTypeOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>What are you doing?</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-8 space-y-2">
            <button onClick={() => { setWorkoutTypeOpen(false); setGymPickerOpen(true); }} className="flex w-full items-center gap-4 rounded-xl border border-border bg-card p-4 text-left transition-all active:scale-[0.98]">
              <div className="h-10 w-10 rounded-xl bg-primary/15 flex items-center justify-center">
                <Dumbbell className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-sm">Lift</p>
                <p className="text-xs text-muted-foreground">Gym workout with exercises and sets</p>
              </div>
            </button>
            <button onClick={() => { setWorkoutTypeOpen(false); setTemplatePickerOpen(true); }} className="flex w-full items-center gap-4 rounded-xl border border-border bg-card p-4 text-left transition-all active:scale-[0.98]">
              <div className="h-10 w-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                <Footprints className="h-5 w-5 text-amber-400" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-sm">Run</p>
                <p className="text-xs text-muted-foreground">Easy, threshold, or speed work</p>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
            <button onClick={() => { setWorkoutTypeOpen(false); setSoccerOpen(true); }} className="flex w-full items-center gap-4 rounded-xl border border-border bg-card p-4 text-left transition-all active:scale-[0.98]">
              <div className="h-10 w-10 rounded-xl bg-sky-500/15 flex items-center justify-center">
                <Goal className="h-5 w-5 text-sky-400" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-sm">Soccer</p>
                <p className="text-xs text-muted-foreground">Log a session — time, field, notes</p>
              </div>
            </button>
          </div>
        </DrawerContent>
      </Drawer>

      {/* Soccer quick log */}
      <Drawer open={soccerOpen} onOpenChange={setSoccerOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Log Soccer</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-8 space-y-3">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                placeholder="60"
                value={soccerMinutes}
                onChange={(e) => setSoccerMinutes(e.target.value)}
                className="h-12 text-center text-lg font-mono flex-1"
              />
              <span className="text-sm text-muted-foreground shrink-0 w-24">minutes played</span>
            </div>
            <Input
              placeholder="Field / location (optional)"
              value={soccerField}
              onChange={(e) => setSoccerField(e.target.value)}
              className="h-12"
            />
            <Textarea
              placeholder="Notes (optional)"
              value={soccerNotes}
              onChange={(e) => setSoccerNotes(e.target.value)}
              rows={2}
            />
            <Button
              onClick={saveSoccer}
              disabled={savingSoccer || !soccerMinutes.trim()}
              className="w-full h-12"
            >
              {savingSoccer ? "Saving..." : "Save"}
            </Button>
          </div>
        </DrawerContent>
      </Drawer>

      {/* Run Template Picker */}
      <Drawer open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Pick a run workout</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-8 space-y-2 max-h-[60vh] overflow-y-auto">
            {RUN_TEMPLATES.map((t) => {
              const pool = t.pools[0];
              const icon = POOL_ICON[pool] || POOL_ICON.speed;
              return (
                <button key={t.id} onClick={() => handleSelectTemplate(t)} className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-all active:scale-[0.98]">
                  <div className={`h-9 w-9 rounded-lg ${icon.bg} flex items-center justify-center shrink-0`}>
                    <icon.Icon className={`h-4 w-4 ${icon.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">{t.name}</p>
                    <p className="text-[10px] text-muted-foreground">{t.durationEst} · {humanizeTag(t.surface)}{t.footwear !== "running_shoes" ? ` · ${humanizeTag(t.footwear)}` : ""}</p>
                  </div>
                  {t.variants && <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />}
                </button>
              );
            })}
          </div>
        </DrawerContent>
      </Drawer>

      {/* Variant Picker */}
      <Drawer open={variantPickerOpen} onOpenChange={setVariantPickerOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{selectedTemplate?.name}</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-8 space-y-2 max-h-[60vh] overflow-y-auto">
            {selectedTemplate?.variants?.map((v) => (
              <button key={v.id} onClick={() => createRunSession(selectedTemplate!, v.id)} className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-all active:scale-[0.98]">
                <span className="font-mono text-xs text-muted-foreground/60 w-14 shrink-0">{v.id}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{v.label}</p>
                  <p className="text-[10px] text-muted-foreground">{v.description}</p>
                </div>
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>

      <GymSelector open={gymPickerOpen} onOpenChange={setGymPickerOpen} onSelect={handleStartWorkout} />

      {/* Calendar Picker */}
      <Drawer open={calendarPickerOpen} onOpenChange={setCalendarPickerOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Select your health calendar</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-8 space-y-2 max-h-[60vh] overflow-y-auto">
            {availableCalendars.map((cal) => (
              <button
                key={cal.id}
                onClick={async () => {
                  await fetch("/api/google/select-calendar", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ calendarId: cal.id, calendarName: cal.name }),
                  });
                  setCalendarPickerOpen(false);
                  load();
                }}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-all active:scale-[0.98]"
              >
                {cal.color && <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: cal.color }} />}
                <p className="font-medium text-sm">{cal.name}</p>
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}
