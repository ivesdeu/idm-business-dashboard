import { createRoot, type Root } from 'react-dom/client';
import '../auth-gate-island.css';
import { AuthLoginGate } from '@/components/ui/auth-login-gate';

let root: Root | null = null;

/** Mounts the provider-first auth gate (`AuthLoginGate`) into `#auth-login-react-root`. */
export function mountAuthLoginGate() {
  const el = document.getElementById('auth-login-react-root');
  if (!el) return;
  if (!root) root = createRoot(el);
  root.render(<AuthLoginGate />);
}
