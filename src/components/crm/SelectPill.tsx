import type { CrmPillColorKey } from '@/lib/crm-customers-schema';

/** Low-saturation fills so pills read clean on white (Notion-like). */
const colorMap: Record<
  CrmPillColorKey,
  { bg: string; text: string; dot: string }
> = {
  gray: { bg: 'bg-stone-100/80', text: 'text-stone-700', dot: 'bg-stone-400' },
  red: { bg: 'bg-red-50', text: 'text-red-800', dot: 'bg-red-500' },
  orange: { bg: 'bg-orange-50', text: 'text-orange-900', dot: 'bg-orange-500' },
  yellow: { bg: 'bg-amber-50', text: 'text-amber-900', dot: 'bg-amber-500' },
  green: { bg: 'bg-emerald-50', text: 'text-emerald-900', dot: 'bg-emerald-600' },
  blue: { bg: 'bg-sky-50', text: 'text-sky-900', dot: 'bg-sky-600' },
  purple: { bg: 'bg-violet-50', text: 'text-violet-900', dot: 'bg-violet-500' },
  pink: { bg: 'bg-pink-50', text: 'text-pink-900', dot: 'bg-pink-500' },
};

export type SelectPillProps = {
  label: string;
  color: CrmPillColorKey;
};

export function SelectPill({ label, color }: SelectPillProps) {
  const { bg, text, dot } = colorMap[color] ?? colorMap.gray;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1 text-[12px] font-medium leading-none ${bg} ${text}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
