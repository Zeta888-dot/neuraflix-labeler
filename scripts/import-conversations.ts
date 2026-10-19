/**
 * Import English conversations from a JSONL file into conversation_items.
 *
 * Local script only. This is the one place that reads
 * SUPABASE_SERVICE_ROLE_KEY, it is never imported by anything under src/, and
 * the key is never printed. Run it through the npm script, which loads
 * .env.local with Node's --env-file flag:
 *
 *   npm run import:conversations -- --file path.jsonl --source name --target-count 1 [--dry-run]
 *
 * One JSON object per line:
 *   {"turns":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
 * messages works as an alias of turns, and source overrides --source.
 * Roles: system, user, assistant. At least 2 turns, at most 20, an optional
 * single system turn only at the start, then user and assistant alternating,
 * starting with user and ending with assistant.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_TURN_CHARS,
  conversationHashSource,
  isConversationRole,
  type ConversationTurn,
} from "../src/lib/khowar";

const USAGE =
  "npm run import:conversations -- --file path.jsonl --source name --target-count 1 [--dry-run]";

const BATCH_SIZE = 200;
const HASH_PAGE_SIZE = 1000;
const MIN_TURNS = 2;
const MAX_TURNS = 20;

type Options = {
  file: string;
  source: string;
  targetCount: number;
  dryRun: boolean;
};

type NewItem = {
  english_hash: string;
  source: string;
  target_count: number;
  english: { turns: ConversationTurn[] };
  line: number;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseOptions(argv: string[]): Options {
  let file = "";
  let source = "";
  let targetCount = 1;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (flag === "--file" || flag === "--source" || flag === "--target-count") {
      if (next === undefined || next.startsWith("--")) {
        fail(`${flag} needs a value.\n${USAGE}`);
      }
      index += 1;
      if (flag === "--file") file = next;
      if (flag === "--source") source = next.trim();
      if (flag === "--target-count") {
        const parsed = Number(next);
        if (!Number.isInteger(parsed) || parsed < 1) {
          fail(`--target-count must be a whole number of 1 or more.\n${USAGE}`);
        }
        targetCount = parsed;
      }
      continue;
    }

    fail(`Unknown argument: ${flag}\n${USAGE}`);
  }

  if (file.trim() === "") fail(`--file is required.\n${USAGE}`);
  if (source === "") fail(`--source is required.\n${USAGE}`);

  return { file, source, targetCount, dryRun };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Checks the turn structure. Returns the reason when the turns are unusable. */
function parseTurns(
  value: unknown,
): { turns: ConversationTurn[] } | { reason: string } {
  if (!Array.isArray(value)) {
    return { reason: "turns must be an array" };
  }
  if (value.length < MIN_TURNS) {
    return { reason: `at least ${MIN_TURNS} turns are required` };
  }
  if (value.length > MAX_TURNS) {
    return { reason: `at most ${MAX_TURNS} turns are allowed` };
  }

  const turns: ConversationTurn[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { reason: `turn ${index + 1} must be an object with role and content` };
    }

    const record = entry as Record<string, unknown>;
    if (!isConversationRole(record.role)) {
      return {
        reason: `turn ${index + 1} has an unknown role, use system, user or assistant`,
      };
    }
    if (record.content !== undefined && typeof record.content !== "string") {
      return { reason: `turn ${index + 1} content must be a string` };
    }

    const content = text(record.content);
    if (!content) {
      return { reason: `turn ${index + 1} has no content` };
    }
    if (content.length > MAX_TURN_CHARS) {
      return {
        reason: `turn ${index + 1} is longer than ${MAX_TURN_CHARS} characters`,
      };
    }

    turns.push({ role: record.role, content });
  }

  const systemCount = turns.filter((turn) => turn.role === "system").length;
  if (systemCount > 0 && turns[0].role !== "system") {
    return { reason: "a system turn is only allowed as the first turn" };
  }
  if (systemCount > 1) {
    return { reason: "only one system turn is allowed" };
  }

  const body = systemCount === 1 ? turns.slice(1) : turns;
  for (let index = 0; index < body.length; index += 1) {
    const expected = index % 2 === 0 ? "user" : "assistant";
    if (body[index].role !== expected) {
      return {
        reason: `turn ${index + (systemCount === 1 ? 2 : 1)} must be a ${expected} turn, user and assistant alternate`,
      };
    }
  }
  if (body.length % 2 !== 0) {
    return { reason: "the conversation must end with an assistant turn" };
  }

  return { turns };
}

