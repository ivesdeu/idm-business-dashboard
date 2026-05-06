import { createRoot } from 'react-dom/client';
import { MeetingNotesPage } from '@/app/scheduling/meeting-notes-page';

let mounted = false;

export function mountMeetingNotesPage() {
  if (mounted) return;
  const rootEl = document.getElementById('meeting-notes-react-root');
  if (!rootEl) return;
  createRoot(rootEl).render(<MeetingNotesPage />);
  mounted = true;
}
