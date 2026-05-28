import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { OrgRosterEntry, ToolContext } from "./context.ts";
import { executeAppointmentAction } from "./writes/appointments.ts";
import { executeClientAction } from "./writes/clients.ts";
import { executeMeetingNoteAction } from "./writes/meetingNotes.ts";
import { executeTaskAction } from "./writes/tasks.ts";
import { executeTransactionAction } from "./writes/transactions.ts";
import { executeWorkspacePrefAction } from "./writes/workspacePrefs.ts";
import { executeCalendarSyncAction } from "./writes/calendarSync.ts";
import { runAdvisorExecuteCompound } from "./advisorExecuteCompound.ts";
import { isCompoundProposalType, type CompoundStep } from "./writes/shared.ts";

export type AdvisorActionInput = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

export type AdvisorExecuteResult = {
  ok: boolean;
  summary_human: string;
  summary_voice: string;
  result?: Record<string, unknown>;
  error?: string;
  client_action?: string;
  steps?: Array<{
    id: string;
    label: string;
    type: string;
    status: string;
    result?: Record<string, unknown>;
    error?: string;
  }>;
  workflow_run_id?: string | null;
};

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

function humanSummaryForType(type: string, result?: Record<string, unknown>, error?: string): string {
  if (error) return `Could not apply that change: ${error}`;
  switch (type) {
    case "appointment.create":
      return `Scheduled **${result?.title || "appointment"}**${result?.start_time ? ` for ${new Date(String(result.start_time)).toLocaleString()}` : ""}.`;
    case "appointment.update":
      return `Updated appointment **${result?.title || "event"}**.`;
    case "appointment.cancel":
      return `Cancelled **${result?.title || "appointment"}**.`;
    case "task.create":
      return `Added task **${result?.title || "task"}**.`;
    case "task.complete":
      return `Marked **${result?.title || "task"}** as done.`;
    case "client.create":
      return `Added client **${result?.company_name || result?.contact_name || "client"}**.`;
    case "client.update":
      return `Updated client **${result?.company_name || result?.contact_name || "record"}**.`;
    case "meeting_note.create":
      return `Created meeting note **${result?.title || "note"}**. Opening it now.`;
    case "meeting_note.assign_action_items":
      return `Assigned action items on ${(result?.updated_note_ids as string[] | undefined)?.length || 0} note(s) to you.`;
    case "meeting_note.email_summary":
      return `Opened email composer with the meeting summary. Click Send when ready.`;
    case "transaction.review":
      return `Updated transaction review status.`;
    case "transaction.recategorize_bulk":
      return `Recategorized **${result?.updated_count || 0}** transaction(s) to ${result?.label || result?.category_code}.`;
    case "workspace_prefs.update":
      return `Updated your workspace preferences.`;
    case "calendar.sync":
      return `Synced to Google Calendar${result?.invite_sent ? " and sent invite." : "."}`;
    case "transaction.approve_unreviewed_in_period":
      return `Approved **${result?.updated_count || 0}** unreviewed Plaid transaction(s).`;
    default:
      return "Change applied.";
  }
}

export async function runAdvisorExecuteAction(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  claims: Record<string, unknown>,
  action: AdvisorActionInput,
  effectiveTimezone: string,
  requestMeta?: { authHeader?: string; supabaseUrl?: string; anonKey?: string },
): Promise<AdvisorExecuteResult> {
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
    authHeader: requestMeta?.authHeader,
    supabaseUrl: requestMeta?.supabaseUrl,
    anonKey: requestMeta?.anonKey,
  };

  const type = String(action.type || "").trim();
  const payload = action.payload && typeof action.payload === "object" ? action.payload : {};

  if (isCompoundProposalType(type)) {
    const stepsRaw = Array.isArray((payload as { steps?: unknown }).steps)
      ? ((payload as { steps: CompoundStep[] }).steps)
      : [];
    const steps = stepsRaw.map((s, i) => ({
      id: s.id || `step_${i + 1}`,
      type: s.type,
      label: s.label || s.type,
      payload: s.payload && typeof s.payload === "object" ? s.payload : {},
      optional: s.optional === true,
    }));
    if (!steps.length) {
      return {
        ok: false,
        summary_human: "No steps found in compound action.",
        summary_voice: "That multi-step action had no steps.",
        error: "empty_compound_steps",
      };
    }
    const compoundResult = await runAdvisorExecuteCompound(ctx, type, steps, action.id);
    return compoundResult;
  }

  let exec: { ok: boolean; result?: Record<string, unknown>; error?: string; client_action?: string };

  if (type === "calendar.sync") {
    exec = await executeCalendarSyncAction(payload, ctx);
  } else if (type.startsWith("appointment.")) {
    exec = await executeAppointmentAction(type, payload, ctx);
  } else if (type.startsWith("task.")) {
    exec = await executeTaskAction(type, payload, ctx);
  } else if (type.startsWith("client.")) {
    exec = await executeClientAction(type, payload, ctx);
  } else if (type.startsWith("meeting_note.")) {
    exec = await executeMeetingNoteAction(type, payload, ctx);
  } else if (type.startsWith("transaction.")) {
    exec = await executeTransactionAction(type, payload, ctx);
  } else if (type.startsWith("workspace_prefs.")) {
    exec = await executeWorkspacePrefAction(type, payload, ctx);
  } else {
    return {
      ok: false,
      summary_human: `Unknown action type: ${type}`,
      summary_voice: "I could not apply that action.",
      error: `Unknown action type: ${type}`,
    };
  }

  const human = humanSummaryForType(type, exec.result, exec.error);
  const voice = exec.ok
    ? human.replace(/\*\*/g, "").slice(0, 400)
    : `Sorry, ${exec.error || "that failed"}.`;

  return {
    ok: exec.ok,
    summary_human: human,
    summary_voice: voice,
    result: exec.result,
    error: exec.error,
    client_action: exec.client_action,
    steps: exec.ok
      ? [
          {
            id: "single",
            label: humanSummaryForType(type, exec.result, exec.error),
            type,
            status: "ok",
            result: exec.result,
          },
        ]
      : [
          {
            id: "single",
            label: type,
            type,
            status: "error",
            error: exec.error,
          },
        ],
  };
}
