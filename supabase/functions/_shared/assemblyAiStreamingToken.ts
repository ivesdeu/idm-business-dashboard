import { createClient } from "npm:@supabase/supabase-js@2.101.1";

export type AssemblyAiTokenResult =
  | { ok: true; token: string }
  | { ok: false; status: number; error: string };

export async function createAssemblyAiStreamingToken(
  accessToken: string,
): Promise<AssemblyAiTokenResult> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  // Prefer ASSEMBLYAI_API_KEY; accept legacy typo SSEMBLYAI_API_KEY (missing leading A).
  const assemblyApiKey =
    Deno.env.get("ASSEMBLYAI_API_KEY")?.trim() ||
    Deno.env.get("SSEMBLYAI_API_KEY")?.trim() ||
    "";
  if (!supabaseUrl || !anonKey) {
    return { ok: false, status: 500, error: "Missing Supabase env vars" };
  }
  if (!assemblyApiKey) {
    return {
      ok: false,
      status: 500,
      error:
        "Missing AssemblyAI env vars. Set ASSEMBLYAI_API_KEY in Supabase Edge secrets.",
    };
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(accessToken);
  if (userErr || !userData?.user) {
    return { ok: false, status: 401, error: userErr?.message || "Invalid session" };
  }

  // AssemblyAI streaming auth: raw API key in Authorization header (no "Bearer" prefix).
  const expiresInSeconds = 120;
  const tokenUrl =
    `https://streaming.assemblyai.com/v3/token?expires_in_seconds=${expiresInSeconds}&max_session_duration_seconds=3600`;
  const aaiRes = await fetch(tokenUrl, {
    method: "GET",
    headers: { Authorization: assemblyApiKey },
  });

  const payload = await aaiRes.json().catch(() => ({}));
  if (!aaiRes.ok) {
    const detail =
      typeof (payload as { error?: unknown }).error === "string"
        ? ((payload as { error: string }).error ?? "")
        : typeof (payload as { message?: unknown }).message === "string"
          ? ((payload as { message: string }).message ?? "")
          : `AssemblyAI token request failed (${aaiRes.status})`;
    const status = aaiRes.status === 402 ? 402 : 502;
    return {
      ok: false,
      status,
      error:
        aaiRes.status === 402
          ? "AssemblyAI streaming is not enabled on this account. Upgrade your AssemblyAI plan."
          : detail || "Failed to create AssemblyAI temporary token",
    };
  }

  const token =
    typeof (payload as { token?: unknown }).token === "string"
      ? (payload as { token: string }).token.trim()
      : "";
  if (!token) {
    return { ok: false, status: 502, error: "AssemblyAI token response was missing token" };
  }

  return { ok: true, token };
}
