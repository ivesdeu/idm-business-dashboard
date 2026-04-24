/**
 * Workspace icon color is always derived from branding — never a free-form picker.
 * Black & white accent uses token `black-white` so callers can branch (e.g. outlined icons).
 */

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
  if (/^lucide:/i.test(t)) return false;
  try {
    return /\p{Extended_Pictographic}/u.test(t);
  } catch {
    return /[\u{1F300}-\u{1F9FF}]/u.test(t);
  }
}

export function effectiveIconStrokeWidth(
  brandingToken: string,
  iconStyle: IconStyle | string | undefined,
  icon: string | null | undefined,
): number {
  if (brandingToken !== BLACK_WHITE_TOKEN) return 2;
  if (isEmojiIcon(icon)) return 2;
  return (iconStyle || DEFAULT_ICON_STYLE) === 'outlined' ? 1.25 : 2.35;
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

/** Curated lucide keys (kebab) aligned with `lucide:name` storage. */
export const ICON_PICKER_LUCIDE_KEYS: readonly string[] = [
  'layout-dashboard',
  'users',
  'check-square',
  'calendar',
  'mail',
  'line-chart',
  'wallet',
  'receipt',
  'clock',
  'list',
  'message-square',
  'bar-chart-2',
  'refresh-ccw',
  'pie-chart',
  'megaphone',
  'settings',
  'folder',
  'file-text',
  'table',
  'layout-grid',
  'sparkles',
  'search',
  'star',
  'heart',
  'bookmark',
  'home',
  'briefcase',
  'layers',
  'target',
] as const;

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

export function parseStoredIcon(raw: string | null | undefined): { kind: 'lucide' | 'emoji' | 'empty'; value: string } {
  const t = String(raw || '').trim();
  if (!t) return { kind: 'empty', value: '' };
  const m = t.match(/^lucide:\s*([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
  if (m) return { kind: 'lucide', value: m[1].toLowerCase() };
  return { kind: 'emoji', value: t };
}

export function formatLucideIconKey(kebab: string): string {
  return 'lucide:' + String(kebab || '').trim().toLowerCase().replace(/\s+/g, '-');
}
