import { composeMeetingSummaryDocument } from '@/lib/scheduling/meetingSummaryFormat';
import type { MeetingActionItem } from '@/components/scheduling/types';

type MeetingSummaryMarkdownProps = {
  summary: string;
  actionItems?: MeetingActionItem[];
  className?: string;
};

type Block =
  | { kind: 'h3'; text: string }
  | { kind: 'ul'; items: ListItem[] };

type ListItem = {
  text: string;
  children: string[];
};

function parseMarkdownBlocks (markdown: string): Block[] {
  const blocks: Block[] = [];
  let currentList: ListItem[] | null = null;

  const flushList = () => {
    if (currentList && currentList.length) {
      blocks.push ({ kind: 'ul', items: currentList });
    }
    currentList = null;
  };

  for (const rawLine of markdown.split ('\n')) {
    const line = rawLine.trimEnd ();
    const trimmed = line.trim ();
    if (!trimmed) {
      flushList ();
      continue;
    }
    if (trimmed.startsWith ('### ')) {
      flushList ();
      blocks.push ({ kind: 'h3', text: trimmed.slice (4).trim () });
      continue;
    }
    const nested = line.match (/^\s{2,}-\s+(.*)$/);
    if (nested && currentList) {
      const last = currentList[currentList.length - 1];
      last.children.push (nested[1].trim ());
      continue;
    }
    const bullet = trimmed.match (/^-\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (bullet) {
      if (!currentList) currentList = [];
      currentList.push ({ text: bullet[1].trim (), children: [] });
      continue;
    }
    flushList ();
    if (!currentList) currentList = [];
    currentList.push ({ text: trimmed, children: [] });
  }
  flushList ();
  return blocks;
}

function CheckboxItem ({ text }: { text: string }) {
  return (
    <li className="flex gap-2 text-sm text-[var(--text2)]">
      <span
        className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-[var(--border2)] bg-[var(--bg)] text-[10px] text-[var(--text3)]"
        aria-hidden
      />
      <span>{text}</span>
    </li>
  );
}

export function MeetingSummaryMarkdown ({
  summary,
  actionItems = [],
  className = '',
}: MeetingSummaryMarkdownProps) {
  const document = composeMeetingSummaryDocument (summary, actionItems);
  const blocks = parseMarkdownBlocks (document);

  return (
    <div className={`space-y-4 ${className}`}>
      {blocks.map ((block, idx) => {
        if (block.kind === 'h3') {
          const isActions = block.text.toLowerCase () === 'action items';
          return (
            <h3
              key={`h3-${idx}-${block.text}`}
              className={`text-sm font-semibold text-[var(--text)] ${isActions && idx > 0 ? 'mt-2 border-t border-[var(--border)] pt-4' : ''}`}
            >
              {block.text}
            </h3>
          );
        }
        const isActionList = blocks[idx - 1]?.kind === 'h3'
          && blocks[idx - 1].text.toLowerCase () === 'action items';
        return (
          <ul
            key={`ul-${idx}`}
            className={`space-y-1.5 ${isActionList ? 'list-none pl-0' : 'list-disc pl-5'}`}
          >
            {block.items.map ((item, itemIdx) => (
              <li key={`${idx}-${itemIdx}-${item.text}`} className={isActionList ? 'list-none' : ''}>
                {isActionList ? (
                  <CheckboxItem text={item.text} />
                ) : (
                  <span className="text-sm text-[var(--text2)]">{item.text}</span>
                )}
                {item.children.length ? (
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {item.children.map ((child, childIdx) => (
                      <li key={`${idx}-${itemIdx}-${childIdx}`} className="text-sm text-[var(--text2)]">
                        {child}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        );
      })}
    </div>
  );
}
