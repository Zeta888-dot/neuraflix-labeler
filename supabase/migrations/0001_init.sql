-- ============================================================================
-- NeuraFlix Labeler: initial schema (Phase L0)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again: tables use IF NOT EXISTS, functions use
--      CREATE OR REPLACE, and every policy/trigger is dropped first.
--   4. Nothing in this repo runs it for you; migrations are applied by hand
--      through the SQL editor (or "supabase db push" if you use the CLI).
--
-- Make yourself the first admin (replace the placeholder email, then run it
-- once, after you have signed in at least once so your profile row exists):
--
--   update public.profiles
--      set role = 'admin'
--    where id = (select id from auth.users where email = 'you@example.com');
--
-- What this file creates
--   profiles, instruction_items, instruction_translations, conversation_items,
--   conversation_translations, text_submissions, ocr_pages, ocr_lines, claims,
--   report_issues, the claim_next(kind) function, the profile-on-signup
--   trigger, RLS policies for every table, and the private ocr-lines bucket
--   with storage policies.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. profiles
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role text not null default 'contributor'
    check (role in ('contributor', 'reviewer', 'admin')),
  consent_version text,
  consent_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. Created by the on_auth_user_created trigger.';

-- Profile row on first sign-in. The display name comes from auth metadata
-- when present; otherwise it stays empty and the UI falls back to the email.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Nobody may change their own role through the API. Admins (and the SQL
-- editor) change roles on other rows.
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and auth.uid() = old.id then
    raise exception 'A profile owner cannot change their own role';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
before update on public.profiles
for each row execute function public.guard_profile_role();


-- ----------------------------------------------------------------------------
-- 2. Role helpers (security definer so policies never recurse into profiles)
-- ----------------------------------------------------------------------------
create or replace function public.actor_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.role from public.profiles p where p.id = auth.uid()
$$;

create or replace function public.is_reviewer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.actor_role() in ('reviewer', 'admin'), false)
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.actor_role() = 'admin', false)
$$;


-- ----------------------------------------------------------------------------
-- 3. Work items
-- ----------------------------------------------------------------------------
create table if not exists public.instruction_items (
  id uuid primary key default gen_random_uuid(),
  english jsonb not null,
  source text,
  status text not null default 'open'
    check (status in ('open', 'complete', 'retired')),
  target_count integer not null default 1 check (target_count >= 1),
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_items (
  id uuid primary key default gen_random_uuid(),
  english jsonb not null,
  source text,
  status text not null default 'open'
    check (status in ('open', 'complete', 'retired')),
  target_count integer not null default 1 check (target_count >= 1),
  created_at timestamptz not null default now()
);


-- ----------------------------------------------------------------------------
-- 4. Contributor work
-- ----------------------------------------------------------------------------
create table if not exists public.instruction_translations (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null
    references public.instruction_items (id) on delete cascade,
  contributor_id uuid not null references public.profiles (id) on delete cascade,
  khowar_instruction text not null,
  khowar_input text,
  khowar_response text,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected')),
  reviewer_id uuid references public.profiles (id) on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  exported_at timestamptz
);

create table if not exists public.conversation_translations (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null
    references public.conversation_items (id) on delete cascade,
  contributor_id uuid not null references public.profiles (id) on delete cascade,
  turns jsonb not null,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected')),
  reviewer_id uuid references public.profiles (id) on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  exported_at timestamptz
);

create table if not exists public.text_submissions (
  id uuid primary key default gen_random_uuid(),
  contributor_id uuid not null references public.profiles (id) on delete cascade,
  title text,
  khowar_text text not null,
  source_note text,
  rights_confirmed boolean not null default false,
  text_hash text not null unique,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected')),
  reviewer_id uuid references public.profiles (id) on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  exported_at timestamptz
);

create table if not exists public.ocr_pages (
  id uuid primary key default gen_random_uuid(),
  contributor_id uuid not null references public.profiles (id) on delete cascade,
  label text,
  rights_confirmed boolean not null default false,
  line_count integer not null default 0 check (line_count >= 0),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create table if not exists public.ocr_lines (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.ocr_pages (id) on delete cascade,
  idx integer not null check (idx >= 0),
  storage_path text,
  label text,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected')),
  width integer,
  height integer,
  bytes integer,
  exported_at timestamptz,
  purged_at timestamptz,
  unique (page_id, idx)
);


-- ----------------------------------------------------------------------------
-- 5. Claims
-- ----------------------------------------------------------------------------
create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('instruction', 'conversation')),
  item_id uuid not null,
  contributor_id uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '30 minutes')
);

