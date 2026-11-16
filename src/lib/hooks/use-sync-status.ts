"use client";

import { useSyncExternalStore } from "react";
import {
  INITIAL_SYNC_STATUS,
  SyncStatus,
  getSyncStatus,
  subscribeSyncStatus,
} from "@/lib/sync";

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    subscribeSyncStatus,
    getSyncStatus,
    () => INITIAL_SYNC_STATUS
  );
}
