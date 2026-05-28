-- Compass Scheduling: per-event color categorization.
-- Stores a small slug (e.g. "blue", "green", "red", "amber", "purple", "rose", "slate")
-- so the UI can map to design tokens; null means "default" (current accent).

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS color text;

ALTER TABLE public.appointments
  DROP CONSTRAINT IF EXISTS appointments_color_check;

ALTER TABLE public.appointments
  ADD CONSTRAINT appointments_color_check
  CHECK (
    color IS NULL
    OR color IN ('blue', 'green', 'red', 'amber', 'purple', 'rose', 'slate', 'teal', 'pink')
  );

COMMENT ON COLUMN public.appointments.color IS
  'Optional color category slug for the event pill. NULL = default accent.';
