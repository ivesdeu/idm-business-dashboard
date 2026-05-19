import { corsHeadersFor } from "../_shared/cors.ts";
import { createAssemblyAiStreamingToken } from "../_shared/assemblyAiStreamingToken.ts";
import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

serveWithEdgeRequestLogging("assemblyai-token", async (req, _ctx) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "Method not allowed" });
  }

  const authHeader = req.headers.get("Authorization")?.trim() || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(req, 401, { error: "Missing Authorization" });
  }
  const accessToken = authHeader.slice(7).trim();
  if (!accessToken) {
    return json(req, 401, { error: "Missing Authorization" });
  }

  const result = await createAssemblyAiStreamingToken(accessToken);
  if (!result.ok) {
    return json(req, result.status, { error: result.error });
  }
  return json(req, 200, { token: result.token });
});
