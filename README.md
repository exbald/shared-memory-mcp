# Shared Memory MCP Server

Cross-agent persistent memory store. Deploy once, connect any MCP-compatible agent.

## Tools

| Tool | Description |
|------|-------------|
| `mem_add` | Save a memory with category, tags, and agent name |
| `mem_search` | Search by keyword, tag, or category |
| `mem_list` | List recent memories |
| `mem_get` | Get a specific memory by ID |
| `mem_delete` | Delete a memory by ID |
| `mem_stats` | View memory store statistics |

## Connect any MCP agent

### Claude Code
Add to `.mcp.json` in your project root:
```json
{
  "mcpServers": {
    "shared-memory": {
      "url": "https://YOUR_DEPLOYMENT_URL/mcp"
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

| Variable | Description | Required |
|----------|-------------|----------|
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_ANON_KEY` | Supabase anon (public) key | Yes |

## Deploy to Vercel

```bash
vercel --prod
```

Set env vars in Vercel dashboard or via CLI:
```bash
vercel env add SUPABASE_URL
vercel env add SUPABASE_ANON_KEY
```

## Run locally

```bash
SUPABASE_URL=your_url SUPABASE_ANON_KEY=your_key node --experimental-strip-types server.mts
```
