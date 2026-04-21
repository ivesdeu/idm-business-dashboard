import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../scheduling-island.css';
import { SchedulingPage } from '@/app/scheduling/page';

let root: Root | null = null;

export function mountSchedulingApp () {
  const el = document.getElementById ('scheduling-react-root');
  if (!el) return;
  if (!root) root = createRoot (el);
  root.render (
    <StrictMode>
      <SchedulingPage />
    </StrictMode>,
  );
}
