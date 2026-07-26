"use client";

import { useState } from "react";
import { ChevronDown, Footprints, Zap, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { RUN_TEMPLATES, humanizeTag, type RunTemplate } from "@/lib/run-workout-structures";

const POOL_CONFIG = {
  easy: { label: "Easy", icon: Footprints, color: "text-green-400" },
  threshold: { label: "Threshold", icon: Gauge, color: "text-amber-400" },
  speed: { label: "Speed", icon: Zap, color: "text-red-400" },
} as const;

type Pool = keyof typeof POOL_CONFIG;

function groupByPool(): Map<Pool, RunTemplate[]> {
  const map = new Map<Pool, RunTemplate[]>();
  for (const t of RUN_TEMPLATES) {
    const pool = t.pools[0] as Pool;
    if (!map.has(pool)) map.set(pool, []);
    map.get(pool)!.push(t);
  }
  return map;
}

export function RunPoolList() {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const grouped = groupByPool();

  function toggleCollapse(pool: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(pool)) next.delete(pool);
      else next.add(pool);
      return next;
    });
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {(["easy", "threshold", "speed"] as Pool[]).map((pool) => {
        const items = grouped.get(pool) || [];
        if (!items.length) return null;
        const config = POOL_CONFIG[pool];
        const Icon = config.icon;
        const isCollapsed = collapsed.has(pool);

        return (
          <div key={pool}>
            <button
              onClick={() => toggleCollapse(pool)}
              className="flex w-full items-center gap-2 py-2 text-left"
            >
              <Icon className={cn("h-4 w-4", config.color)} />
              <span className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {config.label}
              </span>
              <span className="text-xs text-muted-foreground/60 ml-1">
                {items.length}
              </span>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 ml-auto text-muted-foreground/40 transition-transform",
                  isCollapsed && "-rotate-90"
                )}
              />
            </button>

            {!isCollapsed && (
              <div className="space-y-2">
                {items.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => toggleExpand(t.id)}
                    className="w-full rounded-xl border border-border bg-card p-3 text-left transition-all active:scale-[0.98]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm flex-1 truncate">
                        {t.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {t.durationEst}
                      </span>
                    </div>

                    {expanded.has(t.id) && (
                      <div className="mt-2 pt-2 border-t border-border/50">
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t.description}
                        </p>

                        <div className="flex gap-2 mt-2 flex-wrap">
                          <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground">
                            {humanizeTag(t.surface)}
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground">
                            {humanizeTag(t.footwear)}
                          </span>
                          {t.stravaUseful && (
                            <span className="px-1.5 py-0.5 rounded bg-orange-500/15 text-[10px] text-orange-400">
                              Strava
                            </span>
                          )}
                          <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] text-muted-foreground">
                            {t.trackingMode.replace(/_/g, " ")}
                          </span>
                        </div>

                        {t.variants && (
                          <div className="mt-2 space-y-1">
                            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                              Variants
                            </p>
                            {t.variants.map((v) => (
                              <div key={v.id} className="flex items-center gap-2 text-xs">
                                <span className="font-mono text-muted-foreground/60 w-16 shrink-0">
                                  {v.id}
                                </span>
                                <span className="text-muted-foreground">
                                  {v.description}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        {t.tiers && (
                          <div className="mt-2 space-y-1">
                            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                              Tiers
                            </p>
                            {t.tiers.map((tier) => (
                              <div key={tier.label} className="flex items-center justify-between text-xs">
                                <span className="font-medium">{tier.label}</span>
                                <span className="text-muted-foreground">{tier.target}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
