// Embeddings for meaning-based search: text-embedding-3-small (1536 dims) through OpenAI, or
// OpenRouter for "sk-or-" keys (same model, so stored vectors stay comparable).
// embed() never throws: a slow or failing provider yields null and search falls back to keywords.
import { sliceSafe } from "./text.ts";

export const DIMS = 1536;
const MAX_INPUT_CHARS = 8000; // stays under the model's 8,191-token limit for most text
const RETRY_INPUT_CHARS = 2000; // a second try for text that still turned out too long

export interface Embedder {
  readonly enabled: boolean;
  /** A pgvector literal ("[0.1,...]") for the text, or null when unavailable. */
  embed(text: string, opts: { timeoutMs: number; cache?: boolean }): Promise<string | null>;
}

export interface EmbedderOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Entries in the query cache (least recently used goes first). */
  cacheSize?: number;
  /** After a failure other than HTTP 400, skip calls for this long, so a dead provider costs one timeout. */
  breakerMs?: number;
  now?: () => number;
}

type Provider = { url: string; model: string };
type Attempt = { vector?: string; status: number };

export function providerFor(apiKey: string): Provider {
  return apiKey.startsWith("sk-or-")
    ? { url: "https://openrouter.ai/api/v1/embeddings", model: "openai/text-embedding-3-small" }
    : { url: "https://api.openai.com/v1/embeddings", model: "text-embedding-3-small" };
}

/** Exactly `dims` finite numbers, not all zero (a zero vector's cosine distance is NaN). */
export function toVectorLiteral(v: ArrayLike<unknown>, dims: number = DIMS): string {
  if (v.length !== dims) throw new Error(`expected ${dims} dimensions, got ${v.length}`);
  const out = new Array<number>(dims);
  let nonZero = false;
  for (let i = 0; i < dims; i++) {
    const x = v[i];
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error(`dimension ${i} is not a finite number`);
    out[i] = x;
    nonZero ||= x !== 0;
  }
  if (!nonZero) throw new Error("every dimension is zero");
  return `[${out.join(",")}]`;
}

/** One HTTP call. Timeouts, network errors and malformed replies all come back as status 0. */
async function requestEmbedding(
  provider: Provider,
  apiKey: string,
  doFetch: typeof fetch,
  input: string,
  signal: AbortSignal,
): Promise<Attempt> {
  try {
    const res = await doFetch(provider.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: provider.model, input }),
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return { status: res.status };
    }
    const data = (await res.json()) as { data?: { embedding?: unknown }[] };
    const embedding = data?.data?.[0]?.embedding;
    return Array.isArray(embedding) ? { vector: toVectorLiteral(embedding), status: 200 } : { status: 0 };
  } catch {
    return { status: 0 };
  }
}

function lruCache(size: number) {
  const entries = new Map<string, string>();
  return {
    get(key: string): string | undefined {
      const value = entries.get(key);
      if (value !== undefined) {
        entries.delete(key);
        entries.set(key, value); // most recently used goes to the back
      }
      return value;
    },
    set(key: string, value: string): void {
      entries.set(key, value);
      if (entries.size > size) entries.delete(entries.keys().next().value as string);
    },
  };
}

export function createEmbedder(opts: EmbedderOptions = {}): Embedder {
  const apiKey = opts.apiKey ?? "";
  if (!apiKey) return { enabled: false, embed: async () => null };
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const breakerMs = opts.breakerMs ?? 30_000;
  const provider = providerFor(apiKey);
  const cache = lruCache(opts.cacheSize ?? 256);
  let openUntil = 0;

  // One deadline covers the retry too, so a 400 never doubles the caller's wait.
  async function fetchVector(input: string, timeoutMs: number): Promise<Attempt> {
    const signal = AbortSignal.timeout(timeoutMs);
    const first = await requestEmbedding(provider, apiKey, doFetch, input, signal);
    if (first.status !== 400 || input.length <= RETRY_INPUT_CHARS || signal.aborted) return first;
    return requestEmbedding(provider, apiKey, doFetch, sliceSafe(input, RETRY_INPUT_CHARS), signal);
  }

  return {
    enabled: true,
    async embed(text, { timeoutMs, cache: useCache = false }) {
      const input = sliceSafe(text.trim(), MAX_INPUT_CHARS);
      if (!input) return null;
      const hit = useCache ? cache.get(input) : undefined;
      if (hit) return hit;
      if (now() < openUntil) return null;
      const result = await fetchVector(input, timeoutMs);
      if (result.vector) {
        if (useCache) cache.set(input, result.vector);
        return result.vector;
      }
      if (result.status !== 400) openUntil = now() + breakerMs; // timeout, network, 5xx, 401, 429
      return null;
    },
  };
}
