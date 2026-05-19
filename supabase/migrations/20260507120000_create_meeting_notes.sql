-- Meeting notes per organization (scheduling / transcription UI).

CREATE TABLE IF NOT EXISTS public.meeting_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.clients (id) ON DELETE SET NULL,
  calendar_event_id text,
  title text NOT NULL DEFAULT '',
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_at timestamptz,
  agenda text,
  raw_notes text DEFAULT '',
  manual_notes text DEFAULT '',
  transcript text DEFAULT '',
  topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  transcript_duration integer NOT NULL DEFAULT 0,
  action_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  decisions text DEFAULT '',
  summary text DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_notes_organization_id_updated_at_idx
  ON public.meeting_notes (organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS meeting_notes_contact_id_idx ON public.meeting_notes (contact_id);

ALTER TABLE public.meeting_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_row_select" ON public.meeting_notes;
DROP POLICY IF EXISTS "org_row_insert" ON public.meeting_notes;
DROP POLICY IF EXISTS "org_row_update" ON public.meeting_notes;
DROP POLICY IF EXISTS "org_row_delete" ON public.meeting_notes;

CREATE POLICY "org_row_select" ON public.meeting_notes FOR SELECT TO authenticated
  USING (public.user_is_org_member (organization_id));
CREATE POLICY "org_row_insert" ON public.meeting_notes FOR INSERT TO authenticated
  WITH CHECK (public.user_can_write_org (organization_id));
CREATE POLICY "org_row_update" ON public.meeting_notes FOR UPDATE TO authenticated
  USING (public.user_can_write_org (organization_id))
  WITH CHECK (public.user_can_write_org (organization_id));
CREATE POLICY "org_row_delete" ON public.meeting_notes FOR DELETE TO authenticated
  USING (public.user_can_write_org (organization_id));

CREATE OR REPLACE FUNCTION public.trg_meeting_notes_contact_org ()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'meeting_notes.organization_id is required';
  END IF;
  IF NEW.contact_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
      WHERE c.id = NEW.contact_id AND c.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'meeting_notes.contact_id does not belong to this organization';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meeting_notes_contact_org ON public.meeting_notes;
CREATE TRIGGER meeting_notes_contact_org
  BEFORE INSERT OR UPDATE OF contact_id, organization_id ON public.meeting_notes
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_meeting_notes_contact_org ();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_notes TO authenticated;
GRANT ALL ON public.meeting_notes TO service_role;
