// supabase/functions/org-setup/index.ts
//
// Built against the FULLY VERIFIED real schema:
//   organisations(id, name, plan, trial_ends_at, plan_renews_at,
//     plan_updated_at, billing_email, billing_name, billing_address,
//     billing_country, pesapal_customer_token, ticket_limit,
//     agent_limit, inbox_limit, support_email, custom_domain,
//     logo_url, hide_branding)
//   billing_transactions(id, org_id, order_ref, plan, amount,
//     currency, status, user_email, user_name, receipt_number,
//     pesapal_tracking_id, pesapal_confirmation_code, paid_at)
//   system_settings(key, value, updated_at) — new, caches the
//     registered Pesapal IPN id so we never need a manual dashboard
//     step or a hand-set PESAPAL_IPN_ID secret.
//   profiles.org_id, support_tickets.org_id (added by migration-final.sql)
//
// Payment provider: PESAPAL (confirmed live for East Africa).
// Stripe is intentionally NOT included — billing_transactions has
// zero Stripe columns.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
function ok(d: unknown) { return new Response(JSON.stringify(d), { status: 200, headers: { ...CORS, "content-type": "application/json" } }); }
function err(msg: string, status = 400, extra: object = {}) { return new Response(JSON.stringify({ error: msg, ...extra }), { status, headers: { ...CORS, "content-type": "application/json" } }); }

const APP_URL              = Deno.env.get("APP_URL") ?? "https://goobox.necxa.uk";
const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const PESAPAL_CONSUMER_KEY = Deno.env.get("PESAPAL_CONSUMER_KEY") ?? "";
const PESAPAL_CONSUMER_SECRET = Deno.env.get("PESAPAL_CONSUMER_SECRET") ?? "";
const PESAPAL_BASE = Deno.env.get("PESAPAL_ENV") === "live"
  ? "https://pay.pesapal.com/v3"
  : "https://cybqa.pesapal.com/pesapalv3"; // sandbox default — safer until confirmed live

// The IPN callback URL Pesapal will hit after payment. Must be
// reachable publicly — this function's own deployed URL, routed by
// the "pesapal-ipn" path check in the router below.
const IPN_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/org-setup/pesapal-ipn`;

const PLAN_PRICES_UGX: Record<string,number> = { pro: 109000, proplus: 299000 }; // approx £29/£79 in UGX, adjust as needed
const PLAN_LIMITS: Record<string,{tickets:number;agents:number;inboxes:number}> = {
  free:    {tickets:100,   agents:1,  inboxes:1},
  pro:     {tickets:1000,  agents:3,  inboxes:2},
  proplus: {tickets:10000, agents:10, inboxes:5},
};

function sbAdmin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return err("Method not allowed", 405);
  const path = new URL(req.url).pathname.split("/").pop();
  if (path === "pesapal-webhook" || path === "pesapal-ipn") return handlePesapalIPN(req);

  let body: any;
  try { body = await req.json(); } catch { return err("Invalid JSON", 400); }
  switch (body?.action) {
    case "send-invite":      return sendInvite(body);
    case "create-checkout":  return createPesapalCheckout(body);
    case "get-org":          return getOrg(body);
    case "update-org":       return updateOrg(body);
    case "cancel-invite":    return cancelInvite(body);
    case "generate-api-key": return generateApiKey(body);
    default: return err("Unknown action", 404);
  }
});

// ── Invite a new agent — enforces agent_limit BEFORE creating it ──
async function sendInvite(body: any) {
  const { orgId, email, role = "agent", invitedBy } = body;
  if (!orgId || !email) return err("Missing orgId or email", 400);

  const client = sbAdmin();
  const { data: org, error: oe } = await client.from("organisations").select("*").eq("id", orgId).single();
  if (oe || !org) return err("Organisation not found", 404);

  const { count: agentCount } = await client.from("profiles")
    .select("*", { count: "exact", head: true }).eq("org_id", orgId);
  const { count: pendingCount } = await client.from("invites")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId).is("accepted_at", null).gt("expires_at", new Date().toISOString());

  const seatsUsed = (agentCount ?? 0) + (pendingCount ?? 0);
  if (seatsUsed >= org.agent_limit) {
    return err(
      `AGENT_LIMIT_EXCEEDED: Your ${org.plan} plan allows ${org.agent_limit} agent seat(s) — all are in use (including pending invites). Upgrade to add more.`,
      403,
      { plan: org.plan, agentLimit: org.agent_limit, seatsUsed }
    );
  }

  const { data: invite, error: ie } = await client.from("invites").insert({
    org_id: orgId, email, role, invited_by: invitedBy,
  }).select().single();
  if (ie) return err("Invite creation failed: " + ie.message, 500);

  const inviteUrl = `${APP_URL}?invite=${invite.token}`;
  await client.auth.admin.inviteUserByEmail(email, {
    redirectTo: inviteUrl,
    data: { invite_token: invite.token, org_name: org.name },
  });

  return ok({ invited: true, token: invite.token, inviteUrl, seatsUsed: seatsUsed + 1, seatsTotal: org.agent_limit });
}

// ── Pesapal OAuth token (required before any Pesapal API call) ──
async function getPesapalToken(): Promise<string> {
  const res = await fetch(`${PESAPAL_BASE}/api/Auth/RequestToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ consumer_key: PESAPAL_CONSUMER_KEY, consumer_secret: PESAPAL_CONSUMER_SECRET }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error("Pesapal auth failed: " + JSON.stringify(data));
  return data.token;
}

