import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { EmailComposeDialog, type ComposeOpenOptions } from './EmailComposeDialog';
import { EmailsHubPanels } from './EmailsHubPanels';
import { buildReplyPrefill } from '@/lib/email/reply';

export type EmailComposeApi = {
  open: (prefill?: ComposeOpenOptions) => void;
  close: () => void;
};

declare global {
  interface Window {
    __emailCompose?: EmailComposeApi;
    bizDashOpenEmailComposer?: (prefill?: ComposeOpenOptions) => void;
  }
}

export function EmailComposeApp() {
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<ComposeOpenOptions | null>(null);
  const [hubRefresh, setHubRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState<'drafts' | 'outbox' | 'templates'>('drafts');
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);

  const openComposer = useCallback((p?: ComposeOpenOptions) => {
    setPrefill(p ?? null);
    setOpen(true);
  }, []);

  const closeComposer = useCallback(() => {
    setOpen(false);
    setPrefill(null);
  }, []);

  useEffect(() => {
    window.__emailCompose = { open: openComposer, close: closeComposer };
    window.bizDashOpenEmailComposer = openComposer;
    window.bizDashOpenEmailReply = (opts: Parameters<typeof buildReplyPrefill>[0]) => {
      openComposer(buildReplyPrefill(opts));
    };
    return () => {
      delete window.__emailCompose;
      delete window.bizDashOpenEmailReply;
    };
  }, [openComposer, closeComposer]);

  const syncTabAndPanel = useCallback(() => {
    const root = document.getElementById('page-emails');
    if (!root) return;
    const onTab = root.querySelector('.eml-tab.on');
    const id = onTab?.getAttribute('data-eml-tab');
    const tab = id === 'drafts' || id === 'outbox' || id === 'templates' ? id : 'drafts';
    setActiveTab(tab);
    const panel = root.querySelector(`[data-eml-panel="${tab}"]`) as HTMLElement | null;
    setPanelEl(panel);
  }, []);

  useEffect(() => {
    const root = document.getElementById('page-emails');
    if (!root) return;
    syncTabAndPanel();
    root.querySelectorAll('[data-eml-tab]').forEach((tab) => {
      tab.addEventListener('click', syncTabAndPanel);
    });
    const mo = new MutationObserver(syncTabAndPanel);
    mo.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [syncTabAndPanel]);

  useEffect(() => {
    const root = document.getElementById('page-emails');
    if (!root) return;
    const onComposeClick = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-eml-compose]')) {
        e.preventDefault();
        openComposer();
      }
    };
    root.addEventListener('click', onComposeClick);
    return () => root.removeEventListener('click', onComposeClick);
  }, [openComposer]);

  return (
    <>
      <EmailComposeDialog
        open={open}
        onOpenChange={setOpen}
        prefill={prefill}
        onSent={() => setHubRefresh((n) => n + 1)}
      />
      {panelEl &&
        createPortal(
          <EmailsHubPanels activeTab={activeTab} onCompose={openComposer} refreshToken={hubRefresh} />,
          panelEl,
        )}
    </>
  );
}

export function mountEmailsHubReact() {
  const host = document.getElementById('email-compose-react-root');
  if (!host || host.getAttribute('data-mounted') === '1') return;
  host.setAttribute('data-mounted', '1');
  createRoot(host).render(<EmailComposeApp />);
}
