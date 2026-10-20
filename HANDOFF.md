# Handoff

Status: L0 to L3 and OCR L4a, L4b, L4c are complete. L5 has not been started. 0006 has not been run against Supabase.

## How to run

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the four values. The service role key is read only by local scripts under `scripts/`, never by app code, and is never logged.
3. `npm run dev`, then open http://localhost:3000
4. `npm run test:ocr`, `npm run lint` and `npm run build` pass.

## Supabase setup (once, in order)

1. Project settings, API: copy the project URL, the anon key and the service role key into `.env.local`.
2. Authentication: keep the email magic link, and add `/auth/callback` for the local and deployed origins.
3. SQL Editor: run `supabase/migrations/` 0001 to 0006 in order. 0006 is new for L4c.
4. Make yourself the first admin with the UPDATE statement in 0001's header comment, using your email.

## Phase L4c: apply it in this order

1. Run `supabase/migrations/0006_ocr.sql` in the SQL Editor. Do not edit 0001 to 0005.
2. In Storage, open the `ocr-lines` bucket and confirm it is private, has a 2 MB file size limit, and allows `image/webp` and `image/jpeg`.
3. Run `npm run test:ocr`, then `npm run lint` and `npm run build`.
4. In the dashboard, check Storage has uploaded line images under `<user id>/<page id>/<idx>.<webp|jpg>`, and Table Editor shows `app_settings` with `ocr_quota_mb = 400`, the new `ocr_pages` columns `reviewer_id` and `review_note`, and the new `ocr_lines` checks.

## What 0006 changes

- `app_settings` stores the OCR quota. The row `ocr_quota_mb = 400` is seeded and is readable only for that key. API writes are revoked.
- `ocr_pages` statuses become uploading, submitted, approved, rejected, failed. Existing draft rows become failed. Page checks: line_count 1 to 40, rights_confirmed true, label at most 120 characters. Reviewer fields are added.
- `ocr_lines` checks: idx 1 to 40, trimmed label 1 to 400 characters, bytes 1 to 2,000,000, positive width and height.
- The private `ocr-lines` bucket gets the 2 MB cap and the WebP and JPEG MIME types. The 0001 storage policies are left in place and not duplicated.
- Contributors lose direct insert, update and delete on `ocr_pages` and `ocr_lines`. Reads stay under the 0001 RLS policies. L5 will add review grants and policies.
- Functions: `ocr_storage_status()`, `ocr_create_page(p_label, p_rights, p_line_count, p_total_bytes)`, `ocr_finalize_page(p_page_id, p_lines)` and `ocr_abort_page(p_page_id)`. All are security definer with `search_path = public`, use `p_` parameters, qualify columns through aliases, and execute only for authenticated.

## Quota deviation from LABELER.md

The brief planned an environment variable for the OCR quota. That cannot guard `ocr_create_page`, because a signed-in user can call the function directly and an environment variable is not visible inside Postgres. The quota therefore lives in `app_settings.ocr_quota_mb`, seeded at 400 MB. Admins change it with SQL. The client warns at 60 percent, blocks new uploads above 80 percent, and the server enforces the same 80 percent threshold. Other modules keep working.

## Submission flow and schema

- Step 4 is active. The contributor sees the page label, line counts, unreadable count and rights state, then confirms in a dialog. The original page image is never uploaded.
- Each line is cropped at working resolution, converted to grayscale, encoded as WebP quality 0.90, and falls back to JPEG quality 0.92 when the browser does not really return WebP. The real blob type is stored. A line above 2 MB fails with a clear message.
- Prepare runs first so the total encoded bytes are known. Then `ocr_create_page` reserves the row, then up to 3 line images upload at once with 3 retries and exponential backoff. Stop upload keeps the page and uploaded line numbers. Cancel submission calls `ocr_abort_page` and returns to labeling. A beforeunload warning runs during an upload.
- The IndexedDB draft schema stays at version 1. It gains `submission: { pageId, uploadedIdx } | null`; old records default to null. No encoded blobs are stored. A reload re-encodes the lines from the original page and uploads only the missing line numbers with upsert.
- `npm run test:ocr` covers the plan, extension, quota and submit gate helpers in `src/lib/ocr/submit.ts`. `encodeLine` is in `src/lib/ocr/encode.ts`.
- On success the draft is deleted, the workspace shows "Page submitted. N lines uploaded.", My pages refreshes, and the success card offers another page. The server re-validates every label and path.

## Error messages

- Storage above 80 percent: "OCR uploads are full for now. Plain text, instructions and conversations are still open."
- Rate limit, 20 pages in 24 hours: "You have reached today's page limit. Please come back tomorrow."
- Rights, session and not-editable errors have their own messages in `src/app/(app)/ocr/actions.ts`. Submit errors log only the message and code with the `[ocr_submit]` prefix.
- My pages shows newest first, 20 at a time with Load more. Pages without a label show "Untitled page". Uploading pages show the Incomplete badge. Rejected pages show the reviewer note. There is no edit or delete action and the empty state is honest.
- Dashboard adds OCR pages by status and total uploaded lines. Admin adds page and line counts by status, a storage meter with used MB, quota MB and percentage, and `npm run sync` as copyable text marked "Available in a later update".

## L5 scope (not started)

Review actions for OCR pages and lines, approve and reject with a reviewer note, signed URLs for reviewers, export and sync through `npm run sync`, storage purge after export, and quota cleanup for failed or abandoned pages.

## Browser checks

Apply 0006 first. Submit a page from step 4: the confirm dialog names the line count, progress moves through preparing, creating and uploading, and the success card shows "Page submitted. N lines uploaded." My pages, Dashboard and Admin update after the refresh, and the Storage folder holds only line images, never the page.

Reload during an upload: the resume card offers "Resume upload" and only missing lines are sent. Stop upload shows the interrupted card with the uploaded count. Cancel submission closes the page and returns to labeling with the labels intact. Check that an unfinished page is never counted as Submitted.

Check the 60 and 80 percent states on a local project by changing `app_settings.ocr_quota_mb`. The warning appears at 60, the submit button is blocked above 80, and the exact full message appears. Confirm plain text, instructions and conversations still work.

Check My pages empty state, 20 items plus Load more, the Incomplete badge for an interrupted page, and a rejected page with a note once L5 can set one. Check Dashboard and Admin zero states, then real counts. Check the storage meter arithmetic and the 360 px and 1440 px layouts, both themes, keyboard only and a screen reader.
