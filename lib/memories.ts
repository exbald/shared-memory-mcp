// Every memory read and write, as plain SQL. Vectors travel as pgvector text literals ("[0.1,...]").
import type { Embedder } from "./embeddings.ts";
import type { AddInput, Filters, ListInput, UpdateInput } from "./validate.ts";
import type { MemoryRow, SimilarRow, Sql, Stats } from "./types.ts";

export const COLUMNS = "id, content, category, tags, source_agent, created_at, updated_at";

/** "and ..." conditions for the optional tag, category and agent filters. Call once per use. */
export function filterSql(sql: Sql, f: Filters) {
  return sql`
    ${f.tag ? sql`and tags @> array[${f.tag}::text]` : sql``}
    ${f.category ? sql`and category = ${f.category}` : sql``}
    ${f.agent ? sql`and source_agent = ${f.agent}` : sql``}`;
}

export async function addMemory(sql: Sql, m: AddInput & { id: string; embedding: string | null }): Promise<MemoryRow> {
  const [row] = await sql<MemoryRow[]>`
    insert into memories (id, content, category, tags, source_agent, embedding)
    values (${m.id}, ${m.content}, ${m.category}, ${sql.array(m.tags)}::text[], ${m.agent}, ${m.embedding}::vector)
    returning ${sql.unsafe(COLUMNS)}`;
  return row;
}

/** The closest memories at or above minSimilarity (cosine), for duplicate hints. */
export async function similarMemories(
  sql: Sql,
  embedding: string,
  opts: { excludeId: string; minSimilarity: number; limit: number },
): Promise<SimilarRow[]> {
  return sql<SimilarRow[]>`
    with knn as materialized (
      select id, embedding <=> ${embedding}::vector as distance
      from memories
      where embedding is not null and id <> ${opts.excludeId}
      order by distance
      limit ${opts.limit}
    )
    select m.id, m.content, m.category, m.tags, m.source_agent, m.created_at, m.updated_at,
           (1 - knn.distance)::float8 as similarity
    from knn join memories m on m.id = knn.id
    where knn.distance <= ${1 - opts.minSimilarity}
    order by knn.distance, m.id`;
}

/**
 * Changes only the given fields and sets updated_at. `embedding` is the vector for the new
 * content (null when embedding failed): it replaces the stored vector only if the content
 * really changed, so a stale vector is cleared rather than kept. Returns null if the id is unknown.
 */
export async function updateMemory(
  sql: Sql,
  u: UpdateInput,
  embedding: string | null,
): Promise<(MemoryRow & { content_changed: boolean; embedded: boolean }) | null> {
  const content = u.content ?? null;
  const [row] = await sql<(MemoryRow & { content_changed: boolean; embedded: boolean })[]>`
    with old as (select id, content from memories where id = ${u.id} for update)
    update memories m set
      content = coalesce(${content}::text, m.content),
      category = coalesce(${u.category ?? null}::text, m.category),
      tags = coalesce(${u.tags ? sql.array(u.tags) : null}::text[], m.tags),
      source_agent = coalesce(${u.agent ?? null}::text, m.source_agent),
      embedding = case
        when ${content}::text is null then m.embedding
        when ${content}::text = m.content then coalesce(${embedding}::vector, m.embedding)
        else ${embedding}::vector
      end,
      updated_at = now()
    from old
    where m.id = old.id
    returning m.id, m.content, m.category, m.tags, m.source_agent, m.created_at, m.updated_at,
              (m.content is distinct from old.content) as content_changed,
              (m.embedding is not null) as embedded`;
  return row ?? null;
}

export async function getMemory(sql: Sql, id: string): Promise<(MemoryRow & { has_embedding: boolean }) | null> {
  const [row] = await sql<(MemoryRow & { has_embedding: boolean })[]>`
    select ${sql.unsafe(COLUMNS)}, embedding is not null as has_embedding from memories where id = ${id}`;
  return row ?? null;
}

export async function deleteMemory(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`delete from memories where id = ${id} returning id`;
  return rows.length > 0;
}

/** Newest first. */
export async function listMemories(sql: Sql, input: ListInput): Promise<MemoryRow[]> {
  return sql<MemoryRow[]>`
    select ${sql.unsafe(COLUMNS)} from memories
    where true ${filterSql(sql, input)}
    order by created_at desc, id
    limit ${input.max}`;
}

/** One scan: totals, plus counts by agent and by category, largest first. */
export async function memoryStats(sql: Sql): Promise<Stats> {
  const rows = await sql<{ by_agent: boolean; by_category: boolean; name: string | null; n: number; missing: number }[]>`
    select grouping(source_agent) = 0 as by_agent, grouping(category) = 0 as by_category,
           coalesce(source_agent, category) as name,
           count(*)::int as n, (count(*) filter (where embedding is null))::int as missing
    from memories
    group by grouping sets ((), (source_agent), (category))
    order by n desc, name`;
  const total = rows.find((r) => !r.by_agent && !r.by_category);
  const pairs = (pick: (r: (typeof rows)[number]) => boolean): [string, number][] =>
    rows.filter(pick).map((r) => [r.name ?? "", r.n]);
  return {
    total: total?.n ?? 0,
    withoutEmbedding: total?.missing ?? 0,
    byAgent: pairs((r) => r.by_agent),
    byCategory: pairs((r) => r.by_category),
  };
}

/**
 * Embeds every memory saved without a vector (the provider was down, or slow), `limit` rows per
 * query. Each row is tried at most once per run, so rows that keep failing cannot block the rest.
 * A row edited while its vector was being computed is skipped and picked up on the next run.
 * Rows with blank content are left alone: there is nothing to embed. Never touches updated_at.
 */
export async function backfillEmbeddings(
  sql: Sql,
  embedder: Embedder,
  opts: { limit: number; timeoutMs: number },
): Promise<{ filled: number; skipped: number; failed: number }> {
  const counts = { filled: 0, skipped: 0, failed: 0 };
  if (!embedder.enabled) return counts;
  const tried: string[] = [];
  for (;;) {
    const rows = await sql<{ id: string; content: string }[]>`
      select id, content from memories
      where embedding is null and content ~ '[^[:space:]]' and id <> all(${sql.array(tried)}::uuid[])
      order by created_at, id limit ${opts.limit}`;
    for (const row of rows) {
      tried.push(row.id);
      const vector = await embedder.embed(row.content, { timeoutMs: opts.timeoutMs });
      if (!vector) {
        counts.failed++;
        continue;
      }
      const done = await sql`
        update memories set embedding = ${vector}::vector
        where id = ${row.id} and embedding is null and content = ${row.content}`;
      if (done.count > 0) counts.filled++;
      else counts.skipped++;
    }
    if (rows.length < opts.limit) return counts;
  }
}
