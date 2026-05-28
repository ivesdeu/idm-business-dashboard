import type { AdvisorToolModule } from "./context.ts";
import { clampInt, parseIsoDate, tomorrowRangeUtc } from "./utils.ts";

const DEFAULT_WORK_START = 9;
const DEFAULT_WORK_END = 17;

export const findFreeSlotTool: AdvisorToolModule = {
  name: "find_free_slot",
  definition: {
    name: "find_free_slot",
    description:
      "Find open time slots without conflicting appointments. Use for: when am I free, find 30 minutes tomorrow, open slot this week.",
    input_schema: {
      type: "object",
      properties: {
        duration_minutes: {
          type: "number",
          description: "Required meeting length in minutes (e.g. 30).",
        },
        search_from: { type: "string", description: "ISO datetime start of search window." },
        search_to: { type: "string", description: "ISO datetime end of search window." },
        working_hours_start: {
          type: "number",
          description: "Hour of day (0-23) for workday start. Default 9.",
        },
        working_hours_end: {
          type: "number",
          description: "Hour of day (0-23) for workday end. Default 17.",
        },
        max_slots: { type: "number", description: "Max slots to return (default 5)." },
      },
      required: ["duration_minutes"],
    },
  },
  async execute(input, ctx) {
    const duration = clampInt(input.duration_minutes, 15, 480, 30);
    const maxSlots = clampInt(input.max_slots, 1, 10, 5);
    const workStart = clampInt(input.working_hours_start, 0, 23, DEFAULT_WORK_START);
    const workEnd = clampInt(input.working_hours_end, 1, 24, DEFAULT_WORK_END);

    let searchFrom = parseIsoDate(input.search_from);
    let searchTo = parseIsoDate(input.search_to);
    if (!searchFrom || !searchTo) {
      const t = tomorrowRangeUtc();
      searchFrom = searchFrom || t.from;
      searchTo = searchTo || t.to;
    }

    const { data, error } = await ctx.supabase
      .from("appointments")
      .select("start_time, end_time")
      .eq("organization_id", ctx.orgId)
      .neq("status", "cancelled")
      .gte("start_time", searchFrom)
      .lte("start_time", searchTo)
      .order("start_time", { ascending: true });

    if (error) return { error: error.message, slots: [] };

    const busy = (data || []).map((r: { start_time: string; end_time: string }) => ({
      start: new Date(r.start_time).getTime(),
      end: new Date(r.end_time).getTime(),
    }));

    const slots: Array<{ start_time: string; end_time: string }> = [];
    const windowStart = new Date(searchFrom);
    const windowEnd = new Date(searchTo);
    const durationMs = duration * 60 * 1000;

    for (
      let day = new Date(windowStart);
      day <= windowEnd && slots.length < maxSlots;
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      const dayStart = new Date(day);
      dayStart.setUTCHours(workStart, 0, 0, 0);
      const dayEnd = new Date(day);
      dayEnd.setUTCHours(workEnd, 0, 0, 0);

      let cursor = Math.max(dayStart.getTime(), windowStart.getTime());
      const dayLimit = Math.min(dayEnd.getTime(), windowEnd.getTime());

      const dayBusy = busy
        .filter((b) => b.start < dayLimit && b.end > cursor)
        .sort((a, b) => a.start - b.start);

      for (const block of dayBusy) {
        if (block.start - cursor >= durationMs) {
          slots.push({
            start_time: new Date(cursor).toISOString(),
            end_time: new Date(cursor + durationMs).toISOString(),
          });
          if (slots.length >= maxSlots) break;
        }
        cursor = Math.max(cursor, block.end);
      }
      if (slots.length < maxSlots && dayLimit - cursor >= durationMs) {
        slots.push({
          start_time: new Date(cursor).toISOString(),
          end_time: new Date(cursor + durationMs).toISOString(),
        });
      }
    }

    return {
      duration_minutes: duration,
      search_from: searchFrom,
      search_to: searchTo,
      slots: slots.slice(0, maxSlots),
    };
  },
};
