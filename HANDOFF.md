# Handoff

Status: L0 to L6 are implemented. L7a (code hardening) is complete in code. L7b (hosting, Google login, SMTP and the neuraflix.si integration) has not started. `0009_hardening.sql` is written but not applied.

## How to run

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the three names. `SUPABASE_SERVICE_ROLE_KEY` is read only by `scripts/` and is never imported by `src/` or logged.
3. `npm run dev`, then open http://localhost:3000
4. `npm run test:core`, `npm run test:ocr`, `npm run test:export`, `npm run lint` and `npm run build`.

Environment variable names only: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. The OCR quota has no environment variable. Its only source is `app_settings.ocr_quota_mb`. Warn at 60 percent after upload, block above 80 percent.

## Supabase setup

1. Project settings, API: copy the project URL, anon key and service role key into `.env.local`. Never commit or print them.
2. Authentication: keep the email magic link and add `/auth/callback` for the local and deployed origins.
3. Migration: `0007_review.sql` is confirmed applied. Apply `0008_admin_settings.sql` if it is not applied yet. Then paste `supabase/migrations/0009_hardening.sql` into the Supabase SQL editor and Run. It is safe to run again. Nothing in this repo applies it.
4. `0009` adds the submission rate limits, the plain text trigger, `health_ping()` and its grants. Until it is applied, `/api/health` returns 503 and the new limits are not enforced.
5. The first admin already exists. Later role changes use Admin, Users, or SQL:

```sql
update public.profiles p set role = 'reviewer'
  from auth.users u where u.id = p.id and u.email = 'person@example.com';
```

## L7a hardening

- Rate limits are rolling one-hour windows: 60 instruction submissions, 30 conversation submissions and 30 plain text submissions per contributor. The functions and trigger live in `0009_hardening.sql`.
- `submit_instruction_translation` and `submit_conversation_translation` raise `RATE_LIMIT`; the actions map it to "You are submitting very quickly. Please wait a little and try again." Plain text uses a `BEFORE INSERT` trigger, so the 0005 policy is unchanged.
- `/api/health` calls `health_ping()` with the anon key and returns `{ok:true}` or 503 `{ok:false}`. No table is read and no detail is exposed. It is public in `src/proxy.ts`.
- The keep-alive workflow is `.github/workflows/keep-alive.yml`. It runs every 3 days and by hand. Set the repository variable `HEALTH_URL` under Settings, Secrets and variables, Actions, Variables, to `https://<host>/api/health`. A non-200 response fails the job.
- `supabase/cleanup/launch-reset.sql` is not a migration. Run `npm run purge:ocr` first, because deleting OCR rows removes the only map to the Storage objects. Review the counts with the default ROLLBACK, fill in the explicit test id blocks only for confirmed test rows, then change the last statement to COMMIT. Never run it against real contributor data.
- Tests: `test:core` 81, `test:ocr` 22, `test:export` 28. Lint and build pass. Browser checks for focus, 360px layout and reduced motion are still manual.

## L6 commands

- `npm run export` writes a new snapshot and `DATASET_NOTES.md`. Options: `--out path`, `--data path`, `--dry-run`, `--no-latest`.
- `npm run sync` is a dry run. `npm run sync -- --commit` downloads missing approved OCR images. Sync never deletes remote objects. Options: `--data path`, `--page uuid`.
- `npm run purge:ocr` is a dry run. Purge is the only command that deletes remote objects. Its `--commit` mode is destructive. Options: `--data path`, `--page uuid`.
- Defaults are `exports/<UTC timestamp>/` and `data/ocr`. A custom `--out` that already exists is refused.
- `exports/latest` is a junction on Windows and a directory link elsewhere. A real directory named latest is never removed; the export succeeds with a warning.

## Output structure

```text
exports/<timestamp>/
  manifest.json
  DATASET_NOTES.md
  contributors.csv
  cpt/ train.jsonl, val.jsonl
  sft/ train.jsonl, val.jsonl
  sft_multiturn/ train.jsonl, val.jsonl
  parallel/ train.jsonl, val.jsonl
  ocr/ train.jsonl, val.jsonl, train.txt, val.txt, charset.json, manifest.json
  ocr/images/<page_uuid>_<NN>.<webp|jpg>
data/ocr/<page_uuid>/line_<NN>.<webp|jpg>
data/ocr/<page_uuid>/manifest.json
```

