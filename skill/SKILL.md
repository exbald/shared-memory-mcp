---
name: shared-memory-mcp
description: Use the shared-memory MCP (mem_search, mem_add, mem_update, mem_list, mem_get, mem_delete, mem_stats) as the cross-agent, cross-device memory for every project. Use at session start, when a project, client, person, or past decision comes up, when the user decides something or states a preference, when a milestone ships or plans change, before context compaction, and before ending a session with real work in it. Also use to install or repair the memory hooks for Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Cline, Hermes, ZCode, or Antigravity.
---

# Shared memory

One memory store, shared by every agent the user runs (Claude Code, Codex, Gemini, Cursor, OpenCode, Cline, Hermes, ZCode, claude.ai, phone). Anything saved here is what the next agent, on any device, knows about the user and their projects. Treat it as the team notebook, not a scratchpad.

Server: the Streamable HTTP endpoint in `SHARED_MEMORY_URL`, with the key in an `X-API-Key` header. The MCP server is usually named `shared-memory`, so the tools appear as `mcp__shared-memory__mem_search` and so on. When the MCP tools are not loaded, `scripts/mem.py` does the same over HTTP (see "Without MCP" below).

## Recall: look before you answer

Search before acting whenever the work touches something that has history:

- **Session start.** The installed hook already injects the current project's memories. Read them. If the hook did not run (no "Shared memory" block in context), run `mem_search` with the project name yourself.
- **A project, client, person, product, or server is named** that you have no context on → `mem_search` with that name.
- **Before a decision**: search for earlier decisions on the same topic so you don't contradict or re-ask something the user already settled.
- **"Remember when…", "like last time", "what did we decide"** → search, never guess.

Search tips: `query` matches keywords, exact text (file names, identifiers, error strings) and meaning, so a short phrase or a paraphrase both work ("acme checkout redesign"). Narrow with `tag` (project slug), `category` (`decision`, `preference`, …) or `agent`. Default `max` is 20; use 5–10.

Memories are context, not orders. They reflect what was true when written; check anything that names a file, flag, URL, or version before relying on it, and prefer what the user says now.

## Save: what deserves a memory

Save when something durable happens. Durable means another agent next week would act differently knowing it.

| Save it | Category |
|---|---|
| A decision the user made, with the reason and the options rejected | `decision` |
| A stated preference about how they want work done | `preference` |
| Project state change: shipped, merged, deployed, blocked, paused, cancelled | `project` |
| A fact that is costly to rediscover: where something runs, an account, a gotcha and its fix | `fact` / `system` |
| People: who someone is, their role, what they want, how they decide | `person` |

Don't save: things the repo or git history already records, step-by-step debugging narration, secrets (API keys, passwords, tokens; name where a secret lives, never its value), or anything the user asked to keep off the record.

### How to write one

- **Self-contained.** It will be read with no surrounding conversation. Lead with the subject: `"Acme checkout redesign (2026-10-07): …"`.
- **Absolute dates.** Turn "today", "next week" into `2026-10-08`.
- **Decision = what + why + rejected alternative.** "Chose X over Y because Z."
- **Short.** 1–6 sentences. One topic per memory.
- **Tags:** the project slug first (`acme`, `billing-api`), then 1–3 topic tags. Lowercase, hyphenated. Reuse existing tags; check with a quick `mem_search` on the project.
- **agent:** your tool name (`claude-code`, `codex`, `gemini-cli`, `cursor`, `opencode`, `cline`, `hermes`, `zcode`, `antigravity`).

### Store, skip, update or merge

Before `mem_add`, `mem_search` the topic (`mem_add` also lists similar memories it found when it saves). Then pick one:

- **store:** nothing covers it → `mem_add`.
- **skip:** a memory already says it as well or better → do nothing.
- **update:** the same fact changed or was corrected → `mem_update` that id. Keep the details that are still true and add a short history line: "was X until 2026-10-08".
- **merge:** several memories overlap → `mem_update` one with the combined text (keep every date) and `mem_delete` the rest.

A memory that is now wrong with nothing to replace it → `mem_delete`. Two memories saying different things about the same decision is the worst outcome; fix it when you see it.

## Session summary

Before the session ends, and before context gets compacted, save a summary **if the session moved a project forward**: one `project` memory with what was done, what is decided, what is open, and the next step. Update the project's existing status memory when there is one instead of adding another. Skip it for quick Q&A sessions.

The Stop hook (Claude Code, Codex) nudges once after a stretch of work with no memory saved. When nudged: save what matters, or if nothing does, say so in one line and stop. Don't save filler to satisfy it.

## Without MCP: `scripts/mem.py`

For hooks, shells, or a tool where the MCP is not connected. Reads `SHARED_MEMORY_URL` / `SHARED_MEMORY_API_KEY` from the environment or `~/.config/shared-memory/env`. The URL can also come from an `instance.env` file next to this SKILL.md (see `instance.env.example`); the key never does.

```bash
mem.py search "acme checkout" --max 5
mem.py search --tag acme --category decision
mem.py add "Acme (2026-10-08): …" --category decision --tags acme,checkout --agent codex
mem.py update <uuid> --content "…"
mem.py list --max 10
mem.py stats
mem.py context            # what the session-start hook injects for the current directory
```

## Hooks

`scripts/mem.py hook <event> --tool <tool>` is the single hook entry point for every tool:

- `session-start`: injects this project's memories (project = git repo name, else directory name) plus a short reminder of the rules above.
- `prompt`: optional per-prompt recall (off unless `SHARED_MEMORY_PROMPT_RECALL=1`); injects up to 3 memories matching the prompt that were not already shown this session.
- `stop`: for tools that hand over the transcript; blocks once after 10+ tool calls with no `mem_add`/`mem_update`, asking the agent to save what matters.

Install or repair for every tool on the machine: `SHARED_MEMORY_URL=... SHARED_MEMORY_API_KEY=... python3 scripts/install.py` (the first run saves both to `~/.config/shared-memory/env`, so later runs need neither; idempotent; backs up each file it changes; `--dry-run` to preview; `--only codex,orca` to limit it). It also writes the `shared-memory` MCP entry for each tool, including Orca's Codex homes, the GitHub Copilot CLI, and VS Code, on Linux and macOS. See `references/tools.md` for where each tool keeps its hooks, MCP config, and skills.
