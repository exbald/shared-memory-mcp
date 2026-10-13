import { test } from "node:test";
import assert from "node:assert/strict";
import { cached, loadConfig, ping, retry } from "../lib/deps.ts";
import type { Sql } from "../lib/types.ts";

const base = { DATABASE_URL: "postgres://u:p@db:5432/memory", MCP_API_KEY: "k".repeat(32) };

test("loadConfig: DATABASE_URL is required, everything else has a default", () => {
  assert.throws(() => loadConfig({ MCP_API_KEY: "k" }), /DATABASE_URL/);
  const c = loadConfig(base);
  assert.equal(c.port, 3000);
  assert.equal(c.poolMax, 5);
  assert.equal(c.apiKey, base.MCP_API_KEY);
  assert.deepEqual(c.tools, { minSimilarity: 0.3, dedupSimilarity: 0.82, queryTimeoutMs: 2000, writeTimeoutMs: 4000 });
});

test("loadConfig: no API key stops the boot, unless running open is asked for explicitly", () => {
  const { MCP_API_KEY: _, ...noKey } = base;
  assert.throws(() => loadConfig(noKey), /MCP_API_KEY/);
  assert.throws(() => loadConfig({ ...base, MCP_API_KEY: "   " }), /MCP_API_KEY/);
  assert.equal(loadConfig({ ...noKey, MCP_ALLOW_NO_AUTH: "1" }).apiKey, "");
});

test("loadConfig: tuning values are read, and a bad one stops the boot with its name", () => {
  const c = loadConfig({ ...base, SEARCH_MIN_SIMILARITY: "0.25", DEDUP_SIMILARITY: "0.9", PG_POOL_MAX: "8", PORT: "8080" });
  assert.equal(c.tools.minSimilarity, 0.25);
  assert.equal(c.tools.dedupSimilarity, 0.9);
  assert.equal(c.poolMax, 8);
  assert.equal(c.port, 8080);
  assert.throws(() => loadConfig({ ...base, SEARCH_MIN_SIMILARITY: "high" }), /SEARCH_MIN_SIMILARITY/);
  assert.throws(() => loadConfig({ ...base, DEDUP_SIMILARITY: "1.5" }), /DEDUP_SIMILARITY/);
});

test("ping: true when the database answers, false when it errors or hangs past the timeout", async () => {
  const fake = (answer: () => Promise<unknown>) => (() => answer()) as unknown as Sql;
  assert.equal(await ping(fake(async () => [{ "?column?": 1 }]), 100), true);
  assert.equal(await ping(fake(async () => { throw new Error("down"); }), 100), false);
  const t0 = Date.now();
  assert.equal(await ping(fake(() => new Promise(() => {})), 100), false);
  assert.ok(Date.now() - t0 < 1000);
});

test("retry: tries again after a failure, and gives up after the last attempt", async () => {
  let calls = 0;
  const retried: number[] = [];
  const flaky = async () => {
    if (++calls < 3) throw new Error(`fail ${calls}`);
    return "ok";
  };
  assert.equal(await retry(flaky, { attempts: 5, delayMs: 1, onRetry: (n) => retried.push(n) }), "ok");
  assert.deepEqual(retried, [1, 2]);
  calls = -10;
  await assert.rejects(retry(flaky, { attempts: 2, delayMs: 1 }), /fail -8/);
});

test("cached: one check per time window, shared by concurrent callers", async () => {
  let now = 0;
  let calls = 0;
  const check = cached(async () => ++calls % 2 === 1, 2000, () => now);
  assert.deepEqual(await Promise.all([check(), check(), check()]), [true, true, true]);
  assert.equal(calls, 1);
  now = 1999;
  await check();
  assert.equal(calls, 1);
  now = 2000;
  assert.equal(await check(), false);
  assert.equal(calls, 2);
});
