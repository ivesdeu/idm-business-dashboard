import type { AdvisorToolModule } from "./context.ts";
import { clampInt, optionalString } from "./utils.ts";

export const listUnreviewedTransactionsTool: AdvisorToolModule = {
  name: "list_unreviewed_transactions",
  definition: {
    name: "list_unreviewed_transactions",
    description:
      "Count or list Plaid (or other) transactions pending review. Use for: uncategorized Plaid transactions, unreviewed bank imports.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Filter by source column (default Plaid).",
        },
        count_only: {
          type: "boolean",
          description: "When true, return only the count (faster).",
        },
        limit: { type: "number", description: "Max rows when not count_only (default 20)." },
      },
    },
  },
  async execute(input, ctx) {
    const source = optionalString(input.source, 64) || "Plaid";
    const limit = clampInt(input.limit, 1, 50, 20);

    let query = ctx.supabase
      .from("transactions")
      .select("id, date, amount, description, category, source, metadata", { count: "exact" })
      .eq("organization_id", ctx.orgId)
      .eq("source", source)
      .filter("metadata->>review_status", "eq", "unreviewed");

    if (input.count_only === true) {
      const { count, error } = await query;
      if (error) return { error: error.message, count: 0 };
      return { source, review_status: "unreviewed", count: count ?? 0 };
    }

    const { data, error, count } = await query.order("date", { ascending: false }).limit(limit);
    if (error) return { error: error.message, count: 0, transactions: [] };

    return {
      source,
      review_status: "unreviewed",
      count: count ?? (data || []).length,
      transactions: (data || []).map((row: Record<string, unknown>) => ({
        id: row.id,
        date: row.date,
        amount: row.amount,
        description: row.description,
        category: row.category,
      })),
    };
  },
};
