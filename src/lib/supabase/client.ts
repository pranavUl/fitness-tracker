import { createBrowserClient } from "@supabase/ssr";
import { SupabaseClient, User } from "@supabase/supabase-js";
import { Database } from "@/types/database.types";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

// Weak gym wifi is usually "connected but dead": requests don't error, they
// just hang forever. Cap every Supabase request so callers fail fast and
// fall back to local data instead of freezing.
const REQUEST_TIMEOUT_MS = 12000;

function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const outer = init?.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

export function createClient() {
  return createBrowserClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: fetchWithTimeout },
  });
}

const USER_ID_KEY = "fitness_user_id";

export function rememberUserId(id: string | null | undefined) {
  if (!id) return;
  try {
    localStorage.setItem(USER_ID_KEY, id);
  } catch {}
}

/**
 * Pull the user id out of the stored auth cookie without touching the
 * network. auth.getSession() tries to refresh an expired token first and
 * returns null when that refresh can't reach the server — which is exactly
 * the situation in a dead-signal gym.
 */
function readUserIdFromAuthCookie(): string | null {
  try {
    const chunks = new Map<string, string>();
    for (const part of document.cookie.split("; ")) {
      const eq = part.indexOf("=");
      const name = part.slice(0, eq);
      if (name.startsWith("sb-") && name.includes("-auth-token")) {
        chunks.set(name, decodeURIComponent(part.slice(eq + 1)));
      }
    }
    if (chunks.size === 0) return null;
    // Large sessions are split across name.0, name.1, ...
    const ordered = [...chunks.entries()]
      .sort(([a], [b]) => {
        const ia = parseInt(a.split(".").pop() || "0") || 0;
        const ib = parseInt(b.split(".").pop() || "0") || 0;
        return ia - ib;
      })
      .map(([, v]) => v)
      .join("");
    let json = ordered;
    if (json.startsWith("base64-")) {
      const b64 = json.slice(7).replace(/-/g, "+").replace(/_/g, "/");
      json = new TextDecoder().decode(
        Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      );
    }
    const parsed = JSON.parse(json);
    return parsed?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Synchronous, network-free user id. Null only if never signed in here. */
export function getCachedUserId(): string | null {
  try {
    const cached = localStorage.getItem(USER_ID_KEY);
    if (cached) return cached;
  } catch {}
  const fromCookie = readUserIdFromAuthCookie();
  if (fromCookie) rememberUserId(fromCookie);
  return fromCookie;
}

/**
 * Offline-safe user id for writes. Rows are stamped locally and synced
 * later; RLS still checks the real session when the sync reaches the server.
 */
export async function getUserId(
  supabase: SupabaseClient<Database>
): Promise<string | null> {
  const cached = getCachedUserId();
  if (cached) return cached;
  const user = await getLocalUser(supabase);
  return user?.id ?? null;
}

/**
 * Reads the locally stored session instead of hitting the auth server like
 * auth.getUser() does. May still try a token refresh — prefer getUserId()
 * anywhere the UI must not wait on the network.
 */
export async function getLocalUser(
  supabase: SupabaseClient<Database>
): Promise<User | null> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.user) rememberUserId(session.user.id);
    return session?.user ?? null;
  } catch {
    return null;
  }
}
