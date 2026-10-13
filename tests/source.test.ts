import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// A raw U+2028 or U+2029 inside a regex literal is a line break to the parser. Escapes only.
test("sources hold no raw line or paragraph separators", () => {
  const root = new URL("../", import.meta.url);
  const files = ["server.ts", ...["lib", "tests", "tests/helpers"].flatMap((dir) =>
    readdirSync(new URL(dir, root)).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f}`))];
  const offenders = files.filter((f) => /[\u2028\u2029]/.test(readFileSync(new URL(f, root), "utf8")));
  assert.deepEqual(offenders, []);
});
