-- ============================================================================
-- NeuraFlix Labeler: review queues, roles and admin (Phase L5)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again: columns use IF NOT EXISTS, functions use
--      CREATE OR REPLACE, and the review_log policy is dropped first.
--   4. Nothing in this repo runs it for you. Do not edit 0001 to 0006.
--
-- What this file changes
--   - reviewed_at, reviewer_edited and original_content on the three
--     translation/submission tables, reviewed_at on ocr_pages, and
--     reviewer_edited and original_label on ocr_lines.
--   - ocr_lines status becomes submitted, approved or rejected.
--   - review_log with staff-only reads and no direct writes.
--   - app_settings.allow_self_review, seeded false.
--   - recompute_item_status, review_next, review_counts, the four review
--     functions, my_feedback and the three admin functions.
--   - Grants: authenticated only, and the internal helper stays internal.
--
-- Rules used by every function here
--   - security definer, set search_path = public
--   - p_ parameters, every column qualified through a table alias
--   - output columns carry the out_ prefix so they cannot shadow a column
--   - reviewer and admin functions read profiles for auth.uid() themselves
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Review columns
-- ----------------------------------------------------------------------------
alter table public.instruction_translations
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewer_edited boolean not null default false,
  add column if not exists original_content jsonb;

alter table public.conversation_translations
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewer_edited boolean not null default false,
  add column if not exists original_content jsonb;

alter table public.text_submissions
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewer_edited boolean not null default false,
  add column if not exists original_content jsonb;

alter table public.ocr_pages
  add column if not exists reviewed_at timestamptz;

alter table public.ocr_lines
  add column if not exists reviewer_edited boolean not null default false,
  add column if not exists original_label text;

-- 0001 allowed a draft line and 0006 only ever inserted submitted lines.
-- A leftover draft is treated as submitted so the new check can be applied.
update public.ocr_lines l
   set status = 'submitted'
 where l.status = 'draft';

alter table public.ocr_lines
  drop constraint if exists ocr_lines_status_check;
alter table public.ocr_lines
  add constraint ocr_lines_status_check
  check (status in ('submitted', 'approved', 'rejected'));

alter table public.ocr_lines
  alter column status set default 'submitted';

create index if not exists instruction_translations_review_queue_idx
  on public.instruction_translations (status, submitted_at, created_at);
create index if not exists conversation_translations_review_queue_idx
  on public.conversation_translations (status, submitted_at, created_at);
create index if not exists text_submissions_review_queue_idx
  on public.text_submissions (status, created_at);
create index if not exists ocr_pages_review_queue_idx
  on public.ocr_pages (status, created_at);


-- ----------------------------------------------------------------------------
-- 2. review_log: one row per decision. Written only by the functions below.
-- ----------------------------------------------------------------------------
create table if not exists public.review_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('instruction', 'conversation', 'text', 'ocr')),
  item_id uuid not null,
  reviewer_id uuid not null references public.profiles (id) on delete cascade,
  decision text not null check (decision in ('approve', 'reject')),
  note text,
  created_at timestamptz not null default now()
);

comment on table public.review_log is
  'Append-only review decisions. Contributors never read this table; staff read it through RLS.';

create index if not exists review_log_reviewer_idx
  on public.review_log (reviewer_id, created_at desc);
create index if not exists review_log_item_idx
  on public.review_log (kind, item_id);

alter table public.review_log enable row level security;

drop policy if exists "review_log: staff read" on public.review_log;
create policy "review_log: staff read" on public.review_log
  for select to authenticated
  using ((select public.is_reviewer()));

-- No insert, update or delete policy. The security definer functions are the
-- only writers. Direct table writes are revoked in section 11.


-- ----------------------------------------------------------------------------
-- 3. app_settings: self review for testing. The existing RLS still exposes
--    only ocr_quota_mb to normal users; the functions read this key directly.
-- ----------------------------------------------------------------------------
insert into public.app_settings (key, value)
values ('allow_self_review', 'false')
on conflict (key) do nothing;


