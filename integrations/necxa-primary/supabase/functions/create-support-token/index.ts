// supabase/functions/create-support-token/index.ts
// Deploy on NECXA'S PRIMARY project (lzdtrmjcwzalckszdzpt), not Goobox.
//
// A logged-in Necxa user calls this with their normal session JWT. It returns a
// 10-minute signed token saying "this is Necxa user X". Goobox's
// create-support-ticket / track-tickets verify the signature with the same
// SUPPORT_TOKEN_SECRET, so the app never has to be trusted to tell Goobox who
// it is.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return err("Method not allowed", 405);
  if (!keyPromise) return err("SUPPORT_TOKEN_SECRET is not configured", 503);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return err("Unauthorized: missing Authorization header", 401);

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return err("Unauthorized: invalid session", 401);

  const token = await create(
    { alg: "HS256", typ: "JWT" },
    {
      user_id: user.id,
      email: user.email ?? null, // phone-only accounts have no email
      purpose: "goobox_support",
      iat: getNumericDate(0),
      exp: getNumericDate(60 * 10),
    },
    await keyPromise,
  );

  return json({ token });
});
