// Run workout templates.
//
// Templates are pure data. The generic defaults below ship with the repo;
// the owner's actual training plan is supplied privately at build time via
// the NEXT_PUBLIC_RUN_TEMPLATES env var (a JSON array of RunTemplate).
// This keeps personal programming out of the public repo while letting the
// deployed app use the real plan.

export interface TierBenchmark {
  label: string;
  pool: "easy" | "threshold";
  target: string;
  /** Upper bound in minutes for this tier; used to grade timed returns. */
  maxMinutes?: number;
}

export interface IntervalInput {
  id: string;
  label: string;
  target: string;
  inputType: "time_minutes";
}

export interface VariantOption {
  id: string;
  label: string;
  description: string;
  intervals?: IntervalInput[];
}

export interface RunTemplate {
  id: string;
  name: string;
  pools: ("easy" | "threshold" | "speed")[];
  surface: string;
  footwear: string;
  stravaUseful: boolean;
  trackingMode: "timer_only" | "manual_splits" | "timer_with_variant";
  description: string;
  durationEst: string;
  variants?: VariantOption[];
  tiers?: TierBenchmark[];
  intervals?: IntervalInput[];
}

const DEFAULT_TEMPLATES: RunTemplate[] = [
  {
    id: "easy_run",
    name: "Easy Run",
    pools: ["easy"],
    surface: "road",
    footwear: "running_shoes",
    stravaUseful: true,
    trackingMode: "timer_only",
    description: "Relaxed run at conversational pace.",
    durationEst: "~30 min",
  },
  {
    id: "intervals",
    name: "Intervals",
    pools: ["threshold"],
    surface: "road",
    footwear: "running_shoes",
    stravaUseful: true,
    trackingMode: "manual_splits",
    description: "Timed repeats on a track or measured course.",
    durationEst: "~40 min",
    intervals: [
      { id: "rep_1", label: "Rep 1", target: "goal pace", inputType: "time_minutes" },
      { id: "rep_2", label: "Rep 2", target: "goal pace", inputType: "time_minutes" },
      { id: "rep_3", label: "Rep 3", target: "goal pace", inputType: "time_minutes" },
    ],
  },
  {
    id: "sprints",
    name: "Sprints",
    pools: ["speed"],
    surface: "road",
    footwear: "running_shoes",
    stravaUseful: false,
    trackingMode: "timer_only",
    description: "Short max-effort sprint work. Total time is the metric.",
    durationEst: "~20 min",
  },
];

/** "running_shoes" -> "Running shoes" — display helper for tag-style values. */
export function humanizeTag(value: string): string {
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function loadTemplates(): RunTemplate[] {
  const raw = process.env.NEXT_PUBLIC_RUN_TEMPLATES;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as RunTemplate[];
      }
    } catch {
      console.warn("[run-templates] NEXT_PUBLIC_RUN_TEMPLATES is not valid JSON — using defaults");
    }
  }
  return DEFAULT_TEMPLATES;
}

export const RUN_TEMPLATES: RunTemplate[] = loadTemplates();

export const RUN_TEMPLATES_MAP = Object.fromEntries(
  RUN_TEMPLATES.map((t) => [t.id, t])
);

/** Intervals for a template, preferring the selected variant's own list. */
export function getIntervalsFor(
  template: RunTemplate | undefined,
  variantId?: string | null
): IntervalInput[] {
  if (!template) return [];
  if (variantId && template.variants) {
    const variant = template.variants.find((v) => v.id === variantId);
    if (variant?.intervals) return variant.intervals;
  }
  return template.intervals ?? [];
}

/** Grade a timed return against a template's bounded tiers. */
export function getTierForReturn(
  template: RunTemplate | undefined,
  returnMinutes: number
): TierBenchmark | null {
  const tiers = (template?.tiers ?? [])
    .filter((t) => t.maxMinutes != null)
    .sort((a, b) => a.maxMinutes! - b.maxMinutes!);
  if (tiers.length === 0) return null;
  for (const tier of tiers) {
    if (returnMinutes < tier.maxMinutes!) return tier;
  }
  const last = tiers[tiers.length - 1];
  return returnMinutes <= last.maxMinutes! ? last : null;
}

/** Back-compat helper used by the run session page. */
export function getTierForBacktracker(returnMinutes: number): TierBenchmark | null {
  return getTierForReturn(RUN_TEMPLATES_MAP["backtracker"], returnMinutes);
}
