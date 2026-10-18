<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->


# Labeler: agent rules

Before any work, read DESIGN.md (visual system), LABELER.md (the full brief) and, if present, HANDOFF.md.
Work ONLY on the phase the user names. Do not start the next phase.
Minimal edits, do not print whole files, no measurement harnesses or Lighthouse runs unless asked.
After each phase: run `npm run build`, fix errors, update HANDOFF.md, and summarize what to check in the browser.
The service role key is used ONLY in scripts/ run locally. It must never be imported by anything under src/app or src/components, and never logged.
Never invent statistics, contributors, counts or testimonials. Empty states are honest.
reference/ is read-only material (old local labeler, site tokens). Port logic from it; never edit it.
Before Phase L4 (OCR module), read reference/PORTING.md fully. It documents the old local labeler (segmentation algorithm, UI flow, export format) that must be ported.
Copy rules: no em dashes, no eyebrow labels above headings, no emojis in UI.