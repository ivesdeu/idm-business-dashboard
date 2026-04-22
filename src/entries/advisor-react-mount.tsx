import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AIChatInput, type AdvisorComposerApi } from '@/components/ui/ai-chat-input';
import '../advisor-island.css';

let root: Root | null = null;

/**
 * Mounts the Tailwind Advisor composer into #advisor-react-composer-root.
 * Call once after `wireDashboardAssistant` so `window.bizDashAdvisorGetComposerApi` exists.
 */
export function mountAdvisorReactComposer() {
  const el = document.getElementById('advisor-react-composer-root');
  if (!el) return;
  const getApi = (window as unknown as { bizDashAdvisorGetComposerApi?: () => AdvisorComposerApi | null })
    .bizDashAdvisorGetComposerApi;
  const api = getApi ? getApi() : null;
  if (!root) {
    root = createRoot(el);
  }
  root.render(
    <StrictMode>
      <AIChatInput composerApi={api} />
    </StrictMode>
  );
}
