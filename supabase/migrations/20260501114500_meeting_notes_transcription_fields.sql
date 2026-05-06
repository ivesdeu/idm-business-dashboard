-- Meeting transcription support fields.
-- Safe/idempotent for repeated deploys.

alter table if exists public.meeting_notes
  add column if not exists manual_notes text default '';

alter table if exists public.meeting_notes
  add column if not exists topics jsonb default '[]'::jsonb;

alter table if exists public.meeting_notes
  add column if not exists transcript_duration integer default 0;
