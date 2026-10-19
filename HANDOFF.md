# Handoff

Status: Phases L0 to L3 complete. Phase L4 (OCR module) has not been started.

## How to run

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the four values. `.env.local` is gitignored. The
   service role key is read only by local scripts under `scripts/`, never by app code, and is never logged.
3. `npm run dev`, then open http://localhost:3000
4. `npm run build` and `npm run lint` both pass with no warnings.

## Supabase setup (do this once, in order)

1. Project settings, API: copy the project URL, the anon key and the service role key into `.env.local`.
2. Authentication, Sign In / Providers: keep email enabled (magic link, no password).
3. Authentication, URL Configuration: add `http://localhost:3000/auth/callback` as a redirect URL.
   Add the deployed origin's `/auth/callback` too when there is one.
4. SQL Editor: run `supabase/migrations/0001_init.sql` once.
5. SQL Editor: run `supabase/migrations/0002_instructions.sql` after 0001. It adds `english_hash`,
   `submit_instruction_translation`, `release_claim`, the unique claim index and re-issues `claim_next`.
6. SQL Editor: run `supabase/migrations/0003_fix_ambiguous_columns.sql` after 0002. It recreates
   `claim_next` with `out_*` output columns so no column reference is ambiguous.
7. SQL Editor: run `supabase/migrations/0004_conversations.sql` after 0003. It adds the unique
   `conversation_items.english_hash` (backfilled) and `submit_conversation_translation(p_item_id, p_turns)`.
8. SQL Editor: run `supabase/migrations/0005_plain_text.sql` after 0004. It adds text length and rights
   checks, an index for a contributor's list, and re-issues the insert policy so a new row is always
   their own, submitted, with rights confirmed and no reviewer fields. Run it before testing plain text.
9. Make yourself the first admin with the UPDATE statement in 0001's header comment, using your email.

## Import English items and conversations (local)

Items: `npm run import:english -- --file path.jsonl --source name --target-count 1 [--dry-run]`
- One JSON object per line: `{"instruction":"...","input":"...","response":"..."}`.
  `instruction` and `response` are required, `input` is optional, `output` aliases `response`, and
  `source` overrides `--source`.

Conversations: `npm run import:conversations -- --file path.jsonl --source name --target-count 1 [--dry-run]`
- One JSON object per line:
  `{"turns":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}`. `messages`
  aliases `turns`. Roles: system, user, assistant. At least 2 turns, at most 20, an optional single
  system turn only at the start, then user and assistant alternating, starting with user and ending
  with assistant. Every content is non-empty and at most 4000 characters.
- Both scripts trim, skip invalid lines with a line number, dedupe by hash within the file and against
  the database, insert in batches of 200, and print `read / invalid / duplicates / inserted`.
  `--dry-run` writes nothing. First runs: both `samples/*.sample.jsonl` files with
  `--source sample --target-count 1`.

## What exists in the app

- App shell, tokens, fonts, auth, consent, profiles, Guidelines and Account from L0.
- `/instructions`: one claimed item, English next to three Khowar fields with the letters palette,
  validation and length warnings from `src/lib/khowar.ts`, Ctrl/Cmd + Enter, skip, report an issue,
  drafts in `localStorage` per item, submitted counter.
- `/conversations`: turns listed in order, each with a role badge, a copy button and its own Khowar
  field directly under it, plus a sticky bar with "Submit and next", Skip, Report an issue,
  "N of M turns translated" and "Jump to next empty turn". Drafts survive an expired claim.
- `/plain-text`: optional title and source, one RTL Nastaliq field with the letters palette, live
  character, word and Arabic-script stats, inline errors, a visible disabled reason, Ctrl/Cmd + Enter,
  the duplicate message, a success card with "Submit another", a browser draft with "Clear draft", and
  the caller's submissions newest first, 20 per page with Load more, status badges and reviewer notes.
- Dashboard shows your own counts for all three modules. Admin shows real item totals per module, plus
  plain text counts by status and total characters.

## Browser checks (run the 0005 SQL first)

- Plain text empty state, honest Dashboard zero counts, Admin counts at zero.
- On `/plain-text`, type or paste 20 to 20,000 characters of Khowar: live stats update, the palette
  inserts at the caret, and the field is resizable with a minimum height of about 280px.
- Submit stays disabled with a visible reason until the length, script ratio and rights box pass.
  Latin-heavy text is rejected.
- Ctrl + Enter submits. A second identical text shows exactly "This text has already been submitted."
- A successful submit clears the form, shows the confirmation and adds the newest row under Your
  submissions. "Submit another" returns to an empty form.
- Reload mid-draft restores text, title and source and shows the restored notice; editing hides it.
  "Clear draft" empties the form and local storage.
- With more than 20 rows, Load more appends the next page in order. A rejected row shows its note.
- Keyboard reaches the palette, field and actions; check both themes at 360px and 1440px. There are
  no edit or delete controls.

## Phase L4

The OCR module, the biggest phase. Read `reference/PORTING.md` in full before starting. It documents
the old local labeler: segmentation, the UI flow and the export format. Work only on L4 when asked.
