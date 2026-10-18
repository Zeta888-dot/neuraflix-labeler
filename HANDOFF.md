# Handoff

Status: Phase L1 complete. Phase L2 (Conversations module) has not been started.

## How to run

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the four values. `.env.local` is gitignored; the
   service role key is only read by local scripts under `scripts/`, never by app code.
3. `npm run dev`, then open http://localhost:3000
4. `npm run build` and `npm run lint` both pass with no warnings.

## Supabase setup (do this once)

1. Project settings, API: copy the project URL, the anon key and the service role key into `.env.local`.
2. Authentication, Sign In / Providers: keep email enabled (magic link, no password).
3. Authentication, URL Configuration: add `http://localhost:3000/auth/callback` as a redirect URL.
   Add the deployed origin's `/auth/callback` too when there is one.
4. SQL Editor: paste all of `supabase/migrations/0001_init.sql` and run it once.
5. SQL Editor: paste all of `supabase/migrations/0002_instructions.sql` and run it once, after 0001.
   It adds `english_hash`, `submit_instruction_translation`, `release_claim`, a unique index on
   `(kind, item_id, contributor_id)` and re-issues `claim_next` for both kinds. It also fixes a 0001
   bug: `claim_next` inserted a new claim row on every call, so claiming the same item again
   inflated the item's `active_claims` and could push it past `target_count`. 0002 collapses the
   duplicate rows that bug left behind, and a repeat claim now renews the caller's own row instead.
6. Make yourself the first admin with the UPDATE statement in 0001's header comment, using your email.

## Import English items (local)

`npm run import:english -- --file path.jsonl --source name --target-count 1 [--dry-run]`

- One JSON object per line, UTF-8:
  `{"instruction":"...","input":"...","response":"...","source":"..."}`
- `instruction` and `response` are required. `input` is optional and is only shown when the English
  item has one. `source` overrides `--source` for that line. `output` works as an alias of `response`.
- Lines are trimmed. Blank or invalid lines are skipped with a line number in a warning. Items are
  deduplicated within the file and against `english_hash` in the database, then inserted in batches
  of 200. The run ends with a `read / invalid / duplicates / inserted` summary; `--dry-run` writes
  nothing.
- First import: `npm run import:english -- --file samples/english-instructions.sample.jsonl --source sample --target-count 1`

## What exists in the app

- App shell, tokens, fonts, auth, consent, profiles, Guidelines and Account pages from L0.
- `/instructions`: claims one item at a time through a server action, shows the English payload next
  to three Khowar fields (instruction, input when present, response) with the letters palette,
  Khowar validation and length warnings from `src/lib/khowar.ts`, Ctrl/Cmd + Enter to submit, skip,
  report an issue, drafts kept in `localStorage` per item, and a submitted counter.
- Dashboard shows your real open, in-progress and submitted counts. Admin shows real
  `instruction_items` totals (open, complete, retired) and the exact import command.
- `supabase/migrations/0002_instructions.sql` holds every database change for L1 and has not been run.

## Browser checks

- `/` redirects to `/dashboard`; signed out you land on `/login`.
- Before the sample import, `/instructions` says no items are available and the Dashboard counts are
  zero. Honest empty states, no invented numbers.
- After the import: an item appears with English on the left, Khowar fields on the right, and the
  palette inserts letters at the caret. Both columns stack at 360px with the action bar pinned to the
  bottom of the viewport.
- Submitting moves to the next item, bumps the Dashboard counts and the "you have submitted" line.
  Reloading mid-page restores the draft. Ctrl/Cmd + Enter submits without the mouse.
- Skip and report both return you to the next item, and a report shows up under Admin counts.
- A wrong keyboard layout or empty field blocks the submit with a field error; a suspiciously short
  Khowar field warns first and lets you "Submit anyway".
- Tab order reaches the palette, the fields and the three action buttons; check both themes at 360px
  and 1440px.

## What Phase L2 will do

The Conversations module: same claim and validation shape for multi-turn English conversations,
reusing `src/lib/khowar.ts`, the claim functions and the Khowar field components from L1.
