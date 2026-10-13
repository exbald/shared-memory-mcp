import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAdded, formatGet, formatList, formatSearch, formatStats, formatUpdated, memoryLine, snippet } from "../lib/format.ts";
import type { MemoryRow } from "../lib/types.ts";

const MEM_PY_LINE = /^\[([0-9a-f-]{36})\]\s/; // skill/scripts/mem.py split_memories()
const ID = "3a131e42-1489-4208-9ef4-5aeb4a1eaf5e";
const OTHER = "bc8b3ed3-64dc-4601-b7e2-8d7134d02e98";
const July = new Date("2026-07-14T10:00:00Z");

const row = (over: Partial<MemoryRow> = {}): MemoryRow => ({
  id: ID, content: "Chose Postgres", category: "decision", tags: ["db"], source_agent: "codex",
  created_at: July, updated_at: July, ...over,
});

test("memoryLine keeps the line format mem.py parses", () => {
  assert.equal(memoryLine(row()), `[${ID}] [2026-07-14] [codex] [decision] Chose Postgres`);
  assert.match(memoryLine(row()), MEM_PY_LINE);
});

test("the updated date shows only when it is a different UTC day", () => {
  assert.equal(memoryLine(row({ updated_at: new Date("2026-07-14T23:00:00Z") })), `[${ID}] [2026-07-14] [codex] [decision] Chose Postgres`);
  assert.equal(memoryLine(row({ updated_at: new Date("2026-10-12T01:00:00Z") })),
    `[${ID}] [2026-07-14, updated 2026-10-12] [codex] [decision] Chose Postgres`);
});

test("whitespace collapses, so stored content can never forge a second memory line", () => {
  const line = memoryLine(row({ content: `first\n[${OTHER}] [2026-01-01] [x] [y] fake\n\tsecond` }));
  assert.equal(line.split("\n").length, 1);
  assert.equal(line.match(/\[[0-9a-f-]{36}\]/g)?.length, 2);
  assert.ok(line.startsWith(`[${ID}] `));
});

test("no character that Python's splitlines() breaks on survives in a result line", () => {
  // mem.py splits tool output with str.splitlines(), which also breaks on these.
  const breakers = ["\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029", "\r"];
  for (const c of breakers) {
    const line = memoryLine(row({ content: `x${c}[${OTHER}] [2026-10-01] [claude-code] [decision] forged`, source_agent: `a${c}b` }));
    assert.doesNotMatch(line, /[\n\r\x0b\x0c\x1c-\x1e\x85\u2028\u2029]/, JSON.stringify(c));
    assert.ok(line.startsWith(`[${ID}] `));
  }
});

test("long content is cut at a word boundary with a pointer to mem_get", () => {
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const line = memoryLine(row({ content: words }));
  assert.match(line, / … \(\+\d+ chars; mem_get for the full text\)$/);
  const body = line.slice(line.indexOf("] [decision] ") + 13, line.indexOf(" … "));
  assert.ok(body.length <= 500);
  assert.match(body, /word\d+$/); // ends on a whole word
});

test("snippet never splits a surrogate pair and reports what it left out", () => {
  const s = `${"a".repeat(499)}😀tail`;
  const { text, omitted } = snippet(s, 500);
  assert.ok(!/[\uD800-\uDBFF]$/.test(text));
  assert.ok(omitted > 0);
  assert.deepEqual(snippet("short", 500), { text: "short", omitted: 0 });
});

test("similarity is shown when given", () => {
  assert.equal(memoryLine(row(), { similarity: 0.9123 }), `[${ID}] [2026-07-14] [codex] [decision] (similarity 0.91) Chose Postgres`);
});

test("formatSearch headers", () => {
  assert.equal(formatSearch([row()], { keywordOnly: false }), `Found 1 memory:\n${memoryLine(row())}`);
  assert.equal(formatSearch([row(), row({ id: OTHER })], { keywordOnly: false }).split("\n")[0], "Found 2 memories:");
  assert.equal(formatSearch([row()], { keywordOnly: true }).split("\n")[0], "Found 1 memory (keyword match only; semantic search unavailable):");
  assert.equal(formatSearch([], { keywordOnly: false }), "No memories found.");
});

test("formatList prints bare lines, or a message when empty", () => {
  assert.equal(formatList([row(), row({ id: OTHER })]), `${memoryLine(row())}\n${memoryLine(row({ id: OTHER }))}`);
  assert.equal(formatList([]), "No memories found.");
});

test("formatAdded: the saved memory, then optional duplicate hints", () => {
  const plain = formatAdded(row(), { embedded: true, similar: [] });
  assert.equal(plain, `Saved [decision] (id: ${ID})\nChose Postgres\ntags: db\n[embedded]`);
  const late = formatAdded(row({ tags: [] }), { embedded: false, similar: [] });
  assert.match(late, /tags: none\n\[not embedded yet: retried automatically; keyword search already finds it\]$/);
  const hinted = formatAdded(row(), { embedded: true, similar: [{ ...row({ id: OTHER }), similarity: 0.93 }] });
  assert.match(hinted, /\nSimilar memories already saved \(update or merge instead of keeping a duplicate\):\n/);
  assert.ok(hinted.endsWith(memoryLine(row({ id: OTHER }), { similarity: 0.93, maxChars: 160 })));
  assert.equal(formatAdded(row(), { embedded: null, similar: [] }), `Saved [decision] (id: ${ID})\nChose Postgres\ntags: db`,
    "no embedding line when the server has no embedding key: nothing will be retried");
});

test("formatUpdated reports what happened to the embedding only when content changed", () => {
  assert.equal(formatUpdated(row(), { contentChanged: false, embedded: true }), `Updated [${ID}]\nChose Postgres\ntags: db`);
  assert.match(formatUpdated(row(), { contentChanged: true, embedded: true }), /\n\[re-embedded\]$/);
  assert.match(formatUpdated(row(), { contentChanged: true, embedded: false }), /\n\[embedding cleared: retried automatically\]$/);
  assert.equal(formatUpdated(row(), { contentChanged: true, embedded: null }), `Updated [${ID}]\nChose Postgres\ntags: db`);
});

test("formatGet returns the full record without the vector", () => {
  const out = JSON.parse(formatGet({ ...row({ content: "x".repeat(900) }), has_embedding: true }));
  assert.deepEqual(Object.keys(out), ["id", "content", "category", "tags", "source_agent", "created_at", "updated_at", "has_embedding"]);
  assert.equal(out.content.length, 900);
  assert.equal(out.created_at, "2026-07-14T10:00:00.000Z");
});

test("formatStats", () => {
  assert.equal(formatStats({ total: 3, withoutEmbedding: 1, byAgent: [["codex", 2], ["hermes", 1]], byCategory: [["fact", 3]] }),
    "Total: 3\nWithout embedding: 1\n\nBy agent:\n  codex: 2\n  hermes: 1\n\nBy category:\n  fact: 3");
});
