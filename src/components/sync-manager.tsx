"use client";

import { useEffect } from "react";
import { createClient, getLocalUser, rememberUserId } from "@/lib/supabase/client";
import { requestSync, startSyncEngine } from "@/lib/sync";
import { refreshReferenceData } from "@/lib/reference-data";

const WARM_KEY = "sw_shell_warmed_at";
const WARM_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Ask the service worker to cache every screen (and its JS) while there's
 * signal, so the app opens and navigates with none.
 */
function warmOfflineShell(force = false) {
  if (!("serviceWorker" in navigator) || !navigator.onLine) return;
  try {
    const last = Number(localStorage.getItem(WARM_KEY) || 0);
    if (!force && Date.now() - last < WARM_INTERVAL_MS) return;
    localStorage.setItem(WARM_KEY, String(Date.now()));
  } catch {}
  // Include what this page already loaded — the first visit happens before
  // the worker is in control, so those files would otherwise never be cached
  const urls = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => u.includes("/_next/static/"));
  navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: "warm", urls }))
    .catch(() => {});
}

export function SyncManager() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      if (process.env.NODE_ENV === "production") {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      } else {
        // Dev chunk names don't change between edits, so a cache-first worker
        // serves stale code and Next reloads in a loop. Offline is prod-only.
        navigator.serviceWorker
          .getRegistrations()
          .then((regs) => regs.forEach((r) => r.unregister()))
          .catch(() => {});
      }
    }
    startSyncEngine();

    const supabase = createClient();
    const refresh = (force = false) => {
      refreshReferenceData(supabase, { force });
      warmOfflineShell(force);
    };

    getLocalUser(supabase).then((user) => {
      if (user) refresh();
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!session?.user) return;
      rememberUserId(session.user.id);
      if (event === "SIGNED_IN") {
        // Deferred: Supabase calls inside this callback can deadlock the auth lock
        setTimeout(() => {
          requestSync(0);
          refresh(true);
        }, 0);
      }
    });

    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onOnline = () => refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      subscription.unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}
