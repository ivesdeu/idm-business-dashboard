import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import {
  BLACK_WHITE_TOKEN,
  DEFAULT_ICON_STYLE,
  ICON_PICKER_EMOJIS,
  ICON_PICKER_LUCIDE_KEYS,
  brandingColorTokenFromAccentHex,
  effectiveIconStrokeWidth,
  formatLucideIconKey,
  isEmojiIcon,
  parseStoredIcon,
  resolveIconColor,
  type IconStyle,
} from '@/lib/iconBranding';

export type IconPickerCommit = {
  icon: string | null;
  iconStyle: IconStyle;
};

export type IconPickerOpenOptions = {
  anchorEl: HTMLElement;
  /** Raw workspace accent hex from settings / CSS (e.g. `#2563eb` or `#0a0a0a`). */
  brandingAccentHex: string;
  initialIcon: string | null | undefined;
  initialIconStyle?: string | null;
  onCommit: (payload: IconPickerCommit) => void;
  onClose: () => void;
};

function pascalFromKebab(kebab: string): string {
  return kebab
    .split('-')
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

function LucideGlyph({
  name,
  brandingToken,
  iconStyle,
  size = 18,
}: {
  name: string;
  brandingToken: string;
  iconStyle: IconStyle;
  size?: number;
}) {
  const pascal = pascalFromKebab(name);
  const Cmp = (Lucide as Record<string, React.ComponentType<Record<string, unknown>>>)[pascal];
  if (!Cmp) return <span style={{ fontSize: 11, color: 'var(--text3)' }}>?</span>;
  const color = resolveIconColor(brandingToken);
  const strokeW = effectiveIconStrokeWidth(brandingToken, iconStyle, formatLucideIconKey(name));
  return (
    <Cmp
      size={size}
      color={color}
      strokeWidth={strokeW}
      aria-hidden
    />
  );
}

export function IconPickerOverlay(opts: IconPickerOpenOptions) {
  const { anchorEl, brandingAccentHex, initialIcon, initialIconStyle, onCommit, onClose } = opts;
  const brandingToken = useMemo(() => brandingColorTokenFromAccentHex(brandingAccentHex), [brandingAccentHex]);
  const parsed = useMemo(() => parseStoredIcon(initialIcon || ''), [initialIcon]);
  const [tab, setTab] = useState<'icons' | 'emoji'>(() => (parsed.kind === 'emoji' ? 'emoji' : 'icons'));
  const [search, setSearch] = useState('');
  const [draftIcon, setDraftIcon] = useState<string>(() => {
    if (parsed.kind === 'lucide') return formatLucideIconKey(parsed.value);
    if (parsed.kind === 'emoji') return parsed.value;
    return formatLucideIconKey(ICON_PICKER_LUCIDE_KEYS[0] || 'layout-dashboard');
  });
  const [draftStyle, setDraftStyle] = useState<IconStyle>(() =>
    (initialIconStyle === 'outlined' ? 'outlined' : DEFAULT_ICON_STYLE) as IconStyle,
  );
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useLayoutEffect(() => {
    function onDoc(e: MouseEvent) {
      const p = panelRef.current;
      if (!p) return;
      if (e.target instanceof Node && p.contains(e.target)) return;
      onClose();
    }
    document.addEventListener('mousedown', onDoc, true);
    return () => document.removeEventListener('mousedown', onDoc, true);
  }, [onClose]);

  const pos = useMemo(() => {
    const r = anchorEl.getBoundingClientRect();
    const w = 280;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    const top = Math.min(r.bottom + 6, window.innerHeight - 320);
    return { left, top, width: w };
  }, [anchorEl]);

  const filteredLucide = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [...ICON_PICKER_LUCIDE_KEYS];
    return ICON_PICKER_LUCIDE_KEYS.filter((k) => k.includes(q));
  }, [search]);

  const filteredEmoji = useMemo(() => {
    const q = search.trim();
    if (!q) return [...ICON_PICKER_EMOJIS];
    return ICON_PICKER_EMOJIS.filter((e) => e.includes(q));
  }, [search]);

  const showStyleToggle =
    brandingToken === BLACK_WHITE_TOKEN && !isEmojiIcon(draftIcon) && tab === 'icons';

  const apply = useCallback(() => {
    onCommit({
      icon: draftIcon || null,
      iconStyle: isEmojiIcon(draftIcon) ? DEFAULT_ICON_STYLE : draftStyle,
    });
    onClose();
  }, [draftIcon, draftStyle, onClose, onCommit]);

  const remove = useCallback(() => {
    onCommit({ icon: null, iconStyle: DEFAULT_ICON_STYLE });
    onClose();
  }, [onCommit, onClose]);

  return createPortal(
    <div
      className="bizdash-icon-picker-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 20050,
        background: 'transparent',
      }}
      aria-hidden
    >
      <div
        ref={panelRef}
        className="bizdash-icon-picker-panel"
        style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          width: pos.width,
          maxHeight: 'min(360px, 70vh)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 10,
          borderRadius: 'var(--r, 6px)',
          border: '1px solid var(--border)',
          background: 'var(--bg2)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.14)',
          overflow: 'hidden',
        }}
        role="dialog"
        aria-label="Choose icon"
      >
        <input
          className="fi"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%',
            fontSize: 12,
            padding: '6px 8px',
            borderRadius: 'var(--rs, 6px)',
            border: '1px solid var(--border)',
            background: 'var(--bg)',
          }}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className={tab === 'icons' ? 'btn btn-p' : 'btn'}
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6 }}
            onClick={() => setTab('icons')}
          >
            Icons
          </button>
          <button
            type="button"
            className={tab === 'emoji' ? 'btn btn-p' : 'btn'}
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6 }}
            onClick={() => setTab('emoji')}
          >
            Emoji
          </button>
        </div>
        {showStyleToggle ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text2)' }}>
            <span>Style</span>
            <button
              type="button"
              className={draftStyle === 'filled' ? 'btn btn-p' : 'btn'}
              style={{ fontSize: 10, padding: '3px 8px', borderRadius: 6 }}
              onClick={() => setDraftStyle('filled')}
            >
              Filled
            </button>
            <button
              type="button"
              className={draftStyle === 'outlined' ? 'btn btn-p' : 'btn'}
              style={{ fontSize: 10, padding: '3px 8px', borderRadius: 6 }}
              onClick={() => setDraftStyle('outlined')}
            >
              Outlined
            </button>
          </div>
        ) : null}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(6, 1fr)',
            gap: 4,
            overflowY: 'auto',
            paddingRight: 2,
            minHeight: 120,
          }}
        >
          {tab === 'icons'
            ? filteredLucide.map((k) => {
                const key = formatLucideIconKey(k);
                const on = draftIcon === key;
                return (
                  <button
                    key={k}
                    type="button"
                    title={k}
                    onClick={() => {
                      setDraftIcon(key);
                      setTab('icons');
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: 36,
                      borderRadius: 6,
                      border: on ? '1px solid var(--coral)' : '1px solid var(--border)',
                      background: on ? 'var(--coral-bg)' : 'var(--bg)',
                      cursor: 'pointer',
                    }}
                  >
                    <LucideGlyph name={k} brandingToken={brandingToken} iconStyle={draftStyle} size={18} />
                  </button>
                );
              })
            : filteredEmoji.map((em) => {
                const on = draftIcon === em;
                return (
                  <button
                    key={em}
                    type="button"
                    onClick={() => setDraftIcon(em)}
                    style={{
                      fontSize: 20,
                      height: 36,
                      borderRadius: 6,
                      border: on ? '1px solid var(--coral)' : '1px solid var(--border)',
                      background: on ? 'var(--coral-bg)' : 'var(--bg)',
                      cursor: 'pointer',
                    }}
                  >
                    {em}
                  </button>
                );
              })}
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'space-between', marginTop: 4 }}>
          <button type="button" className="btn" style={{ fontSize: 11 }} onClick={remove}>
            Remove
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn" style={{ fontSize: 11 }} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-p" style={{ fontSize: 11 }} onClick={apply}>
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
