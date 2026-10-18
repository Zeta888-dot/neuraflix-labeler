# Handoff

Status: Phase L0 complete. Phase L1 has not been started.

## What exists

- App shell in `src/components/app-shell/app-shell.tsx`: fixed collapsible sidebar (persisted in
  `localStorage`), mobile top bar with drawer, theme toggle, user menu with sign out, skip link.
- Design tokens, type scale, radii and fonts ported from `reference/site-design/globals.css` into
  `src/app/globals.css`. Geist, Noto Nastaliq Urdu and Sora load through `next/font` in
  `src/app/layout.tsx`. Dark is the default theme, set before paint by `src/lib/theme.ts`.
- Auth: Supabase browser and server helpers in `src/lib/supabase/`, session refresh and optimistic
  route protection in `src/proxy.ts`, authoritative check in `requireAppUser()` (`src/lib/auth.ts`).
  `/login` sends a magic link, `/auth/callback` exchanges the code, `/consent` collects the two
  consent checkboxes and writes `consent_version` plus `consent_at` to `profiles`.
- Stub pages with honest empty states: Dashboard, Instructions, Conversations, Plain text, OCR,
  Review, Admin, Guidelines, Account. Review and Admin are hidden unless the profile role allows them.
- `supabase/migrations/0001_init.sql`: every table, index, RLS policy, the `claim_next` function,
  the `ocr-lines` storage bucket policies and the trigger that creates a profile row on first login.
  It has not been run.

## How to run

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in the four values. `.env.local` is gitignored;
   the service role key is only ever used by local scripts under `scripts/`, never by app code.
3. `npm run dev`, then open http://localhost:3000
4. `npm run build` and `npm run lint` both pass with no warnings.

## Supabase setup (do this once)

1. Project settings, API: copy the project URL, the anon key and the service role key into `.env.local`.
2. Authentication, Sign In / Providers: keep email enabled (magic link, no password).
3. Authentication, URL Configuration: add `http://localhost:3000/auth/callback` as a redirect URL.
   Add the deployed origin's `/auth/callback` too when there is one.
4. SQL Editor: open `supabase/migrations/0001_init.sql`, paste the whole file and run it once.
5. Make yourself the first admin with the UPDATE statement in that file's header comment, using your
   own email address.

## Browser checks

- `/` redirects to `/dashboard`.
- Signed out, `/dashboard` lands on `/login`; the magic link returns you to `/auth/callback`.
- First login shows `/consent` with both checkboxes required; later visits skip it.
- Theme toggle survives a reload with no flash, and both themes hold up at 360px and 1440px.
- Sidebar collapses, the mobile drawer opens and closes with Escape, tab order reaches the skip link.
- Review and Admin stay hidden for a normal labeler and appear after the first-admin UPDATE.

## What Phase L1 will do

Instructions module with the Khowar letters palette, `scripts/import-english.ts` reading JSONL into
items, and the claim system plus validation on top of `claim_next`.
