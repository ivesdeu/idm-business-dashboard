import type { SchedulingAppointment } from '@/components/scheduling/types';
import type { DemoAppointmentSeed } from '@/lib/mockData/appointments';

export function schedulingAppointmentFromDemoSeed (s: DemoAppointmentSeed): SchedulingAppointment {
  return {
    id: s.id,
    title: s.title,
    clientName: s.clientName,
    clientId: s.demoClientId,
    startTime: s.startIso,
    endTime: s.endIso,
    location: s.location ?? null,
    notes: s.notes ?? null,
    status: s.status,
    googleCalendarEventId: s.googleCalendarEventId ?? null,
    syncedAt: s.syncedAtIso ?? null,
  };
}
