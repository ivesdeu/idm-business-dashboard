-- Newsletter / marketing opt-in at signup (metadata key marketing_opt_in from email/password signUp).

CREATE TABLE IF NOT EXISTS public.marketing_email_subscribers (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email text NOT NULL,
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'email_password_signup'
);

CREATE INDEX IF NOT EXISTS marketing_email_subscribers_subscribed_at_idx
  ON public.marketing_email_subscribers (subscribed_at DESC);

COMMENT ON TABLE public.marketing_email_subscribers IS
  'Users who opted in to marketing/newsletter at signup; rows inserted only via auth.users trigger when raw_user_meta_data.marketing_opt_in is true.';

CREATE OR REPLACE FUNCTION public.handle_new_user_marketing_opt_in()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw text;
  v_opt_in boolean;
BEGIN
  v_raw := NEW.raw_user_meta_data->>'marketing_opt_in';
  IF v_raw IS NULL THEN
    v_opt_in := false;
  ELSIF lower(trim(v_raw)) IN ('true', 't', '1', 'yes') THEN
    v_opt_in := true;
  ELSIF lower(trim(v_raw)) IN ('false', 'f', '0', 'no') THEN
    v_opt_in := false;
  ELSE
    BEGIN
      v_opt_in := v_raw::boolean;
    EXCEPTION WHEN others THEN
      v_opt_in := false;
    END;
  END IF;

  IF NOT v_opt_in THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.marketing_email_subscribers (user_id, email, subscribed_at, source)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    now(),
    'email_password_signup'
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_marketing ON auth.users;
CREATE TRIGGER on_auth_user_created_marketing
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user_marketing_opt_in();

ALTER TABLE public.marketing_email_subscribers ENABLE ROW LEVEL SECURITY;

-- No policies: anon/authenticated cannot read or write; service_role bypasses RLS for exports/admin tooling.
