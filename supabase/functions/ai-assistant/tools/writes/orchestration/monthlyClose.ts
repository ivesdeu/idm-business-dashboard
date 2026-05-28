import type { AdvisorToolModule, ToolContext } from "../../context.ts";
import { getFinancialSummaryTool } from "../../getFinancialSummary.ts";
import { makeCompoundProposal } from "../shared.ts";
import { resolvePeriod } from "../../utils.ts";

function monthTitleFromPeriod(periodLabel: string, fromIso: string): string {
  try {
    const d = new Date(fromIso);
    const month = d.toLocaleString("en-US", { month: "long", year: "numeric" });
    return `P&L - ${month}`;
  } catch {
    return `P&L - ${periodLabel}`;
  }
}

function buildPnlSummaryMarkdown(fin: Record<string, unknown>): string {
  const income = Number(fin.income_total) || 0;
  const expense = Number(fin.expense_total) || 0;
  const net = Number(fin.net) || income - expense;
  const lines: string[] = [
    `### P&L summary (${fin.period || "period"})`,
    "",
    `- **Revenue:** $${income.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `- **Expenses:** $${expense.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `- **Net:** $${net.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    "",
  ];

  const expBreak = fin.expense_breakdown as Array<{ label: string; total: number }> | undefined;
  if (Array.isArray(expBreak) && expBreak.length) {
    lines.push("### Expense breakdown");
    lines.push("");
    for (const row of expBreak.slice(0, 8)) {
      lines.push(`- **${row.label}:** $${Number(row.total).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
    }
    lines.push("");
  }

  const prev = fin.previous_period as Record<string, unknown> | undefined;
  if (prev && prev.income_total != null) {
    lines.push("### vs prior period");
    lines.push("");
    lines.push(
      `- Revenue ${Number(prev.income_total) < income ? "up" : "down"}; net ${Number(prev.net) < net ? "improved" : "declined"}.`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

export const proposeMonthlyCloseTool: AdvisorToolModule = {
  name: "propose_monthly_close",
  definition: {
    name: "propose_monthly_close",
    description:
      "Propose monthly close: approve unreviewed Plaid transactions for a period, then create a meeting note with P&L summary. Requires one confirmation.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          description: "last_month (default) | this_month | mtd | custom object with from/to ISO dates.",
        },
      },
    },
  },
  async execute(input, ctx) {
    const periodLabel = resolvePeriod(input.period ?? "last_month", ctx.effectiveTimezone);
    const fromDate = periodLabel.from.slice(0, 10);
    const toDate = periodLabel.to.slice(0, 10);

    const fin = (await getFinancialSummaryTool.execute(
      {
        period: input.period ?? "last_month",
        breakdown: "expense_categories",
        compare_previous_period: true,
      },
      ctx,
    )) as Record<string, unknown>;

    if (fin.error) return { error: String(fin.error) };

    const noteTitle = monthTitleFromPeriod(periodLabel.label, periodLabel.from);
    const summaryMd = buildPnlSummaryMarkdown(fin);

    const steps = [
      {
        id: "approve_txn",
        type: "transaction.approve_unreviewed_in_period",
        label: `Approve unreviewed Plaid transactions (${periodLabel.label})`,
        payload: { from_date: fromDate, to_date: toDate },
      },
      {
        id: "pnl_note",
        type: "meeting_note.create",
        label: `Create meeting note: ${noteTitle}`,
        payload: {
          title: noteTitle,
          summary: summaryMd,
          decisions: "",
          topics: ["P&L", "Monthly close"],
          status: "draft",
        },
      },
    ];

    const human =
      `**Monthly close** for **${periodLabel.label}**:\n\n` +
      `1. Mark unreviewed Plaid transactions as reviewed (${fromDate} → ${toDate})\n` +
      `2. Create meeting note **${noteTitle}** with P&L summary\n\n` +
      `Confirm once to run both steps.`;

    const voice = `Monthly close for ${periodLabel.label}. Approve transactions and save a P and L note. Say yes to confirm.`;

    return makeCompoundProposal("monthly_close", steps, human, voice);
  },
};
