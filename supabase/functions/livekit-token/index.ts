// supabase/functions/livekit-token/index.ts
//
// Generates a LiveKit participant access token.
//
// Secrets: checks BOTH naming conventions, since this project has had
// secrets set two different ways at different times:
//   - Dashboard UI: "Goobox API key" / "Goobox secret key" (literal
//     names with spaces)
//   - CLI: LIVEKIT_API_KEY / LIVEKIT_API_SECRET
// Whichever pair is actually set will be used — no need to migrate.
//
// Deploy: supabase functions deploy livekit-token

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AccessToken } from "https://esm.sh/livekit-server-sdk@2.6.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function ok(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { ...CORS, "content-type": "application/json" } });
}
function err(msg: string, status = 400, extra: object = {}) {
  return new Response(JSON.stringify({ error: msg, ...extra }), { status, headers: { ...CORS, "content-type": "application/json" } });
}

// Read from either naming convention — whichever is actually set.
const LIVEKIT_API_KEY =
  Deno.env.get("LIVEKIT_API_KEY") ?? Deno.env.get("Goobox API key") ?? "";
const LIVEKIT_API_SECRET =
  Deno.env.get("LIVEKIT_API_SECRET") ?? Deno.env.get("Goobox secret key") ?? "";
const LIVEKIT_URL =
  Deno.env.get("LIVEKIT_URL") ?? "wss://goobox-0h0bg2l4.livekit.cloud";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      console.error("LiveKit secrets not configured — checked LIVEKIT_API_KEY/'Goobox API key' and LIVEKIT_API_SECRET/'Goobox secret key', found neither pair set.");
      return err("LiveKit not configured on server — no API key/secret found under either naming convention", 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return err("Missing Authorization header", 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return err("Unauthorised", 401);

    let body: any;
    try { body = await req.json(); } catch { return err("Invalid JSON", 400); }

    const { roomName, participantName } = body ?? {};
    if (!roomName) return err("roomName is required", 400);

    // LiveKit identifies a participant by `identity`, and a second connection with
    // the same identity DISCONNECTS the first. So the identity must be unique per
    // connection (never a display name, never just the user id — same account in two
    // windows would kick itself out). The human-readable name travels separately.
    const displayName = String(participantName || user.email || "Agent").slice(0, 60);
    const identity = `${user.id}:${crypto.randomUUID().slice(0, 6)}`;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: displayName,
      ttl: "4h",
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await at.toJwt();

    // Best-effort — mark the meeting active. Never fail the token
    // response just because this side-update didn't work.
    try {
      const adminSb = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      await adminSb.from("gb_meetings")
        .update({ status: "active", actual_start: new Date().toISOString() })
        .eq("room_name", roomName)
        .eq("status", "scheduled");
    } catch (e) {
      console.error("gb_meetings status update failed (non-fatal):", e);
    }

    return ok({ token: jwt, identity, name: displayName, roomName, livekitUrl: LIVEKIT_URL });

  } catch (e) {
    console.error("livekit-token error:", e);
    return err((e as Error).message || "Internal error", 500);
  }
});