// ── Ensure we have a registered Pesapal IPN id ────────────────────
// Pesapal requires a one-time RegisterIPN call to get a
// notification_id before any SubmitOrderRequest will accept
// payments correctly. Rather than requiring a manual dashboard step
// or a hand-set secret, we register once and cache the result in
// system_settings — self-healing across sandbox/live switches too,
// since the cache key includes the Pesapal env.
async function ensurePesapalIPN(client: ReturnType<typeof sbAdmin>, token: string): Promise<string> {
  const envTag = Deno.env.get("PESAPAL_ENV") === "live" ? "live" : "sandbox";
  const cacheKey = `pesapal_ipn_id_${envTag}`;

  const { data: cached } = await client.from("system_settings").select("value").eq("key", cacheKey).maybeSingle();
  if (cached?.value) return cached.value;

  const res = await fetch(`${PESAPAL_BASE}/api/URLSetup/RegisterIPN`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ url: IPN_CALLBACK_URL, ipn_notification_type: "GET" }),
  });
  const data = await res.json();
  if (!res.ok || !data.ipn_id) {
    throw new Error("Pesapal IPN registration failed: " + JSON.stringify(data));
  }

  await client.from("system_settings").upsert({
    key: cacheKey,
    value: data.ipn_id,
    updated_at: new Date().toISOString(),
  });

  return data.ipn_id;
}

