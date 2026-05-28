import '../email-compose-island.css';
import { mountEmailsHubReact } from '@/components/email/EmailComposeApp';

let mounted = false;

export function mountEmailCompose() {
  if (mounted) return;
  mountEmailsHubReact();
  mounted = true;
}

if (typeof window !== 'undefined') {
  window.bizDashMountEmailCompose = mountEmailCompose;
}
