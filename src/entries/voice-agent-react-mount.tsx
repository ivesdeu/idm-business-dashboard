import { createRoot } from 'react-dom/client';
import { VoiceAgentLauncher } from '@/components/voice-agent/VoiceAgentLauncher';

let mounted = false;

export function mountVoiceAgent() {
  const host = document.getElementById('voice-agent-react-root');
  if (!host || mounted) return;
  mounted = true;
  host.setAttribute('data-mounted', '1');
  createRoot(host).render(<VoiceAgentLauncher />);
}

if (typeof window !== 'undefined') {
  window.bizDashMountVoiceAgent = mountVoiceAgent;
}