// ── Create a Pesapal checkout (hosted payment page) ──────────────
async function createPesapalCheckout(body: any) {
  const { orgId, plan, userEmail, userName } = body;
  if (!orgId || !plan) return err("Missing orgId or plan", 400);
  if (!PESAPAL_CONSUMER_KEY || !PESAPAL_CONSUMER_SECRET) {
    return err("Pesapal not configured — add PESAPAL_CONSUMER_KEY and PESAPAL_CONSUMER_SECRET to this function's edge secrets", 503);
  }

  const client = sbAdmin();
  const { data: org } = await client.from("organisations").select("*").eq("id", orgId).single();
  if (!org) return err("Organisation not found", 404);

  const amount = PLAN_PRICES_UGX[plan];
  if (!amount) return err(`No price configured for plan "${plan}"`, 400);

  let token: string;
  try { token = await getPesapalToken(); }
  catch (e) { return err("Pesapal auth error: " + (e as Error).message, 502); }

  let ipnId: string;
  try { ipnId = await ensurePesapalIPN(client, token); }
  catch (e) { return err("Pesapal IPN setup error: " + (e as Error).message, 502); }

  const orderRef = `goobox-${orgId.slice(0, 8)}-${Date.now()}`;

  // Record the pending transaction first so the IPN callback has
  // something to match against when Pesapal confirms payment.
  await client.from("billing_transactions").insert({
    org_id: orgId, order_ref: orderRef, plan, amount, currency: "UGX",
    status: "pending", user_email: userEmail ?? org.billing_email,
    user_name: userName ?? org.billing_name,
  });

  const submitRes = await fetch(`${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      id: orderRef,
      currency: "UGX",
      amount,
      description: `GOOBOX ${plan} plan subscription`,
      callback_url: `${APP_URL}?checkout=return&plan=${plan}&order=${orderRef}`,
      notification_id: ipnId,
      billing_address: {
        email_address: userEmail ?? org.billing_email ?? "",
        first_name: userName ?? org.billing_name ?? "Customer",
        country_code: org.billing_country ?? "UG",
      },
    }),
  });

  const submitData = await submitRes.json();
  if (!submitRes.ok || !submitData.redirect_url) {
    console.error("Pesapal SubmitOrderRequest failed:", JSON.stringify(submitData));
    return err("Pesapal order submission failed: " + (submitData.error?.message || submitData.message || "unknown error"), 502, { detail: submitData });
  }

  await client.from("billing_transactions").update({
    pesapal_tracking_id: submitData.order_tracking_id,
  }).eq("order_ref", orderRef);

  return ok({ checkoutUrl: submitData.redirect_url, orderRef });
}

// ── Pesapal IPN (Instant Payment Notification) — confirms payment ──
async function handlePesapalIPN(req: Request) {
  const url = new URL(req.url);
  const orderTrackingId = url.searchParams.get("OrderTrackingId") ?? url.searchParams.get("orderTrackingId");
  const orderRef = url.searchParams.get("OrderMerchantReference") ?? url.searchParams.get("orderMerchantReference");
  if (!orderTrackingId) return err("Missing OrderTrackingId", 400);

  const client = sbAdmin();
  let token: string;
  try { token = await getPesapalToken(); }
  catch (e) { return err("Pesapal auth error: " + (e as Error).message, 502); }

  const statusRes = await fetch(`${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const statusData = await statusRes.json();

  const { data: txn } = await client.from("billing_transactions")
    .select("*").eq("pesapal_tracking_id", orderTrackingId).maybeSingle();
  if (!txn) return err("Transaction not found for tracking id " + orderTrackingId, 404);

  const isPaid = statusData.payment_status_description?.toLowerCase() === "completed" || statusData.status_code === 1;

  await client.from("billing_transactions").update({
    status: isPaid ? "paid" : "failed",
    pesapal_confirmation_code: statusData.confirmation_code ?? null,
    paid_at: isPaid ? new Date().toISOString() : null,
  }).eq("id", txn.id);

  if (isPaid) {
    const lim = PLAN_LIMITS[txn.plan] ?? PLAN_LIMITS.free;
    await client.from("organisations").update({
      plan: txn.plan,
      ticket_limit: lim.tickets,
      agent_limit: lim.agents,
      inbox_limit: lim.inboxes,
      plan_updated_at: new Date().toISOString(),
      plan_renews_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    }).eq("id", txn.org_id);
  }

  return ok({ received: true, paid: isPaid });
}

// ── Get org details + members + pending invites ───────────────────
async function getOrg(body: any) {
  const { orgId } = body;
  if (!orgId) return err("Missing orgId", 400);
  const client = sbAdmin();
  const { data: org } = await client.from("organisations").select("*").eq("id", orgId).single();
  if (!org) return err("Not found", 404);
  const { data: members } = await client.from("profiles").select("id, full_name, role, created_at").eq("org_id", orgId);
  const { data: pending } = await client.from("invites").select("*").eq("org_id", orgId).is("accepted_at", null).gt("expires_at", new Date().toISOString());
  const { data: summary } = await client.from("org_billing_summary").select("*").eq("org_id", orgId).maybeSingle();
  return ok({ ...org, members: members ?? [], pendingInvites: pending ?? [], billingSummary: summary ?? null });
}

async function updateOrg(body: any) {
  const { orgId, updates } = body;
  if (!orgId || !updates) return err("Missing fields", 400);
  const allowed = ["name", "support_email", "custom_domain", "logo_url", "hide_branding", "billing_email", "billing_name", "billing_address", "billing_country"];
  const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)));
  const client = sbAdmin();
  const { data, error } = await client.from("organisations").update(safe).eq("id", orgId).select().single();
  if (error) return err("Update failed: " + error.message, 500);
  return ok(data);
}

async function cancelInvite(body: any) {
  const { inviteId } = body;
  if (!inviteId) return err("Missing inviteId", 400);
  await sbAdmin().from("invites").delete().eq("id", inviteId);
  return ok({ cancelled: true });
}

// ── Generate a real API key — hashed at rest, shown once ──────────
async function generateApiKey(body: any) {
  const { orgId } = body;
  if (!orgId) return err("Missing orgId", 400);
  const client = sbAdmin();
  const { data: org, error: oe } = await client.from("organisations").select("plan").eq("id", orgId).single();
  if (oe || !org) return err("Organisation not found", 404);
  if (org.plan !== "proplus" && org.plan !== "enterprise") {
    return err("API_ACCESS_REQUIRES_PROPLUS: API access requires the Pro+ plan or higher.", 403, { plan: org.plan });
  }

  const rawBytes = new Uint8Array(32);
  crypto.getRandomValues(rawBytes);
  const rawHex = Array.from(rawBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const apiKey = `goobox_sk_${rawHex}`;

  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

  const { error: ue } = await client.from("organisations").update({
    api_key_hash: hashHex,
    api_key_prefix: apiKey.slice(0, 20),
    api_key_created_at: new Date().toISOString(),
  }).eq("id", orgId);
  if (ue) return err("Failed to save API key: " + ue.message, 500);

  return ok({ apiKey });
}
