import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, LIMITS, clampMax, isUuid, normalizeTags, parseAdd, parseId, parseList, parseSearch, parseUpdate } from "../lib/validate.ts";

const ID = "3a131e42-1489-4208-9ef4-5aeb4a1eaf5e";

test("clampMax clamps instead of rejecting", () => {
  assert.equal(clampMax(undefined), LIMITS.maxDefault);
  assert.equal(clampMax(0), 1);
  assert.equal(clampMax(-5), 1);
  assert.equal(clampMax(500), LIMITS.maxCap);
  assert.equal(clampMax("10"), 10);
  assert.equal(clampMax("abc"), LIMITS.maxDefault);
  assert.equal(clampMax(7.8), 7);
  assert.equal(clampMax(undefined, 5), 5);
});

test("normalizeTags trims and dedupes, keeps case, and accepts a comma-separated string", () => {
  assert.deepEqual(normalizeTags(["  Amazon SP-API ", "x", "x", ""]), { ok: true, value: ["Amazon SP-API", "x"] });
  assert.deepEqual(normalizeTags("a, b ,a"), { ok: true, value: ["a", "b"] });
  assert.deepEqual(normalizeTags(undefined), { ok: true, value: [] });
  assert.equal(normalizeTags([1, 2]).ok, false);
  assert.equal(normalizeTags(Array.from({ length: LIMITS.tags + 1 }, (_, i) => `t${i}`)).ok, false);
  assert.equal(normalizeTags(["x".repeat(LIMITS.tag + 1)]).ok, false);
});

test("isUuid", () => {
  assert.ok(isUuid(ID));
  assert.ok(isUuid(ID.toUpperCase()));
  assert.ok(!isUuid("not-a-uuid"));
  assert.ok(!isUuid(42));
  assert.ok(!isUuid(`${ID}x`));
});

test("parseAdd fills defaults, trims, and strips NUL characters", () => {
  assert.deepEqual(parseAdd({ content: "  hello\u0000 world  " }),
    { ok: true, value: { content: "hello world", category: "general", tags: [], agent: "unknown" } });
  assert.deepEqual(parseAdd({ content: "x", tags: ["P1"], agent: " codex ", category: "decision" }),
    { ok: true, value: { content: "x", category: "decision", tags: ["P1"], agent: "codex" } });
});

test("control characters are stripped on the way in; tab, newline and carriage return stay", () => {
  const r = parseAdd({ content: "a\u001eb\u0085c\u0007d\te\nf\r\ng\u007f", tags: ["t\u001cx"] });
  assert.deepEqual(r, { ok: true, value: { content: "abcd\te\nf\r\ng", category: "general", tags: ["tx"], agent: "unknown" } });
});

test("agent names cannot carry brackets, so they cannot fake the [agent] [category] fields", () => {
  assert.equal(parseAdd({ content: "x", agent: "codex] [decision" }).ok, false);
  assert.equal(parseUpdate({ id: ID, agent: "[x]" }).ok, false);
  assert.deepEqual(parseAdd({ content: "x", agent: "meta-pm" }), { ok: true, value: { content: "x", category: "general", tags: [], agent: "meta-pm" } });
  assert.deepEqual(parseList({ agent: "[legacy]" }), { ok: true, value: { max: LIMITS.maxDefault, agent: "[legacy]" } }, "filters still match any stored name");
});

test("parseAdd rejects empty or oversized content, unknown categories and long agent names", () => {
  assert.equal(parseAdd({ content: "   " }).ok, false);
  assert.equal(parseAdd({}).ok, false);
  assert.equal(parseAdd(null).ok, false);
  assert.equal(parseAdd({ content: "x".repeat(LIMITS.content + 1) }).ok, false);
  assert.equal(parseAdd({ content: "x", agent: "a".repeat(LIMITS.agent + 1) }).ok, false);
  const bad = parseAdd({ content: "x", category: "nope" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /category/);
  assert.ok(CATEGORIES.includes("decision"));
});

test("parseUpdate needs a UUID and at least one valid field", () => {
  assert.equal(parseUpdate({ id: "nope", content: "x" }).ok, false);
  assert.equal(parseUpdate({ id: ID }).ok, false);
  assert.equal(parseUpdate({ id: ID, content: " " }).ok, false);
  assert.equal(parseUpdate({ id: ID, category: "bad" }).ok, false);
  assert.deepEqual(parseUpdate({ id: ID, tags: ["a"] }), { ok: true, value: { id: ID, tags: ["a"] } });
  assert.deepEqual(parseUpdate({ id: ID, content: " new ", agent: "codex" }), { ok: true, value: { id: ID, content: "new", agent: "codex" } });
});

test("parseUpdate treats null as not given (some clients send null for every unset field)", () => {
  assert.deepEqual(parseUpdate({ id: ID, content: "x", tags: null, agent: null, category: null }), { ok: true, value: { id: ID, content: "x" } });
  assert.equal(parseUpdate({ id: ID, tags: null }).ok, false, "nothing left to update");
  assert.deepEqual(parseUpdate({ id: ID, tags: [] }), { ok: true, value: { id: ID, tags: [] } }, "[] still clears tags");
});

test("search degrades instead of failing: a long query is cut, long filters are allowed", () => {
  const r = parseSearch({ query: "y".repeat(LIMITS.query + 500), tag: "t".repeat(200), agent: "a".repeat(200) });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.query.length, LIMITS.query);
    assert.equal(r.value.tag?.length, 200);
  }
});

test("parseSearch: optional filters, clamped max, empty query allowed", () => {
  assert.deepEqual(parseSearch({}), { ok: true, value: { query: "", max: LIMITS.maxDefault } });
  assert.deepEqual(parseSearch({ query: " x ", tag: "t", category: "fact", agent: "codex", max: 999 }),
    { ok: true, value: { query: "x", tag: "t", category: "fact", agent: "codex", max: LIMITS.maxCap } });
  assert.equal(parseSearch({ category: "bad" }).ok, false);
});

test("parseList and parseId", () => {
  assert.deepEqual(parseList({ max: "3", agent: "a" }), { ok: true, value: { max: 3, agent: "a" } });
  assert.deepEqual(parseList(undefined), { ok: true, value: { max: LIMITS.maxDefault } });
  assert.deepEqual(parseId({ id: ID }), { ok: true, value: { id: ID } });
  assert.equal(parseId({ id: "x" }).ok, false);
});
