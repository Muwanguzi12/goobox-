// supabase/functions/track-tickets/index.ts
//
// Replaces the portal's direct anon query on support_tickets.
//   - With a valid Necxa handoff token: returns that Necxa user's tickets.
//   - Without one: requires BOTH the email and the ticket reference, so typing
//     someone else's email alone reveals nothing.
// Returns only: id, subject, status, priority, received_at, created_at.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const err = (m: string, status = 400) => json({ error: m }, status);

const SECRET = Deno.env.get("SUPPORT_TOKEN_SECRET");
const keyPromise = SECRET
  ? crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
  : null;

const FIELDS = "id, subject, status, priority, received_at, created_at";
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return err("Method not allowed", 405);

  let body: any;
  try { body = await req.json(); } catch { return err("Invalid JSON"); }
  const { email, ref, token } = body ?? {};

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Verified Necxa user
  if (token && keyPromise) {
    try {
      const payload = await verify(token, await keyPromise);
      if (payload.purpose === "goobox_support" && payload.user_id) {
        const { data, error } = await sb.from("support_tickets").select(FIELDS)
          .eq("necxa_user_id", payload.user_id as string)
          .order("received_at", { ascending: false }).limit(20);
        if (error) return err("Lookup failed", 500);
        return json({ tickets: data ?? [], verified: true });
      }
    } catch { /* expired or invalid — fall through to email + reference */ }
  }

  const cleanEmail = String(email ?? "").trim();
  const cleanRef = String(ref ?? "").trim().replace(/^tkt-/i, "").toLowerCase();
  if (!cleanEmail) return err("Enter the email you used when submitting.");
  if (!/^[0-9a-f-]{6,36}$/.test(cleanRef)) {
    return err("Enter your ticket reference too — it's in your confirmation or reply email.");
  }

  const { data, error } = await sb.from("support_tickets").select(FIELDS)
    .ilike("customer_email", escapeLike(cleanEmail))
    .order("received_at", { ascending: false }).limit(50);
  if (error) return err("Lookup failed", 500);

  const tickets = (data ?? []).filter((t: any) => String(t.id).toLowerCase().startsWith(cleanRef));
  return json({ tickets, verified: false });
});
