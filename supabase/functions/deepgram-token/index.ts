import { createClient } from "npm:@supabase/supabase-js@2.101.1";
import { corsHeadersFor } from "../_shared/cors.ts";
import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

serveWithEdgeRequestLogging("deepgram-token", async (req, _ctx) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const deepgramApiKey = Deno.env.get("DEEPGRAM_API_KEY");
  const deepgramProjectId = Deno.env.get("DEEPGRAM_PROJECT_ID");
  if (!supabaseUrl || !anonKey) {
    return json(req, 500, { error: "Missing Supabase env vars" });
  }
  if (!deepgramApiKey || !deepgramProjectId) {
    return json(req, 500, { error: "Missing Deepgram env vars" });
  }

  const authHeader = req.headers.get("Authorization")?.trim() || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(req, 401, { error: "Missing Authorization" });
  }
  const accessToken = authHeader.slice(7).trim();
  if (!accessToken) {
    return json(req, 401, { error: "Missing Authorization" });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(accessToken);
  if (userErr || !userData?.user) {
    return json(req, 401, { error: userErr?.message || "Invalid session" });
  }

  const dgRes = await fetch(`https://api.deepgram.com/v1/projects/${deepgramProjectId}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Token ${deepgramApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      comment: "Compass transient browser transcription key",
      scopes: ["usage:write", "listen:write"],
      time_to_live_in_seconds: 60,
      tags: ["compass", "transcription", "temporary"],
    }),
  });

  const payload = await dgRes.json().catch(() => ({}));
  if (!dgRes.ok) {
    const detail =
      typeof (payload as { err_msg?: unknown }).err_msg === "string"
        ? ((payload as { err_msg?: string }).err_msg ?? "")
        : typeof (payload as { message?: unknown }).message === "string"
          ? ((payload as { message?: string }).message ?? "")
          : "Failed to create Deepgram temporary key";
    return json(req, 502, { error: detail || "Failed to create Deepgram temporary key" });
  }

  const key = typeof (payload as { key?: unknown }).key === "string" ? (payload as { key: string }).key : "";
  if (!key) {
    return json(req, 502, { error: "Deepgram temporary key response was missing key" });
  }

  return json(req, 200, { key });
});
