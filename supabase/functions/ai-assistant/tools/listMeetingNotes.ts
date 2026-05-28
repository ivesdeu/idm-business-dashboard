import type { AdvisorToolModule } from "./context.ts";
import { clampInt, optionalString, parseIsoDate } from "./utils.ts";

export const listMeetingNotesTool: AdvisorToolModule = {
  name: "list_meeting_notes",
  definition: {
    name: "list_meeting_notes",
    description:
      "List meeting notes with summaries and decisions. Use for: decisions from last Tuesday, summarize last call with client, read meeting notes.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO datetime — filter scheduled_at >= from." },
        to: { type: "string", description: "ISO datetime — filter scheduled_at <= to." },
        client_name: { type: "string", description: "Filter by linked client name." },
        limit: { type: "number", description: "Max notes (default 10)." },
      },
    },
  },
  async execute(input, ctx) {
    const limit = clampInt(input.limit, 1, 20, 10);
    const from = parseIsoDate(input.from);
    const to = parseIsoDate(input.to);
    const clientName = optionalString(input.client_name, 200)?.toLowerCase();

    let query = ctx.supabase
      .from("meeting_notes")
      .select(
        "id, title, scheduled_at, summary, decisions, topics, action_items, status, contact_id, clients(company_name, contact_name)",
      )
      .eq("organization_id", ctx.orgId)
      .order("scheduled_at", { ascending: false, nullsFirst: false })
      .limit(clientName ? 50 : limit);

    if (from) query = query.gte("scheduled_at", from);
    if (to) query = query.lte("scheduled_at", to);

    const { data, error } = await query;
    if (error) return { error: error.message, notes: [] };

    let notes = (data || []).map((row: Record<string, unknown>) => {
      const clients = row.clients as Record<string, unknown> | null;
      const company = clients ? String(clients.company_name || "").trim() : "";
      const contact = clients ? String(clients.contact_name || "").trim() : "";
      return {
        id: row.id,
        title: row.title,
        scheduled_at: row.scheduled_at,
        status: row.status,
        client_name: company || contact || null,
        summary: row.summary ? String(row.summary).slice(0, 3000) : "",
        decisions: row.decisions ? String(row.decisions).slice(0, 1500) : "",
        topics: row.topics,
        action_item_count: Array.isArray(row.action_items) ? row.action_items.length : 0,
      };
    });

    if (clientName) {
      notes = notes.filter((n) => String(n.client_name || "").toLowerCase().includes(clientName));
      notes = notes.slice(0, limit);
    }

    return { count: notes.length, notes };
  },
};
