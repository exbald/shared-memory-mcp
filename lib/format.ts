// Tool output. Every memory prints as one line that starts with "[<uuid>] ", the format
// skill/scripts/mem.py and the session hooks parse, so content is flattened onto that line.
import { sliceSafe } from "./text.ts";
import type { MemoryRow, SimilarRow, Stats } from "./types.ts";

export const SNIPPET_CHARS = 500;
export const HINT_CHARS = 160;

// Whitespace and control characters (stored data predates input validation) become one space.
const flat = (s: string) => s.replace(/[\s\p{Cc}]+/gu, " ").trim();

export const day = (d: Date): string => d.toISOString().slice(0, 10);

/** Collapses whitespace and cuts at a word boundary, never inside a surrogate pair. */
export function snippet(text: string, max: number = SNIPPET_CHARS): { text: string; omitted: number } {
  const s = flat(text);
  if (s.length <= max) return { text: s, omitted: 0 };
  const space = s.lastIndexOf(" ", max);
  const out = sliceSafe(s, space > max * 0.6 ? space : max).trimEnd();
  return { text: out, omitted: s.length - out.length };
}

export function memoryLine(row: MemoryRow, opts: { maxChars?: number; similarity?: number | null } = {}): string {
  const created = day(row.created_at);
  const updated = day(row.updated_at);
  const when = updated !== created ? `${created}, updated ${updated}` : created;
  const similarity = opts.similarity != null ? `(similarity ${opts.similarity.toFixed(2)}) ` : "";
  const { text, omitted } = snippet(row.content, opts.maxChars ?? SNIPPET_CHARS);
  const more = omitted ? ` … (+${omitted} chars; mem_get for the full text)` : "";
  return `[${row.id}] [${when}] [${flat(row.source_agent)}] [${flat(row.category)}] ${similarity}${text}${more}`;
}

const tagsLine = (row: MemoryRow) => `tags: ${row.tags.filter((t) => t != null).map(flat).join(", ") || "none"}`;

export function formatSearch(rows: MemoryRow[], opts: { keywordOnly: boolean }): string {
  if (rows.length === 0) return "No memories found.";
  const noun = rows.length === 1 ? "memory" : "memories";
  const note = opts.keywordOnly ? " (keyword match only; semantic search unavailable)" : "";
  return [`Found ${rows.length} ${noun}${note}:`, ...rows.map((r) => memoryLine(r))].join("\n");
}

export function formatList(rows: MemoryRow[]): string {
  return rows.length ? rows.map((r) => memoryLine(r)).join("\n") : "No memories found.";
}

/** `embedded: null` means the server has no embedding key, so there is nothing to report. */
export function formatAdded(row: MemoryRow, opts: { embedded: boolean | null; similar: SimilarRow[] }): string {
  const lines = [`Saved [${row.category}] (id: ${row.id})`, snippet(row.content).text, tagsLine(row)];
  if (opts.embedded !== null) {
    lines.push(opts.embedded ? "[embedded]" : "[not embedded yet: retried automatically; keyword search already finds it]");
  }
  if (opts.similar.length) {
    lines.push(
      "Similar memories already saved (update or merge instead of keeping a duplicate):",
      ...opts.similar.map((s) => memoryLine(s, { similarity: s.similarity, maxChars: HINT_CHARS })),
    );
  }
  return lines.join("\n");
}

export function formatUpdated(row: MemoryRow, opts: { contentChanged: boolean; embedded: boolean | null }): string {
  const lines = [`Updated [${row.id}]`, snippet(row.content).text, tagsLine(row)];
  if (opts.contentChanged && opts.embedded !== null) {
    lines.push(opts.embedded ? "[re-embedded]" : "[embedding cleared: retried automatically]");
  }
  return lines.join("\n");
}

export function formatGet(row: MemoryRow & { has_embedding: boolean }): string {
  const { id, content, category, tags, source_agent, created_at, updated_at, has_embedding } = row;
  return JSON.stringify(
    { id, content, category, tags, source_agent, created_at: created_at.toISOString(), updated_at: updated_at.toISOString(), has_embedding },
    null,
    2,
  );
}

export function formatStats(s: Stats): string {
  const block = (pairs: [string, number][]) => pairs.map(([name, n]) => `  ${name}: ${n}`).join("\n");
  return `Total: ${s.total}\nWithout embedding: ${s.withoutEmbedding}\n\nBy agent:\n${block(s.byAgent)}\n\nBy category:\n${block(s.byCategory)}`;
}
