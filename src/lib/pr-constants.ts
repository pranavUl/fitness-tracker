import { PrType } from "@/types/database.types";

export const PR_BADGE_STYLES: Record<PrType, string> = {
  WEIGHT: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  "1RM": "bg-teal-500/20 text-teal-400 border-teal-500/30",
  VOL: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  REPS: "bg-green-500/20 text-green-400 border-green-500/30",
  DURATION: "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

export const PR_BADGE_LABELS: Record<PrType, string> = {
  WEIGHT: "🏆 WEIGHT",
  "1RM": "🏆 1RM",
  VOL: "🏆 VOL.",
  REPS: "🏆 REPS",
  DURATION: "🏆 DURATION",
};

export const PR_FLAG_MAP: Record<PrType, string> = {
  WEIGHT: "is_pr_weight",
  "1RM": "is_pr_1rm",
  VOL: "is_pr_volume",
  REPS: "is_pr_reps",
  DURATION: "is_pr_duration",
};
