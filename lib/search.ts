// Hybrid search over every memory, in one SQL statement. Up to three ranked lists:
//   keyword: Postgres full-text search (stemmed English words),
//   exact:   a case-insensitive substring match, for code tokens, paths and CJK text,
//   meaning: cosine similarity to the query embedding, above a floor so junk stays out,
// merged by reciprocal rank fusion: score = sum over lists of 1 / (60 + rank).
import type { Embedder } from "./embeddings.ts";
import { filterSql, listMemories } from "./memories.ts";
import type { SearchInput } from "./validate.ts";
import type { SearchRow, Sql } from "./types.ts";

const RRF_K = 60;
const HAS_WORDS = /[\p{L}\p{N}]/u;
const NON_ASCII = /[^\x00-\x7f]/;

export interface SearchOptions {
  minSimilarity: number;
  queryTimeoutMs: number;
}

/** An escaped ILIKE pattern, or null for queries too short to mean anything as a substring. */
export function substringPattern(query: string): string | null {
  const minLength = NON_ASCII.test(query) ? 2 : 3;
  if (query.length < minLength) return null;
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchMemories(
  sql: Sql,
  embedder: Embedder,
  input: SearchInput,
  opts: SearchOptions,
): Promise<{ rows: SearchRow[]; keywordOnly: boolean }> {
  if (!input.query) {
    const rows = await listMemories(sql, input);
    return { rows: rows.map((r) => ({ ...r, score: 0, similarity: null })), keywordOnly: false };
  }
  const hasWords = HAS_WORDS.test(input.query);
  const vector = hasWords ? await embedder.embed(input.query, { timeoutMs: opts.queryTimeoutMs, cache: true }) : null;
  const rows = await hybrid(sql, input, { vector, hasWords, minSimilarity: opts.minSimilarity });
  return { rows, keywordOnly: hasWords && !vector };
}

type Leg = ReturnType<Sql>;
type HybridOptions = { vector: string | null; hasWords: boolean; minSimilarity: number };

/** With meaning available, keywords must all match (precise); without it, any may (recall). */
function keywordLeg(sql: Sql, input: SearchInput, o: HybridOptions, limit: number): Leg {
  const tsquery = o.vector
    ? sql`websearch_to_tsquery('english'::regconfig, ${input.query})`
    : sql`replace(plainto_tsquery('english'::regconfig, ${input.query})::text, ' & ', ' | ')::tsquery`;
  // querytree(q) = 'T' for a pure negation ("-word"), which would match nearly every row.
  return sql`
    select id, row_number() over (order by ts_rank_cd(fts, q) desc, created_at desc, id) as rank, null::float8 as similarity
    from memories, (select ${tsquery} as q) query
    where fts @@ q and querytree(q) <> 'T' ${filterSql(sql, input)}
    order by rank limit ${limit}`;
}

function exactLeg(sql: Sql, input: SearchInput, pattern: string, limit: number): Leg {
  return sql`
    select id, row_number() over (order by created_at desc, id) as rank, null::float8 as similarity
    from memories
    where content ilike ${pattern} ${filterSql(sql, input)}
    order by rank limit ${limit}`;
}

/** Nearest first, then the floor. Written as `distance <= 1 - floor` so a NaN distance never passes. */
function meaningLeg(sql: Sql, input: SearchInput, o: HybridOptions & { vector: string }, limit: number): Leg {
  return sql`
    select id, row_number() over (order by distance, id) as rank, (1 - distance)::float8 as similarity
    from (
      select id, embedding <=> ${o.vector}::vector as distance
      from memories
      where embedding is not null ${filterSql(sql, input)}
      order by distance limit ${limit}
    ) nearest
    where distance <= ${1 - o.minSimilarity}`;
}

async function hybrid(sql: Sql, input: SearchInput, o: HybridOptions): Promise<SearchRow[]> {
  const perList = Math.max(20, 3 * input.max);
  const pattern = substringPattern(input.query);
  const legs: Leg[] = [];
  if (o.hasWords) legs.push(keywordLeg(sql, input, o, perList));
  if (pattern) legs.push(exactLeg(sql, input, pattern, perList));
  if (o.vector) legs.push(meaningLeg(sql, input, { ...o, vector: o.vector }, perList));
  if (legs.length === 0) return [];
  const hits = legs.slice(1).reduce((all, leg) => sql`${all} union all (${leg})`, sql`(${legs[0]})`);

  return sql<SearchRow[]>`
    with hits as (${hits}),
    fused as (
      select id, sum(1.0 / (${RRF_K} + rank))::float8 as score, max(similarity) as similarity
      from hits group by id
    )
    select m.id, m.content, m.category, m.tags, m.source_agent, m.created_at, m.updated_at, f.score, f.similarity
    from fused f join memories m on m.id = f.id
    order by f.score desc, m.created_at desc, m.id
    limit ${input.max}`;
}
