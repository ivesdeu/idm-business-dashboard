import { createClient } from "npm:@supabase/supabase-js@2.101.1";
import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { maybeEncryptRefreshToken } from "../_shared/tokenCrypto.ts";
import { itemPublicTokenExchange, accountsGet, transactionsSync } from "../_shared/plaidClient.ts";
import { mapPlaidPfcPrimaryToLedgerCategory, isInflow } from "../_shared/plaidCategoryMap.ts";

type Body = {
  organizationId?: string;
  public_token?: string;
  institution?: { institution_id?: string; name?: string };
};

function json(req: Request, status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function isAdminRole(role: string | undefined) {
  return role === "owner" || role === "admin";
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

serveWithEdgeRequestLogging("plaid-exchange", async (req, _ctx) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "Method not allowed. Use POST." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(req, 500, { error: "Server misconfiguration" });
  }

  const authHeader = req.headers.get("Authorization")?.trim() || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(req, 401, { error: "Missing Authorization bearer token." });
  }
  const jwt = authHeader.slice(7).trim();
  if (!jwt) return json(req, 401, { error: "Missing JWT." });

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(req, 400, { error: "Invalid JSON body." });
  }

  const organizationId = cleanText(body.organizationId);
  const publicToken = cleanText(body.public_token);
  const institutionId = cleanText(body.institution?.institution_id);
  const institutionName = cleanText(body.institution?.name);

  if (!organizationId) return json(req, 400, { error: "organizationId is required." });
  if (!publicToken) return json(req, 400, { error: "public_token is required." });

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return json(req, 401, { error: "Invalid or expired auth token." });
  }
  const user = userData.user;

  const { data: membership, error: memErr } = await userClient
    .from("organization_members")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (memErr || !membership || !isAdminRole(membership.role as string | undefined)) {
    return json(req, 403, { error: "Only workspace owners and admins can connect Plaid." });
  }

  const exchanged = await itemPublicTokenExchange({ public_token: publicToken });
  if (!exchanged.ok) return json(req, 500, { error: exchanged.error });

  const accessToken = exchanged.data.access_token;
  const itemId = exchanged.data.item_id;

  const encrypted = await maybeEncryptRefreshToken(accessToken);
  if (!encrypted) return json(req, 500, { error: "Failed to encrypt Plaid access token." });

  const { data: itemRow, error: insErr } = await admin
    .from("plaid_items")
    .upsert(
      {
        organization_id: organizationId,
        connected_by_user_id: user.id,
        plaid_item_id: itemId,
        institution_id: institutionId || null,
        institution_name: institutionName || null,
        access_token_encrypted: encrypted,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "plaid_item_id" },
    )
    .select("*")
    .single();

  if (insErr || !itemRow) {
    return json(req, 500, { error: "Failed to save Plaid item.", details: insErr?.message });
  }

  const accts = await accountsGet({ access_token: accessToken });
  if (!accts.ok) return json(req, 500, { error: accts.error });

  for (const acct of accts.data.accounts || []) {
    const balances = acct.balances || {};
    await admin.from("plaid_accounts").upsert(
      {
        organization_id: organizationId,
        item_id: itemRow.id,
        plaid_account_id: acct.account_id,
        name: acct.name ?? null,
        mask: acct.mask ?? null,
        type: acct.type ?? null,
        subtype: acct.subtype ?? null,
        current_balance: typeof balances.current === "number" ? balances.current : null,
        available_balance: typeof balances.available === "number" ? balances.available : null,
        iso_currency_code: balances.iso_currency_code ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "plaid_account_id" },
    );
  }

  // Initial backfill using cursor-less sync.
  let cursor: string | null = null;
  let totalUpserted = 0;
  let loops = 0;

  while (loops < 12) {
    loops += 1;
    const syncRes = await transactionsSync({ access_token: accessToken, cursor, count: 500 });
    if (!syncRes.ok) return json(req, 500, { error: syncRes.error });
    const data = syncRes.data;
    cursor = data.next_cursor;

    const rows: Array<Record<string, unknown>> = [];
    for (const tx of [...(data.added || []), ...(data.modified || [])]) {
      const pfcPrimary = tx.personal_finance_category?.primary ?? null;
      const category = mapPlaidPfcPrimaryToLedgerCategory(pfcPrimary, tx.amount);
      const amt = Math.abs(Number(tx.amount || 0) || 0);
      const desc = cleanText(tx.merchant_name) || cleanText(tx.name) || "Plaid transaction";
      rows.push({
        id: crypto.randomUUID(),
        organization_id: organizationId,
        user_id: user.id,
        date: tx.date,
        category,
        amount: amt,
        description: desc,
        source: "Plaid",
        metadata: {
          plaid_transaction_id: tx.transaction_id,
          plaid_account_id: tx.account_id,
          pending: !!tx.pending,
          inflow: isInflow(tx.amount),
          pfc_primary: pfcPrimary,
          pfc_detailed: tx.personal_finance_category?.detailed ?? null,
          review_status: "unreviewed",
        },
        updated_at: new Date().toISOString(),
      });
    }

    if (rows.length) {
      const { error: upErr } = await admin.from("transactions").upsert(rows, {
        onConflict: "organization_id,(metadata->>'plaid_transaction_id')",
        ignoreDuplicates: false,
      });
      if (upErr) {
        // Fall back: insert without explicit onConflict if PostgREST rejects expression onConflict.
        const { error: insertErr } = await admin.from("transactions").insert(rows);
        if (insertErr) {
          return json(req, 500, { error: "Failed to upsert Plaid transactions.", details: insertErr.message });
        }
      }
      totalUpserted += rows.length;
    }

    if (!data.has_more) break;
  }

  await admin
    .from("plaid_items")
    .update({ sync_cursor: cursor, last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", itemRow.id)
    .eq("organization_id", organizationId);

  return json(req, 200, {
    plaid_item_id: itemId,
    accounts: (accts.data.accounts || []).length,
    transactions_upserted: totalUpserted,
  });
});

