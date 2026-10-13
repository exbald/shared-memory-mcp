-- The shared-memory schema. Idempotent: the server runs it in one transaction on every boot.
-- To apply it by hand: psql -1 -v ON_ERROR_STOP=1 -f lib/schema.sql
-- Every change sits behind a catalog check, so a boot with nothing to change needs no CREATE
-- privilege and takes no lock on the table while another server instance is still serving it.

-- Give up instead of queueing behind a long transaction; the server retries the whole step.
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- Serialises concurrent runs (two containers during a rolling deploy). Released at commit.
select pg_advisory_xact_lock(7203511046);

do $$
declare
  col text[];
  actual text;
  dflt text[];
begin
  if not exists (select 1 from pg_extension where extname = 'vector') then
    create extension vector;
  end if;

  if to_regclass('memories') is null then
    create table memories (
      id uuid primary key default gen_random_uuid(),
      content text not null,
      category text not null default 'general',
      tags text[] not null default '{}',
      source_agent text not null default 'unknown',
      embedding vector(1536),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  end if;

  -- v1 never wrote updated_at, so a v1 table may lack it (filled from created_at below).
  if not exists (select 1 from pg_attribute where attrelid = 'memories'::regclass and attname = 'updated_at' and not attisdropped) then
    alter table memories add column updated_at timestamptz;
  end if;

  -- A column of another type would fail every query later; fail here, with its name.
  foreach col slice 1 in array array[
    ['id', 'uuid'], ['content', 'text'], ['category', 'text'], ['tags', 'text[]'], ['source_agent', 'text'],
    ['embedding', 'vector(1536)'], ['created_at', 'timestamp with time zone'], ['updated_at', 'timestamp with time zone']]
  loop
    select format_type(atttypid, atttypmod) into actual
    from pg_attribute where attrelid = 'memories'::regclass and attname = col[1] and not attisdropped;
    if actual is distinct from col[2] then
      raise exception 'memories.% is %, expected %', col[1], coalesce(actual, 'missing'), col[2];
    end if;
  end loop;

  -- Inserts rely on these defaults, and a v1 table (or the updated_at added above) may lack them.
  foreach dflt slice 1 in array array[
    ['id', 'gen_random_uuid()'], ['category', '''general'''], ['tags', '''{}'''], ['source_agent', '''unknown'''],
    ['created_at', 'now()'], ['updated_at', 'now()']]
  loop
    if not exists (
      select 1 from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where d.adrelid = 'memories'::regclass and a.attname = dflt[1]
    ) then
      execute format('alter table memories alter column %I set default %s', dflt[1], dflt[2]);
    end if;
  end loop;

  -- Upgrade a table created elsewhere (v1 allowed NULLs): fill, then harden.
  if exists (
    select 1 from pg_attribute
    where attrelid = 'memories'::regclass and attnum > 0 and not attisdropped and not attnotnull
      and attname in ('content', 'category', 'tags', 'source_agent', 'created_at', 'updated_at')
  ) then
    -- Taken up front, so this UPDATE and the ALTER below cannot deadlock with writers.
    lock table memories in access exclusive mode;
    update memories set
      content = coalesce(content, ''),
      category = coalesce(category, 'general'),
      tags = array_remove(coalesce(tags, '{}'), null),
      source_agent = coalesce(source_agent, 'unknown'),
      created_at = coalesce(created_at, now()),
      updated_at = coalesce(updated_at, created_at, now())
    where content is null or category is null or tags is null or array_position(tags, null) is not null
       or source_agent is null or created_at is null or updated_at is null;
    alter table memories
      alter column content set not null,
      alter column category set not null,
      alter column tags set not null,
      alter column source_agent set not null,
      alter column created_at set not null,
      alter column updated_at set not null;
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'memories'::regclass and conname = 'memories_category_check') then
    -- v1 did not check categories. Keep an unknown one as a tag rather than refuse to start.
    update memories set
      tags = case when category = any(tags) then tags else array_append(tags, category) end,
      category = 'general'
    where category not in ('general', 'preference', 'decision', 'fact', 'project', 'person', 'system');
    alter table memories add constraint memories_category_check
      check (category in ('general', 'preference', 'decision', 'fact', 'project', 'person', 'system'));
  end if;

  -- Full-text search column, kept in sync by Postgres itself. STORED: PG 18 defaults to virtual.
  if not exists (select 1 from pg_attribute where attrelid = 'memories'::regclass and attname = 'fts' and not attisdropped) then
    alter table memories add column fts tsvector
      generated always as (to_tsvector('english'::regconfig, content)) stored;
  end if;

  if to_regclass('memories_fts_idx') is null then
    create index memories_fts_idx on memories using gin (fts);
  end if;
  if to_regclass('memories_tags_idx') is null then
    create index memories_tags_idx on memories using gin (tags);
  end if;
  if to_regclass('memories_created_at_idx') is null then
    create index memories_created_at_idx on memories (created_at desc);
  end if;
  -- No vector index: exact cosine search over every row stays fast up to ~20k memories and
  -- never misses. Past that, add HNSW with `create index concurrently` outside this transaction,
  -- and set hnsw.ef_search above the per-list limit in search.ts (plus hnsw.iterative_scan,
  -- since filters apply after the index scan).
end $$;
