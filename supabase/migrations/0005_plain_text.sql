-- ============================================================================
-- NeuraFlix Labeler: plain text module (Phase L3)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again (guarded drops / IF NOT EXISTS).
--   4. Nothing in this repo runs it for you.
--
-- What this file changes
--   - text_submissions length and rights checks.
--   - An index for a contributor's own list, newest first.
--   - Re-issues the insert policy so a contributor can only insert their own
--     row, with rights confirmed, status submitted and no reviewer fields.
--
-- Checked, no change needed
--   - "text_submissions: read own" from 0001 already limits select to rows
--     where contributor_id = auth.uid().
--   - text_hash is already unique from 0001.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Checks, mirroring the shared schema in src/lib/khowar.ts
-- ----------------------------------------------------------------------------
alter table public.text_submissions
  drop constraint if exists text_submissions_khowar_text_length_check;
alter table public.text_submissions
  add constraint text_submissions_khowar_text_length_check
  check (char_length(khowar_text) between 20 and 20000);

alter table public.text_submissions
  drop constraint if exists text_submissions_rights_confirmed_check;
alter table public.text_submissions
  add constraint text_submissions_rights_confirmed_check
  check (rights_confirmed = true);

alter table public.text_submissions
  drop constraint if exists text_submissions_title_length_check;
alter table public.text_submissions
  add constraint text_submissions_title_length_check
  check (title is null or char_length(title) <= 120);

alter table public.text_submissions
  drop constraint if exists text_submissions_source_note_length_check;
alter table public.text_submissions
  add constraint text_submissions_source_note_length_check
  check (source_note is null or char_length(source_note) <= 300);


-- ----------------------------------------------------------------------------
-- 2. List index: one contributor, newest first
-- ----------------------------------------------------------------------------
create index if not exists text_submissions_contributor_created_idx
  on public.text_submissions (contributor_id, created_at desc);


-- ----------------------------------------------------------------------------
-- 3. Insert policy. 0001 already limited the row to the caller and a confirmed
--    rights checkbox. This re-issue also forces submitted status and empty
--    reviewer fields. A contributor cannot insert a draft, approved or
--    rejected row, and cannot name a reviewer.
-- ----------------------------------------------------------------------------
drop policy if exists "text_submissions: insert own" on public.text_submissions;
create policy "text_submissions: insert own" on public.text_submissions
  for insert to authenticated
  with check (
    contributor_id = (select auth.uid())
    and rights_confirmed = true
    and status = 'submitted'
    and reviewer_id is null
    and review_note is null
  );
