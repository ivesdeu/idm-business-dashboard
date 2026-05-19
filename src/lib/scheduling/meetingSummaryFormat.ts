import type { MeetingActionItem } from '@/components/scheduling/types';

/** Canonical section style for Advisor meeting summaries (see product spec). */
export const MEETING_SUMMARY_FORMAT_INSTRUCTIONS = `
Format the "summary" field as Markdown only (no JSON inside it). Use clear ### section headings chosen from the meeting content (for example: Event Overview, Reservations & Space, Catering & Services, Financial Considerations — or business equivalents such as Project Status, Budget, Risks, Next Steps).

Rules:
- Each section starts with ### Title on its own line.
- Use bullet lists with "- " for each point.
- Use nested bullets with four-space indent for sub-points (e.g. timelines, sub-lists).
- Be specific: dates, times, numbers, owners, and deadlines when mentioned in the transcript.
- Do not include an Action Items section in summary — action items go only in the action_items array.
- Omit empty sections. Prefer 4–8 substantive sections.
- Write in past tense, concise professional tone.
`.trim ();

export function formatActionItemsMarkdown (items: MeetingActionItem[]): string {
  if (!items.length) return '';
  const lines = items.map ((item) => {
    const owner = item.owner?.trim ();
    const due = item.dueDate?.trim ();
    const meta = [owner, due].filter (Boolean).join (' · ');
    return meta ? `- [ ] ${item.task} (${meta})` : `- [ ] ${item.task}`;
  });
  return `### Action Items\n\n${lines.join ('\n')}`;
}

export function composeMeetingSummaryDocument (
  summaryMarkdown: string,
  actionItems: MeetingActionItem[],
): string {
  const body = summaryMarkdown.trim ();
  const actions = formatActionItemsMarkdown (actionItems);
  if (!body) return actions;
  if (!actions) return body;
  return `${body}\n\n${actions}`;
}
