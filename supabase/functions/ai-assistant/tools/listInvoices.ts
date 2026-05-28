import type { AdvisorToolModule } from "./context.ts";
import { clampInt, optionalString } from "./utils.ts";

export const listInvoicesTool: AdvisorToolModule = {
  name: "list_invoices",
  definition: {
    name: "list_invoices",
    description:
      "List invoices, including overdue unpaid. Use for: invoices over 30 days late, open invoices for a client.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status (e.g. sent, paid, draft). Omit for unpaid non-paid.",
        },
        overdue_days: {
          type: "number",
          description: "Only invoices unpaid with due_date older than this many days (e.g. 30).",
        },
        client_name: { type: "string", description: "Filter by client name via linked transaction." },
        limit: { type: "number", description: "Max rows (default 25)." },
      },
    },
  },
  async execute(input, ctx) {
    const limit = clampInt(input.limit, 1, 50, 25);
    const overdueDays = input.overdue_days != null ? clampInt(input.overdue_days, 0, 3650, 30) : null;
    const clientName = optionalString(input.client_name, 200)?.toLowerCase();
    const statusFilter = optionalString(input.status, 32);

    let query = ctx.supabase
      .from("invoices")
      .select("id, number, amount, status, due_date, date_issued, paid_at, income_tx_id")
      .eq("organization_id", ctx.orgId)
      .order("due_date", { ascending: true })
      .limit(100);

    if (statusFilter) {
      query = query.eq("status", statusFilter);
    } else if (overdueDays != null) {
      query = query.neq("status", "paid");
    }

    const { data: invoices, error } = await query;
    if (error) return { error: error.message, invoices: [] };

    const today = new Date().toISOString().slice(0, 10);
    const overdueCutoff =
      overdueDays != null
        ? new Date(Date.now() - overdueDays * 86400000).toISOString().slice(0, 10)
        : null;

    const txIds = (invoices || []).map((i: { income_tx_id: string }) => i.income_tx_id).filter(Boolean);
    const { data: txs } = txIds.length
      ? await ctx.supabase
          .from("transactions")
          .select("id, client_id, clients(company_name, contact_name)")
          .in("id", txIds)
      : { data: [] };

    const txMap = new Map(
      (txs || []).map((t: Record<string, unknown>) => {
        const clients = t.clients as Record<string, unknown> | null;
        const name =
          (clients && String(clients.company_name || "").trim()) ||
          (clients && String(clients.contact_name || "").trim()) ||
          "";
        return [String(t.id), { client_id: t.client_id, client_name: name }];
      }),
    );

    let rows = (invoices || []).map((inv: Record<string, unknown>) => {
      const tx = txMap.get(String(inv.income_tx_id));
      const due = inv.due_date ? String(inv.due_date) : null;
      const status = String(inv.status || "");
      const isPaid = status.toLowerCase() === "paid";
      const daysOverdue =
        due && !isPaid && due < today
          ? Math.floor((Date.parse(today) - Date.parse(due)) / 86400000)
          : 0;
      return {
        id: inv.id,
        number: inv.number,
        amount: inv.amount,
        status: inv.status,
        due_date: due,
        date_issued: inv.date_issued,
        paid_at: inv.paid_at,
        client_name: tx?.client_name || null,
        days_overdue: daysOverdue,
        is_overdue: !isPaid && due != null && due < today,
      };
    });

    if (overdueCutoff) {
      rows = rows.filter(
        (r) => r.is_overdue && r.due_date && r.due_date <= overdueCutoff,
      );
    }

    if (clientName) {
      rows = rows.filter((r) => String(r.client_name || "").toLowerCase().includes(clientName));
    }

    return {
      count: Math.min(rows.length, limit),
      invoices: rows.slice(0, limit),
    };
  },
};
