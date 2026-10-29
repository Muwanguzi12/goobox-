// supabase/functions/gmail-sync/index.ts
//
// Matches the VERIFIED live schema (confirmed via information_schema
// column + foreign-key dumps run directly against the production DB).
//
// Writes inbound customer email into:
//   support_tickets   (gmail_message_id, gmail_thread_id, sender,
//                       customer_email, subject, snippet, status,
//                       received_at, priority)
//   ticket_messages    (ticket_id, gmail_message_id, gmail_thread_id,
//                       sender_type='customer', sender, body,
//                       attachments jsonb, is_internal_note=false,
//                       message_id_header, in_reply_to)
//   ticket_attachments (message_id, file_name, mime_type, file_size,
//                       storage_path)  -- note: file_name/file_size,
//                       NOT filename/size
//
// Token source priority:
//   1. inboxes row matching SUPPORT_EMAIL, if active — its
//      gmail_refresh_token is exchanged for a FRESH access token on
//      every call (Google access tokens expire in ~1hr, so we never
//      trust a cached one).
//   2. accessToken passed from the browser (current agent's session),
//      only if no refresh token is available.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const SUPPORT_EMAIL = Deno.env.get("SUPPORT_EMAIL") ?? "support@necxa.uk";
const GMAIL_ACCOUNT = Deno.env.get("GMAIL_ACCOUNT") ?? "knestars@gmail.com";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");

