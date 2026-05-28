import type { AdvisorToolModule, ToolContext } from "../context.ts";
import { makeProposal } from "./shared.ts";
import { optionalString } from "../utils.ts";

const THEMES = new Set(["light", "dark", "system"]);

export const proposeWorkspacePrefUpdateTool: AdvisorToolModule = {
  name: "propose_workspace_pref_update",
  definition: {
    name: "propose_workspace_pref_update",
    description:
      "Propose updating user UI preferences (theme, timezone). Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        theme: { type: "string", enum: ["light", "dark", "system"] },
        timezone: { type: "string", description: "IANA timezone e.g. America/Chicago" },
        timezone_auto: { type: "boolean" },
      },
    },
  },
  async execute(input, ctx) {
    const patch: Record<string, unknown> = {};
    const theme = optionalString(input.theme, 16)?.toLowerCase();
    if (theme && THEMES.has(theme)) patch.theme = theme;
    const tz = optionalString(input.timezone, 64);
    if (tz) patch.timezone = tz;
    if (typeof input.timezone_auto === "boolean") patch.timezone_auto = input.timezone_auto;

    if (!Object.keys(patch).length) return { error: "No preference fields to update." };

    const bits: string[] = [];
    if (patch.theme) bits.push(`theme → ${patch.theme}`);
    if (patch.timezone) bits.push(`timezone → ${patch.timezone}`);
    if (patch.timezone_auto !== undefined) bits.push(`automatic timezone → ${patch.timezone_auto}`);

    const human = `Update your preferences: ${bits.join(", ")}?`;
    const voice = `Update ${bits.join(", ")}. Say yes to confirm.`;
    return makeProposal("workspace_prefs.update", patch, human, voice);
  },
};

export async function executeWorkspacePrefAction(
  type: string,
  payload: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string; client_action?: string }> {
  if (type !== "workspace_prefs.update") {
    return { ok: false, error: `Unknown workspace pref action: ${type}` };
  }

  const { data: existing, error: fetchErr } = await ctx.supabase
    .from("user_ui_preferences")
    .select("payload")
    .eq("user_id", ctx.userId)
    .maybeSingle();

  if (fetchErr) return { ok: false, error: fetchErr.message };

  const base =
    existing?.payload && typeof existing.payload === "object"
      ? (existing.payload as Record<string, unknown>)
      : { v: 1, preferences: {} };

  const prefs =
    base.preferences && typeof base.preferences === "object"
      ? { ...(base.preferences as Record<string, unknown>) }
      : {};

  if (payload.theme) prefs.theme = payload.theme;
  if (payload.timezone) prefs.timezone = payload.timezone;
  if (payload.timezone_auto !== undefined) prefs.timezoneAuto = payload.timezone_auto;

  const nextPayload = { ...base, v: 1, preferences: prefs };

  const { error } = await ctx.supabase.from("user_ui_preferences").upsert(
    {
      user_id: ctx.userId,
      payload: nextPayload,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    result: { preferences: prefs },
    client_action: "apply_preferences_runtime",
  };
}
