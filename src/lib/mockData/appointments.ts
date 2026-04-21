import { isDemoMode } from '@/lib/demoMode';

/** Shared shape for scheduling demos (browser-only placeholder rows). */
export type DemoAppointmentSeed = {
  id: string;
  /** Synthetic id for filters / dropdowns — never inserted into Supabase. */
  demoClientId: string;
  title: string;
  clientName: string;
  startIso: string;
  endIso: string;
  status: 'confirmed' | 'pending' | 'cancelled';
  location?: string;
  notes?: string;
  googleCalendarEventId?: string | null;
  syncedAtIso?: string | null;
};

/** Never exported — only surfaced via {@link getSchedulingMockAppointments} in demo sessions. */
const MOCK_APPOINTMENTS_DEMO_ONLY: DemoAppointmentSeed[] = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01',
    demoClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001',
    title: 'Strategy call — Q2 roadmap',
    clientName: 'Northwind Aviation LLC',
    startIso: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    endIso: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
    status: 'confirmed',
    location: 'Zoom',
    googleCalendarEventId: 'mock_gcal_evt_001',
    syncedAtIso: new Date().toISOString(),
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02',
    demoClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb002',
    title: 'Client onboarding session',
    clientName: 'Harbor Ridge Partners',
    startIso: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    endIso: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 90 * 60 * 1000).toISOString(),
    status: 'pending',
    location: 'Conference room B',
    googleCalendarEventId: null,
    syncedAtIso: null,
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03',
    demoClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb003',
    title: 'Contract review — retainer renewal',
    clientName: 'Sterling Ops Co.',
    startIso: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    endIso: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000 + 45 * 60 * 1000).toISOString(),
    status: 'confirmed',
    googleCalendarEventId: 'mock_gcal_evt_003',
    syncedAtIso: new Date().toISOString(),
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04',
    demoClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb004',
    title: 'Quarterly business review',
    clientName: 'Brightline Advisory',
    startIso: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString(),
    endIso: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
    status: 'confirmed',
    location: 'Google Meet',
    googleCalendarEventId: 'mock_gcal_evt_004',
    syncedAtIso: new Date().toISOString(),
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05',
    demoClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb005',
    title: 'Proposal walkthrough',
    clientName: 'Coastal Growth Group',
    startIso: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    endIso: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 50 * 60 * 1000).toISOString(),
    status: 'cancelled',
    googleCalendarEventId: null,
    syncedAtIso: null,
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06',
    demoClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb006',
    title: 'Executive coaching — leadership sync',
    clientName: 'Summit Field Services',
    startIso: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    endIso: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
    status: 'pending',
    notes: 'Send prep worksheet 24h before.',
    googleCalendarEventId: null,
    syncedAtIso: null,
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa07',
    demoClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb007',
    title: 'Tax season planning check-in',
    clientName: 'Atlas Private Wealth',
    startIso: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000).toISOString(),
    endIso: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString(),
    status: 'pending',
    googleCalendarEventId: null,
    syncedAtIso: null,
  },
];

/**
 * Sample appointments for the View Demo session only.
 * Live users always get an empty array here — load real rows from Supabase instead.
 */
export function getSchedulingMockAppointments(): DemoAppointmentSeed[] {
  if (!isDemoMode()) return [];
  return MOCK_APPOINTMENTS_DEMO_ONLY;
}