create table if not exists public.report_issues (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  item_id uuid,
  contributor_id uuid not null references public.profiles (id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now()
);


-- ----------------------------------------------------------------------------
-- 6. Item status maintenance: an item is complete when its submitted or
--    approved translations reach target_count.
-- ----------------------------------------------------------------------------
create or replace function public.refresh_instruction_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target integer;
  v_done integer;
begin
  select target_count into v_target
  from public.instruction_items where id = p_item_id;

  if v_target is null then
    return;
  end if;

  select count(*) into v_done
  from public.instruction_translations
  where item_id = p_item_id and status in ('submitted', 'approved');

  if v_done >= v_target then
    update public.instruction_items
    set status = 'complete'
    where id = p_item_id and status = 'open';
  end if;
end;
$$;

create or replace function public.refresh_conversation_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target integer;
  v_done integer;
begin
  select target_count into v_target
  from public.conversation_items where id = p_item_id;

  if v_target is null then
    return;
  end if;

  select count(*) into v_done
  from public.conversation_translations
  where item_id = p_item_id and status in ('submitted', 'approved');

  if v_done >= v_target then
    update public.conversation_items
    set status = 'complete'
    where id = p_item_id and status = 'open';
  end if;
end;
$$;

create or replace function public.handle_instruction_translation_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_instruction_item(coalesce(new.item_id, old.item_id));
  return null;
end;
$$;

create or replace function public.handle_conversation_translation_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_conversation_item(coalesce(new.item_id, old.item_id));
  return null;
end;
$$;

drop trigger if exists instruction_translations_refresh on public.instruction_translations;
create trigger instruction_translations_refresh
after insert or update of status or delete on public.instruction_translations
for each row execute function public.handle_instruction_translation_change();

drop trigger if exists conversation_translations_refresh on public.conversation_translations;
create trigger conversation_translations_refresh
after insert or update of status or delete on public.conversation_translations
for each row execute function public.handle_conversation_translation_change();


-- ----------------------------------------------------------------------------
-- 7. claim_next(kind): hand the caller one open item they have not done yet.
--    FOR UPDATE SKIP LOCKED keeps two contributors off the same row; the claim
--    expires after 30 minutes. SECURITY DEFINER, so it can read the item tables
--    that contributors cannot select directly.
-- ----------------------------------------------------------------------------
create or replace function public.claim_next(p_kind text)
returns table (
  item_id uuid,
  english jsonb,
  source text,
  target_count integer,
  claimed_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_expires timestamptz := now() + interval '30 minutes';
  v_item_id uuid;
begin
  if v_uid is null then
    raise exception 'claim_next requires an authenticated session';
  end if;

  if p_kind not in ('instruction', 'conversation') then
    raise exception 'claim_next: unknown kind %', p_kind;
  end if;

  -- Release this user's expired claims first: those items become available
  -- again, including for this user.
  delete from public.claims
  where contributor_id = v_uid
    and expires_at <= now();

  if p_kind = 'instruction' then
    select i.id
    into v_item_id
    from public.instruction_items i
    where i.status = 'open'
      and not exists (
        select 1
        from public.instruction_translations t
        where t.item_id = i.id
          and t.contributor_id = v_uid
      )
      and (
        select count(*)
        from public.claims c
        where c.kind = 'instruction'
          and c.item_id = i.id
          and c.expires_at > now()
      ) < i.target_count
    order by i.created_at, i.id
    for update skip locked
    limit 1;

    if v_item_id is null then
      return;
    end if;

    insert into public.claims (kind, item_id, contributor_id, expires_at)
    values ('instruction', v_item_id, v_uid, v_expires);

    return query
      select i.id, i.english, i.source, i.target_count, v_expires
      from public.instruction_items i
      where i.id = v_item_id;
  else
    select i.id
    into v_item_id
    from public.conversation_items i
    where i.status = 'open'
      and not exists (
        select 1
        from public.conversation_translations t
        where t.item_id = i.id
          and t.contributor_id = v_uid
      )
      and (
        select count(*)
        from public.claims c
        where c.kind = 'conversation'
          and c.item_id = i.id
          and c.expires_at > now()
      ) < i.target_count
    order by i.created_at, i.id
    for update skip locked
    limit 1;

    if v_item_id is null then
      return;
    end if;

    insert into public.claims (kind, item_id, contributor_id, expires_at)
    values ('conversation', v_item_id, v_uid, v_expires);

    return query
      select i.id, i.english, i.source, i.target_count, v_expires
      from public.conversation_items i
      where i.id = v_item_id;
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. Indexes
-- ----------------------------------------------------------------------------
create index if not exists instruction_items_status_idx
  on public.instruction_items (status, created_at);
create index if not exists conversation_items_status_idx
  on public.conversation_items (status, created_at);

create index if not exists instruction_translations_item_idx
  on public.instruction_translations (item_id);
create index if not exists instruction_translations_contributor_idx
  on public.instruction_translations (contributor_id);
create index if not exists instruction_translations_status_idx
  on public.instruction_translations (status);
create index if not exists instruction_translations_export_idx
  on public.instruction_translations (exported_at)
  where exported_at is null and status = 'approved';

create index if not exists conversation_translations_item_idx
  on public.conversation_translations (item_id);
create index if not exists conversation_translations_contributor_idx
  on public.conversation_translations (contributor_id);
create index if not exists conversation_translations_status_idx
  on public.conversation_translations (status);

create index if not exists text_submissions_contributor_idx
  on public.text_submissions (contributor_id);
create index if not exists text_submissions_status_idx
  on public.text_submissions (status, created_at);

create index if not exists ocr_pages_contributor_idx
  on public.ocr_pages (contributor_id, created_at);
create index if not exists ocr_lines_status_idx
  on public.ocr_lines (status);
create index if not exists ocr_lines_pending_sync_idx
  on public.ocr_lines (exported_at)
  where exported_at is null and purged_at is null;

create index if not exists claims_lookup_idx
  on public.claims (kind, item_id, expires_at);
create index if not exists claims_contributor_idx
  on public.claims (contributor_id, expires_at);

create index if not exists report_issues_item_idx
  on public.report_issues (kind, item_id);
create index if not exists report_issues_contributor_idx
  on public.report_issues (contributor_id, created_at);


-- ----------------------------------------------------------------------------
-- 9. Row level security
--    contributors: insert and read only their own rows
--    reviewers and admins: read everything, update the review fields
--    admins: manage the imported item tables
--    item tables: no direct select for contributors; claim_next serves them
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.instruction_items enable row level security;
alter table public.instruction_translations enable row level security;
alter table public.conversation_items enable row level security;
alter table public.conversation_translations enable row level security;
alter table public.text_submissions enable row level security;
alter table public.ocr_pages enable row level security;
alter table public.ocr_lines enable row level security;
alter table public.claims enable row level security;
alter table public.report_issues enable row level security;

-- profiles
drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "profiles: staff read all" on public.profiles;
create policy "profiles: staff read all" on public.profiles
  for select to authenticated
  using ((select public.is_reviewer()));

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "profiles: admin update all" on public.profiles;
create policy "profiles: admin update all" on public.profiles
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- instruction_items / conversation_items
drop policy if exists "instruction_items: staff read" on public.instruction_items;
create policy "instruction_items: staff read" on public.instruction_items
  for select to authenticated
  using ((select public.is_reviewer()));

drop policy if exists "instruction_items: admin write" on public.instruction_items;
create policy "instruction_items: admin write" on public.instruction_items
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "conversation_items: staff read" on public.conversation_items;
create policy "conversation_items: staff read" on public.conversation_items
  for select to authenticated
  using ((select public.is_reviewer()));

drop policy if exists "conversation_items: admin write" on public.conversation_items;
create policy "conversation_items: admin write" on public.conversation_items
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- instruction_translations
drop policy if exists "instruction_translations: insert own" on public.instruction_translations;
create policy "instruction_translations: insert own" on public.instruction_translations
  for insert to authenticated
  with check (contributor_id = (select auth.uid()));

drop policy if exists "instruction_translations: read own" on public.instruction_translations;
create policy "instruction_translations: read own" on public.instruction_translations
  for select to authenticated
  using (contributor_id = (select auth.uid()));

drop policy if exists "instruction_translations: staff read" on public.instruction_translations;
create policy "instruction_translations: staff read" on public.instruction_translations
  for select to authenticated
  using ((select public.is_reviewer()));

drop policy if exists "instruction_translations: update own draft" on public.instruction_translations;
create policy "instruction_translations: update own draft" on public.instruction_translations
  for update to authenticated
  using (
    contributor_id = (select auth.uid())
    and status in ('draft', 'rejected')
  )
  with check (
    contributor_id = (select auth.uid())
    and status in ('draft', 'submitted', 'rejected')
    and reviewer_id is null
  );

drop policy if exists "instruction_translations: delete own draft" on public.instruction_translations;
create policy "instruction_translations: delete own draft" on public.instruction_translations
  for delete to authenticated
  using (
    contributor_id = (select auth.uid())
    and status in ('draft', 'rejected')
  );

drop policy if exists "instruction_translations: staff review" on public.instruction_translations;
create policy "instruction_translations: staff review" on public.instruction_translations
  for update to authenticated
  using ((select public.is_reviewer()))
  with check ((select public.is_reviewer()));

-- conversation_translations
drop policy if exists "conversation_translations: insert own" on public.conversation_translations;
create policy "conversation_translations: insert own" on public.conversation_translations
  for insert to authenticated
  with check (contributor_id = (select auth.uid()));

drop policy if exists "conversation_translations: read own" on public.conversation_translations;
create policy "conversation_translations: read own" on public.conversation_translations
  for select to authenticated
  using (contributor_id = (select auth.uid()));

drop policy if exists "conversation_translations: staff read" on public.conversation_translations;
create policy "conversation_translations: staff read" on public.conversation_translations
  for select to authenticated
  using ((select public.is_reviewer()));

drop policy if exists "conversation_translations: update own draft" on public.conversation_translations;
create policy "conversation_translations: update own draft" on public.conversation_translations
  for update to authenticated
  using (
    contributor_id = (select auth.uid())
    and status in ('draft', 'rejected')
  )
  with check (
    contributor_id = (select auth.uid())
    and status in ('draft', 'submitted', 'rejected')
    and reviewer_id is null
  );

drop policy if exists "conversation_translations: delete own draft" on public.conversation_translations;
create policy "conversation_translations: delete own draft" on public.conversation_translations
  for delete to authenticated
  using (
    contributor_id = (select auth.uid())
    and status in ('draft', 'rejected')
  );

drop policy if exists "conversation_translations: staff review" on public.conversation_translations;
create policy "conversation_translations: staff review" on public.conversation_translations
  for update to authenticated
  using ((select public.is_reviewer()))
  with check ((select public.is_reviewer()));

-- text_submissions
drop policy if exists "text_submissions: insert own" on public.text_submissions;
create policy "text_submissions: insert own" on public.text_submissions
  for insert to authenticated
  with check (contributor_id = (select auth.uid()) and rights_confirmed);

drop policy if exists "text_submissions: read own" on public.text_submissions;
create policy "text_submissions: read own" on public.text_submissions
  for select to authenticated
  using (contributor_id = (select auth.uid()));

drop policy if exists "text_submissions: staff read" on public.text_submissions;
create policy "text_submissions: staff read" on public.text_submissions
  for select to authenticated
  using ((select public.is_reviewer()));

drop policy if exists "text_submissions: update own draft" on public.text_submissions;
create policy "text_submissions: update own draft" on public.text_submissions
  for update to authenticated
  using (
    contributor_id = (select auth.uid())
    and status in ('draft', 'rejected')
  )
  with check (
    contributor_id = (select auth.uid())
    and status in ('draft', 'submitted', 'rejected')
    and reviewer_id is null
  );

drop policy if exists "text_submissions: delete own draft" on public.text_submissions;
create policy "text_submissions: delete own draft" on public.text_submissions
  for delete to authenticated
  using (
    contributor_id = (select auth.uid())
    and status in ('draft', 'rejected')
  );

drop policy if exists "text_submissions: staff review" on public.text_submissions;
create policy "text_submissions: staff review" on public.text_submissions
  for update to authenticated
  using ((select public.is_reviewer()))
  with check ((select public.is_reviewer()));

-- ocr_pages
drop policy if exists "ocr_pages: insert own" on public.ocr_pages;
create policy "ocr_pages: insert own" on public.ocr_pages
  for insert to authenticated
  with check (contributor_id = (select auth.uid()) and rights_confirmed);

drop policy if exists "ocr_pages: read own" on public.ocr_pages;
create policy "ocr_pages: read own" on public.ocr_pages
  for select to authenticated
  using (contributor_id = (select auth.uid()));

drop policy if exists "ocr_pages: staff read" on public.ocr_pages;
create policy "ocr_pages: staff read" on public.ocr_pages
  for select to authenticated
  using ((select public.is_reviewer()));

drop policy if exists "ocr_pages: update own" on public.ocr_pages;
create policy "ocr_pages: update own" on public.ocr_pages
  for update to authenticated
  using (contributor_id = (select auth.uid()))
  with check (contributor_id = (select auth.uid()));

drop policy if exists "ocr_pages: delete own" on public.ocr_pages;
create policy "ocr_pages: delete own" on public.ocr_pages
  for delete to authenticated
  using (contributor_id = (select auth.uid()));

drop policy if exists "ocr_pages: staff review" on public.ocr_pages;
create policy "ocr_pages: staff review" on public.ocr_pages
  for update to authenticated
  using ((select public.is_reviewer()))
  with check ((select public.is_reviewer()));

-- ocr_lines
drop policy if exists "ocr_lines: insert own" on public.ocr_lines;
create policy "ocr_lines: insert own" on public.ocr_lines
  for insert to authenticated
  with check (
    exists (
      select 1 from public.ocr_pages p
      where p.id = page_id and p.contributor_id = (select auth.uid())
    )
  );

drop policy if exists "ocr_lines: read own" on public.ocr_lines;
create policy "ocr_lines: read own" on public.ocr_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.ocr_pages p
      where p.id = page_id and p.contributor_id = (select auth.uid())
    )
  );

