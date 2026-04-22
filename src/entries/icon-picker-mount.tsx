import { StrictMode, useCallback, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IconPickerOverlay, type IconPickerOpenOptions } from '@/components/icons/IconPicker';
import * as iconBranding from '@/lib/iconBranding';

declare global {
  interface Window {
    bizDashIconBranding?: typeof iconBranding;
    bizDashIconPickerOpen?: (opts: IconPickerOpenOptions) => void;
    bizDashIconPickerClose?: () => void;
  }
}

function IconPickerHost() {
  const [open, setOpen] = useState<IconPickerOpenOptions | null>(null);

  const close = useCallback(() => setOpen(null), []);

  useLayoutEffect(() => {
    window.bizDashIconBranding = iconBranding;
    window.bizDashIconPickerOpen = (opts: IconPickerOpenOptions) => {
      setOpen({
        ...opts,
        onClose: () => {
          setOpen(null);
          opts.onClose();
        },
      });
    };
    window.bizDashIconPickerClose = () => setOpen(null);
    return () => {
      delete window.bizDashIconPickerOpen;
      delete window.bizDashIconPickerClose;
      delete window.bizDashIconBranding;
    };
  }, []);

  if (!open) return null;
  return (
    <IconPickerOverlay
      anchorEl={open.anchorEl}
      brandingAccentHex={open.brandingAccentHex}
      initialIcon={open.initialIcon}
      initialIconStyle={open.initialIconStyle}
      onCommit={open.onCommit}
      onClose={open.onClose}
    />
  );
}

export function mountIconPicker() {
  const el = document.getElementById('icon-picker-root');
  if (!el) return;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <IconPickerHost />
    </StrictMode>,
  );
}
