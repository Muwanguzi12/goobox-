import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })

const err = (message: string, status = 400) => json({ error: message }, status)

// Goobox's own project — used to verify the caller is a logged-in agent
const GOOBOX_SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const GOOBOX_SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!
const GOOBOX_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

// Necxa's primary project — secrets live here only, never in the browser
const PRIMARY_SUPABASE_URL = Deno.env.get("PRIMARY_SUPABASE_URL")!
const PRIMARY_SUPABASE_ANON_KEY = Deno.env.get("PRIMARY_SUPABASE_ANON_KEY")!
const GOOBOX_SHARED_SECRET = Deno.env.get("GOOBOX_SHARED_SECRET")!
const NECXA_CHAT_URL = `${PRIMARY_SUPABASE_URL}/functions/v1/necxa-chat`

const adminDb = createClient(GOOBOX_SUPABASE_URL, GOOBOX_SERVICE_ROLE_KEY)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST") return err("Method not allowed", 405)

  try {
    // 1. Verify the caller is a real, logged-in Goobox agent
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) return err("Unauthorized: missing Authorization header", 401)

    const agentClient = createClient(GOOBOX_SUPABASE_URL, GOOBOX_SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user: agent }, error: agentErr } = await agentClient.auth.getUser()
    if (agentErr || !agent) return err("Unauthorized: invalid agent session", 401)

    // 2. Parse request — only ticket_id + body come from the browser, nothing sensitive
    const { ticket_id, body } = await req.json()
    if (!ticket_id || !body) return err("Missing ticket_id or body")

    // 3. Look up the ticket server-side — never trust a necxa_user_id passed from the client
    const { data: ticket, error: tErr } = await adminDb
      .from("support_tickets")
      .select("necxa_user_id, verified")
      .eq("id", ticket_id)
      .single()

    if (tErr || !ticket) return err("Ticket not found", 404)
    if (!ticket.necxa_user_id || !ticket.verified) {
      // Not a verified, identified Necxa user — nothing to relay, not an error
      return json({ success: true, relayed: false, reason: "ticket not linked to a verified Necxa user" })
    }

    // 4. Forward to necxa-chat, with the secret held only here, server-side
    const res = await fetch(NECXA_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": PRIMARY_SUPABASE_ANON_KEY,
        "x-goobox-secret": GOOBOX_SHARED_SECRET,
      },
      body: JSON.stringify({
        action: "SEND_MESSAGE",
        payload: { to_user_id: ticket.necxa_user_id, content: body, metadata: { ticket_id } },
      }),
    })
    const data = await res.json()
    if (!res.ok) return err(data.error || "necxa-chat relay failed", 502)

    return json({ success: true, relayed: true })
  } catch (e) {
    console.error("relay-necxa-reply error:", e)
    return err(`Internal error: ${e.message}`, 500)
  }
})
