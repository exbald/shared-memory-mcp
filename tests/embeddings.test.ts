import { test } from "node:test";
import assert from "node:assert/strict";
import { DIMS, createEmbedder, providerFor, toVectorLiteral } from "../lib/embeddings.ts";

const goodVector = () => Array.from({ length: DIMS }, (_, i) => ((i % 7) - 3) / 10);
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const ok = () => json(200, { data: [{ embedding: goodVector() }] });

interface Call { url: string; body: { model: string; input: string }; headers: Record<string, string> }

function fakeFetch(handler: (call: Call, init: RequestInit) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    calls.push(call);
    return handler(call, init);
  }) as typeof fetch;
  return { fn, calls };
}

/** Never answers; rejects when the caller's abort signal fires, like a real hung request. */
const hang = (_: Call, init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

test("providerFor: OpenRouter for sk-or- keys, OpenAI otherwise, same model", () => {
  assert.deepEqual(providerFor("sk-or-abc"), { url: "https://openrouter.ai/api/v1/embeddings", model: "openai/text-embedding-3-small" });
  assert.deepEqual(providerFor("sk-proj-abc"), { url: "https://api.openai.com/v1/embeddings", model: "text-embedding-3-small" });
});

test("toVectorLiteral checks dimensions and finite numbers", () => {
  assert.equal(toVectorLiteral(goodVector()).split(",").length, DIMS);
  assert.ok(toVectorLiteral(goodVector()).startsWith("["));
  assert.throws(() => toVectorLiteral([1, 2, 3]));
  assert.throws(() => toVectorLiteral(goodVector().map((v, i) => (i === 5 ? Number.NaN : v))));
  assert.throws(() => toVectorLiteral(new Array(DIMS).fill(0)), /zero/, "a zero vector has no direction to compare");
});

test("without a key the embedder is disabled and never calls out", async () => {
  const { fn, calls } = fakeFetch(ok);
  const e = createEmbedder({ apiKey: "", fetchImpl: fn });
  assert.equal(e.enabled, false);
  assert.equal(await e.embed("hello", { timeoutMs: 100 }), null);
  assert.equal(calls.length, 0);
});

test("returns a pgvector literal and sends the model and the key", async () => {
  const { fn, calls } = fakeFetch(ok);
  const e = createEmbedder({ apiKey: "sk-proj-test", fetchImpl: fn });
  const v = await e.embed("hello", { timeoutMs: 1000 });
  assert.equal(v, toVectorLiteral(goodVector()));
  assert.equal(calls[0].body.model, "text-embedding-3-small");
  assert.equal(calls[0].body.input, "hello");
  assert.equal(calls[0].headers.Authorization, "Bearer sk-proj-test");
});

for (const [name, response] of [
  ["a 500", () => json(500, { error: "boom" })],
  ["a wrong shape", () => json(200, { nope: true })],
  ["wrong dimensions", () => json(200, { data: [{ embedding: [1, 2, 3] }] })],
  ["a NaN value", () => json(200, { data: [{ embedding: goodVector().map((v, i) => (i === 1 ? "NaN" : v)) }] })],
] as const) {
  test(`${name} gives null instead of throwing`, async () => {
    const { fn } = fakeFetch(response);
    const e = createEmbedder({ apiKey: "k", fetchImpl: fn });
    assert.equal(await e.embed("x", { timeoutMs: 1000 }), null);
  });
}

test("a timeout gives up quickly; three failures in a row open the breaker until it cools down", async () => {
  let now = 1_000_000;
  const { fn, calls } = fakeFetch(hang);
  const e = createEmbedder({ apiKey: "k", fetchImpl: fn, breakerMs: 30_000, now: () => now });
  const t0 = Date.now();
  assert.equal(await e.embed("x", { timeoutMs: 100 }), null);
  assert.ok(Date.now() - t0 < 1000, "should not wait much longer than the timeout");
  await e.embed("y", { timeoutMs: 100 });
  assert.equal(calls.length, 2, "one or two slow calls do not switch meaning search off");
  await e.embed("z", { timeoutMs: 100 });
  await e.embed("w", { timeoutMs: 100 });
  assert.equal(calls.length, 3, "breaker open after the third failure: no fourth request");
  now += 30_001;
  await e.embed("v", { timeoutMs: 100 });
  assert.equal(calls.length, 4, "after the cool-down one request goes out");
  await e.embed("u", { timeoutMs: 100 });
  assert.equal(calls.length, 4, "and its failure opens the breaker again at once");
});

test("a success resets the failure count", async () => {
  let fail = true;
  const { fn, calls } = fakeFetch((call, init) => (fail ? json(503, {}) : ok()));
  const e = createEmbedder({ apiKey: "k", fetchImpl: fn });
  await e.embed("a", { timeoutMs: 1000 });
  await e.embed("b", { timeoutMs: 1000 });
  fail = false;
  assert.ok(await e.embed("c", { timeoutMs: 1000 }));
  fail = true;
  await e.embed("d", { timeoutMs: 1000 });
  await e.embed("e", { timeoutMs: 1000 });
  await e.embed("f", { timeoutMs: 1000 });
  assert.equal(calls.length, 6, "two failures, a success, then three more before the breaker opens");
  await e.embed("g", { timeoutMs: 1000 });
  assert.equal(calls.length, 6);
});

test("HTTP 400 retries once with a much shorter input", async () => {
  const { fn, calls } = fakeFetch((call) => (call.body.input.length > 2000 ? json(400, { error: "too long" }) : ok()));
  const e = createEmbedder({ apiKey: "k", fetchImpl: fn });
  const v = await e.embed("y".repeat(5000), { timeoutMs: 1000 });
  assert.ok(v);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.input.length <= 2000);
});

test("the retry after a 400 shares the first attempt's deadline", async () => {
  const { fn, calls } = fakeFetch(async (call, init) => {
    if (calls.length === 1) {
      await new Promise((r) => setTimeout(r, 150));
      return json(400, { error: "too long" });
    }
    return hang(call, init);
  });
  const e = createEmbedder({ apiKey: "k", fetchImpl: fn });
  const t0 = Date.now();
  assert.equal(await e.embed("y".repeat(5000), { timeoutMs: 200 }), null);
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - t0 < 300, `took ${Date.now() - t0} ms; two full timeouts would be 350`);
});

test("long input is cut before it is sent", async () => {
  const { fn, calls } = fakeFetch(ok);
  const e = createEmbedder({ apiKey: "k", fetchImpl: fn });
  await e.embed("z".repeat(20_000), { timeoutMs: 1000 });
  assert.equal(calls[0].body.input.length, 8000);
});

test("queries can be served from a small LRU cache", async () => {
  const { fn, calls } = fakeFetch(ok);
  const e = createEmbedder({ apiKey: "k", fetchImpl: fn, cacheSize: 2 });
  await e.embed("a", { timeoutMs: 1000, cache: true });
  await e.embed("a", { timeoutMs: 1000, cache: true });
  assert.equal(calls.length, 1, "second identical query is cached");
  await e.embed("b", { timeoutMs: 1000, cache: true });
  await e.embed("c", { timeoutMs: 1000, cache: true });
  await e.embed("a", { timeoutMs: 1000, cache: true });
  assert.equal(calls.length, 4, "'a' was evicted by b and c");
  await e.embed("a", { timeoutMs: 1000 });
  assert.equal(calls.length, 5, "writes never use the cache");
});
