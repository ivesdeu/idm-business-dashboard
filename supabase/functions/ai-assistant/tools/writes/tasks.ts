import type { AdvisorToolModule, ToolContext } from "../context.ts";
import { makeProposal, newProposalId, resolveClientId } from "./shared.ts";
import { clampInt, isUuid, optionalString, parseIsoDate, todayRangeUtc } from "../utils.ts";

export const listTodayTasksTool: AdvisorToolModule = {
  name: "list_today_tasks",
  definition: {
    name: "list_today_tasks",
    description:
      "List open workspace tasks due today or overdue, and tasks due this week. Use for 'what is on my Today list' or task overview.",
    input_schema: {
      type: "object",
      properties: {
        include_week: { type: "boolean", description: "Include tasks due later this week (default true)." },
        limit: { type: "number" },
      },
    },
  },
  async execute(input, ctx) {
    const limit = clampInt(input.limit, 1, 50, 25);
    const today = todayRangeUtc();
    const nowIso = new Date().toISOString();

    const { data: dueToday, error: e1 } = await ctx.supabase
      .from("workspace_tasks")
      .select("id, title, status, due_at, client_id, body")
      .eq("organization_id", ctx.orgId)
      .eq("status", "open")
      .lte("due_at", today.to)
      .gte("due_at", today.from)
      .order("due_at", { ascending: true })
      .limit(limit);

    if (e1) return { error: e1.message, tasks: [] };

    const { data: overdue, error: e2 } = await ctx.supabase
      .from("workspace_tasks")
      .select("id, title, status, due_at, client_id, body")
      .eq("organization_id", ctx.orgId)
      .eq("status", "open")
      .lt("due_at", today.from)
      .order("due_at", { ascending: true })
      .limit(limit);

    if (e2) return { error: e2.message, tasks: [] };

    let weekTasks: unknown[] = [];
    if (input.include_week !== false) {
      const weekEnd = new Date();
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
      const { data: week, error: e3 } = await ctx.supabase
        .from("workspace_tasks")
        .select("id, title, status, due_at, client_id")
        .eq("organization_id", ctx.orgId)
        .eq("status", "open")
        .gt("due_at", today.to)
        .lte("due_at", weekEnd.toISOString())
        .order("due_at", { ascending: true })
        .limit(limit);
      if (!e3) weekTasks = week || [];
    }

    const { data: noDue, error: e4 } = await ctx.supabase
      .from("workspace_tasks")
      .select("id, title, status, due_at")
      .eq("organization_id", ctx.orgId)
      .eq("status", "open")
      .is("due_at", null)
      .order("created_at", { ascending: false })
      .limit(Math.min(10, limit));

    return {
      as_of: nowIso,
      due_today: dueToday || [],
      overdue: overdue || [],
      due_this_week: weekTasks,
      open_no_due_date: e4 ? [] : noDue || [],
      count:
        (dueToday?.length || 0) + (overdue?.length || 0) + (Array.isArray(weekTasks) ? weekTasks.length : 0),
    };
  },
};

export const proposeTaskCreateTool: AdvisorToolModule = {
  name: "propose_task_create",
  definition: {
    name: "propose_task_create",
    description: "Propose creating a workspace task (to-do). Requires user confirmation.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        due_iso: { type: "string" },
        due_ymd: { type: "string", description: "YYYY-MM-DD" },
        client_name: { type: "string" },
      },
      required: ["title"],
    },
  },
  async execute(input, ctx) {
    const title = optionalString(input.title, 500);
    if (!title) return { error: "title is required." };

    let dueAt: string | null = parseIsoDate(input.due_iso);
    const ymd = optionalString(input.due_ymd, 16);
    if (!dueAt && ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      dueAt = new Date(`${ymd}T12:00:00.000Z`).toISOString();
    }

    const clientRes = await resolveClientId(ctx, optionalString(input.client_name, 120), undefined);
    if (clientRes.error) return { error: clientRes.error, candidates: clientRes.candidates };

    const payload = {
      title,
      body: optionalString(input.body, 8000) || "",
      due_at: dueAt,
      client_id: clientRes.clientId,
    };

    const dueLabel = dueAt ? ` due ${dueAt.slice(0, 10)}` : "";
    const human = `Add task **${title}**${dueLabel}?`;
    const voice = `Add task ${title}${dueLabel}. Say yes to confirm.`;
    return makeProposal("task.create", payload, human, voice);
  },
};

export const proposeTaskCompleteTool: AdvisorToolModule = {
  name: "propose_task_complete",
  definition: {
    name: "propose_task_complete",
    description: "Propose marking a workspace task as done. Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        title_match: { type: "string", description: "Partial title match if task_id unknown." },
      },
    },
  },
  async execute(input, ctx) {
    const taskId = optionalString(input.task_id, 64);
    if (taskId && isUuid(taskId)) {
      const { data, error } = await ctx.supabase
        .from("workspace_tasks")
        .select("id, title, status")
        .eq("organization_id", ctx.orgId)
        .eq("id", taskId)
        .maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "Task not found." };
      const human = `Mark **${data.title}** as done?`;
      return makeProposal("task.complete", { task_id: data.id }, human, `Mark ${data.title} done. Say yes to confirm.`);
    }

    const match = optionalString(input.title_match, 200);
    if (!match) return { error: "task_id or title_match is required." };

    const { data, error } = await ctx.supabase
      .from("workspace_tasks")
      .select("id, title, status")
      .eq("organization_id", ctx.orgId)
      .eq("status", "open")
      .ilike("title", `%${match}%`)
      .limit(6);

    if (error) return { error: error.message };
    const rows = data || [];
    if (!rows.length) return { error: `No open task matched "${match}".` };
    if (rows.length > 1) {
      return {
        error: "Multiple tasks match.",
        candidates: rows.map((r) => ({ id: r.id, title: r.title })),
      };
    }
    const human = `Mark **${rows[0].title}** as done?`;
    return makeProposal(
      "task.complete",
      { task_id: rows[0].id },
      human,
      `Mark ${rows[0].title} done. Say yes to confirm.`,
    );
  },
};

export async function executeTaskAction(
  type: string,
  payload: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  if (type === "task.create") {
    const row = {
      id: newProposalId(),
      user_id: ctx.userId,
      organization_id: ctx.orgId,
      title: String(payload.title || "").slice(0, 500),
      body: String(payload.body || "").slice(0, 8000),
      status: "open",
      due_at: (payload.due_at as string | null) || null,
      client_id: (payload.client_id as string | null) || null,
      campaign_id: null,
      created_by: "user",
      workflow_run_id: null,
      assigned_to_email: null,
    };
    const { data, error } = await ctx.supabase.from("workspace_tasks").insert(row).select("id, title").maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, result: data as Record<string, unknown> };
  }

  if (type === "task.complete") {
    const taskId = String(payload.task_id || "");
    if (!isUuid(taskId)) return { ok: false, error: "Invalid task id." };
    const { data, error } = await ctx.supabase
      .from("workspace_tasks")
      .update({ status: "done" })
      .eq("id", taskId)
      .eq("organization_id", ctx.orgId)
      .select("id, title, status")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, result: data as Record<string, unknown> };
  }

  return { ok: false, error: `Unknown task action: ${type}` };
}
