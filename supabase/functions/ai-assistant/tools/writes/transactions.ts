import type { AdvisorToolModule, ToolContext } from "../context.ts";
import { makeProposal, mapExpenseCategoryLabel } from "./shared.ts";
import { clampInt, isUuid, optionalString } from "../utils.ts";

export const proposeTransactionReviewTool: AdvisorToolModule = {
  name: "propose_transaction_review",
  definition: {
    name: "propose_transaction_review",
    description:
      "Propose marking a transaction as reviewed (approved) or hidden (duplicate/noise). Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        description_match: { type: "string" },
        amount: { type: "number" },
        review_status: { type: "string", enum: ["approved", "hidden"] },
      },
      required: ["review_status"],
    },
  },
  async execute(input, ctx) {
    const status = optionalString(input.review_status, 16);
    if (status !== "approved" && status !== "hidden") {
      return { error: "review_status must be approved or hidden." };
    }

    let txId = optionalString(input.transaction_id, 64);
    if (!txId && ctx.lastEntities?.transactionId && isUuid(ctx.lastEntities.transactionId)) {
      txId = ctx.lastEntities.transactionId;
    }

    let row: Record<string, unknown> | null = null;
    if (txId && isUuid(txId)) {
      const { data, error } = await ctx.supabase
        .from("transactions")
        .select("id, description, amount, date, category, metadata")
        .eq("organization_id", ctx.orgId)
        .eq("id", txId)
        .maybeSingle();
      if (error) return { error: error.message };
      row = data as Record<string, unknown> | null;
    } else {
      let query = ctx.supabase
        .from("transactions")
        .select("id, description, amount, date, category, metadata")
        .eq("organization_id", ctx.orgId)
        .limit(6);
      const desc = optionalString(input.description_match, 120);
      if (desc) query = query.ilike("description", `%${desc}%`);
      if (typeof input.amount === "number" && Number.isFinite(input.amount)) {
        query = query.eq("amount", input.amount);
      }
      const { data, error } = await query;
      if (error) return { error: error.message };
      const rows = (data || []) as Array<Record<string, unknown>>;
      if (!rows.length) return { error: "No matching transaction found." };
      if (rows.length > 1) {
        return {
          error: "Multiple transactions match.",
          candidates: rows.map((r) => ({
            id: r.id,
            description: r.description,
            amount: r.amount,
          })),
        };
      }
      row = rows[0];
      txId = String(row.id);
    }

    if (!row || !txId) return { error: "Transaction not found." };

    const meta = (row.metadata && typeof row.metadata === "object"
      ? { ...(row.metadata as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    meta.review_status = status;

    const payload = {
      transaction_id: txId,
      review_status: status,
      metadata: meta,
      description: row.description,
      amount: row.amount,
      date: row.date,
      category: row.category,
    };

    const verb = status === "hidden" ? "Hide" : "Mark reviewed";
    const human = `${verb} transaction **${row.description}** ($${Number(row.amount).toFixed(2)})?`;
    const voice = `${verb} ${row.description}. Say yes to confirm.`;
    return makeProposal("transaction.review", payload, human, voice);
  },
};

export const proposeTransactionsRecategorizeTool: AdvisorToolModule = {
  name: "propose_transactions_recategorize",
  definition: {
    name: "propose_transactions_recategorize",
    description:
      "Propose bulk recategorizing transactions matching a description pattern. Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        description_match: { type: "string", description: "e.g. Starbucks" },
        target_category_label: { type: "string", description: "e.g. Meals" },
        max_rows: { type: "number" },
      },
      required: ["description_match", "target_category_label"],
    },
  },
  async execute(input, ctx) {
    const match = optionalString(input.description_match, 120);
    const label = optionalString(input.target_category_label, 64);
    if (!match || !label) return { error: "description_match and target_category_label are required." };

    const mapped = mapExpenseCategoryLabel(label);
    const maxRows = clampInt(input.max_rows, 1, 200, 50);

    const { data, error } = await ctx.supabase
      .from("transactions")
      .select("id, description, amount, date, category")
      .eq("organization_id", ctx.orgId)
      .ilike("description", `%${match}%`)
      .limit(maxRows);

    if (error) return { error: error.message };
    const rows = data || [];
    if (!rows.length) return { error: `No transactions matched "${match}".` };

    const payload = {
      description_match: match,
      target_category_code: mapped.code,
      target_category_label: mapped.label,
      transaction_ids: rows.map((r) => r.id),
      preview_rows: rows.slice(0, 5),
    };

    const human =
      `Recategorize **${rows.length}** transaction(s) matching "${match}" to **${mapped.label}** (ledger code \`${mapped.code}\`)?`;
    const voice = `Recategorize ${rows.length} ${match} charges as ${mapped.label}. Say yes to confirm.`;
    return makeProposal("transaction.recategorize_bulk", payload, human, voice);
  },
};