drop policy if exists "ocr_lines: staff read" on public.ocr_lines;
create policy "ocr_lines: staff read" on public.ocr_lines
  for select to authenticated
  using ((select public.is_reviewer()));

drop policy if exists "ocr_lines: update own" on public.ocr_lines;
create policy "ocr_lines: update own" on public.ocr_lines
  for update to authenticated
  using (
    exists (
      select 1 from public.ocr_pages p
      where p.id = page_id and p.contributor_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.ocr_pages p
      where p.id = page_id and p.contributor_id = (select auth.uid())
    )
  );

drop policy if exists "ocr_lines: delete own" on public.ocr_lines;
create policy "ocr_lines: delete own" on public.ocr_lines
  for delete to authenticated
  using (
    exists (
      select 1 from public.ocr_pages p
      where p.id = page_id and p.contributor_id = (select auth.uid())
    )
  );

drop policy if exists "ocr_lines: staff review" on public.ocr_lines;
create policy "ocr_lines: staff review" on public.ocr_lines
  for update to authenticated
  using ((select public.is_reviewer()))
  with check ((select public.is_reviewer()));

-- claims
drop policy if exists "claims: read own" on public.claims;
create policy "claims: read own" on public.claims
  for select to authenticated
  using (contributor_id = (select auth.uid()));

