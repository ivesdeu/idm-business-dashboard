import type { AdvisorToolModule } from "./context.ts";
import { clampInt, matchOwnerToMe, optionalString } from "./utils.ts";

type FlatActionItem = {
  note_id: string;
  note_title: string;
  scheduled_at: string | null;
  task: string;
  owner: string;
  owner_user_id: string | null;
  due_date: string | null;
  completed: boolean;
};

function flattenActionItems(
  notes: Array<Record<string, unknown>>,
  filter: (item: FlatActionItem) => boolean,
): FlatActionItem[] {
  const out: FlatActionItem[] = [];
  for (const note of notes) {
    const items = note.action_items;
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const task = typeof rec.task === "string" ? rec.task.trim() : "";
      if (!task) continue;
      const row: FlatActionItem = {
        note_id: String(note.id),
        note_title: String(note.title || ""),
        scheduled_at: note.scheduled_at ? String(note.scheduled_at) : null,
        task,
        owner: typeof rec.owner === "string" ? rec.owner.trim() : "",
        owner_user_id:
          typeof rec.owner_user_id === "string" && /^[0-9a-f-]{36}$/i.test(rec.owner_user_id.trim())
            ? rec.owner_user_id.trim()
            : null,
        due_date:
          typeof rec.due_date === "string"
            ? rec.due_date
            : typeof rec.dueDate === "string"
              ? rec.dueDate
              : null,
        completed: rec.completed === true,
      };
      if (filter(row)) out.push(row);
    }
  }
  return out;
}

export const listActionItemsTool: AdvisorToolModule = {
  name: "list_action_items",
  definition: {
    name: "list_action_items",
    description:
      "List action items from meeting notes. Use for: what action items do I owe, my open tasks from meetings.",
    input_schema: {
      type: "object",
      properties: {
        owner_user_id: {
          type: "string",
          description: "Filter by owner UUID. Use literal 'me' for the current user.",
        },
        owner_name: { type: "string", description: "Filter by owner name substring." },
        completed: {
          type: "boolean",
          description: "If false (default), only open items. If true, only completed.",
        },
        due_before: { type: "string", description: "ISO date — due on or before." },
        limit: { type: "number", description: "Max items (default 30)." },
      },
    },
  },
  async execute(input, ctx) {
    const limit = clampInt(input.limit, 1, 80, 30);
    const completedFilter = input.completed === true;

    const { data, error } = await ctx.supabase
      .from("meeting_notes")
      .select("id, title, scheduled_at, action_items")
      .eq("organization_id", ctx.orgId)
      .order("updated_at", { ascending: false })
      .limit(80);

    if (error) return { error: error.message, action_items: [] };

    const ownerUserIdRaw = optionalString(input.owner_user_id, 64);
    const ownerName = optionalString(input.owner_name, 200)?.toLowerCase();
    const dueBefore = optionalString(input.due_before, 32);

    const meCtx = {
      userId: ctx.userId,
      userDisplayName: ctx.userDisplayName,
      userEmail: ctx.userEmail,
    };

    let items = flattenActionItems(data || [], (item) => {
      if (item.completed !== completedFilter) return false;
      if (ownerUserIdRaw === "me") {
        if (item.owner_user_id === ctx.userId) return true;
        if (matchOwnerToMe(item.owner, meCtx)) return true;
        return false;
      }
      if (ownerUserIdRaw && ownerUserIdRaw !== "me") {
        if (item.owner_user_id !== ownerUserIdRaw) return false;
      }
      if (ownerName && !item.owner.toLowerCase().includes(ownerName)) return false;
      if (dueBefore && item.due_date && item.due_date > dueBefore) return false;
      return true;
    });

    items = items.slice(0, limit);

    return { count: items.length, action_items: items };
  },
};
