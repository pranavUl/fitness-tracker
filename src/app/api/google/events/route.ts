import { NextRequest, NextResponse } from "next/server";
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

  if (!row) return { token: null, calendarId: null };

  const now = Math.floor(Date.now() / 1000);
  let accessToken = row.access_token;

  if (row.expires_at <= now + 60) {
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

    if (!refreshRes.ok) return { token: null, calendarId: null };
    const refreshed = await refreshRes.json();
    accessToken = refreshed.access_token;

    await supabase
      .from("google_calendar_tokens")
      .update({
        access_token: refreshed.access_token,
        expires_at: Math.floor(Date.now() / 1000) + refreshed.expires_in,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  }

  return { token: accessToken, calendarId: row.calendar_id };
}

export async function GET(request: NextRequest) {
  const authClient = await createAuthClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createClient<Database>(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { token, calendarId } = await getValidToken(supabase, user.id);
  if (!token || !calendarId) {
    return NextResponse.json({ events: [], connected: !!token, calendarSelected: !!calendarId });
  }

  const dateParam = request.nextUrl.searchParams.get("date");
  const date = dateParam || new Date().toISOString().split("T")[0];

  const timeMin = new Date(`${date}T00:00:00`).toISOString();
  const timeMax = new Date(`${date}T23:59:59`).toISOString();

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) return NextResponse.json({ events: [], connected: true, calendarSelected: true });

  const data = await res.json();
  const events = (data.items || [])
    .filter((e: { status: string }) => e.status !== "cancelled")
    .map((e: { id: string; summary?: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string } }) => ({
      id: e.id,
      title: e.summary || "Untitled",
      startTime: e.start.dateTime || e.start.date,
      endTime: e.end.dateTime || e.end.date,
      allDay: !e.start.dateTime,
    }));

  return NextResponse.json({ events, connected: true, calendarSelected: true });
}
