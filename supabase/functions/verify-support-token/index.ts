// supabase/functions/verify-support-token/index.ts
//
// Verifies the signed handoff token issued by Necxa's create-support-token
// function. Used by the Goobox portal on page load (to lock the email
// field for a verified user) and, more importantly, by
// create-support-ticket, which re-verifies the token itself server-side
// rather than trusting the client's claim.

import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "content-type": "application/json" } });
const err = (message: string, status = 400) => json({ error: message }, status);

const SUPPORT_TOKEN_SECRET = Deno.env.get("SUPPORT_TOKEN_SECRET")!; // must match Necxa's create-support-token secret

const keyPromise = crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(SUPPORT_TOKEN_SECRET),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"]
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return err("Method not allowed", 405);

  try {
    const { token } = await req.json();
    if (!token) return err("Missing token");

    const key = await keyPromise;
    let payload;
    try {
      payload = await verify(token, key);
    } catch {
      return err("Invalid or expired token", 401);
    }

    if (payload.purpose !== "goobox_support") return err("Invalid token purpose", 401);
    if (!payload.user_id || !payload.email) return err("Malformed token payload", 401);

    return json({ success: true, user_id: payload.user_id, email: payload.email });
  } catch (e) {
    console.error("verify-support-token error:", e);
    return err(`Internal error: ${e.message}`, 500);
  }
});
