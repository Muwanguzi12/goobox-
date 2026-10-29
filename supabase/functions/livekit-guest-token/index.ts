// supabase/functions/livekit-guest-token/index.ts
//
// Lets a customer join a call from the emailed link without a Goobox account.
// Deploy with --no-verify-jwt (callers are anonymous; this function does its own checks).
//
// Rules:
//  - the room must be a real gb_meetings row
//  - only customer-facing meetings (ticket or customer email attached) — internal
//    team meetings stay agents-only
//  - the meeting must be live, starting within 30 min, or ended in the last 3 hours
//    (so someone who drops can come back through the same link)
//  - guests can publish/subscribe/chat but are never given room-admin rights

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AccessToken } from "https://esm.sh/livekit-server-sdk@2.6.0";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const err = (m: string, status = 400) => json({ error: m }, status);

const LIVEKIT_API_KEY =
  Deno.env.get("LIVEKIT_API_KEY") ?? Deno.env.get("Goobox API key") ?? "";
const LIVEKIT_API_SECRET =
  Deno.env.get("LIVEKIT_API_SECRET") ?? Deno.env.get("Goobox secret key") ?? "";
const LIVEKIT_URL =
  Deno.env.get("LIVEKIT_URL") ?? "wss://goobox-0h0bg2l4.livekit.cloud";

const EARLY_MS = 30 * 60 * 1000;
const GRACE_MS = 3 * 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return err("Method not allowed", 405);
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return err("Video calling is not configured", 500);

  let body: any;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }

  const roomName = String(body?.roomName ?? "").trim();
  const guestName = String(body?.guestName ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(roomName)) return err("This call link isn't valid");
  if (!guestName) return err("Please enter your name");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: meeting, error } = await sb.from("gb_meetings")
    .select("id, title, status, ticket_id, customer_email, meeting_type, scheduled_start, actual_end")
    .eq("room_name", roomName).maybeSingle();

  if (error) { console.error("meeting lookup failed:", error.message); return err("Could not look up this call", 500); }
  if (!meeting) return err("Call not found — check the link in your email", 404);

  if (!meeting.customer_email && !meeting.ticket_id) {
    return err("This call is for the Goobox team — please sign in as an agent", 403);
  }

  const now = Date.now();
  if (meeting.status === "scheduled") {
    const start = meeting.scheduled_start ? new Date(meeting.scheduled_start).getTime() : now;
    if (start - now > EARLY_MS) {
      return err("This call hasn't started yet — it's scheduled for " + new Date(start).toUTCString(), 403);
    }
  } else if (meeting.status === "completed") {
    const end = meeting.actual_end ? new Date(meeting.actual_end).getTime() : 0;
    if (now - end > GRACE_MS) return err("This call has ended", 410);
  } else if (meeting.status !== "active") {
    return err("This call is no longer available", 410);
  }

  const identity = `guest-${crypto.randomUUID().slice(0, 8)}`;
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name: guestName, ttl: "2h" });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  const token = await at.toJwt();

  // Best-effort: mark the call live (or revive it inside the grace window)
  if (meeting.status !== "active") {
    const patch: Record<string, unknown> = { status: "active", actual_end: null };
    if (meeting.status === "scheduled") patch.actual_start = new Date().toISOString();
    const { error: ue } = await sb.from("gb_meetings").update(patch).eq("id", meeting.id);
    if (ue) console.error("gb_meetings status update failed (non-fatal):", ue.message);
  }

  return json({
    token,
    identity,
    title: meeting.title || "Video call",
    callType: meeting.meeting_type === "audio" ? "audio" : "video",
    livekitUrl: LIVEKIT_URL,
  });
});