/** Reads one JSONL line. Returns null with a warning when it is unusable. */
function parseLine(raw: string, line: number, options: Options): NewItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`line ${line}: skipped, not valid JSON`);
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`line ${line}: skipped, expected a JSON object`);
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const rawTurns = record.turns ?? record.messages;

  if (rawTurns === undefined) {
    console.warn(`line ${line}: skipped, turns is missing or empty`);
    return null;
  }
  if (
    record.source !== undefined &&
    record.source !== null &&
    typeof record.source !== "string"
  ) {
    console.warn(`line ${line}: skipped, source must be a string`);
    return null;
  }

  const result = parseTurns(rawTurns);
  if ("reason" in result) {
    console.warn(`line ${line}: skipped, ${result.reason}`);
    return null;
  }

  return {
    english_hash: createHash("sha256")
      .update(conversationHashSource(result.turns), "utf8")
      .digest("hex"),
    source: text(record.source) ?? options.source,
    target_count: options.targetCount,
    english: { turns: result.turns },
    line,
  };
}

async function loadExistingHashes(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  const hashes = new Set<string>();

  for (let from = 0; ; from += HASH_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("conversation_items")
      .select("english_hash")
      .not("english_hash", "is", null)
      .order("english_hash")
      .range(from, from + HASH_PAGE_SIZE - 1);

    if (error) {
      fail(`Could not read existing items: ${error.message}`);
    }

    const rows = (data ?? []) as { english_hash: string | null }[];
    for (const row of rows) {
      if (row.english_hash) hashes.add(row.english_hash);
    }
    if (rows.length < HASH_PAGE_SIZE) break;
  }

  return hashes;
}

/** Inserts a batch, falling back to row by row so one bad row loses one row. */
async function insertBatch(
  supabase: SupabaseClient,
  rows: NewItem[],
): Promise<number> {
  const payload = rows.map((row) => ({
    english: row.english,
    source: row.source,
    target_count: row.target_count,
    english_hash: row.english_hash,
  }));

  const { error } = await supabase.from("conversation_items").insert(payload);
  if (!error) return rows.length;

  console.warn(`Batch of ${rows.length} failed, retrying row by row: ${error.message}`);

  let inserted = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const { error: rowError } = await supabase
      .from("conversation_items")
      .insert(payload[index]);
    if (rowError) {
      console.warn(
        `line ${rows[index].line}: not inserted, ${rowError.message}`,
      );
      continue;
    }
    inserted += 1;
  }
  return inserted;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    fail(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. " +
        "Run this through the npm script so .env.local is loaded.",
    );
  }

  let fileText: string;
  try {
    fileText = readFileSync(resolve(options.file), "utf8");
  } catch {
    fail(`Could not read ${options.file}`);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const knownHashes = await loadExistingHashes(supabase);
  const seenHashes = new Set<string>();

  let read = 0;
  let invalid = 0;
  let duplicates = 0;
  let inserted = 0;
  let failed = 0;

  let batch: NewItem[] = [];

  async function flush() {
    if (batch.length === 0) return;
    if (options.dryRun) {
      batch = [];
      return;
    }
    const count = await insertBatch(supabase, batch);
    inserted += count;
    failed += batch.length - count;
    batch = [];
  }

  const lines = fileText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (raw === "") continue;

    read += 1;
    const item = parseLine(raw, index + 1, options);
    if (!item) {
      invalid += 1;
      continue;
    }

    if (knownHashes.has(item.english_hash) || seenHashes.has(item.english_hash)) {
      duplicates += 1;
      console.warn(
        `line ${item.line}: skipped, already imported (hash ${item.english_hash.slice(0, 12)})`,
      );
      continue;
    }

    seenHashes.add(item.english_hash);
    batch.push(item);
    if (batch.length >= BATCH_SIZE) await flush();
  }

  await flush();

  console.log("");
  console.log(`file: ${options.file}`);
  console.log(`source: ${options.source}`);
  console.log(`target count: ${options.targetCount}`);
  console.log(`read: ${read}`);
  console.log(`invalid: ${invalid}`);
  console.log(`duplicates: ${duplicates}`);
  console.log(`inserted: ${inserted}`);
  if (failed > 0) console.log(`failed: ${failed}`);
  if (options.dryRun) console.log("dry run: nothing was inserted");

  if (failed > 0) process.exit(1);
}

void main();
