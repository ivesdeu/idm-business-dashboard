import type { AdvisorToolModule } from "./context.ts";
import { clampInt, optionalString } from "./utils.ts";

export const listClientsTool: AdvisorToolModule = {
  name: "list_clients",
  definition: {
    name: "list_clients",
    description:
      "List CRM clients with filters. Use for: customers not contacted in 30 days, who is at risk, high priority clients.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status (e.g. Active, At risk, Lead).",
        },
        priority: {
          type: "string",
          description: "Filter by priority (Low, Medium, High).",
        },
        dormant_days: {
          type: "number",
          description: "Clients with last_touch_at older than this many days (or null touch).",
        },
        at_risk: {
          type: "boolean",
          description: "When true: status At risk OR (High priority AND dormant 30+ days and not Inactive/Churned).",
        },
        limit: { type: "number", description: "Max rows (default 25)." },
      },
    },
  },
  async execute(input, ctx) {
    const limit = clampInt(input.limit, 1, 50, 25);
    const dormantDays = input.dormant_days != null ? clampInt(input.dormant_days, 1, 3650, 30) : null;

    let query = ctx.supabase
      .from("clients")
      .select(
        "id, company_name, contact_name, status, priority, last_touch_at, next_follow_up_at, email",
      )
      .eq("organization_id", ctx.orgId)
      .order("company_name", { ascending: true })
      .limit(100);

    const status = optionalString(input.status, 64);
    if (status) query = query.ilike("status", status);

    const priority = optionalString(input.priority, 32);
    if (priority) query = query.ilike("priority", priority);

    const { data, error } = await query;
    if (error) return { error: error.message, clients: [] };

    const cutoff =
      dormantDays != null
        ? new Date(Date.now() - dormantDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        : null;

    let rows = (data || []) as Array<Record<string, unknown>>;

    if (cutoff) {
      rows = rows.filter((c) => {
        const touch = c.last_touch_at ? String(c.last_touch_at) : null;
        return !touch || touch < cutoff;
      });
    }

    if (input.at_risk === true) {
      rows = rows.filter((c) => {
        const st = String(c.status || "").trim().toLowerCase();
        const pr = String(c.priority || "").trim().toLowerCase();
        const touch = c.last_touch_at ? String(c.last_touch_at) : null;
        const dormant30 = !touch || touch < new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        if (st === "at risk") return true;
        if (pr === "high" && dormant30 && st !== "inactive" && st !== "churned") return true;
        return false;
      });
    }

    return {
      count: Math.min(rows.length, limit),
      clients: rows.slice(0, limit).map((c) => ({
        id: c.id,
        company_name: c.company_name,
        contact_name: c.contact_name,
        status: c.status,
        priority: c.priority,
        last_touch_at: c.last_touch_at,
        next_follow_up_at: c.next_follow_up_at,
      })),
    };
  },
};
