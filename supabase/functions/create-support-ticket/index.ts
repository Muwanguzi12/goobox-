// supabase/functions/create-support-ticket/index.ts
//
// Creates a support ticket from the customer portal. If a Necxa
// handoff token is supplied, it is re-verified HERE, server-side —
// the browser's claim of "verified" is never trusted directly. This
// is what makes necxa_user_id / verified trustworthy downstream (in
// relay-necxa-reply, which only bridges replies into Necxa's in-app
// chat for tickets marked verified=true).
//
// Writes:
//   support_tickets (customer_email, necxa_user_id, verified,
//                     subject, snippet, status, priority, source,
//                     received_at, inbox, gmail_message_id,
//                     gmail_thread_id)
//   ticket_messages (ticket_id, sender_type='customer', sender,
//                     body, is_internal_note=false)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function ok(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { ...CORS, "content-type": "application/json" } });
}
function err(msg: string, status = 400, extra: object = {}) {
  return new Response(JSON.stringify({ error: msg, ...extra }), { status, headers: { ...CORS, "content-type": "application/json" } });
}

const SUPPORT_TOKEN_SECRET = Deno.env.get("SUPPORT_TOKEN_SECRET"); // same secret as verify-support-token
const FROM_ADDRESS = Deno.env.get("SUPPORT_EMAIL") ?? "support@necxa.uk";

const keyPromise = SUPPORT_TOKEN_SECRET
  ? crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SUPPORT_TOKEN_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    )
  : null;

async function verifyHandoffToken(token: string): Promise<{ user_id: string; email: string } | null> {
  if (!keyPromise) return null; // secret not configured — treat all tokens as unverifiable
  try {
    const key = await keyPromise;
    const payload = await verify(token, key);
    if (payload.purpose !== "goobox_support") return null;
    if (!payload.user_id) return null;
    return { user_id: payload.user_id as string, email: (payload.email as string) || "" };
  } catch {
    return null; // expired / malformed / bad signature — just treat as unverified, not an error
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return err("Method not allowed", 405);

  let body: any;
  try { body = await req.json(); } catch { return err("Invalid JSON", 400); }

  const {
    token,
    name,
    email: submittedEmail,
    subject,
    message,
    category = "general",
    priority = "medium",
    screenshot_url,
    source: requestedSource,
    call_request: callRequest,
  } = body ?? {};

  if (!subject || !message) return err("Missing subject or message", 400);

  // ── Re-verify identity server-side — never trust the client's claim ──
  let necxaUserId: string | null = null;
  let verified = false;
  let finalEmail = (submittedEmail || "").trim();

  if (token) {
    const identity = await verifyHandoffToken(token);
    if (identity) {
      necxaUserId = identity.user_id;
      verified = true;
      finalEmail = identity.email || finalEmail; // trusted email wins; if the account has none, use the form value
    }
  }

  if (!finalEmail) return err("Missing email", 400);

  // Only token-verified callers (the Necxa app) may label a ticket with
  // anything other than "portal" — an anonymous visitor can't claim "in_app".
  const VERIFIED_SOURCES = ["in_app", "necxa", "mobile", "report", "portal"];
  const source = verified && VERIFIED_SOURCES.includes(requestedSource) ? requestedSource : "portal";

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const uniqueSuffix = crypto.randomUUID();
  const fullSubject = `[${String(category).toUpperCase()}] ${subject}`;

  const { data: ticket, error: tErr } = await sb.from("support_tickets").insert({
    customer_email:   finalEmail,
    necxa_user_id:    necxaUserId,
    verified,
    subject:          fullSubject,
    snippet:          String(message).slice(0, 120),
    status:           "open",
    priority,
    source,
    received_at:      new Date().toISOString(),
    inbox:            FROM_ADDRESS,
    gmail_message_id: `portal-${uniqueSuffix}`,
    gmail_thread_id:  `portal-${uniqueSuffix}`,
  }).select().single();

  if (tErr) {
    console.error("support_tickets insert failed:", tErr.message);
    return err("Could not create ticket: " + tErr.message, 500);
  }

  const fullBody = screenshot_url
    ? `${message}\n\n---\n📎 Screenshot: ${screenshot_url}`
    : message;

  const senderLabel = name && name !== finalEmail ? `${name} <${finalEmail}>` : finalEmail;

  const { error: mErr } = await sb.from("ticket_messages").insert({
    ticket_id:        ticket.id,
    sender_type:      "customer",
    sender:           senderLabel,
    body:             fullBody,
    is_internal_note: false,
  });

  if (mErr) {
    // Ticket exists but the message didn't save — still return success
    // with a warning rather than leaving the customer with no ticket at all.
    console.error("ticket_messages insert failed:", mErr.message);
    return ok({ ticket, warning: "Ticket created but message failed to save: " + mErr.message });
  }

  // "Request a Call" from the portal: also log it where the Online Calls
  // "Requested" tab reads from. Done here, server-side, so the browser never
  // needs write access to these tables.
  if (callRequest?.preferred_time) {
    const { error: cErr } = await sb.from("call_sessions").insert({
      ticket_id:      ticket.id,
      status:         "requested",
      customer_email: finalEmail,
      subject:        String(subject).slice(0, 80),
      preferred_time: String(callRequest.preferred_time).slice(0, 100),
      created_at:     new Date().toISOString(),
    });
    if (cErr) console.error("call_sessions insert failed (non-fatal):", cErr.message);
  }

  return ok({ ticket, verified, necxa_user_id: necxaUserId });
});
