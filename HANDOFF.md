# Handoff

Status: L0 to L4 and the L5 review and admin code are complete. 0007 has not been run against Supabase. L6 has not been started.

## How to run

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the four values. The service role key is read only by local scripts under `scripts/`, never by app code, and is never logged.
3. `npm run dev`, then open http://localhost:3000
4. `npm run test:core`, `npm run lint` and `npm run build` pass.

## Supabase setup (once, in order)

1. Project settings, API: copy the project URL, the anon key and the service role key into `.env.local`.
2. Authentication: keep the email magic link, and add `/auth/callback` for the local and deployed origins.
3. SQL Editor: run `supabase/migrations/` 0001 to 0007 in order. 0006 added OCR upload and quota. 0007 is new for L5.
4. Make yourself the first admin with the UPDATE statement in 0001's header comment, using your email.
5. Later role changes use the Admin page, or SQL:

```sql
update public.profiles p
   set role = 'reviewer'
  from auth.users u
 where u.id = p.id
   and u.email = 'person@example.com';
```

## Phase L5: apply it in this order

1. Run `supabase/migrations/0007_review.sql` after 0006. Do not edit 0001 to 0006.
2. In Table Editor, confirm the new `reviewed_at`, `reviewer_edited` and `original_content` columns, `review_log`, and `app_settings.allow_self_review = false`.
3. Run `npm run test:core`, then `npm run lint` and `npm run build`.
4. Sign in as a reviewer or admin and open Review. The four queue counts come from `review_counts()`.
5. Work through the browser checks at the end of this file.

## What 0007 changes

- Review fields on instruction, conversation and text translations, `reviewed_at` on OCR pages, and `reviewer_edited` plus `original_label` on OCR lines.
- `review_log` is append-only. Staff can read it; only the security definer review functions write it.
- `app_settings.allow_self_review` is seeded `false`. The page learns the setting through `review_counts()`, so normal users still cannot read that row.
- `review_next`, `review_counts`, `review_instruction`, `review_conversation`, `review_text` and `review_ocr_page` check the caller's role by reading `profiles`.
- `admin_overview`, `admin_list_users` and `admin_set_role` check for the admin role. `admin_set_role` refuses a self change and refuses to remove the last admin.
- `my_feedback` returns rejected or reviewer-edited contributions for the signed-in contributor.
- Every function uses `p_` parameters, `out_` output columns, alias-qualified columns, `search_path = public`, and security definer. Execute is granted to authenticated only. `recompute_item_status` stays internal.

## Review page

- Four queues: Instructions, Conversations, Plain text and OCR pages, oldest first. Counts refresh after every decision and queue switch.
- Instructions and conversations show English and Khowar side by side. Plain text shows details and the Khowar editor. OCR shows each signed line image with a one hour URL.
- Approve, edit and approve, or reject. Reject needs a note of at least 3 characters; the dialog offers quick reason chips that append to the note.
- Automatic checks are non-blocking: script ratio, copied English, length ratio, short text, Latin letters and repeated characters.
- OCR images can be zoomed, a line can be removed, and a failed image can be signed again with Retry image. At least one line must stay.
- Keyboard: A approves, R opens reject, 1 to 4 switch queues. The self review notice appears when the setting is on.
- There is no undo. A review decision is final; the next item loads immediately.
- `ALREADY_REVIEWED` shows "Someone else already reviewed this item. Loading the next one." and loads the next item.
- `SELF_REVIEW` shows "You cannot review your own contribution."

## Admin page

- Overview reads `admin_overview()` and shows contribution totals, OCR lines, accounts by role and contributors active in the last 30 days.
- Users reads `admin_list_users()` and shows every account, its role, consent date and contribution counts.
- A role selector opens a confirmation dialog. Your own row has no selector and says "You cannot change your own role."
- The existing import commands, status cards, storage meter and sync text are unchanged.

## Dashboard feedback

- A Reviewer feedback card reads `my_feedback(10)`: rejected or reviewer-edited contributions, newest first, with the reviewer note and date.
- My pages and Plain text already show reviewer notes on rejected work.

## Self-review testing

```sql
update public.app_settings
   set value = 'true', updated_at = now()
 where key = 'allow_self_review';
```

Turn it off with the same statement and `'false'`. The Review page then hides your own submissions again.

## L6 scope (not started)

Export and sync scripts, deterministic train and validation splits, manifest and contributors CSV, storage purge after export, and quota cleanup for failed or abandoned pages. `npm run sync` remains copyable text marked "Available in a later update".

## Browser checks

1. Apply 0007, then sign in as an admin. Admin should show Overview and Users with real numbers and no invented rows.
2. Make a second account a reviewer through Users. Confirm the dialog names the old and new role. Try to change your own role: no selector appears, and the message is clear.
3. As a contributor, submit one instruction, one conversation, one plain text and one OCR page.
4. As the reviewer, open Review. Check all four counts, then approve the instruction, conversation and plain text without edits.
5. On the OCR page, zoom a line, edit one label, remove one line, approve. Check that My pages shows the approved page and the kept line count.
6. Submit another item and reject it with a reason chip plus a note. Check the contributor Dashboard feedback card, My pages and Plain text notes.
7. Open Review in two tabs. Decide the same item in both: the second tab shows the exact ALREADY_REVIEWED message and loads the next item.
8. Turn self review on with the SQL above. The notice appears and your own item can be reviewed. Turn it off.
9. Check 360 px and 1440 px, both themes, keyboard only including A, R and 1 to 4, and a screen reader. Confirm the empty state says "Nothing to review right now", and every action target is at least 44 px.
