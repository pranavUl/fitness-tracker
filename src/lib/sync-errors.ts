/**
 * Error handling for code that runs inside the sync engine. Supabase never
 * throws on network failure — it returns { error, status: 0 } — so every
 * write has to be checked explicitly, and the engine needs to know whether
 * to retry later (no signal, expired token) or give up (bad data).
 */
export class SyncError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    /** The request never reached the server (no signal / timed out). */
    public offline = false
  ) {
    super(message);
  }
}

interface ResultLike {
  error: { message: string; code?: string } | null;
  status: number;
}

export function isRetryable(res: ResultLike): boolean {
  const s = res.status;
  if (s === 0 || s === 401 || s === 408 || s === 429 || s >= 500) return true;
  const code = res.error?.code;
  // JWT expired / missing — resolves once the session refreshes
  return code === "PGRST301" || code === "PGRST303";
}

/** Throw on any error. */
export function check<T extends ResultLike>(res: T, context: string): T {
  if (res.error) {
    throw new SyncError(
      `${context}: ${res.error.message}`,
      isRetryable(res),
      res.status === 0
    );
  }
  return res;
}

/**
 * Throw only if the failure is worth retrying; log and report false for
 * permanent errors so best-effort steps don't block the rest.
 */
export function softCheck(res: ResultLike, context: string): boolean {
  if (!res.error) return true;
  if (isRetryable(res)) {
    throw new SyncError(`${context}: ${res.error.message}`, true, res.status === 0);
  }
  console.error(`[sync] ${context}:`, res.error.message);
  return false;
}
