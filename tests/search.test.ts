import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Sql } from "../lib/types.ts";
import type { Embedder } from "../lib/embeddings.ts";
import { callTool, type ToolResult } from "../lib/tools.ts";
import { fakeEmbedder } from "./helpers/fake-embedder.ts";
import { fillers, freshSchema, seed, skipWithoutDb, testSql, type SeedRow } from "./helpers/db.ts";

const CONFIG = { minSimilarity: 0.3, dedupSimilarity: 0.82, queryTimeoutMs: 300, writeTimeoutMs: 300 };
const keywordOnly: Embedder = { enabled: false, embed: async () => null };
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const lines = (r: ToolResult) => text(r).split("\n").slice(1); // drop the "Found N ..." header
const idsOf = (r: ToolResult) => lines(r).map((l) => l.slice(1, 37));

describe("hybrid search", { skip: skipWithoutDb }, () => {
  let sql: Sql;
  const ids: Record<string, string> = {};
  const search = (args: unknown, embedder: Embedder = fakeEmbedder(), config = CONFIG) =>
    callTool("mem_search", args, async () => ({ sql, embedder, config }));

  before(async () => {
    sql = testSql();
    await freshSchema(sql);
    await seed(sql, fillers(300)); // 300 memories newer than everything below
    const july = (day: string) => new Date(`2026-07-${day}T09:00:00Z`);
    const named: [string, SeedRow][] = [
      ["upwork", { content: "Upwork job digest cron run: found 30 jobs across 3 queries", createdAt: july("24") }],
      ["postgres", { content: "Chose Postgres over MongoDB for the billing database", createdAt: july("14"), category: "decision" }],
      ["terminal", { content: "Terminal tool does not return stdout from node scripts", createdAt: july("23") }],
      ["code", { content: "Set the embedding model to text-embedding-3-small in api/mcp.ts and skill/scripts/mem.py; tool names use snake_case like mem_search", createdAt: july("10") }],
      ["chinese", { content: "記憶搜尋修好了，舊的備忘錄也找得到", createdAt: july("11") }],
      ["noVector", { content: "Grafana dashboard panel layout for the API latency board", createdAt: july("12"), embedded: false }],
      ["special", { content: "100% sure: under_score and back\\slash both survive", createdAt: july("13") }],
      ["rare1", { content: "rare widget item one", tags: ["rare-tag"], createdAt: july("01") }],
      ["rare2", { content: "rare widget item two", tags: ["rare-tag"], createdAt: july("02") }],
      ["rare3", { content: "rare widget item three", tags: ["rare-tag"], createdAt: july("03"), category: "decision" }],
    ];
    for (const [name, row] of named) [ids[name]] = await seed(sql, [row]);
  });
  after(async () => {
    await sql.end();
  });

  test("bug 1, keyword: an exact phrase from an old memory comes first despite 300 newer rows", async () => {
    assert.equal(idsOf(await search({ query: "Upwork job digest", max: 5 }))[0], ids.upwork);
  });

  test("bug 1, meaning: a paraphrase with no shared keywords finds the old memory", async () => {
    const q = { query: "which datastore did we pick for invoicing", max: 5 };
    assert.equal(idsOf(await search(q))[0], ids.postgres);
    assert.equal(text(await search(q, keywordOnly)), "No memories found.", "keywords alone cannot find it, so meaning did");
  });

  test("meaning works for a second paraphrase", async () => {
    assert.ok(idsOf(await search({ query: "shell output missing", max: 5 })).includes(ids.terminal));
  });

  test("an unrelated query returns nothing instead of junk", async () => {
    assert.equal(text(await search({ query: "quantum chromodynamics lattice", max: 5 })), "No memories found.");
  });

  test("filters apply inside both legs", async () => {
    assert.deepEqual(new Set(idsOf(await search({ query: "item", tag: "rare-tag", max: 10 }))), new Set([ids.rare1, ids.rare2, ids.rare3]));
    assert.deepEqual(idsOf(await search({ query: "item", tag: "rare-tag", category: "decision", max: 10 })), [ids.rare3]);
  });

  test("a slow embedding service falls back to keywords quickly, and says so", async () => {
    const t0 = Date.now();
    const r = await search({ query: "Upwork job digest", max: 5 }, fakeEmbedder({ slowMs: 5000 }), { ...CONFIG, queryTimeoutMs: 300 });
    assert.ok(Date.now() - t0 < 2000, "did not wait for the slow service");
    assert.match(text(r).split("\n")[0], /keyword match only/);
    assert.equal(idsOf(r)[0], ids.upwork);
  });

  test("memories without a vector are still found by keyword", async () => {
    assert.ok(idsOf(await search({ query: "Grafana dashboard", max: 5 })).includes(ids.noVector));
  });

  test("code tokens, paths and identifiers", async () => {
    for (const q of ["text-embedding-3-small", "mem.py", "api/mcp.ts", "snake_case", "mem_search"]) {
      assert.ok(idsOf(await search({ query: q, max: 5 })).includes(ids.code), q);
    }
  });

  test("a Chinese substring is found", async () => {
    assert.ok(idsOf(await search({ query: "搜尋", max: 5 })).includes(ids.chinese));
  });

  test("special characters never break the query; % and _ match literally", async () => {
    for (const q of ["'", "\\", "%", "_", ":*", "&", "|", "!", "(", ")", "' or 1=1 --", "\"unclosed", "a:* & !b | (c"]) {
      assert.notEqual((await search({ query: q, max: 5 })).isError, true, q);
    }
    assert.ok(idsOf(await search({ query: "100%", max: 5 })).includes(ids.special));
    assert.ok(idsOf(await search({ query: "under_score", max: 5 })).includes(ids.special));
    assert.equal(text(await search({ query: "%", max: 5 })), "No memories found.", "a bare % must not match everything");
    for (const q of ["e_w", "e%w"]) assert.equal(text(await search({ query: q, max: 5 })), "No memories found.", `${q} is literal, not a wildcard`);
  });

  test("max is clamped and results are deterministic", async () => {
    assert.ok(lines(await search({ query: "item", max: 999 })).length <= 50);
    assert.equal(text(await search({ query: "rare widget", max: 5 })), text(await search({ query: "rare widget", max: 5 })));
  });

  test("a query that only excludes a word matches nothing, instead of everything else", async () => {
    assert.equal(text(await search({ query: "-quantum", max: 5 })), "No memories found.");
    assert.equal(text(await search({ query: "-quantum", max: 5 }, keywordOnly)), "No memories found.");
  });

  test("a broken all-zero query vector cannot let every row through the similarity floor", async () => {
    const zero: Embedder = { enabled: true, embed: async () => `[${new Array(1536).fill(0).join(",")}]` };
    assert.equal(text(await search({ query: "quantum chromodynamics lattice", max: 5 }, zero)), "No memories found.");
  });

  test("a word that grows past the tsquery limit when lowercased is not an error", async () => {
    const r = await search({ query: "Ⱥ".repeat(1000), max: 5 });
    assert.notEqual(r.isError, true, text(r));
  });

  test("a query with no letters or digits never calls the embedding service", async () => {
    const e = fakeEmbedder();
    for (const q of ["%", "'", "!!!", "-->"]) await search({ query: q, max: 5 }, e);
    assert.equal(e.calls, 0);
  });

  test("without embeddings, any keyword may match (OR), so partial queries still find things", async () => {
    assert.ok(idsOf(await search({ query: "upwork chromodynamics", max: 5 }, keywordOnly)).includes(ids.upwork));
  });

  test("an empty query lists the newest memories, with filters applied", async () => {
    const r = await search({ max: 2 });
    assert.equal(lines(r).length, 2);
    assert.ok(text(r).includes("Note 299"));
    assert.equal(lines(await search({ tag: "rare-tag", max: 10 })).length, 3);
  });
});
