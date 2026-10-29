// supabase/functions/gmail-reply/index.ts
//
// Outbound agent replies go in ticket_replies (id, ticket_id,
// gmail_message_id, gmail_thread_id, sender, body, created_at).
//
// Token resolution: always try the support inbox's stored
// gmail_refresh_token first (exchanged fresh, every call — never
// trust a cached access token, it expires in ~1hr). Falls back to a
// browser-supplied token only if no refresh token is available.
// Deliberately does NOT depend on ticket.inbox_id being set, since
// portal-created tickets and some synced tickets never get that
// column populated.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const SUPPORT_EMAIL = Deno.env.get("SUPPORT_EMAIL") ?? "support@necxa.uk";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const GOOBOX_PORTAL_URL = Deno.env.get("GOOBOX_PORTAL_URL") ?? "https://goobox.necxa.uk";
const NECXA_BUY_URL = Deno.env.get("NECXA_BUY_URL") ?? "https://necxa.uk";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


// Branded HTML email — table-based layout with inline styles throughout
// for max compatibility across email clients (many strip <style>
// blocks or ignore CSS gradients/shadows outside inline contexts).
// Falls back gracefully: the plain-text part sent alongside this as
// multipart/alternative is what clients without HTML rendering see.
type CallInvite = {
  joinUrl: string;
  title: string;
  kind: "now" | "scheduled";
  whenText?: string;
  startIso?: string;
  endIso?: string;
};

function gcalDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// Card shown INSTEAD of the Buy Now / Track cards when the email is a call invitation
function buildCallCard(invite: CallInvite): string {
  const whenLine = invite.kind === "now"
    ? "Starting now — join whenever you're ready"
    : (invite.whenText || "Scheduled");

  let calendar = "";
  if (invite.kind === "scheduled" && invite.startIso && !isNaN(new Date(invite.startIso).getTime())) {
    const end = invite.endIso && !isNaN(new Date(invite.endIso).getTime())
      ? invite.endIso
      : new Date(new Date(invite.startIso).getTime() + 3600000).toISOString();
    const calUrl = "https://calendar.google.com/calendar/render?action=TEMPLATE"
      + "&text=" + encodeURIComponent(invite.title)
      + "&dates=" + gcalDate(invite.startIso) + "/" + gcalDate(end)
      + "&details=" + encodeURIComponent("Join the call: " + invite.joinUrl)
      + "&location=" + encodeURIComponent(invite.joinUrl);
    calendar = `<p style="margin:12px 0 0 0;text-align:center;"><a href="${escapeHtml(calUrl)}" style="color:#7aa2ff;text-decoration:none;font-size:12.5px;font-weight:600;">📅&nbsp; Add to Google Calendar</a></p>`;
  }

  return `
          <!-- Call invitation card -->
          <tr><td style="padding:24px 36px 32px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0c1226;border-radius:14px;overflow:hidden;">
              <tr><td style="padding:26px 28px 8px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                  <td style="width:42px;height:42px;background:linear-gradient(135deg,#2563ff,#6d3bff);background-color:#2563ff;border-radius:11px;text-align:center;vertical-align:middle;font-size:19px;">🎥</td>
                  <td style="padding-left:14px;">
                    <p style="margin:0;font-size:16px;font-weight:700;color:#ffffff;">${escapeHtml(invite.title)}</p>
                    <p style="margin:3px 0 0 0;font-size:12.5px;color:#9aa2c0;">${escapeHtml(whenLine)}</p>
                  </td>
                </tr></table>
              </td></tr>
              <tr><td style="padding:18px 28px 26px 28px;">
                <a href="${escapeHtml(invite.joinUrl)}" style="display:block;text-align:center;background:linear-gradient(90deg,#2563ff,#6d3bff);background-color:#2563ff;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:16px 0;border-radius:10px;letter-spacing:.2px;">Join call &nbsp;→</a>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px auto 0 auto;"><tr>
                  <td style="font-size:11px;color:#8992b3;padding-right:14px;">✓&nbsp; No account needed</td>
                  <td style="font-size:11px;color:#8992b3;">🌐&nbsp; Opens in your browser</td>
                </tr></table>
                ${calendar}
                <p style="margin:16px 0 0 0;text-align:center;font-size:11px;line-height:1.6;color:#6f7694;">Button not working? Copy this link into your browser:<br/><span style="color:#9aa2c0;word-break:break-all;">${escapeHtml(invite.joinUrl)}</span></p>
              </td></tr>
            </table>
          </td></tr>
`;
}

