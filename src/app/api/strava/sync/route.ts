import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createClient as createAuthClient } from "@/lib/supabase/server";
import { Database } from "@/types/database.types";
import { SUPABASE_URL } from "@/lib/supabase/config";

async function getValidToken(supabase: SupabaseClient<Database>) {
  const { data: tokenRow } = await supabase
    .from("strava_tokens")
    .select("*")
    .limit(1)
    .single();

  if (!tokenRow) return null;

  const now = Math.floor(Date.now() / 1000);
  if (tokenRow.expires_at > now + 60) {
    return tokenRow.access_token;
  }

  const refreshRes = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokenRow.refresh_token,
    }),
  });

  if (!refreshRes.ok) return null;

  const refreshed = await refreshRes.json();

  await supabase
    .from("strava_tokens")
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq("athlete_id", tokenRow.athlete_id);

  return refreshed.access_token as string;
}

export async function POST(request: NextRequest) {
  const authClient = await createAuthClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient<Database>(
    SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const accessToken = await getValidToken(supabase);
  if (!accessToken) {
    return NextResponse.json({ error: "Strava not connected" }, { status: 401 });
  }

  const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const activitiesRes = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?after=${thirtyDaysAgo}&per_page=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!activitiesRes.ok) {
    return NextResponse.json({ error: "Failed to fetch activities" }, { status: 500 });
  }

  const activities = await activitiesRes.json();
  const runs = activities.filter(
    (a: { type: string }) => a.type === "Run" || a.type === "VirtualRun"
  );

  const stravaIds = runs.map((r: { id: number }) => r.id);
  const { data: existing } = await supabase
    .from("run_sessions")
    .select("strava_id")
    .in("strava_id", stravaIds);

  const existingIds = new Set((existing || []).map((r) => r.strava_id));

  const toInsert = runs
    .filter((r: { id: number }) => !existingIds.has(r.id))
    .map((r: {
      id: number;
      name: string;
      distance: number;
      moving_time: number;
      average_speed: number;
      average_heartrate?: number;
      start_date: string;
      map?: { summary_polyline?: string };
    }) => ({
      user_id: user.id,
      strava_id: r.id,
      source: "strava",
      name: r.name,
      distance_meters: r.distance,
      duration_seconds: r.moving_time,
      avg_pace: r.average_speed > 0 ? 1609.34 / r.average_speed : null,
      avg_heart_rate: r.average_heartrate ? Math.round(r.average_heartrate) : null,
      started_at: r.start_date,
      polyline: r.map?.summary_polyline || null,
      raw_data: r,
      completed: true,
    }));

  if (toInsert.length > 0) {
    const { error } = await supabase.from("run_sessions").insert(toInsert);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    synced: toInsert.length,
    skipped: existingIds.size,
    total: runs.length,
  });
}
