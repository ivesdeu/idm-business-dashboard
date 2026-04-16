/**
 * Browser CORS for dashboard origins only. Set DASHBOARD_ALLOWED_ORIGINS (comma-separated)
 * in Supabase Edge secrets for production hosts (e.g. https://app.example.com,https://preview.netlify.app).
 */
function parseAllowedOrigins(): Set<string> {
  const set = new Set<string>();
  set.add("http://localhost:5173");
  set.add("http://127.0.0.1:5173");
  const raw = Deno.env.get("DASHBOARD_ALLOWED_ORIGINS") ?? "";
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t) set.add(t);
  }
  return set;
}

export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allowed = parseAllowedOrigins();
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (origin && allowed.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}