A split file is created only when that split has rows. `manifest.json` is written last. No manifest stores labels or names. `contributors.csv` has pseudonymous ids only.

## Export schemas

- `cpt`: `{"id","source","text"}`, where source is `instruction`, `input`, `response` or `text`.
- `sft`: `{"id":"instruction:<translation_uuid>","messages":[{"role":"user","content":"...\n\n<input when present>"},{"role":"assistant","content":"..."}]}`.
- `sft_multiturn`: `{"id":"conversation:<translation_uuid>","messages":[{"role":"system|user|assistant","content":"..."}]}` in original turn order.
- `parallel`: `{"id","type":"instruction|input|response|turn","en","khw"}`. Conversation turn ids include the one based turn position.
- `ocr/train.jsonl` and `val.jsonl`: `{"id":"<page_uuid>_<NN>","messages":[{"role":"<|User|>","content":"<image>\nFree OCR. ","images":["images/<page_uuid>_<NN>.<ext>"]},{"role":"<|Assistant|>","content":"<label>"}]}`.
- `ocr/train.txt` and `val.txt`: `images/<page_uuid>_<NN>.<ext><TAB><label>`.
- `ocr/charset.json`: frequency sorted `{"char","code","count"}` entries.
- `ocr/manifest.json`: `schemaVersion`, `createdAt`, prompt, counts and rows with `id`, `pageId`, `lineId`, `line`, `image`, `split`, `bytes`, `width`, `height`, `sha256`.
- Top `manifest.json`: schema, `createdAt`, normalization rules, split method, `ocrPrompt`, `valRatio`, real counts and warnings.
- `DATASET_NOTES.md`: purpose, one example line for each split, counts, normalization and split rules, privacy, licence and a load snippet. It is not written in a dry run.
- The full page image is never read or exported.

## Selection, sync and purge

- Text export includes rows whose final status is exactly `approved`. OCR export requires both the line and its page to be `approved`.
- Normalization: NFC, U+064A and U+0649 to U+06CC, U+0643 to U+06A9, controls and invisible marks removed, ZWNJ kept, whitespace collapsed. Paragraph breaks stay in plain text.
- Splits use SHA-1 of the source item id, val when the value is below 0.05. Records from one source item stay together. If either side would be empty, all rows stay in train.
- Sync validates each storage path as `<contributor_uuid>/<page_uuid>/<line>.<webp|jpg>`, checks header, type, bytes and dimensions, then writes through a temporary file. An existing file is never replaced.
- Purge needs an approved line and page, `exported_at`, a valid manifest entry, and a local file whose type, dimensions, bytes and sha256 match. Only then does it delete the Storage object and set `purged_at`. Local files are kept.
- A malformed approved row stops the export. Sync and purge are idempotent. Use `--page uuid` to work one page at a time.
- `--include-unreviewed` and `--push-hf` remain waived. Offsite backup is a manual copy of `data/` for now.

## Manual checks still open

L6: run `npm run sync` (dry run), then `sync --commit` for one approved page, `export --dry-run`, `export`, `purge:ocr` and `purge:ocr --commit` for the same page. Check `exports/<timestamp>/` and `data/ocr/<page_uuid>/manifest.json`. If credentials or approved test records are unavailable, mark these blocked instead of using real user data.

L7a browser checks: keyboard focus rings, dialog focus return, skip link, the review single-key shortcuts outside form controls, 44px touch targets on a coarse pointer, 360px width, reduced motion, and both themes for muted text contrast.

## Next phase (L7b)

L7b covers deployment and the live account path: hosting the Next.js app, the production domain `label.neuraflix.si`, Google login in Supabase Auth, SMTP for magic links, callback and redirect URLs for the deployed origin, and the neuraflix.si integration (links between the marketing site and the labeler). It does not change the phase L7a code.

## UI tuning

- Shared page container: reading and form routes cap at 60rem, OCR, review and admin at 88rem, all centred in the space right of the sidebar.
- The account block opens a menu above it with the theme toggle (showing the current Light or Dark), Account and Sign out; the standalone top bar toggle is gone.
- Global cursor rule in `src/app/globals.css`: pointer for interactive controls, not-allowed for disabled controls, text cursor kept for text fields.