function ok(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { ...CORS, "content-type": "application/json" } });
}
function err(msg: string, status = 400, extra: object = {}) {
  return new Response(JSON.stringify({ error: msg, ...extra }), { status, headers: { ...CORS, "content-type": "application/json" } });
}
async function tfetch(url: string, opts: RequestInit, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
function b64uDecode(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
}
function b64uBytes(data: string): Uint8Array {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function hdr(headers: any[], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}
function parseFrom(raw: string) {
  const m = raw.match(/^(.+?)\s*<(.+?)>$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: raw, email: raw };
}
function senderLabel(name: string, email: string) {
  return name && name !== email ? `${name} <${email}>` : email;
}
function extractParts(payload: any, out = { textPlain: "", textHtml: "", attachments: [] as any[] }) {
  if (!payload) return out;
  const mime = payload.mimeType ?? "";
  if (payload.body?.data && !payload.parts) {
    const d = b64uDecode(payload.body.data);
    if (mime === "text/plain") out.textPlain = d;
    if (mime === "text/html")  out.textHtml  = d;
    return out;
  }
  if (payload.filename?.length && payload.body?.attachmentId) {
    out.attachments.push({ filename: payload.filename, mimeType: mime, attachmentId: payload.body.attachmentId, size: payload.body.size ?? 0 });
    return out;
  }
  for (const p of payload.parts ?? []) extractParts(p, out);
  return out;
}

// Exchange a stored refresh_token for a brand-new, short-lived access
// token. Called on every sync — cheap, and guarantees we never work
// with a stale token.
async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not configured on this function");
  }
  const res = await tfetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error("Token refresh failed: " + (data.error_description || data.error || res.status));
  }
  return data.access_token as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return err("Method not allowed", 405);

  let body: any;
  try { body = await req.json(); } catch { return err("Invalid JSON", 400); }

  const { accessToken: browserToken, userId, maxResults = 50 } = body ?? {};

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── Resolve which Gmail token to use ──────────────────────────
  let accessToken: string | null = null;
  let inboxId: string | null = null;
  let tokenSource = "browser";

  const { data: inboxRow } = await sb
    .from("inboxes")
    .select("id, gmail_refresh_token, active")
    .eq("email_address", SUPPORT_EMAIL)
    .eq("active", true)
    .maybeSingle();

  if (inboxRow?.gmail_refresh_token) {
    try {
      accessToken = await refreshGoogleAccessToken(inboxRow.gmail_refresh_token);
      inboxId = inboxRow.id;
      tokenSource = "inboxes-refreshed";
      // keep a cached copy current for any legacy code path that still reads it
      await sb.from("inboxes").update({
        gmail_access_token: accessToken,
        gmail_token_updated: new Date().toISOString(),
      }).eq("id", inboxRow.id);
    } catch (e) {
      console.error("Token refresh failed, falling back to browser token:", (e as Error).message);
    }
  }

  if (!accessToken && browserToken && browserToken.length > 10) {
    accessToken = browserToken;
  }

  if (!accessToken) {
    return err(
      "No Gmail access token available — refresh token missing/invalid for " + SUPPORT_EMAIL + " and no browser token supplied. Re-authorize the support inbox, or sign in with Google.",
      400
    );
  }

  // ── Resolve org_id for the calling agent ────────────────────────
  let resolvedOrgId: string | null = null;
  if (userId) {
    const { data: profile } = await sb.from("profiles").select("org_id").eq("id", userId).maybeSingle();
    resolvedOrgId = profile?.org_id ?? null;
  }

  if (userId && tokenSource === "browser") {
    await sb.from("profiles").update({
      gmail_access_token: accessToken,
      gmail_token_updated: new Date().toISOString(),
    }).eq("id", userId);
  }

  // ── Fetch inbox — exclude our own addresses ─────────────────────
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("maxResults", String(maxResults));
  listUrl.searchParams.set("labelIds", "INBOX");
  listUrl.searchParams.set("q", `-from:${SUPPORT_EMAIL} -from:${GMAIL_ACCOUNT}`);

  let listRes: Response;
  try {
    listRes = await tfetch(listUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    return err("Gmail list request timed out or failed", 504, { detail: String(e) });
  }

  if (!listRes.ok) {
    const d = await listRes.json().catch(() => ({}));
    const isAuthError = listRes.status === 401 || listRes.status === 403;
    return err(
      isAuthError
        ? `Gmail authorization expired or insufficient scope (token source: ${tokenSource}). Re-sign in with Google.`
        : "Gmail API error",
      502,
      { gmailStatus: listRes.status, detail: d, tokenSource }
    );
  }

  const listData = await listRes.json();
  const ids: string[] = (listData.messages ?? []).map((m: any) => m.id);
  if (!ids.length) return ok({ synced: 0, tokenSource, message: "Inbox empty — no new messages matched the filter" });

  let synced = 0;
  const errors: any[] = [];

  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5);
    const msgs = await Promise.all(batch.map(id =>
      tfetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).then(r => r.json())
    ));

    for (const msg of msgs) {
      if (!msg?.payload) continue;
      const hdrs = msg.payload.headers ?? [];
      const from = parseFrom(hdr(hdrs, "From"));
      if ([SUPPORT_EMAIL, GMAIL_ACCOUNT].includes(from.email.toLowerCase())) continue;

      const subject    = hdr(hdrs, "Subject") || "(no subject)";
      const dateRaw     = hdr(hdrs, "Date");
      const msgIdHdr    = hdr(hdrs, "Message-ID");
      const inReplyTo   = hdr(hdrs, "In-Reply-To");
      const receivedAt  = dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString();
      const { textPlain, textHtml, attachments } = extractParts(msg.payload);
      const bodyContent = textPlain || textHtml || "";

      const { data: ticket, error: te } = await sb.from("support_tickets").upsert({
        gmail_message_id: msg.id,
        gmail_thread_id:  msg.threadId,
        sender:           senderLabel(from.name, from.email),
        customer_email:   from.email,
        subject,
        snippet:          msg.snippet ?? "",
        received_at:      receivedAt,
        status:           "open",
        priority:         "medium",
        ...(inboxId ? { inbox_id: inboxId } : {}),
        ...(resolvedOrgId ? { org_id: resolvedOrgId } : {}),
      }, { onConflict: "gmail_message_id" }).select().single();

      if (te) {
        console.error("ticket upsert failed:", te.message);
        const limitExceeded = te.message?.includes("TICKET_LIMIT_EXCEEDED");
        errors.push({ msgId: msg.id, stage: "ticket", error: te.message, limitExceeded });
        if (limitExceeded) {
          return ok({ synced, tokenSource, errors, limitExceeded: true });
        }
        continue;
      }

      const attachmentsJson = attachments.map(a => ({
        filename: a.filename, mimeType: a.mimeType, attachmentId: a.attachmentId, size: a.size,
      }));

      const { data: savedMsg, error: me } = await sb.from("ticket_messages").upsert({
        ticket_id:          ticket.id,
        gmail_message_id:   msg.id,
        gmail_thread_id:    msg.threadId,
        sender_type:        "customer",
        sender:             senderLabel(from.name, from.email),
        body:               bodyContent,
        attachments:        attachmentsJson.length ? attachmentsJson : [],
        is_internal_note:   false,
        message_id_header:  msgIdHdr,
        in_reply_to:        inReplyTo,
      }, { onConflict: "gmail_message_id" }).select().single();

      if (me) {
        console.error("message upsert failed:", me.message);
        errors.push({ msgId: msg.id, stage: "message", error: me.message });
        continue;
      }

      for (const att of attachments) {
        try {
          const ar = await tfetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}/attachments/${att.attachmentId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
          const aj = await ar.json();
          const bytes = b64uBytes(aj.data ?? "");
          const path  = `${ticket.id}/${msg.id}/${att.filename}`;

          const { error: ue } = await sb.storage.from("support-attachments").upload(path, bytes, { contentType: att.mimeType, upsert: true });
          if (!ue && savedMsg?.id) {
            await sb.from("ticket_attachments").upsert({
              message_id:   savedMsg.id,
              file_name:    att.filename,
              mime_type:    att.mimeType,
              file_size:    att.size,
              storage_path: path,
            });
          }
        } catch (e) {
          console.error("attachment download failed (non-fatal):", e);
        }
      }

      synced++;
    }
  }

  return ok({ synced, tokenSource, errors: errors.length ? errors : undefined });
});