function buildReplyEmailHtml(opts: { replyBody: string; agentName: string; trackUrl: string; buyUrl: string; invite?: CallInvite }): string {
  const { replyBody, agentName, trackUrl, buyUrl, invite } = opts;
  const bodyHtml = escapeHtml(replyBody).replace(/\n/g, "<br/>");
  const initial = (agentName || "N").trim().charAt(0).toUpperCase();

  const buyAndTrackHtml = `
          <!-- Buy Now CTA card -->
          <tr><td style="padding:24px 36px 8px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0c1226;border-radius:14px;overflow:hidden;">
              <tr><td style="padding:26px 28px 8px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                  <td style="width:42px;height:42px;background:linear-gradient(135deg,#2563ff,#6d3bff);background-color:#2563ff;border-radius:11px;text-align:center;vertical-align:middle;font-size:19px;">🛍️</td>
                  <td style="padding-left:14px;">
                    <p style="margin:0;font-size:16px;font-weight:700;color:#ffffff;">Ready to purchase?</p>
                    <p style="margin:3px 0 0 0;font-size:12.5px;color:#9aa2c0;">Complete your order securely on Necxa</p>
                  </td>
                </tr></table>
              </td></tr>
              <tr><td style="padding:18px 28px 26px 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>
                  <a href="${escapeHtml(buyUrl)}" style="display:block;text-align:center;background:linear-gradient(90deg,#2563ff,#6d3bff);background-color:#2563ff;color:#ffffff;text-decoration:none;font-size:14.5px;font-weight:700;padding:15px 0;border-radius:10px;letter-spacing:.2px;">Buy Now on Necxa &nbsp;→</a>
                </td></tr></table>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px auto 0 auto;"><tr>
                  <td style="font-size:11px;color:#8992b3;padding-right:14px;">🔒&nbsp; Secure</td>
                  <td style="font-size:11px;color:#8992b3;padding-right:14px;">⚡&nbsp; Fast</td>
                  <td style="font-size:11px;color:#8992b3;">✓&nbsp; Trusted</td>
                </tr></table>
              </td></tr>
            </table>
          </td></tr>

          <!-- Track ticket -->
          <tr><td style="padding:14px 36px 32px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fc;border-radius:12px;border:1px solid #eceff8;">
              <tr><td style="padding:16px 20px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                  <td style="font-size:13px;color:#4a4f68;">
                    <span style="font-size:15px;">📋</span>&nbsp; Want to check on this ticket later?
                  </td>
                  <td align="right">
                    <a href="${escapeHtml(trackUrl)}" style="color:#2563ff;text-decoration:none;font-size:13px;font-weight:700;white-space:nowrap;">Track status →</a>
                  </td>
                </tr></table>
              </td></tr>
            </table>
          </td></tr>

`;
  const ctaSections = invite ? buildCallCard(invite) : buyAndTrackHtml;

  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
</head>
<body style="margin:0;padding:0;background:#eef1f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f8;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- ── Top brand bar ── -->
        <tr><td style="padding:0 4px 16px 4px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:34px;height:34px;background:linear-gradient(135deg,#2563ff,#6d3bff);background-color:#2563ff;border-radius:9px;text-align:center;vertical-align:middle;font-weight:800;color:#ffffff;font-size:16px;font-family:Georgia,serif;">N</td>
            <td style="padding-left:10px;font-size:14px;font-weight:700;color:#232842;letter-spacing:.2px;">NECXA <span style="font-weight:500;color:#8b91a8;">Support</span></td>
          </tr></table>
        </td></tr>

        <!-- ── Main card ── -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(20,25,50,.06);">

          <!-- gradient header strip -->
          <tr><td style="height:6px;line-height:6px;font-size:0;background:linear-gradient(90deg,#2563ff,#6d3bff);background-color:#2563ff;">&nbsp;</td></tr>

          <!-- reply body -->
          <tr><td style="padding:32px 36px 20px 36px;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:18px;"><tr>
              <td style="width:36px;height:36px;background:#eef1ff;border-radius:50%;text-align:center;vertical-align:middle;font-weight:700;color:#2563ff;font-size:14px;">${escapeHtml(initial)}</td>
              <td style="padding-left:10px;">
                <p style="margin:0;font-size:13.5px;font-weight:700;color:#232842;">${escapeHtml(agentName)}</p>
                <p style="margin:1px 0 0 0;font-size:11.5px;color:#9aa0b8;">Necxa Support Team</p>
              </td>
            </tr></table>

            <p style="margin:0;font-size:15px;line-height:1.7;color:#2a2f47;">${bodyHtml}</p>
          </td></tr>

          <tr><td style="padding:0 36px;"><div style="border-top:1px solid #eef0f6;"></div></td></tr>

${ctaSections}
        </table>

        <!-- footer -->
        <tr><td style="padding:22px 8px 0 8px;" align="center">
          <p style="margin:0;font-size:11.5px;color:#9aa0b4;line-height:1.6;">
            Necxa Support &nbsp;·&nbsp; ${escapeHtml(SUPPORT_EMAIL)}<br/>
            This reply was sent in response to your support request.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

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
function b64uEncode(str: string): string {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

  const { ticketId, body: replyBody, accessToken: browserToken, fromAddress = SUPPORT_EMAIL, agentName = "Necxa Support", invite: rawInvite } = body ?? {};
  if (!ticketId || !replyBody) return err("Missing ticketId or body", 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: ticket, error: te } = await sb.from("support_tickets").select("*").eq("id", ticketId).single();
  if (te || !ticket) return err("Ticket not found", 404);

  // ── Resolve Gmail token — always try the support inbox's refresh token first ──
  let accessToken: string | null = null;
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
      tokenSource = "inboxes-refreshed";
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
      "No Gmail access token available to send this reply — refresh token missing/invalid for " + SUPPORT_EMAIL + ". Re-authorize the support inbox, or sign in with Google.",
      400
    );
  }

  console.log("gmail-reply token source:", tokenSource);

  const { data: lastInbound } = await sb
    .from("ticket_messages")
    .select("message_id_header, gmail_message_id")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const replyToMsgId = lastInbound?.message_id_header
    || (lastInbound?.gmail_message_id ? `<${lastInbound.gmail_message_id}@mail.gmail.com>` : null);

  const toAddress = ticket.customer_email;
  const subject   = ticket.subject?.startsWith("Re:") ? ticket.subject : `Re: ${ticket.subject ?? ""}`;

  const hdrs = [
    `From: ${agentName} <${fromAddress}>`,
    `To: ${toAddress}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
  ];
  if (replyToMsgId) {
    hdrs.push(`In-Reply-To: ${replyToMsgId}`);
    hdrs.push(`References: ${replyToMsgId}`);
  }

  const fullBody = replyBody + `\n\n—\n${agentName}\n${SUPPORT_EMAIL}`;

  // Portal-originated tickets get a placeholder like "portal-<timestamp>"
  // for gmail_thread_id since they never came through Gmail — that's not
  // a real Gmail thread ID, so passing it makes the send API reject the
  // whole request. Only thread a reply if we have a genuine Gmail thread.
  const isRealThreadId = ticket.gmail_thread_id && !String(ticket.gmail_thread_id).startsWith("portal-");

  const trackUrl = `${GOOBOX_PORTAL_URL}/?view=track&email=${encodeURIComponent(toAddress)}&ref=${encodeURIComponent(String(ticket.id).slice(0, 8))}`;
  // Only honour an invite whose link really points at our own /meet/ room URLs
  const invite: CallInvite | undefined =
    rawInvite && typeof rawInvite.joinUrl === "string" && rawInvite.joinUrl.startsWith(`${GOOBOX_PORTAL_URL}/meet/`)
      ? {
          joinUrl: rawInvite.joinUrl,
          title: String(rawInvite.title || "Video call").slice(0, 120),
          kind: rawInvite.kind === "scheduled" ? "scheduled" : "now",
          whenText: rawInvite.whenText ? String(rawInvite.whenText).slice(0, 120) : undefined,
          startIso: rawInvite.startIso ? String(rawInvite.startIso) : undefined,
          endIso: rawInvite.endIso ? String(rawInvite.endIso) : undefined,
        }
      : undefined;

  const html = buildReplyEmailHtml({
    replyBody,
    agentName,
    trackUrl,
    buyUrl: NECXA_BUY_URL,
    invite,
  });

  const boundary = "necxa-boundary-" + crypto.randomUUID();
  hdrs.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const raw = b64uEncode(
    [
      ...hdrs,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      fullBody,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      html,
      "",
      `--${boundary}--`,
    ].join("\r\n")
  );

  const sendPayload: Record<string, string> = { raw };
  if (isRealThreadId) sendPayload.threadId = ticket.gmail_thread_id;

  const sendRes = await tfetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(sendPayload),
  });

  const sendData = await sendRes.json();
  if (!sendRes.ok) {
    console.error("Gmail send failed:", sendRes.status, JSON.stringify(sendData));
    const isAuthError = sendRes.status === 401 || sendRes.status === 403;
    const isAlias = JSON.stringify(sendData).toLowerCase().includes("alias");
    return err(
      isAuthError
        ? `Gmail authorization expired (token source: ${tokenSource}). Re-authorize the support inbox.`
        : isAlias
        ? `Gmail alias error: Add ${fromAddress} as a verified "Send As" alias inside the Gmail account → Settings → Accounts`
        : "Gmail send error",
      502,
      { detail: sendData, tokenSource }
    );
  }

  const { data: savedReply, error: se } = await sb.from("ticket_replies").insert({
    ticket_id:         ticketId,
    gmail_message_id:  sendData.id,
    gmail_thread_id:   sendData.threadId ?? ticket.gmail_thread_id,
    sender:            `${agentName} <${fromAddress}>`,
    body:              replyBody,
  }).select().single();

  if (se) {
    return ok({ sent: true, gmailMessageId: sendData.id, tokenSource, warning: "Email sent but failed to save to ticket_replies: " + se.message });
  }

  await sb.from("support_tickets").update({
    last_reply_at: new Date().toISOString(),
    ...(!isRealThreadId && sendData.threadId ? { gmail_thread_id: sendData.threadId } : {}),
  }).eq("id", ticketId);

  return ok({ sent: true, gmailMessageId: sendData.id, replyDbId: savedReply?.id, tokenSource });
});
