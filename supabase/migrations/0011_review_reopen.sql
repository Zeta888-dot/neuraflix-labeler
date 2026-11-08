-- ============================================================================
-- NeuraFlix Labeler: reject safeguard and admin OCR reopen (Phase L8a-ux)
-- ============================================================================
-- How to run
--   1. Open your Supabase project dashboard.
--   2. Go to SQL Editor, create a new query, paste this whole file, and Run.
--   3. It is safe to run again (guarded drops and CREATE OR REPLACE).
--   4. Nothing in this repo runs it for you.
--
-- What this file changes
--   - review_log.decision accepts a third value, 'reopen', so an undo is kept
--     in the same append-only audit trail as approve and reject.
--   - A reject must now carry at least five characters of note. The check is
--     NOT VALID so rows written before this migration stay untouched.
--   - admin_reopen_ocr_page(page id, note) returns a reviewed page and its
--     lines to the submitted queue. Admin only, security definer, explicit
--     search_path. It clears the reviewer fields, restores reviewer edited
--     labels to the labeler's original text, and logs 'reopen'.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. review_log: allow the reopen decision and tighten the reject note
-- ----------------------------------------------------------------------------
alter table public.review_log
  drop constraint if exists review_log_decision_check;
alter table public.review_log
  add constraint review_log_decision_check
  check (decision in ('approve', 'reject', 'reopen'));

alter table public.review_log
  drop constraint if exists review_log_reject_note_check;
alter table public.review_log
  add constraint review_log_reject_note_check
  check (
    decision <> 'reject'
    or (note is not null and char_length(btrim(note)) >= 5)
  ) not valid;

comment on column public.review_log.decision is
  'approve, reject or reopen. Reopen is an admin undo of an approved or rejected OCR page.';


-- ----------------------------------------------------------------------------
-- 2. admin_reopen_ocr_page: put a reviewed page back in the review queue
-- ----------------------------------------------------------------------------
create or replace function public.admin_reopen_ocr_page(
  p_page_id uuid,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_note text;
begin
  if v_uid is null then
    raise exception 'REVIEW_AUTH_REQUIRED';
  end if;

  if not public.is_admin() then
    raise exception 'REVIEW_FORBIDDEN';
  end if;

  if p_page_id is null then
    raise exception 'REVIEW_NOT_FOUND';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'REVIEW_INVALID_NOTE';
  end if;

  select p.status
    into v_status
    from public.ocr_pages p
   where p.id = p_page_id
     for update;

  if v_status is null then
    raise exception 'REVIEW_NOT_FOUND';
  end if;

  if v_status not in ('approved', 'rejected') then
    raise exception 'REVIEW_ALREADY_SUBMITTED';
  end if;

  -- Undo reviewer label edits, then return every line to the submitted queue.
  update public.ocr_lines l
     set label = coalesce(l.original_label, l.label),
         original_label = null,
         reviewer_edited = false,
         status = 'submitted'
   where l.page_id = p_page_id;

  update public.ocr_pages p
     set status = 'submitted',
         reviewer_id = null,
         reviewed_at = null,
         review_note = null
   where p.id = p_page_id;

  insert into public.review_log (kind, item_id, reviewer_id, decision, note)
  values ('ocr', p_page_id, v_uid, 'reopen', v_note);
end;
$$;

comment on function public.admin_reopen_ocr_page(uuid, text) is
  'Admin only. Moves an approved or rejected OCR page and its lines back to submitted, clears reviewer fields and logs reopen.';


-- ----------------------------------------------------------------------------
-- 3. Grants: the reopen RPC is authenticated only and checks is_admin inside.
-- ----------------------------------------------------------------------------
revoke all on function public.admin_reopen_ocr_page(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_reopen_ocr_page(uuid, text)
  to authenticated;
