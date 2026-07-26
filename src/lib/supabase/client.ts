import { createBrowserClient } from "@supabase/ssr";
import { SupabaseClient, User } from "@supabase/supabase-js";
import { Database } from "@/types/database.types";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

export function createClient() {
  return createBrowserClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/**
 * Fast, offline-safe user lookup. Reads the locally stored session instead
 * of hitting the auth server like auth.getUser() does. Middleware already
 * validates the JWT server-side, and RLS enforces authorization on every
 * query, so trusting the local session in the client is safe.
 */
export async function getLocalUser(
  supabase: SupabaseClient<Database>
): Promise<User | null> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.user ?? null;
  } catch {
    return null;
  }
}
