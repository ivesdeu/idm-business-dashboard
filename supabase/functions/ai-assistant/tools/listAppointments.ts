import type { AdvisorToolModule } from "./context.ts";
import { clampInt, optionalString, parseIsoDate, todayRangeUtc, weekRangeUtc } from "./utils.ts";

export const listAppointmentsTool: AdvisorToolModule = {
  name: "list_appointments",
  definition: {
    name: "list_appointments",
    description:
      "List calendar appointments in a date range. Use for: what's on my calendar today, this week, next meeting, last meeting with a client, upcoming events.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO datetime start of range (optional)." },
        to: { type: "string", description: "ISO datetime end of range (optional)." },
        preset: {
          type: "string",
          enum: ["today", "week", "upcoming"],
          description: "Shortcut when from/to omitted: today, week (Sun-Sat), or upcoming (from now).",
        },
        client_name: { type: "string", description: "Filter by client company/contact name (partial match)." },
        status: {
          type: "string",
          enum: ["confirmed", "pending", "cancelled"],
          description: "Optional status filter.",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort by start_time. Default asc.",
        },
        limit: { type: "number", description: "Max rows (default 20, max 50)." },
        include_past_for_client: {
          type: "boolean",
          description: "When client_name set, include past appointments (for 'last met with').",
        },
      },
    },
  },
  async execute(input, ctx) {
    const limit = clampInt(input.limit, 1, 50, 20);
    const order = input.order === "desc" ? "desc" : "asc";
    const preset = optionalString(input.preset, 32);
    let from = parseIsoDate(input.from);
    let to = parseIsoDate(input.to);

    if (!from && !to) {
      if (preset === "week") {
        const r = weekRangeUtc();
        from = r.from;
        to = r.to;
      } else if (preset === "upcoming") {
        from = new Date().toISOString();
        to = undefined;
      } else {
        const r = todayRangeUtc();
        from = r.from;
        to = r.to;
      }
    }

    let query = ctx.supabase
      .from("appointments")
      .select(
        "id, title, start_time, end_time, status, location, notes, client_id, color, clients(company_name, contact_name)",
      )
      .eq("organization_id", ctx.orgId);

    if (from) query = query.gte("start_time", from);
    if (to) query = query.lte("start_time", to);
    if (!input.include_past_for_client && preset !== "upcoming" && !from) {
      query = query.gte("start_time", new Date().toISOString());
    }

    const status = optionalString(input.status, 32);
    if (status === "confirmed" || status === "pending" || status === "cancelled") {
      query = query.eq("status", status);
    } else if (!input.include_past_for_client) {
      query = query.neq("status", "cancelled");
    }

    query = query.order("start_time", { ascending: order === "asc" }).limit(limit);

    const { data, error } = await query;
    if (error) return { error: error.message, appointments: [] };

    const clientFilter = optionalString(input.client_name, 200)?.toLowerCase();
    let rows = (data || []).map((row: Record<string, unknown>) => {
      const clients = row.clients as Record<string, unknown> | null;
      const company = clients ? String(clients.company_name || "").trim() : "";
      const contact = clients ? String(clients.contact_name || "").trim() : "";
      const clientName = company || contact || null;
      return {
        id: row.id,
        title: row.title,
        start_time: row.start_time,
        end_time: row.end_time,
        status: row.status,
        location: row.location,
        notes: row.notes ? String(row.notes).slice(0, 500) : null,
        color: row.color,
        client_id: row.client_id,
        client_name: clientName,
      };
    });

    if (clientFilter) {
      rows = rows.filter((r) => {
        const name = String(r.client_name || "").toLowerCase();
        return name.includes(clientFilter);
      });
      if (input.include_past_for_client && rows.length > 1) {
        rows.sort(
          (a, b) =>
            new Date(String(b.start_time)).getTime() - new Date(String(a.start_time)).getTime(),
        );
        rows = rows.slice(0, 1);
      }
    }

    return {
      count: rows.length,
      appointments: rows,
      range: { from, to },
    };
  },
};
