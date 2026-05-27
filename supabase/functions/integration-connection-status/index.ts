import { createClient } from "npm:@supabase/supabase-js@2.101.1";
import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { resolveOrganizationId } from "../_shared/orgContext.ts";

type Body = { organizationId?: string };

function json(req: Request, status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

/** Infer granted products from stored OAuth scope string (no tokens returned). */
function flagsFromScopes(scopes: string | null | undefined) {
  const s = (scopes || "").toLowerCase();
  if (!s.trim()) {
    return { gmail: true, google_calendar: true };
  }
  return {
    gmail: s.includes("gmail."),
    google_calendar: s.includes("calendar"),
  };
}

serveWithEdgeRequestLogging("integration-connection-status", async (req, _ctx) => {
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

  const authHeader = req.headers.get("Authorization")?.trim() || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(req, 401, { error: "Missing Authorization" });
  }
  const jwt = authHeader.slice(7).trim();

  let organizationId: string | undefined;
  try {
    const body = (await req.json()) as Body;
    organizationId = body.organizationId?.trim();
  } catch {
    return json(req, 400, { error: "Invalid JSON body" });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user?.id) {
    return json(req, 401, { error: "Invalid session" });
  }
  const userId = userData.user.id;

  const orgId = await resolveOrganizationId(userClient, userId, organizationId ?? null);
  if (!orgId) {
    return json(req, 403, { error: "No organization membership" });
  }

  const { data: cred } = await admin
    .from("integration_credentials")
    .select("scopes")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();

  let gmail = false;
  let google_calendar = false;
  if (cred) {
    const f = flagsFromScopes(cred.scopes as string | undefined);
    gmail = f.gmail;
    google_calendar = f.google_calendar;
  }

  const { data: stripeRow, error: stripeErr } = await userClient
    .from("organization_stripe_connections")
    .select("charges_enabled, payouts_enabled, connect_status")
    .eq("organization_id", orgId)
    .maybeSingle();

  const disconnected = stripeRow?.connect_status === "disconnected";
  const stripe_ready =
    !stripeErr &&
    !!stripeRow &&
    !disconnected &&
    !!stripeRow.charges_enabled &&
    !!stripeRow.payouts_enabled;

  const { count: plaidCount } = await admin
    .from("plaid_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);

  const { data: plaidLatest } = await admin
    .from("plaid_items")
    .select("last_sync_at")
    .eq("organization_id", orgId)
    .order("last_sync_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: plaidUnreviewed } = await admin
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("source", "Plaid")
    // PostgREST supports json path filters via `metadata->>review_status`.
    .filter("metadata->>review_status", "eq", "unreviewed");

  return json(req, 200, {
    gmail,
    google_calendar,
    stripe: stripe_ready,
    plaid: {
      connected: (plaidCount ?? 0) > 0,
      item_count: plaidCount ?? 0,
      last_sync_at: (plaidLatest as { last_sync_at?: unknown } | null)?.last_sync_at ?? null,
      unreviewed_count: plaidUnreviewed ?? 0,
    },
  });
});
