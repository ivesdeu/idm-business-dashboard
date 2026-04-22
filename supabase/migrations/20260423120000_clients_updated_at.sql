-- Track last modification time for CRM clients (inline edits + modal saves).
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

UPDATE public.clients SET updated_at = COALESCE(created_at, now()) WHERE updated_at IS NULL;

CREATE OR REPLACE FUNCTION public.trg_clients_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clients_touch_updated_at ON public.clients;
CREATE TRIGGER clients_touch_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_clients_touch_updated_at();
