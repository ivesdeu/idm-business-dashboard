const ANTHROPIC_MODEL = "claude-opus-4-6";

export type WeeklyStatusDraftPayload = {
  title: string;
  summary: string;
  decisions: string;
  topics: string[];
  action_items: Array<{
    task: string;
    owner: string;
    owner_user_id: string | null;
    due_date: string | null;
    completed: boolean;
  }>;
};

function extractJsonObjectFromText(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function callWeeklyStatusDraftAnthropic(
  anthropicApiKey: string,
  weeklyData: Record<string, unknown>,
): Promise<WeeklyStatusDraftPayload> {
  const systemPrompt =
    "You are a business operations assistant drafting a weekly status report for a small business dashboard. " +
    "Return ONLY valid JSON (no markdown fences). Required keys: " +
    "title (string), summary (string, Markdown with ### sections and bullets), " +
    "decisions (string, short paragraph of key decisions/outcomes), " +
    "topics (array of 3-8 short topic labels), " +
    "action_items (array of { task, owner, owner_user_id: null, due_date: YYYY-MM-DD or null, completed: false } for follow-ups only). " +
    "Use ONLY facts from the provided weekly_data JSON. Do not invent clients or numbers.";

  const userPrompt = `weekly_data JSON:\n${JSON.stringify(weeklyData, null, 2)}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Anthropic error ${resp.status}: ${txt.slice(0, 500)}`);
  }

  const data = await resp.json();
  const contentArr = Array.isArray(data?.content) ? data.content : [];
  const textPart = contentArr.find((p: { type?: string }) => p && p.type === "text");
  const rawText = String(textPart?.text || "").trim();
  if (!rawText) throw new Error("Anthropic returned empty content.");

  const parsed = extractJsonObjectFromText(rawText);
  if (!parsed) throw new Error("Invalid weekly status JSON from Anthropic.");

  const title = String(parsed.title || "Weekly status").trim();
  const summary = String(parsed.summary || "").trim();
  const decisions = String(parsed.decisions || "").trim();
  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.map((t) => String(t)).filter(Boolean)
    : [];

  const action_items = Array.isArray(parsed.action_items)
    ? parsed.action_items.map((item: Record<string, unknown>) => ({
        task: String(item.task || "").trim(),
        owner: String(item.owner || "").trim(),
        owner_user_id: null,
        due_date: item.due_date != null ? String(item.due_date).slice(0, 10) : null,
        completed: false,
      })).filter((a) => a.task)
    : [];

  return { title, summary, decisions, topics, action_items };
}
