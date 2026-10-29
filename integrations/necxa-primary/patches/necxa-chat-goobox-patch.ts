// ─────────────────────────────────────────────────────────────────────────────
// PATCH for necxa-chat  (Necxa primary project: lzdtrmjcwzalckszdzpt)
// Apply to your LIVE copy — three small insertions, nothing else changes.
// Download first so you patch what's actually deployed:
//   npx supabase functions download necxa-chat --project-ref lzdtrmjcwzalckszdzpt
// ─────────────────────────────────────────────────────────────────────────────


// ── INSERTION 1 — near the other constants at the top of the file ───────────
const GOOBOX_SHARED_SECRET = Deno.env.get("GOOBOX_SHARED_SECRET") ?? ""
const SUPPORT_ACCOUNT_ID   = Deno.env.get("SUPPORT_ACCOUNT_ID") ?? ""

// Constant-time string compare, so the secret can't be guessed by timing
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}


// ── INSERTION 2 — first thing inside the `try {` of Deno.serve, ABOVE the
//    existing `const primaryJwt = req.headers.get("x-primary-jwt")` line ─────
    // ── Goobox bridge: server-to-server, may ONLY send one message to one user ──
    const gooboxSecret = req.headers.get("x-goobox-secret")
    if (gooboxSecret) {
      if (!GOOBOX_SHARED_SECRET || !SUPPORT_ACCOUNT_ID || !safeEqual(gooboxSecret, GOOBOX_SHARED_SECRET)) {
        return err("Unauthorized", 401)
      }
      const gb = await req.json()
      if (gb?.action !== "SEND_MESSAGE") return err("Goobox bridge may only SEND_MESSAGE", 403)

      const p = gb.payload ?? {}
      if (!p.to_user_id || !p.content) return err("Missing to_user_id or content")
      if (p.to_user_id === SUPPORT_ACCOUNT_ID) return err("Invalid recipient")

      // Rebuild the payload from scratch. room_id / media_url / id from the caller are
      // deliberately ignored — otherwise a leaked secret could post into any room.
      return handleSendMessage(SUPPORT_ACCOUNT_ID, {
        to_user_id: p.to_user_id,
        content: String(p.content).slice(0, 4000),
        message_type: "text",
        metadata: { source: "goobox", ticket_id: p.metadata?.ticket_id ?? null },
      })
    }


// ── INSERTION 3 — none. The existing x-primary-jwt path below stays exactly as is.
//
// Secrets to set on the Necxa project:
//   npx supabase secrets set GOOBOX_SHARED_SECRET=<long random string> --project-ref lzdtrmjcwzalckszdzpt
//   npx supabase secrets set SUPPORT_ACCOUNT_ID=<uuid of the Necxa Support user> --project-ref lzdtrmjcwzalckszdzpt
// The SAME GOOBOX_SHARED_SECRET value goes on the Goobox project (relay-necxa-reply).
//
// If Goobox's call comes back 401 "Invalid JWT" from the gateway (before reaching this code),
// redeploy with:  npx supabase functions deploy necxa-chat --no-verify-jwt --project-ref lzdtrmjcwzalckszdzpt
// That's safe: the function does its own auth (x-primary-jwt, or the secret above).
