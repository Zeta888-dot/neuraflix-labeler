import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

/**
 * Regression guard for Skip. Before 0013, Skip released the claim and
 * claim_next handed the same oldest open row straight back, so the screen never
 * changed. The SQL must remember the skip per contributor, exclude it from
 * both claim paths and offer Start over through clear_skips.
 */
const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0013_skip_items.sql"),
  "utf8",
);

function functionBlock(name: string, args: string): string {
  const pattern = new RegExp(
    `create (?:or replace )?function public\\.${name}\\s*\\(${args}\\)[\\s\\S]*?\\n\\$\\$;`,
    "i",
  );
  const match = migration.match(pattern);
  assert.ok(match, `${name} is missing from 0013_skip_items.sql`);
  return match[0];
}

test("skips are private, closed to direct writes and indexed by contributor", () => {
  assert.match(
    migration,
    /create table if not exists public\.skips/i,
    "skips table must exist",
  );
  assert.match(
    migration,
    /alter table public\.skips enable row level security;/i,
    "skips must enable RLS",
  );
  assert.match(
    migration,
    /revoke all on table public\.skips from public, anon, authenticated;/i,
    "skips must be closed to direct app writes",
  );
  assert.match(
    migration,
    /on public\.skips \(contributor_id, kind\)/i,
    "skips needs a contributor lookup index",
  );
});

test("skip_item remembers the skip and releases only the caller's claim", () => {
  const block = functionBlock("skip_item", "p_kind text, p_item_id uuid");

  assert.match(block, /security definer/i);
  assert.match(block, /set search_path = public/i);
  assert.match(
    block,
    /insert into public\.skips \(kind, item_id, contributor_id\)/i,
    "skip must be recorded",
  );
  assert.match(
    block,
    /delete from public\.claims c[\s\S]*contributor_id = v_uid/i,
    "skip must release the caller's claim",
  );
});

test("claim_next excludes this contributor's skips on every path", () => {
  const block = functionBlock("claim_next", "p_kind text");

  // Four pick/renew paths plus two claim-cleanup paths.
  const exclusions = block.match(/from public\.skips s/g) ?? [];
  assert.ok(
    exclusions.length >= 6,
    `expected six skip checks in claim_next, found ${exclusions.length}`,
  );

  // The skip check must be per contributor and per kind, never global.
  const scoped = block.match(
    /from public\.skips s\s+where s\.kind = p_kind\s+and s\.item_id = (?:i\.id|c\.item_id)\s+and s\.contributor_id = v_uid/gi,
  ) ?? [];
  assert.ok(
    scoped.length >= 6,
    `expected every skip check to be scoped to the caller, found ${scoped.length}`,
  );
});

test("clear_skips is Start over and only clears the caller's rows", () => {
  const block = functionBlock("clear_skips", "p_kind text");

  assert.match(block, /security definer/i);
  assert.match(block, /set search_path = public/i);
  assert.match(
    block,
    /delete from public\.skips s\s+where s\.kind = p_kind\s+and s\.contributor_id = v_uid;/i,
    "clear_skips must be limited to the caller and the kind",
  );
});

test("skip RPCs are closed to public and anon and granted to authenticated", () => {
  for (const signature of [
    "public.claim_next(text)",
    "public.skip_item(text, uuid)",
    "public.clear_skips(text)",
    "public.skipped_item_count(text)",
  ]) {
    assert.ok(
      migration.includes(
        `revoke all on function ${signature} from public, anon;`,
      ),
      `${signature} must revoke public and anon`,
    );
    assert.ok(
      migration.includes(`grant execute on function ${signature} to authenticated;`),
      `${signature} must be granted to authenticated`,
    );
  }
});
