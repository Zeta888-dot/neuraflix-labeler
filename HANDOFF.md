# Handoff

Status: Phase L2 complete. Phase L3 (Plain text module) has not been started.

## How to run

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the four values. `.env.local` is gitignored; the
   service role key is only read by local scripts under `scripts/`, never by app code.
3. `npm run dev`, then open http://localhost:3000
4. `npm run build` and `npm run lint` both pass with no warnings.

## Supabase setup (do this once, in order)

1. Project settings, API: copy the project URL, the anon key and the service role key into `.env.local`.
2. Authentication, Sign In / Providers: keep email enabled (magic link, no password).
3. Authentication, URL Configuration: add `http://localhost:3000/auth/callback` as a redirect URL.
   Add the deployed origin's `/auth/callback` too when there is one.
4. SQL Editor: run `supabase/migrations/0001_init.sql` once.
5. SQL Editor: run `supabase/migrations/0002_instructions.sql` after 0001. It adds `english_hash`,
   `submit_instruction_translation`, `release_claim`, the unique index on `(kind, item_id,
   contributor_id)` and re-issues `claim_next`; it also collapses the duplicate claim rows a 0001 bug
   left behind, so a repeat claim renews the caller's own row.
6. SQL Editor: run `supabase/migrations/0003_fix_ambiguous_columns.sql` after 0002. Postgres raised
   `column reference "item_id" is ambiguous` from `claim_next`, because a `RETURNS TABLE` output
   column is a PL/pgSQL variable inside the body. 0003 recreates `claim_next` with `out_*` output
   columns and qualifies every column reference. No behaviour change.
7. SQL Editor: run `supabase/migrations/0004_conversations.sql` after 0003. It adds the unique
   `conversation_items.english_hash` (backfilled) and `submit_conversation_translation(p_item_id,
   p_turns)`. Until it runs, `/conversations` still claims items but every submit fails with a save
   error.
8. Make yourself the first admin with the UPDATE statement in 0001's header comment, using your email.

## Import English items and conversations (local)

Items: `npm run import:english -- --file path.jsonl --source name --target-count 1 [--dry-run]`
- One JSON object per line: `{"instruction":"...","input":"...","response":"...","source":"..."}`.
  `instruction` and `response` are required, `input` is optional, `output` aliases `response`, and
  `source` overrides `--source`.

Conversations:
`npm run import:conversations -- --file path.jsonl --source name --target-count 1 [--dry-run]`
- One JSON object per line:
  `{"turns":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}`. `messages`
  aliases `turns`. Roles: system, user, assistant. At least 2 turns, at most 20, an optional single
  system turn only at the start, then user and assistant alternating, starting with user and ending
  with assistant. Every content is non-empty and at most 4000 characters.
- Both scripts trim, skip invalid lines with a line number, dedupe by `english_hash` within the file
  and against the database, insert in batches of 200, and print
  `read / invalid / duplicates / inserted`. `--dry-run` writes nothing.
- First runs: both `samples/*.sample.jsonl` files with `--source sample --target-count 1`.

## What exists in the app

- App shell, tokens, fonts, auth, consent, profiles, Guidelines and Account from L0.
- `/instructions`: one claimed item, English next to three Khowar fields with the letters palette,
  validation and length warnings from `src/lib/khowar.ts`, Ctrl/Cmd + Enter, skip, report an issue,
  drafts in `localStorage` per item, submitted counter.
- `/conversations`: turns listed in order, each with a role badge, a copy button and its own Khowar
  field directly under it, plus a sticky bar with "Submit and next", Skip, Report an issue,
  "N of M turns translated" and "Jump to next empty turn". Drafts survive an expired claim.
- Dashboard shows your own counts for both modules. Admin shows real item totals per module plus both
  exact import commands.

## Browser checks

- Before either import: honest empty states, and Dashboard counts at zero.
- Items: English left, Khowar fields right, palette inserts at the caret, columns stack at 360px with
  the action bar pinned to the bottom of the viewport.
- Conversations: each group holds one English block and one field, in order; a wrong layout or empty
  turn blocks the submit and focus moves to the first bad turn; a short turn warns and asks for
  confirmation.
- Submitting moves on, bumps the counts and the "you have submitted" line; reloading mid-page
  restores the draft; Skip and Report clear it, and a report shows under Admin counts.
- Tab order reaches the palette, the fields and the actions; check both themes at 360px and 1440px.

## What Phase L3 will do

The Plain text module: one long English block per item, same claim, validation, draft and counting
shape, with its own import script and page.
