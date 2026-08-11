-- A signed-in user may INSERT an organization (Layer 1 grants role `user` insert
-- with an unconditional check). That row has to make them its owner, but the
-- membership cannot be part of the same GraphQL mutation: the insert permission
-- on org_members requires the caller to *already* be an owner of the org.
--
-- This trigger closes that bootstrap gap in the database, where it cannot be
-- skipped. Inserts made with the admin secret (the seed script) carry no session
-- user and create their memberships explicitly instead.

CREATE OR REPLACE FUNCTION public.organizations_add_creator_as_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  session_user_id uuid;
  session_email   text;
BEGIN
  BEGIN
    session_user_id := nullif(
      current_setting('hasura.user', true)::json ->> 'x-hasura-user-id', ''
    )::uuid;
  EXCEPTION WHEN others THEN
    session_user_id := NULL;
  END;

  IF session_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT u.email::text INTO session_email FROM auth.users u WHERE u.id = session_user_id;

  INSERT INTO public.org_members (org_id, user_id, role, invited_email)
  VALUES (NEW.id, session_user_id, 'owner', coalesce(session_email, ''))
  ON CONFLICT (org_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_add_creator_as_owner
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_add_creator_as_owner();
