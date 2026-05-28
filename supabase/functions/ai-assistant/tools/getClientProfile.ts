import type { AdvisorToolModule } from "./context.ts";
import { isUuid, optionalString } from "./utils.ts";

export const getClientProfileTool: AdvisorToolModule = {
  name: "get_client_profile",
  definition: {
    name: "get_client_profile",
    description:
      "Get a single client profile with recent appointments, open invoices, and last meeting note. Use for: tell me about Acme, client overview.",
    input_schema: {
      type: "object",
      properties: {
        client_id: { type: "string", description: "Client UUID if known." },
        name: { type: "string", description: "Company or contact name to search." },
      },
    },
  },
  async execute(input, ctx) {
    const clientId = isUuid(input.client_id) ? String(input.client_id).trim() : null;
    const name = optionalString(input.name, 200);

    if (!clientId && !name) {
      return { error: "Provide client_id or name.", needs_clarification: true };
    }

    let clientQuery = ctx.supabase
      .from("clients")
      .select(
        "id, company_name, contact_name, status, priority, industry, email, phone, notes, last_touch_at, next_follow_up_at, total_revenue, created_at, updated_at",
      )
      .eq("organization_id", ctx.orgId);

    if (clientId) {
      clientQuery = clientQuery.eq("id", clientId);
    } else if (name) {
      clientQuery = clientQuery.or(
        `company_name.ilike.%${name.replace(/%/g, "")}%,contact_name.ilike.%${name.replace(/%/g, "")}%`,
      );
    }

    const { data: clients, error: cErr } = await clientQuery.limit(10);
    if (cErr) return { error: cErr.message };
    if (!clients?.length) return { found: false, message: "No client matched that name." };

    if (!clientId && clients.length > 1) {
      return {
        needs_clarification: true,
        candidates: clients.map((c: Record<string, unknown>) => ({
          id: c.id,
          company_name: c.company_name,
          contact_name: c.contact_name,
          status: c.status,
        })),
      };
    }

    const client = clients[0] as Record<string, unknown>;
    const id = String(client.id);

    const [apptsRes, notesRes, invoicesRes] = await Promise.all([
      ctx.supabase
        .from("appointments")
        .select("id, title, start_time, end_time, status")
        .eq("organization_id", ctx.orgId)
        .eq("client_id", id)
        .order("start_time", { ascending: false })
        .limit(5),
      ctx.supabase
        .from("meeting_notes")
        .select("id, title, scheduled_at, summary, decisions")
        .eq("organization_id", ctx.orgId)
        .eq("contact_id", id)
        .order("scheduled_at", { ascending: false, nullsFirst: false })
        .limit(1),
      ctx.supabase
        .from("invoices")
        .select("id, number, amount, status, due_date, date_issued, income_tx_id")
        .eq("organization_id", ctx.orgId)
        .neq("status", "paid")
        .order("due_date", { ascending: true })
        .limit(20),
    ]);

    const incomeTxIds = (invoicesRes.data || [])
      .map((inv: { income_tx_id: string }) => inv.income_tx_id)
      .filter(Boolean);
    let openInvoices = invoicesRes.data || [];
    if (incomeTxIds.length) {
      const { data: txs } = await ctx.supabase
        .from("transactions")
        .select("id, client_id")
        .in("id", incomeTxIds);
      const txClient = new Map(
        (txs || []).map((t: { id: string; client_id: string | null }) => [t.id, t.client_id]),
      );
      openInvoices = openInvoices.filter(
        (inv: { income_tx_id: string }) => txClient.get(inv.income_tx_id) === id,
      );
    } else {
      openInvoices = [];
    }

    const lastNote = notesRes.data?.[0] as Record<string, unknown> | undefined;

    return {
      found: true,
      client: {
        id: client.id,
        company_name: client.company_name,
        contact_name: client.contact_name,
        status: client.status,
        priority: client.priority,
        industry: client.industry,
        email: client.email,
        phone: client.phone,
        notes: client.notes ? String(client.notes).slice(0, 800) : null,
        last_touch_at: client.last_touch_at,
        next_follow_up_at: client.next_follow_up_at,
        total_revenue: client.total_revenue,
      },
      recent_appointments: apptsRes.data || [],
      open_invoices: openInvoices.slice(0, 10),
      last_meeting_note: lastNote
        ? {
            id: lastNote.id,
            title: lastNote.title,
            scheduled_at: lastNote.scheduled_at,
            summary: lastNote.summary ? String(lastNote.summary).slice(0, 1500) : "",
            decisions: lastNote.decisions ? String(lastNote.decisions).slice(0, 500) : "",
          }
        : null,
    };
  },
};
