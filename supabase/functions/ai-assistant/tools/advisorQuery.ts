import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AdvisorProposal, OrgRosterEntry, ToolContext } from "./context.ts";
import { TOOL_DEFINITIONS, executeTool, isProposeToolName } from "./registry.ts";

const ANTHROPIC_MODEL = "claude-opus-4-6";
const MAX_TOOL_TURNS = 4;

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type AdvisorQueryResult = {
  title: string | null;
  bullets: string[];
  actions: { id: string; label: string }[];
  draft: string;
  structuredData: unknown;
  proposal: AdvisorProposal | null;
  crmProposal: null;
  taskProposal: null;
  clientNoteProposal: null;
  workspaceListProposal: null;
  workspaceListEditProposal: null;
  meta: {
    provider: string;
    apiConnected: boolean;
    toolCalls: string[];
  };
};

function advisorQuerySystemPrompt(): string {
  return (
    "You are a business advisor for a workspace dashboard with read tools and propose_* write tools. " +
    "For questions, call the minimum read tools (usually one) and summarize results. " +
    "For create/update/delete requests, call the matching propose_* tool once — do NOT claim the change is done. " +
    "After a propose_* tool returns a proposal, stop calling tools and tell the user to confirm (yes) or cancel. " +
    "Never invent data not returned by tools. " +
    "Capability hints: " +
    "calendar schedule/move/cancel/color → propose_appointment_*; lookup → list_appointments or find_free_slot; " +
    "tasks/todo → propose_task_* or list_today_tasks; " +
    "client status/priority/add → propose_client_*; overview → get_client_profile; " +
    "meeting note create/assign/email summary → propose_meeting_note_*; summaries → list_meeting_notes; " +
    "transaction review/hide/categorize → propose_transaction_*; unreviewed → list_unreviewed_transactions; " +
    "theme/timezone → propose_workspace_pref_update; " +
    "revenue/expenses → get_financial_summary; invoices → list_invoices. " +
    "Tier 3 multi-step (one confirmation for all steps): " +
    "schedule meeting + calendar invite → propose_schedule_and_invite; " +
    "monthly close (approve Plaid + P&L note) → propose_monthly_close; " +
    "onboard new client (CRM + kickoff + task) → propose_client_onboarding; " +
    "weekly status report → propose_weekly_status_draft. " +
    "Prefer these compound tools over chaining separate propose_* calls when the user wants multiple related changes."
  );
}

async function loadOrgRoster(
  supabase: SupabaseClient,
  orgId: string,
): Promise<OrgRosterEntry[]> {
  const { data, error } = await supabase.rpc("org_members_roster", { p_org: orgId });
  if (error || !Array.isArray(data)) return [];
  return data
    .map((row: Record<string, unknown>) => ({
      user_id: String(row.user_id || ""),
      display_name: String(row.display_name || ""),
      email: String(row.email || ""),
    }))
    .filter((m) => m.user_id && /^[0-9a-f-]{36}$/i.test(m.user_id));
}

function resolveUserDisplayName(
  claims: Record<string, unknown>,
  roster: OrgRosterEntry[],
  userId: string,
): { displayName: string; email: string } {
  const meta = (claims.user_metadata || claims) as Record<string, unknown>;
  const email = typeof claims.email === "string" ? claims.email : "";
  const fromMeta =
    (typeof meta.full_name === "string" && meta.full_name.trim()) ||
    [meta.first_name, meta.last_name].filter(Boolean).join(" ").trim() ||
    "";
  const fromRoster = roster.find((m) => m.user_id === userId);
  const displayName = fromMeta || fromRoster?.display_name || email.split("@")[0] || "User";
  return { displayName, email: email || fromRoster?.email || "" };
}

export async function runAdvisorQuery(
  anthropicApiKey: string,
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  claims: Record<string, unknown>,
  message: string,
  effectiveTimezone: string,
  lastEntities?: ToolContext["lastEntities"],
): Promise<AdvisorQueryResult> {
  const roster = await loadOrgRoster(supabase, orgId);
  const { displayName, email } = resolveUserDisplayName(claims, roster, userId);

  const ctx: ToolContext = {
    supabase,
    orgId,
    userId,
    userDisplayName: displayName,
    userEmail: email,
    effectiveTimezone: effectiveTimezone || "America/New_York",
    roster,
    lastEntities,
  };

  const messages: AnthropicMessage[] = [{ role: "user", content: message }];
  const toolCalls: string[] = [];
  let lastStructured: unknown = null;
  let capturedProposal: AdvisorProposal | null = null;
  let finalText = "";

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        system: advisorQuerySystemPrompt(),
        tools: TOOL_DEFINITIONS,
        tool_choice: { type: "auto" },
        messages,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Anthropic error ${resp.status}: ${txt.slice(0, 500)}`);
    }

    const data = await resp.json();
    const stopReason = String(data.stop_reason || "");
    const contentBlocks = Array.isArray(data.content) ? data.content : [];

    if (stopReason === "end_turn" || stopReason === "max_tokens") {
      const textParts = contentBlocks
        .filter((b: { type?: string }) => b?.type === "text")
        .map((b: { text?: string }) => String(b.text || ""))
        .join("\n")
        .trim();
      finalText = textParts || "I couldn't generate a response.";
      break;
    }

    if (stopReason !== "tool_use") {
      finalText = "I couldn't complete that request.";
      break;
    }

    const assistantContent: AnthropicContentBlock[] = contentBlocks.map((block: Record<string, unknown>) => {
      if (block.type === "text") {
        return { type: "text", text: String(block.text || "") };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: String(block.id),
          name: String(block.name),
          input: (block.input as Record<string, unknown>) || {},
        };
      }
      return { type: "text", text: "" };
    });

    messages.push({ role: "assistant", content: assistantContent });

    const toolResults: AnthropicContentBlock[] = [];
    for (const block of contentBlocks) {
      if (block.type !== "tool_use") continue;
      const name = String(block.name);
      const input = (block.input as Record<string, unknown>) || {};
      toolCalls.push(name);
      const result = await executeTool(name, input, ctx);
      lastStructured = result;
      if (
        isProposeToolName(name) &&
        result &&
        typeof result === "object" &&
        "proposal" in (result as Record<string, unknown>)
      ) {
        const p = (result as { proposal: AdvisorProposal }).proposal;
        if (p && p.id && p.type) {
          capturedProposal = p;
        }
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: String(block.id),
        content: JSON.stringify(result),
      });
    }

    if (!toolResults.length) {
      finalText = "No tool results were produced.";
      break;
    }

    messages.push({ role: "user", content: toolResults });

    if (capturedProposal) {
      finalText =
        capturedProposal.summary_human +
        "\n\nReply **yes** to apply, or **cancel** to discard. You can also use the buttons below.";
      break;
    }
  }

  if (!finalText) {
    finalText = "I reached the maximum number of lookup steps. Try a simpler question.";
  }

  return {
    title: null,
    bullets: [],
    actions: [],
    draft: finalText,
    structuredData: capturedProposal ? capturedProposal.payload : lastStructured,
    proposal: capturedProposal,
    crmProposal: null,
    taskProposal: null,
    clientNoteProposal: null,
    workspaceListProposal: null,
    workspaceListEditProposal: null,
    meta: {
      provider: "anthropic",
      apiConnected: true,
      toolCalls,
    },
  };
}
