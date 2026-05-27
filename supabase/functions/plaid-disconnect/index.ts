import { createClient } from "npm:@supabase/supabase-js@2.101.1";
import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

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

serveWithEdgeRequestLogging("plaid-disconnect", async (req, _ctx) => {
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

  let organizationId = "";
  try {
    const body = (await req.json()) as Body;
    organizationId = String(body.organizationId || "").trim();
  } catch {
    return json(req, 400, { error: "Invalid JSON body." });
  }

  if (!organizationId) return json(req, 400, { error: "organizationId is required." });

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return json(req, 401, { error: "Invalid or expired auth token." });
  }

  const { data: membership, error: memErr } = await userClient
    .from("organization_members")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (memErr || !membership || !isAdminRole(membership.role as string | undefined)) {
    return json(req, 403, { error: "Only workspace owners and admins can disconnect Plaid." });
  }

  // Delete Plaid items (cascade deletes plaid_accounts).
  const { error: delErr } = await admin
    .from("plaid_items")
    .delete()
    .eq("organization_id", organizationId);

  if (delErr) return json(req, 500, { error: "Failed to disconnect Plaid.", details: delErr.message });

  return json(req, 200, { ok: true });
});

