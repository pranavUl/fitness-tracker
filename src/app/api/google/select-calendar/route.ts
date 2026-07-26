import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createAuthClient } from "@/lib/supabase/server";
import { Database } from "@/types/database.types";
import { SUPABASE_URL } from "@/lib/supabase/config";

export async function POST(request: NextRequest) {
  const authClient = await createAuthClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { calendarId, calendarName } = await request.json();

  const supabase = createClient<Database>(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { error } = await supabase
    .from("google_calendar_tokens")
    .update({
      calendar_id: calendarId,
      calendar_name: calendarName,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
