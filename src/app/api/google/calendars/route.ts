import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createAuthClient } from "@/lib/supabase/server";
import { Database } from "@/types/database.types";
import { SUPABASE_URL } from "@/lib/supabase/config";

async function getValidToken(supabase: ReturnType<typeof createClient<Database>>, userId: string) {
  const { data: row } = await supabase
    .from("google_calendar_tokens")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at > now + 60) return row.access_token;

  const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!refreshRes.ok) return null;
  const refreshed = await refreshRes.json();

  await supabase
    .from("google_calendar_tokens")
    .update({
      access_token: refreshed.access_token,
      expires_at: Math.floor(Date.now() / 1000) + refreshed.expires_in,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  return refreshed.access_token as string;
}

export async function GET() {
  const authClient = await createAuthClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createClient<Database>(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const token = await getValidToken(supabase, user.id);
  if (!token) return NextResponse.json({ error: "Not connected" }, { status: 401 });

  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) return NextResponse.json({ error: "Failed to fetch calendars" }, { status: 500 });

  const data = await res.json();
  const calendars = (data.items || []).map((c: { id: string; summary: string; backgroundColor?: string }) => ({
    id: c.id,
    name: c.summary,
    color: c.backgroundColor,
  }));

  return NextResponse.json({ calendars });
}
