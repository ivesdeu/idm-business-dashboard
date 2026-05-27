import { createClient } from "npm:@supabase/supabase-js@2.101.1";
import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { edgeLog } from "../_shared/edgeLog.ts";

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function authorizeCron(req: Request): boolean {
  const secret = Deno.env.get("INTEGRATION_WORKER_SECRET")?.trim();
  if (!secret) return false;
  const h = req.headers.get("x-integration-worker-secret");
  if (h === secret) return true;
  const auth = req.headers.get("Authorization");
  if (auth === `Bearer ${secret}`) return true;
  return false;
}

/**
 * Scheduled / manual worker for integration sync (refresh tokens, queue sends, etc.).
 * Protect with INTEGRATION_WORKER_SECRET (header or Bearer). Implement sync logic here.
 */
serveWithEdgeRequestLogging("integration-worker", async (req, ctx) => {
  const requestId = ctx.requestId;
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return json(req, 405, { error: "Method not allowed" });
  }

  if (!authorizeCron(req)) {
    edgeLog({
      fn: "integration-worker",
      level: "warn",
      action: "deny",
      requestId,
      detail: "missing or invalid INTEGRATION_WORKER_SECRET",
    });
    return json(req, 401, { error: "Unauthorized" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json(req, 500, { error: "Missing Supabase configuration" });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const { count, error } = await admin.from("integration_credentials").select("id", {
    count: "exact",
    head: true,
  });

  if (error) {
    return json(req, 500, { error: error.message });
  }

  // Plaid safety-net sync (in case webhook delivery is delayed or missed).
  const staleCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data: staleItems } = await admin
    .from("plaid_items")
    .select("organization_id, plaid_item_id, last_sync_at")
    .or(`last_sync_at.is.null,last_sync_at.lt.${staleCutoff}`)
    .limit(12);

  let plaidSynced = 0;
  let plaidAttempts = 0;
  const workerSecret = Deno.env.get("INTEGRATION_WORKER_SECRET")?.trim() || "";

  if (workerSecret && staleItems?.length) {
    for (const item of staleItems as Array<Record<string, unknown>>) {
      const orgId = String(item.organization_id || "").trim();
      const itemId = String(item.plaid_item_id || "").trim();
      if (!orgId || !itemId) continue;
      plaidAttempts += 1;
      try {
        const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/plaid-sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-integration-worker-secret": workerSecret,
          },
          body: JSON.stringify({ organizationId: orgId, plaidItemId: itemId }),
        });
        if (res.ok) plaidSynced += 1;
      } catch {
        // Intentionally ignore: worker is best-effort.
      }
    }
  }

  return json(req, 200, {
    ok: true,
    at: new Date().toISOString(),
    integration_credentials_rows: count ?? 0,
    plaid_attempts: plaidAttempts,
    plaid_synced: plaidSynced,
    note: "Integration worker ran. Add more provider sync tasks here as needed.",
  });
});
