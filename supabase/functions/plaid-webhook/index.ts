import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { verifyPlaidWebhookOrThrow } from "../_shared/plaidWebhookVerify.ts";
import { createClient } from "npm:@supabase/supabase-js@2.101.1";

function json(req: Request, status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

type WebhookBody = {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
};

serveWithEdgeRequestLogging("plaid-webhook", async (req, _ctx) => {
  // Plaid webhooks are server-to-server; still support OPTIONS for browser testing.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/$/, "");
  const serviceKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const workerSecret = (Deno.env.get("INTEGRATION_WORKER_SECRET") ?? "").trim();
  if (!supabaseUrl || !serviceKey || !workerSecret) {
    return json(req, 500, { error: "Server misconfiguration" });
  }

  try {
    await verifyPlaidWebhookOrThrow(req.headers.get("Plaid-Verification"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || "");
    return json(req, 401, { error: "Invalid Plaid webhook signature", details: msg });
  }

  let body: WebhookBody = {};
  try {
    body = (await req.json()) as WebhookBody;
  } catch {
    return json(req, 400, { error: "Invalid JSON body" });
  }

  const webhookType = String(body.webhook_type || "").trim();
  const webhookCode = String(body.webhook_code || "").trim();
  const itemId = String(body.item_id || "").trim();
  if (!itemId) return json(req, 200, { ok: true });

  // We only care about transaction sync updates in v1.
  const shouldSync =
    webhookType.toUpperCase() === "TRANSACTIONS" &&
    webhookCode.toUpperCase() === "SYNC_UPDATES_AVAILABLE";
  if (!shouldSync) return json(req, 200, { ok: true });

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: itemRow } = await admin
    .from("plaid_items")
    .select("organization_id, plaid_item_id")
    .eq("plaid_item_id", itemId)
    .maybeSingle();

  if (!itemRow?.organization_id) return json(req, 200, { ok: true });

  // Dispatch sync via the worker secret path so plaid-sync can run without a user JWT.
  const syncRes = await fetch(`${supabaseUrl}/functions/v1/plaid-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-integration-worker-secret": workerSecret,
    },
    body: JSON.stringify({
      organizationId: String(itemRow.organization_id),
      plaidItemId: itemId,
    }),
  });

  if (!syncRes.ok) {
    const payload = await syncRes.json().catch(() => ({}));
    return json(req, 500, { error: "Plaid sync dispatch failed", details: payload });
  }

  return json(req, 200, { ok: true });
});