export async function executeTransactionAction(
  type: string,
  payload: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  if (type === "transaction.review") {
    const txId = String(payload.transaction_id || "");
    if (!isUuid(txId)) return { ok: false, error: "Invalid transaction id." };

    const { data: existing, error: fetchErr } = await ctx.supabase
      .from("transactions")
      .select("id, date, category, amount, description, client_id, project_id, other_label, other_type, note, metadata, source")
      .eq("id", txId)
      .eq("organization_id", ctx.orgId)
      .maybeSingle();

    if (fetchErr || !existing) return { ok: false, error: fetchErr?.message || "Transaction not found." };

    const meta = (payload.metadata as Record<string, unknown>) || (existing.metadata as Record<string, unknown>) || {};
    const row = {
      id: existing.id,
      user_id: ctx.userId,
      organization_id: ctx.orgId,
      date: existing.date,
      category: existing.category,
      amount: existing.amount,
      description: existing.description,
      client_id: existing.client_id,
      project_id: existing.project_id,
      other_label: existing.other_label,
      other_type: existing.other_type,
      note: existing.note,
      metadata: meta,
    };

    const { error } = await ctx.supabase.from("transactions").upsert(row, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true, result: { transaction_id: txId, review_status: payload.review_status } };
  }

  if (type === "transaction.recategorize_bulk") {
    const ids = Array.isArray(payload.transaction_ids) ? (payload.transaction_ids as string[]) : [];
    const code = String(payload.target_category_code || "oth");
    let updated = 0;
    for (const id of ids.slice(0, 200)) {
      if (!isUuid(id)) continue;
      const { error } = await ctx.supabase
        .from("transactions")
        .update({ category: code })
        .eq("id", id)
        .eq("organization_id", ctx.orgId);
      if (!error) updated += 1;
    }
    return {
      ok: updated > 0,
      result: { updated_count: updated, category_code: code, label: payload.target_category_label },
    };
  }

  if (type === "transaction.approve_unreviewed_in_period") {
    const fromDate = String(payload.from_date || "").slice(0, 10);
    const toDate = String(payload.to_date || "").slice(0, 10);
    if (!fromDate || !toDate) {
      return { ok: false, error: "from_date and to_date are required." };
    }

    const { data: rows, error: listErr } = await ctx.supabase
      .from("transactions")
      .select("id, metadata, source")
      .eq("organization_id", ctx.orgId)
      .eq("source", "Plaid")
      .gte("date", fromDate)
      .lte("date", toDate)
      .filter("metadata->>review_status", "eq", "unreviewed")
      .limit(500);

    if (listErr) return { ok: false, error: listErr.message };

    let updated = 0;
    for (const row of rows || []) {
      const meta = (row.metadata && typeof row.metadata === "object"
        ? { ...(row.metadata as Record<string, unknown>) }
        : {}) as Record<string, unknown>;
      meta.review_status = "approved";

      const { error } = await ctx.supabase
        .from("transactions")
        .update({ metadata: meta })
        .eq("id", row.id)
        .eq("organization_id", ctx.orgId);
      if (!error) updated += 1;
    }

    return {
      ok: true,
      result: {
        updated_count: updated,
        from_date: fromDate,
        to_date: toDate,
      },
    };
  }

  return { ok: false, error: `Unknown transaction action: ${type}` };
}