-- ----------------------------------------------------------------------------
-- 4. recompute_item_status: complete when approved plus submitted translations
--    reach target_count, open otherwise. Retired items are never touched.
--    Internal: no execute grant to authenticated.
-- ----------------------------------------------------------------------------
create or replace function public.recompute_item_status(
  p_kind text,
  p_item_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_target_count integer;
  v_done integer;
begin
  if p_item_id is null then
    return;
  end if;

  if p_kind = 'instruction' then
    select i.status, i.target_count
      into v_status, v_target_count
      from public.instruction_items i
     where i.id = p_item_id
       for update;

    if v_status is null or v_status = 'retired' then
      return;
    end if;

    select count(*)::integer
      into v_done
      from public.instruction_translations t
     where t.item_id = p_item_id
       and t.status in ('submitted', 'approved');

    update public.instruction_items i
       set status = case
                      when v_done >= v_target_count then 'complete'
                      else 'open'
                    end
     where i.id = p_item_id
       and i.status <> 'retired';
  elsif p_kind = 'conversation' then
    select i.status, i.target_count
      into v_status, v_target_count
      from public.conversation_items i
     where i.id = p_item_id
       for update;

    if v_status is null or v_status = 'retired' then
      return;
    end if;

    select count(*)::integer
      into v_done
      from public.conversation_translations t
     where t.item_id = p_item_id
       and t.status in ('submitted', 'approved');

    update public.conversation_items i
       set status = case
                      when v_done >= v_target_count then 'complete'
                      else 'open'
                    end
     where i.id = p_item_id
       and i.status <> 'retired';
  else
    raise exception 'REVIEW_UNKNOWN_KIND';
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5. review_next(p_kind): the oldest submitted row the caller can review.
-- ----------------------------------------------------------------------------
create or replace function public.review_next(p_kind text)
returns table (
  out_kind text,
  out_id uuid,
  out_english jsonb,
  out_source text,
  out_created_at timestamptz,
  out_submitted_at timestamptz,
  out_khowar_instruction text,
  out_khowar_input text,
  out_khowar_response text,
  out_turns jsonb,
  out_title text,
  out_khowar_text text,
  out_source_note text,
  out_page_label text,
  out_line_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_role text;
  v_allow_self boolean := false;
begin
  if v_uid is null then
    raise exception 'REVIEW_AUTH_REQUIRED';
  end if;

  select p.role
    into v_actor_role
    from public.profiles p
   where p.id = v_uid;

  if v_actor_role is null or v_actor_role not in ('reviewer', 'admin') then
    raise exception 'REVIEW_FORBIDDEN';
  end if;

  select coalesce(lower(s.value) = 'true', false)
    into v_allow_self
    from public.app_settings s
   where s.key = 'allow_self_review';

  v_allow_self := coalesce(v_allow_self, false);

  if p_kind = 'instruction' then
    return query
      select
        'instruction'::text as out_kind,
        t.id as out_id,
        i.english as out_english,
        i.source as out_source,
        t.created_at as out_created_at,
        t.submitted_at as out_submitted_at,
        t.khowar_instruction as out_khowar_instruction,
        t.khowar_input as out_khowar_input,
        t.khowar_response as out_khowar_response,
        null::jsonb as out_turns,
        null::text as out_title,
        null::text as out_khowar_text,
        null::text as out_source_note,
        null::text as out_page_label,
        null::integer as out_line_count
      from public.instruction_translations t
      join public.instruction_items i on i.id = t.item_id
     where t.status = 'submitted'
       and (v_allow_self or t.contributor_id <> v_uid)
     order by coalesce(t.submitted_at, t.created_at), t.created_at, t.id
     limit 1;
  elsif p_kind = 'conversation' then
    return query
      select
        'conversation'::text as out_kind,
        t.id as out_id,
        i.english as out_english,
        i.source as out_source,
        t.created_at as out_created_at,
        t.submitted_at as out_submitted_at,
        null::text as out_khowar_instruction,
        null::text as out_khowar_input,
        null::text as out_khowar_response,
        t.turns as out_turns,
        null::text as out_title,
        null::text as out_khowar_text,
        null::text as out_source_note,
        null::text as out_page_label,
        null::integer as out_line_count
      from public.conversation_translations t
      join public.conversation_items i on i.id = t.item_id
     where t.status = 'submitted'
       and (v_allow_self or t.contributor_id <> v_uid)
     order by coalesce(t.submitted_at, t.created_at), t.created_at, t.id
     limit 1;
  elsif p_kind = 'text' then
    return query
      select
        'text'::text as out_kind,
        t.id as out_id,
        null::jsonb as out_english,
        null::text as out_source,
        t.created_at as out_created_at,
        null::timestamptz as out_submitted_at,
        null::text as out_khowar_instruction,
        null::text as out_khowar_input,
        null::text as out_khowar_response,
        null::jsonb as out_turns,
        t.title as out_title,
        t.khowar_text as out_khowar_text,
        t.source_note as out_source_note,
        null::text as out_page_label,
        null::integer as out_line_count
      from public.text_submissions t
     where t.status = 'submitted'
       and (v_allow_self or t.contributor_id <> v_uid)
     order by t.created_at, t.id
     limit 1;
  elsif p_kind = 'ocr' then
    return query
      select
        'ocr'::text as out_kind,
        p.id as out_id,
        null::jsonb as out_english,
        null::text as out_source,
        p.created_at as out_created_at,
        null::timestamptz as out_submitted_at,
        null::text as out_khowar_instruction,
        null::text as out_khowar_input,
        null::text as out_khowar_response,
        null::jsonb as out_turns,
        null::text as out_title,
        null::text as out_khowar_text,
        null::text as out_source_note,
        p.label as out_page_label,
        p.line_count as out_line_count
      from public.ocr_pages p
     where p.status = 'submitted'
       and (v_allow_self or p.contributor_id <> v_uid)
     order by p.created_at, p.id
     limit 1;
  else
    raise exception 'REVIEW_UNKNOWN_KIND';
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 6. review_counts: submitted rows per kind, with the self review setting so
--    the page can show its notice without reading app_settings directly.
-- ----------------------------------------------------------------------------
create or replace function public.review_counts()
returns table (
  out_kind text,
  out_submitted bigint,
  out_allow_self_review boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_role text;
  v_allow_self boolean := false;
begin
  if v_uid is null then
    raise exception 'REVIEW_AUTH_REQUIRED';
  end if;

  select p.role
    into v_actor_role
    from public.profiles p
   where p.id = v_uid;

  if v_actor_role is null or v_actor_role not in ('reviewer', 'admin') then
    raise exception 'REVIEW_FORBIDDEN';
  end if;

  select coalesce(lower(s.value) = 'true', false)
    into v_allow_self
    from public.app_settings s
   where s.key = 'allow_self_review';

  v_allow_self := coalesce(v_allow_self, false);

  return query
    select 'instruction'::text as out_kind,
           count(t.id)::bigint as out_submitted,
           v_allow_self as out_allow_self_review
      from public.instruction_translations t
     where t.status = 'submitted'
       and (v_allow_self or t.contributor_id <> v_uid)
    union all
    select 'conversation'::text,
           count(t.id)::bigint,
           v_allow_self
      from public.conversation_translations t
     where t.status = 'submitted'
       and (v_allow_self or t.contributor_id <> v_uid)
    union all
    select 'text'::text,
           count(t.id)::bigint,
           v_allow_self
      from public.text_submissions t
     where t.status = 'submitted'
       and (v_allow_self or t.contributor_id <> v_uid)
    union all
    select 'ocr'::text,
           count(p.id)::bigint,
           v_allow_self
      from public.ocr_pages p
     where p.status = 'submitted'
       and (v_allow_self or p.contributor_id <> v_uid);
end;
$$;


-- ----------------------------------------------------------------------------
-- 7. review_instruction
-- ----------------------------------------------------------------------------
create or replace function public.review_instruction(
  p_translation_id uuid,
  p_decision text,
  p_instruction text,
  p_input text,
  p_response text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_role text;
  v_status text;
  v_contributor_id uuid;
  v_item_id uuid;
  v_old_instruction text;
  v_old_input text;
  v_old_response text;
  v_note text;
  v_new_input text;
  v_changed boolean := false;
  v_allow_self boolean := false;
begin
  if v_uid is null then
    raise exception 'REVIEW_AUTH_REQUIRED';
  end if;

  select p.role
    into v_actor_role
    from public.profiles p
   where p.id = v_uid;

  if v_actor_role is null or v_actor_role not in ('reviewer', 'admin') then
    raise exception 'REVIEW_FORBIDDEN';
  end if;

  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'REVIEW_INVALID_DECISION';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if p_decision = 'reject' and (v_note is null or char_length(v_note) < 3) then
    raise exception 'REVIEW_NOTE_REQUIRED';
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'REVIEW_INVALID_NOTE';
  end if;

  select coalesce(lower(s.value) = 'true', false)
    into v_allow_self
    from public.app_settings s
   where s.key = 'allow_self_review';
  v_allow_self := coalesce(v_allow_self, false);

  select t.status,
         t.contributor_id,
         t.item_id,
         t.khowar_instruction,
         t.khowar_input,
         t.khowar_response
    into v_status,
         v_contributor_id,
         v_item_id,
         v_old_instruction,
         v_old_input,
         v_old_response
    from public.instruction_translations t
   where t.id = p_translation_id
     for update;

  if v_status is null then
    raise exception 'REVIEW_NOT_FOUND';
  end if;
  if v_status <> 'submitted' then
    raise exception 'ALREADY_REVIEWED';
  end if;
  if v_contributor_id = v_uid and not v_allow_self then
    raise exception 'SELF_REVIEW';
  end if;

  if p_decision = 'approve' then
    if p_instruction is null or btrim(p_instruction) = ''
       or p_response is null or btrim(p_response) = '' then
      raise exception 'REVIEW_INVALID_CONTENT';
    end if;
    if char_length(p_instruction) > 20000
       or char_length(p_response) > 20000
       or (p_input is not null and char_length(p_input) > 20000) then
      raise exception 'REVIEW_INVALID_CONTENT';
    end if;

    v_new_input := case
                     when p_input is null or btrim(p_input) = '' then null
                     else p_input
                   end;

    v_changed := (p_instruction is distinct from v_old_instruction)
      or (v_new_input is distinct from v_old_input)
      or (p_response is distinct from v_old_response);

    update public.instruction_translations t
       set khowar_instruction = p_instruction,
           khowar_input = v_new_input,
           khowar_response = p_response,
           original_content = case
                                when v_changed and t.original_content is null
                                then jsonb_build_object(
                                  'khowar_instruction', v_old_instruction,
                                  'khowar_input', v_old_input,
                                  'khowar_response', v_old_response
                                )
                                else t.original_content
                              end,
           reviewer_edited = t.reviewer_edited or v_changed,
           status = 'approved',
           reviewer_id = v_uid,
           reviewed_at = now(),
           review_note = v_note
     where t.id = p_translation_id;
  else
    update public.instruction_translations t
       set status = 'rejected',
           reviewer_id = v_uid,
           reviewed_at = now(),
           review_note = v_note
     where t.id = p_translation_id;
  end if;

  insert into public.review_log (kind, item_id, reviewer_id, decision, note)
  values ('instruction', p_translation_id, v_uid, p_decision, v_note);

  perform public.recompute_item_status('instruction', v_item_id);
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. review_conversation
-- ----------------------------------------------------------------------------
create or replace function public.review_conversation(
  p_translation_id uuid,
  p_decision text,
  p_turns jsonb,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_role text;
  v_status text;
  v_contributor_id uuid;
  v_item_id uuid;
  v_note text;
  v_old_turns jsonb;
  v_english_turns jsonb;
  v_new_turns jsonb;
  v_expected integer;
  v_given integer;
  v_index integer;
  v_content text;
  v_changed boolean := false;
  v_allow_self boolean := false;
begin
  if v_uid is null then
    raise exception 'REVIEW_AUTH_REQUIRED';
  end if;

  select p.role
    into v_actor_role
    from public.profiles p
   where p.id = v_uid;

  if v_actor_role is null or v_actor_role not in ('reviewer', 'admin') then
    raise exception 'REVIEW_FORBIDDEN';
  end if;

  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'REVIEW_INVALID_DECISION';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if p_decision = 'reject' and (v_note is null or char_length(v_note) < 3) then
    raise exception 'REVIEW_NOTE_REQUIRED';
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'REVIEW_INVALID_NOTE';
  end if;

  select coalesce(lower(s.value) = 'true', false)
    into v_allow_self
    from public.app_settings s
   where s.key = 'allow_self_review';
  v_allow_self := coalesce(v_allow_self, false);

  select t.status, t.contributor_id, t.item_id, t.turns
    into v_status, v_contributor_id, v_item_id, v_old_turns
    from public.conversation_translations t
   where t.id = p_translation_id
     for update;

  if v_status is null then
    raise exception 'REVIEW_NOT_FOUND';
  end if;
  if v_status <> 'submitted' then
    raise exception 'ALREADY_REVIEWED';
  end if;
  if v_contributor_id = v_uid and not v_allow_self then
    raise exception 'SELF_REVIEW';
  end if;

  if p_decision = 'approve' then
    select i.english -> 'turns'
      into v_english_turns
      from public.conversation_items i
     where i.id = v_item_id;

    if v_english_turns is null or jsonb_typeof(v_english_turns) <> 'array' then
      raise exception 'REVIEW_INVALID_CONTENT';
    end if;

    if p_turns is null or jsonb_typeof(p_turns) <> 'array' then
      raise exception 'REVIEW_INVALID_TURNS';
    end if;

    v_expected := jsonb_array_length(v_english_turns);
    v_given := jsonb_array_length(p_turns);

    if v_expected = 0 or v_given <> v_expected then
      raise exception 'REVIEW_INVALID_TURNS';
    end if;

    for v_index in 0 .. v_expected - 1 loop
      if (p_turns -> v_index ->> 'role') is distinct from
         (v_english_turns -> v_index ->> 'role') then
        raise exception 'REVIEW_INVALID_TURNS';
      end if;

      v_content := p_turns -> v_index ->> 'content';
      if v_content is null or btrim(v_content) = '' then
        raise exception 'REVIEW_INVALID_TURNS';
      end if;
      if char_length(v_content) > 4000 then
        raise exception 'REVIEW_INVALID_TURNS';
      end if;
    end loop;

    select jsonb_agg(
             jsonb_build_object(
               'role', e.turn ->> 'role',
               'content', e.turn ->> 'content'
             )
             order by e.ord
           )
      into v_new_turns
      from jsonb_array_elements(p_turns) with ordinality as e(turn, ord);

    v_changed := v_new_turns is distinct from v_old_turns;

    update public.conversation_translations t
       set turns = v_new_turns,
           original_content = case
                                when v_changed and t.original_content is null
                                then v_old_turns
                                else t.original_content
                              end,
           reviewer_edited = t.reviewer_edited or v_changed,
           status = 'approved',
           reviewer_id = v_uid,
           reviewed_at = now(),
           review_note = v_note
     where t.id = p_translation_id;
  else
    update public.conversation_translations t
       set status = 'rejected',
           reviewer_id = v_uid,
           reviewed_at = now(),
           review_note = v_note
     where t.id = p_translation_id;
  end if;

  insert into public.review_log (kind, item_id, reviewer_id, decision, note)
  values ('conversation', p_translation_id, v_uid, p_decision, v_note);

  perform public.recompute_item_status('conversation', v_item_id);
end;
$$;


-- ----------------------------------------------------------------------------
-- 9. review_text
-- ----------------------------------------------------------------------------
create or replace function public.review_text(
  p_submission_id uuid,
  p_decision text,
  p_text text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_role text;
  v_status text;
  v_contributor_id uuid;
  v_old_text text;
  v_note text;
  v_hash text;
  v_changed boolean := false;
  v_allow_self boolean := false;
begin
  if v_uid is null then
    raise exception 'REVIEW_AUTH_REQUIRED';
  end if;

  select p.role
    into v_actor_role
    from public.profiles p
   where p.id = v_uid;

  if v_actor_role is null or v_actor_role not in ('reviewer', 'admin') then
    raise exception 'REVIEW_FORBIDDEN';
  end if;

  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'REVIEW_INVALID_DECISION';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if p_decision = 'reject' and (v_note is null or char_length(v_note) < 3) then
    raise exception 'REVIEW_NOTE_REQUIRED';
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'REVIEW_INVALID_NOTE';
  end if;

  select coalesce(lower(s.value) = 'true', false)
    into v_allow_self
    from public.app_settings s
   where s.key = 'allow_self_review';
  v_allow_self := coalesce(v_allow_self, false);

  select t.status, t.contributor_id, t.khowar_text
    into v_status, v_contributor_id, v_old_text
    from public.text_submissions t
   where t.id = p_submission_id
     for update;

  if v_status is null then
    raise exception 'REVIEW_NOT_FOUND';
  end if;
  if v_status <> 'submitted' then
    raise exception 'ALREADY_REVIEWED';
  end if;
  if v_contributor_id = v_uid and not v_allow_self then
    raise exception 'SELF_REVIEW';
  end if;

  if p_decision = 'approve' then
    if p_text is null or char_length(p_text) < 20 or char_length(p_text) > 20000 then
      raise exception 'REVIEW_INVALID_CONTENT';
    end if;

    v_hash := encode(
      sha256(
        convert_to(
          btrim(
            regexp_replace(
              normalize(p_text, NFC),
              '[[:space:]]+',
              ' ',
              'g'
            )
          ),
          'UTF8'
        )
      ),
      'hex'
    );

    v_changed := p_text is distinct from v_old_text;

    begin
      update public.text_submissions t
         set khowar_text = p_text,
             text_hash = v_hash,
             original_content = case
                                  when v_changed and t.original_content is null
                                  then to_jsonb(v_old_text)
                                  else t.original_content
                                end,
             reviewer_edited = t.reviewer_edited or v_changed,
             status = 'approved',
             reviewer_id = v_uid,
             reviewed_at = now(),
             review_note = v_note
       where t.id = p_submission_id;
    exception when unique_violation then
      raise exception 'DUPLICATE_TEXT';
    end;
  else
    update public.text_submissions t
       set status = 'rejected',
           reviewer_id = v_uid,
           reviewed_at = now(),
           review_note = v_note
     where t.id = p_submission_id;
  end if;

  insert into public.review_log (kind, item_id, reviewer_id, decision, note)
  values ('text', p_submission_id, v_uid, p_decision, v_note);
end;
$$;


-- ----------------------------------------------------------------------------
-- 10. review_ocr_page
-- ----------------------------------------------------------------------------
create or replace function public.review_ocr_page(
  p_page_id uuid,
  p_decision text,
  p_note text,
  p_lines jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_role text;
  v_status text;
  v_contributor_id uuid;
  v_note text;
  v_allow_self boolean := false;
  v_line record;
  v_entry jsonb;
  v_new_label text;
  v_reject boolean;
  v_approved integer := 0;
begin
  if v_uid is null then
    raise exception 'REVIEW_AUTH_REQUIRED';
  end if;

  select p.role
    into v_actor_role
    from public.profiles p
   where p.id = v_uid;

  if v_actor_role is null or v_actor_role not in ('reviewer', 'admin') then
    raise exception 'REVIEW_FORBIDDEN';
  end if;

  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'REVIEW_INVALID_DECISION';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if p_decision = 'reject' and (v_note is null or char_length(v_note) < 3) then
    raise exception 'REVIEW_NOTE_REQUIRED';
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'REVIEW_INVALID_NOTE';
  end if;

  select coalesce(lower(s.value) = 'true', false)
    into v_allow_self
    from public.app_settings s
   where s.key = 'allow_self_review';
  v_allow_self := coalesce(v_allow_self, false);

  select p.status, p.contributor_id
    into v_status, v_contributor_id
    from public.ocr_pages p
   where p.id = p_page_id
     for update;

  if v_status is null then
    raise exception 'REVIEW_NOT_FOUND';
  end if;
  if v_status <> 'submitted' then
    raise exception 'ALREADY_REVIEWED';
  end if;
  if v_contributor_id = v_uid and not v_allow_self then
    raise exception 'SELF_REVIEW';
  end if;

  if p_decision = 'reject' then
    update public.ocr_lines l
       set status = 'rejected'
     where l.page_id = p_page_id;

    update public.ocr_pages p
       set status = 'rejected',
           reviewer_id = v_uid,
           reviewed_at = now(),
           review_note = v_note
     where p.id = p_page_id;
  else
    if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
      raise exception 'REVIEW_INVALID_LINES';
    end if;

    if exists (
      select 1
        from jsonb_array_elements(p_lines) e
       where jsonb_typeof(e.value) <> 'object'
          or e.value -> 'idx' is null
          or jsonb_typeof(e.value -> 'idx') <> 'number'
          or e.value -> 'reject' is null
          or jsonb_typeof(e.value -> 'reject') <> 'boolean'
          or e.value -> 'label' is null
          or jsonb_typeof(e.value -> 'label') <> 'string'
    ) then
      raise exception 'REVIEW_INVALID_LINES';
    end if;

    if exists (
      select 1
        from jsonb_array_elements(p_lines) e
       where (e.value ->> 'idx') !~ '^[0-9]+$'
          or (e.value ->> 'idx')::integer < 1
          or (e.value ->> 'idx')::integer > 40
    ) then
      raise exception 'REVIEW_INVALID_LINES';
    end if;

    if (
      select count(distinct (e.value ->> 'idx')::integer)
        from jsonb_array_elements(p_lines) e
    ) <> (
      select count(*)
        from jsonb_array_elements(p_lines) e
    ) then
      raise exception 'REVIEW_INVALID_LINES';
    end if;

    if exists (
      select 1
        from jsonb_array_elements(p_lines) e
       where not exists (
         select 1
           from public.ocr_lines l
          where l.page_id = p_page_id
            and l.idx = (e.value ->> 'idx')::integer
       )
    ) then
      raise exception 'REVIEW_INVALID_LINES';
    end if;

    for v_line in
      select l.id, l.idx, l.label, l.original_label
        from public.ocr_lines l
       where l.page_id = p_page_id
       order by l.idx
         for update
    loop
      v_entry := null;

      select e.value
        into v_entry
        from jsonb_array_elements(p_lines) e
       where (e.value ->> 'idx')::integer = v_line.idx
       limit 1;

      if v_entry is null then
        v_new_label := v_line.label;
        v_reject := false;
      else
        v_new_label := v_entry ->> 'label';
        v_reject := (v_entry ->> 'reject')::boolean;
      end if;

      if v_reject then
        update public.ocr_lines l
           set status = 'rejected'
         where l.id = v_line.id;
      else
        if v_new_label is null
           or btrim(v_new_label) = ''
           or char_length(btrim(v_new_label)) > 400 then
          raise exception 'REVIEW_INVALID_LABEL';
        end if;

        v_approved := v_approved + 1;

        if v_new_label is distinct from v_line.label then
          update public.ocr_lines l
             set label = v_new_label,
                 status = 'approved',
                 reviewer_edited = true,
                 original_label = coalesce(l.original_label, v_line.label)
           where l.id = v_line.id;
        else
          update public.ocr_lines l
             set status = 'approved'
           where l.id = v_line.id;
        end if;
      end if;
    end loop;

    if v_approved < 1 then
      raise exception 'REVIEW_EMPTY_PAGE';
    end if;

    update public.ocr_pages p
       set status = 'approved',
           reviewer_id = v_uid,
           reviewed_at = now(),
           review_note = v_note
     where p.id = p_page_id;
  end if;

  insert into public.review_log (kind, item_id, reviewer_id, decision, note)
  values ('ocr', p_page_id, v_uid, p_decision, v_note);
end;
$$;


-- ----------------------------------------------------------------------------
-- 11. Admin functions
-- ----------------------------------------------------------------------------
create or replace function public.admin_list_users()
returns table (
  out_user_id uuid,
  out_email text,
  out_display_name text,
  out_role text,
  out_consent_at timestamptz,
  out_created_at timestamptz,
  out_instruction_count bigint,
  out_conversation_count bigint,
  out_text_count bigint,
  out_ocr_page_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_role text;
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

  return query
    select
      p.id as out_user_id,
      u.email::text as out_email,
      p.display_name as out_display_name,
      p.role as out_role,
      p.consent_at as out_consent_at,
      p.created_at as out_created_at,
      (select count(*)
         from public.instruction_translations t
        where t.contributor_id = p.id)::bigint as out_instruction_count,
      (select count(*)
         from public.conversation_translations t
        where t.contributor_id = p.id)::bigint as out_conversation_count,
      (select count(*)
         from public.text_submissions t
        where t.contributor_id = p.id)::bigint as out_text_count,
      (select count(*)
         from public.ocr_pages pg
        where pg.contributor_id = p.id)::bigint as out_ocr_page_count
    from public.profiles p
    join auth.users u on u.id = p.id
   order by p.created_at desc, p.id;
end;
$$;


create or replace function public.admin_set_role(
  p_user_id uuid,
  p_role text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
  v_admin_count integer;
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

  if p_role is null or p_role not in ('contributor', 'reviewer', 'admin') then
    raise exception 'ADMIN_INVALID_ROLE';
  end if;

  if p_user_id is null then
    raise exception 'ADMIN_USER_NOT_FOUND';
  end if;

  if p_user_id = v_uid then
    raise exception 'SELF_ROLE';
  end if;

  select p.role
    into v_target_role
    from public.profiles p
   where p.id = p_user_id;

  if v_target_role is null then
    raise exception 'ADMIN_USER_NOT_FOUND';
  end if;

  if v_target_role = 'admin' and p_role <> 'admin' then
    select count(*)::integer
      into v_admin_count
      from public.profiles p
     where p.role = 'admin';

    if v_admin_count <= 1 then
      raise exception 'LAST_ADMIN';
    end if;
  end if;

  update public.profiles p
     set role = p_role
   where p.id = p_user_id;
end;
$$;


create or replace function public.admin_overview()
returns table (
  out_items jsonb,
  out_users jsonb,
  out_recent_contributors integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_role text;
  v_items jsonb;
  v_users jsonb;
  v_recent integer := 0;
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

  select jsonb_build_object(
    'instruction', jsonb_build_object(
      'draft', (select count(*) from public.instruction_translations t where t.status = 'draft'),
      'submitted', (select count(*) from public.instruction_translations t where t.status = 'submitted'),
      'approved', (select count(*) from public.instruction_translations t where t.status = 'approved'),
      'rejected', (select count(*) from public.instruction_translations t where t.status = 'rejected')
    ),
    'conversation', jsonb_build_object(
      'draft', (select count(*) from public.conversation_translations t where t.status = 'draft'),
      'submitted', (select count(*) from public.conversation_translations t where t.status = 'submitted'),
      'approved', (select count(*) from public.conversation_translations t where t.status = 'approved'),
      'rejected', (select count(*) from public.conversation_translations t where t.status = 'rejected')
    ),
    'text', jsonb_build_object(
      'submitted', (select count(*) from public.text_submissions t where t.status = 'submitted'),
      'approved', (select count(*) from public.text_submissions t where t.status = 'approved'),
      'rejected', (select count(*) from public.text_submissions t where t.status = 'rejected')
    ),
    'ocr_pages', jsonb_build_object(
      'uploading', (select count(*) from public.ocr_pages p where p.status = 'uploading'),
      'submitted', (select count(*) from public.ocr_pages p where p.status = 'submitted'),
      'approved', (select count(*) from public.ocr_pages p where p.status = 'approved'),
      'rejected', (select count(*) from public.ocr_pages p where p.status = 'rejected'),
      'failed', (select count(*) from public.ocr_pages p where p.status = 'failed')
    ),
    'ocr_lines', jsonb_build_object(
      'submitted', (select count(*) from public.ocr_lines l where l.status = 'submitted'),
      'approved', (select count(*) from public.ocr_lines l where l.status = 'approved'),
      'rejected', (select count(*) from public.ocr_lines l where l.status = 'rejected')
    )
  )
  into v_items;

  select jsonb_build_object(
    'contributor', (select count(*) from public.profiles p where p.role = 'contributor'),
    'reviewer', (select count(*) from public.profiles p where p.role = 'reviewer'),
    'admin', (select count(*) from public.profiles p where p.role = 'admin'),
    'total', (select count(*) from public.profiles p)
  )
  into v_users;

  select count(distinct s.contributor_id)::integer
    into v_recent
    from (
      select t.contributor_id
        from public.instruction_translations t
       where t.status in ('submitted', 'approved', 'rejected')
         and t.created_at >= now() - interval '30 days'
      union all
      select t.contributor_id
        from public.conversation_translations t
       where t.status in ('submitted', 'approved', 'rejected')
         and t.created_at >= now() - interval '30 days'
      union all
      select t.contributor_id
        from public.text_submissions t
       where t.status in ('submitted', 'approved', 'rejected')
         and t.created_at >= now() - interval '30 days'
      union all
      select p.contributor_id
        from public.ocr_pages p
       where p.status in ('submitted', 'approved', 'rejected')
         and p.created_at >= now() - interval '30 days'
    ) s;

  return query select v_items, v_users, coalesce(v_recent, 0);
end;
$$;


-- ----------------------------------------------------------------------------
-- 12. Contributor feedback: rejected or reviewer-edited contributions.
-- ----------------------------------------------------------------------------
create or replace function public.my_feedback(p_limit integer default 10)
returns table (
  out_kind text,
  out_id uuid,
  out_preview text,
  out_status text,
  out_reviewer_edited boolean,
  out_review_note text,
  out_reviewed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_limit integer;
begin
  if v_uid is null then
    raise exception 'FEEDBACK_AUTH_REQUIRED';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 10), 50));

  return query
    select 'instruction'::text as out_kind,
           t.id as out_id,
           left(t.khowar_instruction, 80) as out_preview,
           t.status as out_status,
           t.reviewer_edited as out_reviewer_edited,
           t.review_note as out_review_note,
           t.reviewed_at as out_reviewed_at
      from public.instruction_translations t
     where t.contributor_id = v_uid
       and t.reviewed_at is not null
       and (t.status = 'rejected' or t.reviewer_edited)
    union all
    select 'conversation'::text,
           t.id,
           left(coalesce(t.turns -> 0 ->> 'content', ''), 80),
           t.status,
           t.reviewer_edited,
           t.review_note,
           t.reviewed_at
      from public.conversation_translations t
     where t.contributor_id = v_uid
       and t.reviewed_at is not null
       and (t.status = 'rejected' or t.reviewer_edited)
    union all
    select 'text'::text,
           t.id,
           left(t.khowar_text, 80),
           t.status,
           t.reviewer_edited,
           t.review_note,
           t.reviewed_at
      from public.text_submissions t
     where t.contributor_id = v_uid
       and t.reviewed_at is not null
       and (t.status = 'rejected' or t.reviewer_edited)
    union all
    select 'ocr'::text,
           p.id,
           left(
             coalesce(
               p.label,
               (select l.label
                  from public.ocr_lines l
                 where l.page_id = p.id
                 order by l.idx
                 limit 1),
               'OCR page'
             ),
             80
           ),
           p.status,
           exists (
             select 1
               from public.ocr_lines l
              where l.page_id = p.id
                and l.reviewer_edited
           ),
           p.review_note,
           p.reviewed_at
      from public.ocr_pages p
     where p.contributor_id = v_uid
       and p.reviewed_at is not null
       and (
         p.status = 'rejected'
         or exists (
           select 1
             from public.ocr_lines l
            where l.page_id = p.id
              and l.reviewer_edited
         )
       )
     order by 7 desc, 2
     limit v_limit;
end;
$$;


-- ----------------------------------------------------------------------------
-- 13. Grants. RLS is the gate. Internal helpers are not executable by clients.
-- ----------------------------------------------------------------------------
revoke all on function public.recompute_item_status(text, uuid)
  from public, anon, authenticated;

revoke all on function public.review_next(text) from public, anon;
revoke all on function public.review_counts() from public, anon;
revoke all on function public.review_instruction(uuid, text, text, text, text, text) from public, anon;
revoke all on function public.review_conversation(uuid, text, jsonb, text) from public, anon;
revoke all on function public.review_text(uuid, text, text, text) from public, anon;
revoke all on function public.review_ocr_page(uuid, text, text, jsonb) from public, anon;
revoke all on function public.admin_list_users() from public, anon;
revoke all on function public.admin_set_role(uuid, text) from public, anon;
revoke all on function public.admin_overview() from public, anon;
revoke all on function public.my_feedback(integer) from public, anon;

grant execute on function public.review_next(text) to authenticated;
grant execute on function public.review_counts() to authenticated;
grant execute on function public.review_instruction(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.review_conversation(uuid, text, jsonb, text) to authenticated;
grant execute on function public.review_text(uuid, text, text, text) to authenticated;
grant execute on function public.review_ocr_page(uuid, text, text, jsonb) to authenticated;
grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.admin_set_role(uuid, text) to authenticated;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.my_feedback(integer) to authenticated;

revoke all on table public.review_log from public, anon, authenticated;
grant select on table public.review_log to authenticated;
