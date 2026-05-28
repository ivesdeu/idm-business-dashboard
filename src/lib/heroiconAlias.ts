/**
 * Heroicons (Community / heroicons.com v2) is the workspace icon library.
 *
 * Two responsibilities:
 *   1. Translate legacy `lucide:<kebab>` stored values into the closest
 *      Heroicons kebab name. Existing rows in the database use Lucide
 *      names — we render them through this alias instead of breaking them.
 *   2. Provide the canonical kebab list for the workspace Icon Picker
 *      catalog, plus a Pascal-case mapping used to render React components
 *      from `@heroicons/react`.
 *
 * Both Heroicons styles ship in @heroicons/react:
 *   - `@heroicons/react/24/outline` — line-art, used for B&W workspaces.
 *   - `@heroicons/react/24/solid`   — filled, used for branded workspaces
 *     and as the default fallback.
 */

/** Lucide kebab → closest Heroicons (v2) kebab equivalent. */
export const LUCIDE_TO_HEROICONS: Readonly<Record<string, string>> = {
  // Icons used directly in React component imports.
  'x': 'x-mark',
  'mic': 'microphone',
  'pause': 'pause',
  'play': 'play',
  'square': 'stop',
  'calendar': 'calendar',
  'layout-list': 'queue-list',
  'plus-circle': 'plus-circle',
  'arrow-up': 'arrow-up',
  'plus': 'plus',
  'sliders-horizontal': 'adjustments-horizontal',
  'check': 'check',
  'more-horizontal': 'ellipsis-horizontal',
  'trash-2': 'trash',
  'audio-lines': 'speaker-wave',
  'loader-2': 'arrow-path',
  'sparkles': 'sparkles',
  'settings-2': 'cog-6-tooth',
  'copy': 'document-duplicate',
  'refresh-cw': 'arrow-path',
  'refresh-ccw': 'arrow-path',
  'arrow-left': 'arrow-left',
  'lock': 'lock-closed',
  'mail': 'envelope',
  'bell': 'bell',
  'calendar-days': 'calendar-days',
  'chevron-left': 'chevron-left',
  'chevron-right': 'chevron-right',
  'clock-3': 'clock',
  'link-2': 'link',
  'map-pin': 'map-pin',
  'pencil': 'pencil',
  'user-round': 'user',

  // Icons exposed in the curated workspace Icon Picker catalog.
  'layout-dashboard': 'squares-2x2',
  'users': 'users',
  'check-square': 'check-circle',
  'line-chart': 'presentation-chart-line',
  'wallet': 'wallet',
  'receipt': 'receipt-percent',
  'clock': 'clock',
  'list': 'list-bullet',
  'message-square': 'chat-bubble-left-right',
  'bar-chart-2': 'chart-bar',
  'pie-chart': 'chart-pie',
  'megaphone': 'megaphone',
  'settings': 'cog-6-tooth',
  'folder': 'folder',
  'file-text': 'document-text',
  'table': 'table-cells',
  'layout-grid': 'squares-plus',
  'search': 'magnifying-glass',
  'star': 'star',
  'heart': 'heart',
  'bookmark': 'bookmark',
  'home': 'home',
  'briefcase': 'briefcase',
  'layers': 'square-3-stack-3d',
  'target': 'flag',
};

/**
 * Map a kebab name (from either namespace) to its Heroicons kebab.
 * Unknown names fall through unchanged so callers can still attempt to
 * render them via the Iconify CDN (which may 404 — caller's responsibility).
 */
export function toHeroiconsKebab(kebab: string): string {
  const k = String(kebab || '').trim().toLowerCase();
  if (!k) return '';
  return LUCIDE_TO_HEROICONS[k] || k;
}

/** Heroicons kebab → PascalCase + `Icon` suffix (as exported by `@heroicons/react`). */
export function heroiconsPascal(kebab: string): string {
  return (
    String(kebab || '')
      .split('-')
      .filter(Boolean)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join('') + 'Icon'
  );
}
