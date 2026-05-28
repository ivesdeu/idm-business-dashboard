import { createClient } from "npm:@supabase/supabase-js@2.101.1";
import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { maybeDecryptRefreshToken } from "../_shared/tokenCrypto.ts";
import { resolveOrganizationId } from "../_shared/orgContext.ts";
import { transactionsSync } from "../_shared/plaidClient.ts";
import { mapPlaidPfcPrimaryToLedgerCategory, isInflow } from "../_shared/plaidCategoryMap.ts";

type Body = { organizationId?: string; plaidItemId?: string };

function json(req: Request, status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function authorizeWorker(req: Request): boolean {
  const secret = Deno.env.get("INTEGRATION_WORKER_SECRET")?.trim();
  if (!secret) return false;
  const h = req.headers.get("x-integration-worker-secret");
  if (h === secret) return true;
  const auth = req.headers.get("Authorization");
  if (auth === `Bearer ${secret}`) return true;
  return false;
}

function cleanText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

serveWithEdgeRequestLogging("plaid-sync", async (req, _ctx) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(req, 500, { error: "Server misconfiguration" });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(req, 400, { error: "Invalid JSON body" });
  }

  const requestedOrgId = cleanText(body.organizationId);
  const plaidItemId = cleanText(body.plaidItemId);

  const worker = authorizeWorker(req);

  const authHeader = req.headers.get("Authorization")?.trim() || "";
  const hasJwt = authHeader.toLowerCase().startsWith("bearer ") && !worker;
  const jwt = hasJwt ? authHeader.slice(7).trim() : "";

  const admin = createClient(supabaseUrl, serviceKey);

  let orgId = requestedOrgId;
  let userId: string | null = null;

  if (!worker) {
    if (!jwt) return json(req, 401, { error: "Missing Authorization" });
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
    if (userErr || !userData?.user?.id) {
      return json(req, 401, { error: "Invalid session" });
    }
    userId = userData.user.id;
    const resolved = await resolveOrganizationId(userClient, userId, orgId || null);
    if (!resolved) return json(req, 403, { error: "No organization membership" });
    orgId = resolved;
  } else {
    if (!orgId) return json(req, 400, { error: "organizationId is required for worker sync" });
  }

  // Load items for org (and optionally specific item_id).
  let query = admin
    .from("plaid_items")
    .select("id, organization_id, connected_by_user_id, access_token_encrypted, sync_cursor, plaid_item_id")
    .eq("organization_id", orgId);
  if (plaidItemId) query = query.eq("plaid_item_id", plaidItemId);

  const { data: items, error: itemsErr } = await query;
  if (itemsErr) return json(req, 500, { error: "Failed to load Plaid items", details: itemsErr.message });
  if (!items || !items.length) return json(req, 200, { ok: true, synced_items: 0, upserted: 0 });

  let totalUpserted = 0;
  let syncedItems = 0;

  for (const item of items as Array<Record<string, unknown>>) {
    const rowId = String(item.id);
    const tokenEnc = String(item.access_token_encrypted || "");
    const cursorStored = cleanText(item.sync_cursor);
    const connectedBy = String(item.connected_by_user_id || userId || "");

    const accessToken = await maybeDecryptRefreshToken(tokenEnc);
    if (!accessToken) {
      await admin.from("plaid_items").update({ last_error: "Could not decrypt access token", updated_at: new Date().toISOString() }).eq("id", rowId);
      continue;
    }

    let cursor: string | null = cursorStored || null;
    let loops = 0;

    while (loops < 20) {
      loops += 1;
      const syncRes = await transactionsSync({ access_token: accessToken, cursor, count: 500 });
      if (!syncRes.ok) {
        await admin.from("plaid_items").update({ last_error: syncRes.error, updated_at: new Date().toISOString() }).eq("id", rowId);
        break;
      }
      const data = syncRes.data;
      cursor = data.next_cursor;

      const candidates: Array<{ pid: string; row: Record<string, unknown> }> = [];
      for (const tx of [...(data.added || []), ...(data.modified || [])]) {
        const pfcPrimary = tx.personal_finance_category?.primary ?? null;
        const category = mapPlaidPfcPrimaryToLedgerCategory(pfcPrimary, tx.amount);
        const amt = Math.abs(Number(tx.amount || 0) || 0);
        const desc =
          cleanText(tx.merchant_name) || cleanText(tx.name) || "Plaid transaction";
        const pid = String(tx.transaction_id || "");
        if (!pid) continue;
        candidates.push({
          pid,
          row: {
            id: crypto.randomUUID(),
            organization_id: orgId,
            user_id: connectedBy,
            date: tx.date,
            category,
            amount: amt,
            description: desc,
            source: "Plaid",
            metadata: {
              plaid_transaction_id: pid,
              plaid_account_id: tx.account_id,
              pending: !!tx.pending,
              inflow: isInflow(tx.amount),
              pfc_primary: pfcPrimary,
              pfc_detailed: tx.personal_finance_category?.detailed ?? null,
              review_status: "unreviewed",
            },
          },
        });
      }

      if (candidates.length) {
        const pids = candidates.map((c) => c.pid);
        const { data: existing } = await admin
          .from("transactions")
          .select("metadata")
          .eq("organization_id", orgId)
          .in("metadata->>plaid_transaction_id", pids);

        const seen = new Set<string>();
        for (const r of (existing || []) as Array<{ metadata?: Record<string, unknown> }>) {
          const p = String(r?.metadata?.plaid_transaction_id || "");
          if (p) seen.add(p);
        }

        const toInsert = candidates.filter((c) => !seen.has(c.pid)).map((c) => c.row);
        if (toInsert.length) {
          const { error: insErr } = await admin.from("transactions").insert(toInsert);
          if (insErr) {
            await admin.from("plaid_items").update({ last_error: insErr.message, updated_at: new Date().toISOString() }).eq("id", rowId);
            break;
          }
          totalUpserted += toInsert.length;
        }
      }

      if (!data.has_more) {
        await admin.from("plaid_items").update({
          sync_cursor: cursor,
          last_sync_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        }).eq("id", rowId);
        syncedItems += 1;
        break;
      }
    }
  }

  return json(req, 200, { ok: true, synced_items: syncedItems, upserted: totalUpserted });
});

