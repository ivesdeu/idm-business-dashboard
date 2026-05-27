import { createClient } from "npm:@supabase/supabase-js@2.101.1";
import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { linkTokenCreate } from "../_shared/plaidClient.ts";

type Body = { organizationId?: string };

function json(req: Request, status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function isAdminRole(role: string | undefined) {
  return role === "owner" || role === "admin";
}

serveWithEdgeRequestLogging("plaid-link-token", async (req, _ctx) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "Method not allowed. Use POST." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
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

  const organizationId = String(body.organizationId || "").trim();
  if (!organizationId) return json(req, 400, { error: "organizationId is required." });

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

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

  const webhookUrl = (Deno.env.get("PLAID_WEBHOOK_URL") ?? "").trim();

  const link = await linkTokenCreate({
    client_user_id: `${organizationId}|${user.id}`,
    webhook: webhookUrl || null,
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
  });
  if (!link.ok) {
    return json(req, 500, { error: link.error });
  }

  return json(req, 200, {
    link_token: link.data.link_token,
    expiration: link.data.expiration,
  });
});

