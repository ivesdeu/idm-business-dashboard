/**
 * Workspace icon color is always derived from branding — never a free-form picker.
 * Black & white accent uses token `black-white` so callers can branch (e.g. outlined icons).
 *
 * Stored values use the prefix `heroicons:<kebab>` (current) or `lucide:<kebab>`
 * (legacy). Legacy values are auto-mapped to their Heroicons equivalent on read
 * via `src/lib/heroiconAlias.ts` — no DB migration required.
 */

import { toHeroiconsKebab } from '@/lib/heroiconAlias';

export { toHeroiconsKebab, heroiconsPascal, LUCIDE_TO_HEROICONS } from '@/lib/heroiconAlias';

export const BLACK_WHITE_TOKEN = 'black-white';
export const DEFAULT_ICON_STYLE: IconStyle = 'filled';

export type IconStyle = 'filled' | 'outlined';

/** Normalize hex like financial-core `normalizeHexColor` (minimal subset). */
export function normalizeAccentHex(raw: string | null | undefined, fallback = '#2563eb'): string {
  let s = String(raw || '').trim();
  if (!s) return fallback;
  if (!s.startsWith('#')) s = '#' + s;
  if (s.length === 4) {
    s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return fallback;
  return s.toLowerCase();
}

/** Map stored workspace accent hex to resolver input. */
export function brandingColorTokenFromAccentHex(accentHex: string | null | undefined): string {
  const n = normalizeAccentHex(accentHex, '#2563eb');
  if (n === '#0a0a0a') return BLACK_WHITE_TOKEN;
  return n;
}

/**
 * Single resolver for icon paint color (theme-aware in the sense of workspace accent).
 * Pass the token from `brandingColorTokenFromAccentHex` or literal `'black-white'`.
 */
export function resolveIconColor(brandingColor: string): string {
  if (brandingColor === BLACK_WHITE_TOKEN) return '#0a0a0a';
  return brandingColor;
}

export function isEmojiIcon(icon: string | null | undefined): boolean {
  if (!icon) return false;
  const t = String(icon).trim();
  if (!t) return false;
  if (/^(lucide|heroicons):/i.test(t)) return false;
  try {
    return /\p{Extended_Pictographic}/u.test(t);
  } catch {
    return /[\u{1F300}-\u{1F9FF}]/u.test(t);
  }
}

/**
 * Heroicons doesn't expose a stroke-width knob — instead we pick the outline
 * variant for B&W workspaces and the solid variant for branded ones. This
 * helper is preserved for callers that still need a numeric width (e.g.
 * non-Heroicons SVGs rendered alongside). Returns sensible defaults.
 */
export function effectiveIconStrokeWidth(
  brandingToken: string,
  iconStyle: IconStyle | string | undefined,
  icon: string | null | undefined,
): number {
  if (brandingToken !== BLACK_WHITE_TOKEN) return 1.75;
  if (isEmojiIcon(icon)) return 1.75;
  return (iconStyle || DEFAULT_ICON_STYLE) === 'outlined' ? 1.5 : 2;
}

export function shouldRenderOutlined(
  brandingToken: string,
  iconStyle: IconStyle | string | undefined,
  icon: string | null | undefined,
): boolean {
  if (brandingToken !== BLACK_WHITE_TOKEN) return false;
  if (isEmojiIcon(icon)) return false;
  return (iconStyle || DEFAULT_ICON_STYLE) === 'outlined';
}

/**
 * Resolve the rendered Heroicons style for the current branding + user choice:
 *   - B&W workspace + outlined → outline
 *   - everything else          → solid
 */
export function resolveHeroiconsVariant(
  brandingToken: string,
  iconStyle: IconStyle | string | undefined,
  icon: string | null | undefined,
): 'outline' | 'solid' {
  return shouldRenderOutlined(brandingToken, iconStyle, icon) ? 'outline' : 'solid';
}

/** Curated Heroicons kebab keys exposed in the workspace Icon Picker catalog. */
export const ICON_PICKER_HEROICONS_KEYS: readonly string[] = [
  'squares-2x2',
  'users',
  'check-circle',
  'calendar',
  'envelope',
  'presentation-chart-line',
  'wallet',
  'receipt-percent',
  'clock',
  'list-bullet',
  'chat-bubble-left-right',
  'chart-bar',
  'arrow-path',
  'chart-pie',
  'megaphone',
  'cog-6-tooth',
  'folder',
  'document-text',
  'table-cells',
  'squares-plus',
  'sparkles',
  'magnifying-glass',
  'star',
  'heart',
  'bookmark',
  'home',
  'briefcase',
  'square-3-stack-3d',
  'flag',
] as const;

/**
 * @deprecated Legacy alias retained for backwards compatibility. Prefer
 * `ICON_PICKER_HEROICONS_KEYS`. Same length, same ordering — the indexed
 * picker UI keeps stable selection after the icon library swap.
 */
export const ICON_PICKER_LUCIDE_KEYS = ICON_PICKER_HEROICONS_KEYS;

export const ICON_PICKER_EMOJIS: readonly string[] = [
  '📊',
  '📋',
  '✅',
  '📅',
  '✉️',
  '💰',
  '🧾',
  '⏱',
  '📝',
  '💬',
  '📈',
  '🎯',
  '⭐',
  '❤️',
  '🏠',
  '📁',
  '🔔',
  '⚙️',
  '🚀',
  '📌',
  '🗂',
  '📎',
  '🔍',
  '💡',
];

/**
 * Parse a stored icon value. The `icon` kind always returns a Heroicons kebab
 * name — legacy `lucide:*` values are auto-mapped via the alias table.
 */
export function parseStoredIcon(
  raw: string | null | undefined,
): { kind: 'icon' | 'emoji' | 'empty'; value: string } {
  const t = String(raw || '').trim();
  if (!t) return { kind: 'empty', value: '' };
  const m = t.match(/^(lucide|heroicons):\s*([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
  if (m) {
    const lib = m[1].toLowerCase();
    const name = m[2].toLowerCase();
    return { kind: 'icon', value: lib === 'lucide' ? toHeroiconsKebab(name) : name };
  }
  return { kind: 'emoji', value: t };
}

/** Build a storage-safe key for a Heroicons kebab name (e.g. `heroicons:home`). */
export function formatHeroIconKey(kebab: string): string {
  return 'heroicons:' + String(kebab || '').trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * @deprecated Use `formatHeroIconKey`. Retained so existing callers continue
 * to compile during the migration; it produces the modern `heroicons:` prefix
 * after auto-mapping the input through the Lucide→Heroicons alias.
 */
export function formatLucideIconKey(kebab: string): string {
  return formatHeroIconKey(toHeroiconsKebab(kebab));
}
