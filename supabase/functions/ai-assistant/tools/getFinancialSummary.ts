import type { AdvisorToolModule } from "./context.ts";
import { isExpenseCategory, isIncomeCategory, resolvePeriod } from "./utils.ts";

const CATEGORY_LABELS: Record<string, string> = {
  svc: "Services",
  ret: "Retainer",
  own: "Owner draw / other income",
  lab: "Labor",
  sw: "Software",
  ads: "Advertising",
  oth: "Other expense",
};

export const getFinancialSummaryTool: AdvisorToolModule = {
  name: "get_financial_summary",
  definition: {
    name: "get_financial_summary",
    description:
      "Summarize income and expenses for a period. Use for: how much did I bring in this month, revenue vs last month, top expense categories.",
    input_schema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          description:
            "this_month | last_month | mtd | qtd | ytd — or object { from, to } ISO dates for custom.",
        },
        breakdown: {
          type: "string",
          enum: ["none", "expense_categories", "income_categories"],
          description: "Optional category breakdown.",
        },
        compare_previous_period: {
          type: "boolean",
          description: "When true, also compute the prior period of same length for comparison.",
        },
      },
      required: ["period"],
    },
  },
  async execute(input, ctx) {
    const periodLabel = resolvePeriod(input.period, ctx.effectiveTimezone);
    const breakdown = input.breakdown === "expense_categories" || input.breakdown === "income_categories"
      ? input.breakdown
      : "none";

    async function rollup(fromIso: string, toIso: string) {
      const fromDate = fromIso.slice(0, 10);
      const toDate = toIso.slice(0, 10);

      const { data, error } = await ctx.supabase
        .from("transactions")
        .select("amount, category")
        .eq("organization_id", ctx.orgId)
        .gte("date", fromDate)
        .lte("date", toDate);

      if (error) return { error: error.message };

      let incomeTotal = 0;
      let expenseTotal = 0;
      const incomeByCat: Record<string, number> = {};
      const expenseByCat: Record<string, number> = {};

      for (const row of data || []) {
        const amount = Number(row.amount) || 0;
        const cat = String(row.category || "").trim();
        if (isIncomeCategory(cat)) {
          incomeTotal += Math.abs(amount);
          incomeByCat[cat] = (incomeByCat[cat] || 0) + Math.abs(amount);
        } else if (isExpenseCategory(cat) && amount > 0) {
          expenseTotal += amount;
          expenseByCat[cat] = (expenseByCat[cat] || 0) + amount;
        }
      }

      const formatBreakdown = (map: Record<string, number>) =>
        Object.entries(map)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([code, total]) => ({
            category: code,
            label: CATEGORY_LABELS[code] || code,
            total: Math.round(total * 100) / 100,
          }));

      return {
        income_total: Math.round(incomeTotal * 100) / 100,
        expense_total: Math.round(expenseTotal * 100) / 100,
        net: Math.round((incomeTotal - expenseTotal) * 100) / 100,
        income_breakdown: breakdown === "income_categories" ? formatBreakdown(incomeByCat) : undefined,
        expense_breakdown: breakdown === "expense_categories" ? formatBreakdown(expenseByCat) : undefined,
        transaction_count: (data || []).length,
      };
    }

    const current = await rollup(periodLabel.from, periodLabel.to);
    if ("error" in current && current.error) return current;

    let previous: Record<string, unknown> | null = null;
    if (input.compare_previous_period === true) {
      const fromMs = new Date(periodLabel.from).getTime();
      const toMs = new Date(periodLabel.to).getTime();
      const len = toMs - fromMs;
      const prevTo = new Date(fromMs - 1);
      const prevFrom = new Date(fromMs - len);
      previous = await rollup(prevFrom.toISOString(), prevTo.toISOString());
    }

    return {
      period: periodLabel.label,
      from: periodLabel.from,
      to: periodLabel.to,
      ...current,
      previous_period: previous,
    };
  },
};
