"use client";

import { AlertTriangle, WifiOff } from "lucide-react";
import { useSyncStatus } from "@/lib/hooks/use-sync-status";
import { cn } from "@/lib/utils";

/** Only speaks up when something is waiting on the network. */
export function SyncIndicator({ className }: { className?: string }) {
  const s = useSyncStatus();

  if (s.failed > 0) {
    return (
      <Banner tone="error" className={className}>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {s.failed} change{s.failed !== 1 ? "s" : ""} couldn&apos;t sync — still saved on this phone
      </Banner>
    );
  }
  if (s.pending === 0) return null;
  if (s.needsSignIn) {
    return (
      <Banner tone="warn" className={className}>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>
          Saved on this phone.{" "}
          <a href="/login" className="underline">
            Sign in again
          </a>{" "}
          to sync.
        </span>
      </Banner>
    );
  }
  if (!s.online) {
    return (
      <Banner tone="warn" className={className}>
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        Offline — saved on this phone, syncs when you&apos;re back online
      </Banner>
    );
  }
  return null;
}

function Banner({
  tone,
  className,
  children,
}: {
  tone: "warn" | "error";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        tone === "warn"
          ? "bg-amber-500/10 border-amber-500/20 text-amber-400"
          : "bg-red-500/10 border-red-500/20 text-red-400",
        className
      )}
    >
      {children}
    </div>
  );
}
