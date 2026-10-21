-- ============================================================================
-- NeuraFlix Labeler: read-only admin settings (Phase L6 close-out)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again (create or replace and guarded grants).
--   4. Nothing in this repo runs it for you.
--
-- What this file changes
--   - admin_settings_status(), a read-only function that returns the two
--     settings the admin page shows: allow_self_review and ocr_quota_mb.
--   - Values are returned as text because app_settings stores text.
--   - The function checks the admin role inside the database and is
--     executable by authenticated users only.
--
-- Already in 0006 and 0007, left alone
--   - The app_settings table, its rows and its RLS policies.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Read-only settings for the admin page. No insert, update or delete path:
--    admins change values with SQL in the dashboard.
-- ----------------------------------------------------------------------------
create or replace function public.admin_settings_status()
returns table (
  allow_self_review text,
  ocr_quota_mb text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_role text;
  v_allow_self_review text;
  v_ocr_quota_mb text;
begin
  if v_uid is null then
    raise exception 'ADMIN_AUTH_REQUIRED';
  end if;

  select p.role
    into v_actor_role
    from public.profiles p
   where p.id = v_uid;

  if v_actor_role is distinct from 'admin' then
    raise exception 'ADMIN_FORBIDDEN';
  end if;

  select s.value
    into v_allow_self_review
    from public.app_settings s
   where s.key = 'allow_self_review';

  select s.value
    into v_ocr_quota_mb
    from public.app_settings s
   where s.key = 'ocr_quota_mb';

  return query
    select
      coalesce(v_allow_self_review, 'false')::text as allow_self_review,
      coalesce(v_ocr_quota_mb, '400')::text as ocr_quota_mb;
end;
$$;


-- ----------------------------------------------------------------------------
-- 2. Grants. The role check inside the function is the real gate.
-- ----------------------------------------------------------------------------
revoke all on function public.admin_settings_status() from public, anon;

grant execute on function public.admin_settings_status() to authenticated;
