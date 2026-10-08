# Shared Memory MCP Server

Cross-agent persistent memory store. Deploy once, connect any MCP-compatible agent.

## Tools

| Tool | Description |
|------|-------------|
| `mem_add` | Save a memory with category, tags, and agent name |
| `mem_search` | Search by keyword, tag, or category (hybrid vector + keyword when `EMBEDDING_API_KEY` is set) |
| `mem_list` | List recent memories |
| `mem_get` | Get a specific memory by ID |
| `mem_update` | Update an existing memory's content, category, tags, or agent (re-embeds on content change) |
| `mem_delete` | Delete a memory by ID |
| `mem_stats` | View memory store statistics |

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

### Claude Desktop
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "shared-memory": {
      "url": "https://YOUR_DEPLOYMENT_URL/mcp"
    }
  }
}
```

### Hermes Agent
Add to `config.yaml`:
```yaml
mcp_servers:
  shared-memory:
    url: "https://YOUR_DEPLOYMENT_URL/mcp"
    transport: streamable-http
```

### Any MCP-compatible agent
Point to `https://YOUR_DEPLOYMENT_URL/mcp` with Streamable HTTP transport.

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description | Required |
|----------|-------------|----------|
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_ANON_KEY` | Supabase anon (public) key | Yes |
| `MCP_API_KEY` | Shared secret to gate the `/mcp` endpoint. Clients pass it via `?key=...`, `X-API-Key:`, or `Authorization: Bearer ...`. If unset, the endpoint is unauthenticated. | No |
| `EMBEDDING_API_KEY` | OpenRouter (`sk-or-…`) or OpenAI API key. Enables hybrid vector + keyword search via `text-embedding-3-small`. | No |

### Auth & threat model

The deployed `/mcp` endpoint accepts a `MCP_API_KEY` as a bearer token, header, or query param. The query-param form is convenient for MCP clients that only accept a URL, but it leaks into proxy/server logs — treat the full URL (including `?key=...`) as a secret, store it the same way you'd store a password, and rotate it in your host's env settings (Coolify or Vercel) if it's exposed. Without `MCP_API_KEY` set, anyone who finds the deployment URL can read and write your memory store.

## Deploy

The same handler (`api/mcp.ts`) runs on either target, against the same Supabase database. You can run both at once; every endpoint sees the same memories.

### Option A: self-host with Docker (Coolify or any VPS)

```bash
docker build -t shared-memory-mcp .
docker run -d -p 3000:3000 --env-file .env shared-memory-mcp
```

`server.ts` serves `/mcp` (and `/api/mcp`) plus `/health` on `PORT` (default 3000). On Coolify, create an application from this repo with the Dockerfile build pack, set the env vars below, expose port 3000, and attach your domain (e.g. `https://memory.example.com/mcp`). Node 24 runs the TypeScript directly, so there is no build step.

### Option B: Vercel

```bash
vercel --prod
```

Set env vars in Vercel dashboard or via CLI:
```bash
vercel env add SUPABASE_URL
vercel env add SUPABASE_ANON_KEY
```

## Make every agent use it

Connecting the MCP only makes the tools available. To have agents actually look things up at session start and save decisions as they go, install the [`shared-memory-mcp` skill](https://github.com/exbald/skills/tree/main/shared-memory-mcp): its `scripts/install.py` adds the rules, the skill, and memory hooks to Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Cline, Hermes, ZCode, and Antigravity.

## Run locally

```bash
cp .env.example .env  # then fill in SUPABASE_URL and SUPABASE_ANON_KEY
node --env-file=.env --experimental-strip-types server.mts
```

## License

[MIT](./LICENSE)
