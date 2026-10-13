# Shared Memory MCP Server

Persistent memory that every MCP agent shares. Deploy it once, connect Claude Code, Codex, Cursor, Hermes or any other MCP client, and what one agent saves the others can find.

It is one small Node server and one Postgres table. Search combines full-text keywords, exact substrings and embeddings, so an agent finds a memory from last year by an exact phrase, a file name or a paraphrase.

## Tools

| Tool | What it does |
|------|-------------|
| `mem_add` | Save a memory with a category, tags and the agent's name. The reply lists similar memories already saved, so the agent can update or merge instead of adding a duplicate. |
| `mem_search` | Hybrid search over every memory (see below). Filter by tag, category or agent. An empty query lists the newest. |
| `mem_list` | List the newest memories, optionally by category or agent. |
| `mem_get` | One memory in full. Search and list cut long memories at 500 characters. |
| `mem_update` | Change content, category, tags or agent. Keeps `created_at`, sets `updated_at`, re-embeds changed content. |
| `mem_delete` | Delete a memory. |
| `mem_stats` | Totals by agent and category, and how many memories still lack an embedding. |

Categories: `general`, `preference`, `decision`, `fact`, `project`, `person`, `system`.

## How search works

One SQL statement builds three ranked lists over all memories and merges them with reciprocal rank fusion (each list adds `1 / (60 + rank)`):

1. **Keywords:** Postgres full-text search with English stemming, so "deploying" matches "deployed".
2. **Exact text:** a case-insensitive substring match, for code identifiers, paths, version strings and Chinese or Japanese text that full-text search does not split into words.
3. **Meaning:** cosine similarity between the query's embedding and each memory's (`text-embedding-3-small`, 1536 dimensions). Only matches above `SEARCH_MIN_SIMILARITY` count, so an unrelated query returns nothing instead of the closest junk.

If the embedding service is slow (over 1.5 s) or down, search answers from keywords alone and says so in its first line. A memory saved while embeddings were down is still found by keyword, and the server fills in its vector later (on boot and every hour).

Vector search is exact, with no approximate index: it compares the query with every stored vector, which takes a few milliseconds for thousands of memories.

## Run it

You need Docker, or Node 24+ and a Postgres with the [pgvector](https://github.com/pgvector/pgvector) extension available.

### Docker Compose (server and database)

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, MCP_API_KEY (openssl rand -hex 32) and EMBEDDING_API_KEY
docker compose up -d
```

Agents on the same machine connect to `http://localhost:3000/mcp`. The port is published on 127.0.0.1 only; to use the server from other machines, put an HTTPS reverse proxy (Caddy, Traefik, nginx) in front of it.

### Your own Postgres

```bash
docker build -t shared-memory-mcp .
docker run -d -p 3000:3000 -e DATABASE_URL=postgres://... -e MCP_API_KEY=... -e EMBEDDING_API_KEY=... shared-memory-mcp
```

Or without Docker: `npm ci && node --env-file=.env server.ts`.

On first boot the server creates its table and indexes (`lib/schema.sql`). It runs the same idempotent step on every boot, so upgrades need no migration command, and a boot with nothing to change needs no CREATE privilege. If the database is not reachable yet, it retries for about 30 seconds, then exits.

On Coolify: create a PostgreSQL database with the image `pgvector/pgvector:pg18`, create an application from this repo with the Dockerfile build pack and port 3000, set `DATABASE_URL` to the database's internal URL and `MCP_API_KEY` to a new secret, and attach your domain. `/health` checks the database, so a deploy that cannot reach it never takes traffic.

### Environment variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | Postgres connection string. The `vector` extension must be installable (it is in the pgvector images). | Yes |
| `MCP_API_KEY` | Shared secret for `/mcp`, sent as `X-API-Key:`, `Authorization: Bearer ...` or `?key=...`. Make one with `openssl rand -hex 32`. | Yes |
| `MCP_ALLOW_NO_AUTH` | `1` lets the server start without `MCP_API_KEY`, open to anyone who can reach it. | No |
| `EMBEDDING_API_KEY` | OpenAI key, or OpenRouter key (`sk-or-...`). Without it search uses keywords only. | No |
| `SEARCH_MIN_SIMILARITY` | Cosine floor for the meaning half of search. Default `0.30`. | No |
| `DEDUP_SIMILARITY` | `mem_add` lists existing memories at least this similar. Default `0.82`. | No |
| `PG_POOL_MAX` | Database connections. Default `5`. | No |
| `PORT` | Default `3000`. | No |

### Auth and threat model

The key can travel as a header or as `?key=...`. The query form suits MCP clients that only accept a URL, but it ends up in proxy and server logs, so treat the full URL as a secret and rotate the key in your host's settings if it leaks. Rejected keys are logged (the path only, never the key).

Anyone with the key can read, rewrite and delete every memory, and whatever they save is shown to every agent's later sessions. Give the key only to agents you trust, and keep the database backed up: there is no edit history.

## Connect any MCP agent

### Claude Code
For every project: `claude mcp add --scope user --transport http shared-memory https://YOUR_DEPLOYMENT_URL/mcp --header "X-API-Key: YOUR_MCP_API_KEY"`. Or per project in `.mcp.json`:
```json
{
  "mcpServers": {
    "shared-memory": {
      "type": "http",
      "url": "https://YOUR_DEPLOYMENT_URL/mcp",
      "headers": { "X-API-Key": "YOUR_MCP_API_KEY" }
    }
  }
}
```

### Claude Desktop and claude.ai
Settings → Connectors → Add custom connector, with the URL `https://YOUR_DEPLOYMENT_URL/mcp?key=YOUR_MCP_API_KEY` (connectors take a URL only, so the key goes in the query).

### Hermes Agent
Add to `config.yaml`:
```yaml
mcp_servers:
  shared-memory:
    url: "https://YOUR_DEPLOYMENT_URL/mcp"
    transport: streamable-http
    headers:
      X-API-Key: "YOUR_MCP_API_KEY"
```

### Any MCP-compatible agent
Point it at `https://YOUR_DEPLOYMENT_URL/mcp` with the Streamable HTTP transport.

## Make every agent use it

Connecting the MCP only makes the tools available. To have agents look things up at session start and save decisions as they go, install the [skill in `skill/`](./skill). Its `scripts/install.py` adds the rules, the skill and memory hooks to Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Cline, Hermes, ZCode and Antigravity, and writes the MCP entry for each:

```bash
export SHARED_MEMORY_URL=https://YOUR_DEPLOYMENT_URL/mcp
export SHARED_MEMORY_API_KEY=YOUR_MCP_API_KEY
python3 skill/scripts/install.py --dry-run   # preview
python3 skill/scripts/install.py
```

## Upgrading from v1

v1 kept memories in Supabase and also ran on Vercel. v2 talks to any Postgres through `DATABASE_URL` and runs as a long-lived server (Docker, Coolify, any VPS). Tool names, arguments and the result line format are unchanged, so agents need no change beyond the URL if the server moves.

The boot-time schema step also upgrades a v1-shaped `memories` table in place, keeping every row and timestamp:
- it fills NULLs and adds a missing `updated_at` (from `created_at`);
- it adds the full-text column and the category check, moving any category v1 accepted outside the list into the memory's tags (the category becomes `general`);
- it stops with a clear message if a column has an unexpected type.

Copy your v1 table into the new database, or point `DATABASE_URL` at the old one.

## Develop

```bash
npm test            # Postgres + pgvector and Node 24 in Docker; tears itself down
npm run typecheck
```

Tests use a deterministic fake embedder, so they never call an embedding API.

## License

[MIT](./LICENSE)
