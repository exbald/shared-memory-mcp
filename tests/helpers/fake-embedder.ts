// Deterministic stand-in for the embedding API, so tests never call OpenAI.
// Words are mapped to concepts (a tiny synonym table stands in for "meaning"). Each concept
// adds ±1 to 8 hashed buckets of 1536 and the result is L2-normalised, so cosine similarity
// tracks shared concepts, while two unrelated words that share one bucket move it by ~0.05.
import { DIMS, toVectorLiteral, type Embedder } from "../../lib/embeddings.ts";

const GROUPS: Record<string, string[]> = {
  db: ["database", "databases", "datastore", "postgres", "postgresql", "mongodb", "db", "storage"],
  billing: ["billing", "invoice", "invoices", "invoicing"],
  choose: ["chose", "choose", "pick", "picked", "selected", "select"],
  shell: ["terminal", "shell", "console"],
  output: ["stdout", "output", "print", "printed"],
};
const SYNONYMS = new Map(Object.entries(GROUPS).flatMap(([concept, words]) => words.map((w) => [w, concept] as const)));
const STOP = new Set(["a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "we", "did", "which", "what", "is", "it", "be", "was", "with", "from", "over", "not", "do", "does"]);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Spreads FNV-1a's output (alone it barely varies when only the last character changes). */
function finalize(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const BUCKETS_PER_CONCEPT = 8;

export function fakeVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  const add = (concept: string) => {
    for (let i = 0; i < BUCKETS_PER_CONCEPT; i++) {
      const h = finalize(fnv1a(`${concept}#${i}`));
      v[h % DIMS] += (h >>> 16) & 1 ? -1 : 1; // the sign comes from other bits than the bucket
    }
  };
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!STOP.has(word)) add(SYNONYMS.get(word) ?? word);
  }
  if (!v.some((x) => x !== 0)) add(text);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

export type FakeMode = "ok" | "fail" | { slowMs: number };

export interface FakeEmbedder extends Embedder {
  calls: number;
  mode: FakeMode;
  beforeReturn?: (text: string) => Promise<void>;
}

export function fakeEmbedder(mode: FakeMode = "ok"): FakeEmbedder {
  const e: FakeEmbedder = {
    enabled: true,
    calls: 0,
    mode,
    async embed(text, opts) {
      e.calls++;
      if (e.mode === "fail") return null;
      if (typeof e.mode === "object") {
        const slowMs = e.mode.slowMs;
        await new Promise((r) => setTimeout(r, Math.min(slowMs, opts.timeoutMs)));
        if (slowMs > opts.timeoutMs) return null;
      }
      if (e.beforeReturn) await e.beforeReturn(text);
      return toVectorLiteral(fakeVector(text));
    },
  };
  return e;
}
