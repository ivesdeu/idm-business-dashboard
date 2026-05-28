import type { AdvisorToolModule, AnthropicToolDefinition, ToolContext } from "./context.ts";
import { listAppointmentsTool } from "./listAppointments.ts";
import { findFreeSlotTool } from "./findFreeSlot.ts";
import { getClientProfileTool } from "./getClientProfile.ts";
import { listClientsTool } from "./listClients.ts";
import { listMeetingNotesTool } from "./listMeetingNotes.ts";
import { listActionItemsTool } from "./listActionItems.ts";
import { getFinancialSummaryTool } from "./getFinancialSummary.ts";
import { listInvoicesTool } from "./listInvoices.ts";
import { listUnreviewedTransactionsTool } from "./listUnreviewedTransactions.ts";
import { listTodayTasksTool } from "./writes/tasks.ts";
import {
  proposeAppointmentCancelTool,
  proposeAppointmentCreateTool,
  proposeAppointmentUpdateTool,
} from "./writes/appointments.ts";
import { proposeTaskCompleteTool, proposeTaskCreateTool } from "./writes/tasks.ts";
import { proposeClientCreateTool, proposeClientUpdateTool } from "./writes/clients.ts";
import {
  proposeEmailMeetingSummaryTool,
  proposeMeetingNoteAssignActionItemsTool,
  proposeMeetingNoteCreateTool,
} from "./writes/meetingNotes.ts";
import {
  proposeTransactionReviewTool,
  proposeTransactionsRecategorizeTool,
} from "./writes/transactions.ts";
import { proposeWorkspacePrefUpdateTool } from "./writes/workspacePrefs.ts";
import { proposeScheduleAndInviteTool } from "./writes/orchestration/scheduleAndInvite.ts";
import { proposeMonthlyCloseTool } from "./writes/orchestration/monthlyClose.ts";
import { proposeClientOnboardingTool } from "./writes/orchestration/clientOnboarding.ts";
import { proposeWeeklyStatusDraftTool } from "./writes/orchestration/weeklyStatusDraft.ts";

const READ_TOOLS: AdvisorToolModule[] = [
  listAppointmentsTool,
  findFreeSlotTool,
  getClientProfileTool,
  listClientsTool,
  listMeetingNotesTool,
  listActionItemsTool,
  getFinancialSummaryTool,
  listInvoicesTool,
  listUnreviewedTransactionsTool,
  listTodayTasksTool,
];

const PROPOSE_TOOLS: AdvisorToolModule[] = [
  proposeAppointmentCreateTool,
  proposeAppointmentUpdateTool,
  proposeAppointmentCancelTool,
  proposeTaskCreateTool,
  proposeTaskCompleteTool,
  proposeClientUpdateTool,
  proposeClientCreateTool,
  proposeMeetingNoteCreateTool,
  proposeMeetingNoteAssignActionItemsTool,
  proposeEmailMeetingSummaryTool,
  proposeTransactionReviewTool,
  proposeTransactionsRecategorizeTool,
  proposeWorkspacePrefUpdateTool,
  proposeScheduleAndInviteTool,
  proposeMonthlyCloseTool,
  proposeClientOnboardingTool,
  proposeWeeklyStatusDraftTool,
];

const TOOLS: AdvisorToolModule[] = [...READ_TOOLS, ...PROPOSE_TOOLS];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const TOOL_DEFINITIONS: AnthropicToolDefinition[] = TOOLS.map((t) => t.definition);

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const mod = BY_NAME.get(name);
  if (!mod) return { error: `Unknown tool: ${name}` };
  try {
    return await mod.execute(input, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

export function isProposeToolName(name: string): boolean {
  return name.startsWith("propose_");
}
