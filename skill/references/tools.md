# Where each tool keeps hooks, rules, skills, and MCP config

What `scripts/install.py` touches, and why each tool gets the hook it does. Checked against the versions listed on 2026-10-08, on Linux and macOS.

`~/.config/...` paths are the same on both. The app-support paths differ: `<app support>` is `~/Library/Application Support` on macOS and `$XDG_CONFIG_HOME` (default `~/.config`) on Linux. The installer writes every MCP entry below from `~/.config/shared-memory/env`, and leaves an entry alone when it is already right.

| Tool (version) | Hook file | Events used | Context output | Rules file | Skills dir | MCP config |
|---|---|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` `hooks` | SessionStart, UserPromptSubmit, Stop | `hookSpecificOutput.additionalContext`; Stop `{"decision":"block"}` | `~/.claude/rules/shared-memory.md` | `~/.claude/skills` | `~/.claude.json` `mcpServers` (type http) |
| Codex 0.145 | `~/.codex/hooks.json` | SessionStart, UserPromptSubmit, Stop | same as Claude | `~/.codex/AGENTS.md` | `~/.agents/skills` | `~/.codex/config.toml` `[mcp_servers.x]` + `.http_headers` |
| Gemini CLI 0.29 | `~/.gemini/settings.json` `hooks` | SessionStart, BeforeAgent | `hookSpecificOutput.additionalContext` (JSON only; plain stdout never reaches the model) | `~/.gemini/GEMINI.md` | `~/.agents/skills` | `~/.gemini/settings.json` `mcpServers` (`httpUrl`) |
| ZCode | `~/.zcode/cli/config.json` `hooks.events` + `hooks.enabled: true` | SessionStart (also fires after compact), UserPromptSubmit, Stop | `hookSpecificOutput.additionalContext`; strict schema, extra keys fail | `~/.zcode/AGENTS.md` | `~/.agents/skills` | `~/.zcode/cli/config.json` `mcp.servers` (type remote) |
| Cursor 3.16 | none: imports `~/.claude/settings.json` hooks | (Claude's) | `mem.py` sees `cursor_version` in the payload and answers `additional_context` | Settings > Rules (UI only) | `~/.claude/skills`, `~/.agents/skills` | `~/.cursor/mcp.json` |
| OpenCode 1.18 / 2.0 | plugin `~/.config/opencode/plugins/shared-memory.ts` (2.0 needs a default `{id, server, setup}` export; the installer adds it when `opencode --version` is 2.x) | `experimental.chat.system.transform`, `experimental.session.compacting` | pushes onto the system prompt | `~/.config/opencode/AGENTS.md` | `~/.agents/skills` | `~/.config/opencode/opencode.json` `mcp` (type remote) |
| Hermes 0.21 | `~/.hermes/config.yaml` `hooks.pre_llm_call` + `~/.hermes/shell-hooks-allowlist.json` | pre_llm_call, first turn only (`--once`) | `{"context": ...}` | `~/.hermes/SOUL.md` | `~/.hermes/skills` | `~/.hermes/config.yaml` `mcp_servers` |
| Cline 3.0 | `~/.cline/hooks/PreToolUse` (executable) | PreToolUse, first call per task (`--once`) | `{"contextModification": ...}` | `~/.cline/rules/` | `~/.agents/skills` | `~/.cline/data/settings/cline_mcp_settings.json` (type streamableHttp) |
| Antigravity CLI | `~/.gemini/config/hooks.json` | PreInvocation, every call (`--cached`, no refetch) | `{"injectSteps":[{"ephemeralMessage": ...}]}` | `~/.gemini/GEMINI.md` | `~/.gemini/antigravity-cli/skills` (agy 1.3; older builds: `~/.gemini/config/skills`) | `~/.gemini/config/mcp_config.json` (`serverUrl`) |
| Orca (Codex panes) | `<app support>/orca/codex-runtime-home/home/hooks.json` and `<app support>/orca/codex-accounts/<id>/home/hooks.json` (each is a `CODEX_HOME`; Orca's own hooks are kept) | SessionStart, UserPromptSubmit, Stop | same as Codex | `AGENTS.md` in each home, a link to `~/.codex/AGENTS.md` (Orca's own pattern) | `<home>/skills` | `<home>/config.toml` `[mcp_servers.x]` |
| Orca (Claude Code, OpenCode panes) | nothing extra: Claude Code panes use `~/.claude`; OpenCode panes get an overlay that mirrors `~/.config/opencode` | | | | | |
| GitHub Copilot CLI 1.0 | none | | | `~/.copilot/copilot-instructions.md` | `~/.copilot/skills` | `~/.copilot/mcp-config.json` `mcpServers` (type http, `tools: ["*"]`) |
| VS Code | none (MCP only) | | | | | `<app support>/Code/User/mcp.json` `servers` (type http) |

## Gotchas

- **Codex hooks need trust.** Untrusted hooks never run. After installing, open `codex`, run `/hooks`, and trust the shared-memory ones. Trust is pinned to a hash in `config.toml` (`[hooks.state."<id>"] trusted_hash`), so editing the hook command means trusting it again. Each Orca `CODEX_HOME` keeps its own trust, so approve them once in an Orca Codex pane too.
- **Orca copies `~/.codex/config.toml` into its homes and may rewrite them.** If the shared-memory entry or hooks disappear from an Orca home, rerun the installer.
- **OpenCode 2 runs a background service** (`opencode serve --service`) that loads plugins when it starts. After installing, restart it (or run `opencode run --standalone`) before expecting the memory block. Its standalone runs also wait on each other, so test when no other OpenCode run is active.
- **Cursor runs Claude Code's hooks.** That's `thirdPartyExtensibilityEnabled`, on by default. Don't also write `~/.cursor/hooks.json`, or every hook fires twice.
- **Cline can't inject at task start.** Its TaskStart and UserPromptSubmit hooks run detached and their output is dropped, so the first PreToolUse is the earliest point where context lands. Its rules file covers turns before that.
- **Hermes asks before running a hook for the first time.** Non-interactive runs skip unapproved hooks. The installer writes the `{event, command}` approval itself instead of turning on `hooks_auto_accept`, which would approve every hook.
- **Gemini's PreCompress and Cursor's preCompact can't add context.** Claude Code and ZCode fire SessionStart again after compaction (matcher `compact`), which brings the memories back.
- **Stop nudge.** It only works where the payload includes `transcript_path` (Claude Code, Codex, ZCode). It blocks once after 10 or more tool calls with no `mem_add`/`mem_update`, then stays quiet for the next 10.

## Not covered by `install.py`

- claude.ai, the desktop app, and mobile: the MCP is a connector there, set up in claude.ai's settings.
- Grok Bot (desktop app): its connectors live in the Grok cloud account, not in local files. Set the URL and `X-API-Key` header in Grok itself.
- Remote agents (OpenClaw and Hermes on a server): run the installer on that box. Skills and hooks only cover their own machine.
