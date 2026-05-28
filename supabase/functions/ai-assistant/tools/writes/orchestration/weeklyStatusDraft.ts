import type { AdvisorToolModule, ToolContext } from "../../context.ts";
import { listAppointmentsTool } from "../../listAppointments.ts";
import { listInvoicesTool } from "../../listInvoices.ts";
import { getFinancialSummaryTool } from "../../getFinancialSummary.ts";
import { listMeetingNotesTool } from "../../listMeetingNotes.ts";
import { listActionItemsTool } from "../../listActionItems.ts";
import { callWeeklyStatusDraftAnthropic } from "../../weeklyStatusDraftAnthropic.ts";
import { makeCompoundProposal } from "../shared.ts";

function weekRangeUtc(): { from: string; to: string; label: string } {
  const now = new Date();
  const day = now.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const mon = new Date(now);
  mon.setUTCDate(now.getUTCDate() + mondayOffset);
  mon.setUTCHours(0, 0, 0, 0);
  const fri = new Date(mon);
  fri.setUTCDate(mon.getUTCDate() + 4);
  fri.setUTCHours(23, 59, 59, 999);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return {
    from: mon.toISOString(),
    to: fri.toISOString(),
    label: `${fmt(mon)} – ${fmt(fri)}`,
  };
}

export const proposeWeeklyStatusDraftTool: AdvisorToolModule = {
  name: "propose_weekly_status_draft",
  definition: {
    name: "propose_weekly_status_draft",
    description:
      "Gather this week's ops data and propose creating a Weekly status meeting note with an AI-drafted summary. Requires one confirmation.",
    input_schema: {
      type: "object",
      properties: {
        week_anchor: {
          type: "string",
          description: "Optional ISO date within the week to report on (default: current week).",
        },
      },
    },
  },
  async execute(input, ctx) {
    const week = weekRangeUtc();

    const [appointments, invoices, finances, meetings, openItems, completedItems] = await Promise.all([
      listAppointmentsTool.execute({ preset: "week", limit: 30 }, ctx),
      listInvoicesTool.execute({ status: "paid", limit: 30 }, ctx),
      getFinancialSummaryTool.execute(
        {
          period: { from: week.from, to: week.to },
          breakdown: "expense_categories",
          compare_previous_period: true,
        },
        ctx,
      ),
      listMeetingNotesTool.execute({ from: week.from, to: week.to, limit: 15 }, ctx),
      listActionItemsTool.execute(
        { owner_user_id: "me", completed: false, limit: 20 },
        ctx,
      ),
      listActionItemsTool.execute(
        { completed: true, limit: 30 },
        ctx,
      ),
    ]);

    const weeklyData = {
      week_label: week.label,
      from: week.from,
      to: week.to,
      appointments,
      paid_invoices: invoices,
      finances,
      meeting_notes: meetings,
      open_action_items: openItems,
      completed_action_items: completedItems,
    };

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")?.trim() || "";
    let draft;
    if (anthropicKey) {
      try {
        draft = await callWeeklyStatusDraftAnthropic(anthropicKey, weeklyData);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Could not draft weekly status: ${msg}` };
      }
    } else {
      const fin = finances as Record<string, unknown>;
      draft = {
        title: `Weekly status - Week of ${week.label}`,
        summary:
          `### Week of ${week.label}\n\n` +
          `- Revenue: $${Number(fin.income_total || 0).toFixed(2)}\n` +
          `- Expenses: $${Number(fin.expense_total || 0).toFixed(2)}\n` +
          `- Net: $${Number(fin.net || 0).toFixed(2)}\n`,
        decisions: "",
        topics: ["Weekly recap"],
        action_items: [],
      };
    }

    const noteTitle = draft.title.includes("Week of")
      ? draft.title
      : `Weekly status - Week of ${week.label}`;

    const steps = [
      {
        id: "status_note",
        type: "meeting_note.create",
        label: `Create note: ${noteTitle}`,
        payload: {
          title: noteTitle,
          summary: draft.summary,
          decisions: draft.decisions,
          topics: draft.topics,
          action_items: draft.action_items,
          status: "draft",
        },
      },
    ];

    const human =
      `**Draft weekly status** (week of ${week.label}):\n\n` +
      `Creates meeting note **${noteTitle}** with an AI-drafted summary from this week's calendar, finances, invoices, and action items.\n\n` +
      `Confirm to save the note.`;

    const voice = `Draft this week's status report as a meeting note. Say yes to confirm.`;

    return makeCompoundProposal("weekly_status_draft", steps, human, voice);
  },
};
