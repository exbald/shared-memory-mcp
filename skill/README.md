# shared-memory skill

Teaches every agent on your machine to use your shared-memory MCP server: recall project memories at session start, save what lasts, and get a nudge to save when a long session is about to end. `scripts/install.py` wires the hooks, rules and MCP entry into whichever of these tools it finds: Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Cline, Hermes, ZCode, Antigravity, GitHub Copilot CLI, VS Code and Orca. It talks to the server in the parent repo, or to any server with the same tools.

## Install

```bash
export SHARED_MEMORY_URL=https://YOUR_DEPLOYMENT_URL/mcp
export SHARED_MEMORY_API_KEY=YOUR_MCP_API_KEY
python3 scripts/install.py --dry-run   # preview
python3 scripts/install.py
```

The first run saves both values to `~/.config/shared-memory/env` (mode 600), so later runs and the hooks need neither. The installer backs up every file it changes as `<file>.bak.<timestamp>` and is safe to re-run. `--only claude,codex` limits it to some tools. [`references/tools.md`](references/tools.md) lists what it touches in each tool.

## Your own copy with the URL built in

Keep your server URL out of public repos. In a private fork, copy `instance.env.example` to `instance.env`, set `SHARED_MEMORY_URL`, and commit it there. `instance.env` is git-ignored in this repo so it cannot reach it by accident, and it never holds the key. With it in place, a new machine needs only the key. To move the server later, change `SHARED_MEMORY_URL` there and keep the old address as `SHARED_MEMORY_OLD_URL`; `git pull && python3 scripts/install.py` then updates each machine.

## Test

```bash
python3 -m unittest discover -s tests
```