drop policy if exists "claims: release own" on public.claims;
create policy "claims: release own" on public.claims
  for delete to authenticated
  using (contributor_id = (select auth.uid()));

drop policy if exists "claims: staff read" on public.claims;
create policy "claims: staff read" on public.claims
  for select to authenticated
  using ((select public.is_reviewer()));

-- report_issues
drop policy if exists "report_issues: insert own" on public.report_issues;
create policy "report_issues: insert own" on public.report_issues
  for insert to authenticated
  with check (contributor_id = (select auth.uid()));

drop policy if exists "report_issues: read own" on public.report_issues;
create policy "report_issues: read own" on public.report_issues
  for select to authenticated
  using (contributor_id = (select auth.uid()));

drop policy if exists "report_issues: staff read" on public.report_issues;
create policy "report_issues: staff read" on public.report_issues
  for select to authenticated
  using ((select public.is_reviewer()));

drop policy if exists "report_issues: admin delete" on public.report_issues;
create policy "report_issues: admin delete" on public.report_issues
  for delete to authenticated
  using ((select public.is_admin()));


-- ----------------------------------------------------------------------------
-- 10. Storage: private ocr-lines bucket
--     Layout: ocr-lines/<contributor uuid>/<page uuid>/line_<idx>.webp
--     Contributors write only under their own user id prefix; reviewers read
--     through signed URLs. The service role (local scripts) bypasses RLS.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('ocr-lines', 'ocr-lines', false)
on conflict (id) do nothing;

drop policy if exists "ocr-lines: read own prefix" on storage.objects;
create policy "ocr-lines: read own prefix" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ocr-lines'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "ocr-lines: staff read" on storage.objects;
create policy "ocr-lines: staff read" on storage.objects
  for select to authenticated
  using (bucket_id = 'ocr-lines' and (select public.is_reviewer()));

drop policy if exists "ocr-lines: insert own prefix" on storage.objects;
create policy "ocr-lines: insert own prefix" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ocr-lines'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "ocr-lines: update own prefix" on storage.objects;
create policy "ocr-lines: update own prefix" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'ocr-lines'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'ocr-lines'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "ocr-lines: delete own prefix" on storage.objects;
create policy "ocr-lines: delete own prefix" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ocr-lines'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );


-- ----------------------------------------------------------------------------
-- 11. Grants. RLS is the gate; the authenticated role still needs table
--     privileges. The service role keeps full access for local scripts.
-- ----------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on function public.claim_next(text) to authenticated;
grant execute on function public.actor_role() to authenticated;
grant execute on function public.is_reviewer() to authenticated;
grant execute on function public.is_admin() to authenticated;
