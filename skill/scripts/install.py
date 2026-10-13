#!/usr/bin/env python3
"""Install shared-memory skill, rules, and hooks into every agent tool on this machine.

Idempotent: re-running replaces this skill's own entries and leaves everything else alone.
Every changed file is backed up as <file>.bak.<timestamp> first.

  install.py              install for every tool found
  install.py --dry-run    show what would change
  install.py --only claude,codex
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

# `python3 -I`, `-P` and `-m` do not put this folder on the import path, so add it.
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import mem  # noqa: E402  config resolution is shared with the hooks

HOME = os.path.expanduser("~")
MACOS = sys.platform == "darwin"
APP_SUPPORT = f"{HOME}/Library/Application Support" if MACOS else os.environ.get("XDG_CONFIG_HOME", f"{HOME}/.config")
SERVER = "shared-memory"  # MCP server name in every config
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
SKILL_LINK = f"{HOME}/.agents/skills/shared-memory-mcp"
MEM = f"{SKILL_LINK}/scripts/mem.py"
MARK = "shared-memory-mcp/scripts/mem.py"  # identifies our hook entries
OLD_ECHO = re.compile(r"memory-search|memory-ingest|SESSION STARTED: Search memory")  # retired CORE-memory nudges
BLOCK_START, BLOCK_END = "<!-- shared-memory:start -->", "<!-- shared-memory:end -->"
TS = str(int(time.time()))

RULES_BLOCK = f"""{BLOCK_START}
## Shared memory (MCP `shared-memory`)

One memory store shared by every agent and device the user runs. Use it, don't just know about it.

- **Recall first.** A session-start hook injects this project's memories when the tool supports it. Before answering about a project, client, person, server, or earlier decision, `mem_search` it. Never guess what was decided.
- **Save what lasts.** Decisions (what + why + what was rejected), stated preferences, project status changes (shipped, merged, blocked, paused), and facts that are costly to rediscover. `category` + project-slug tag first + your tool name as `agent`. Self-contained, absolute dates, 1–6 sentences.
- **Store, skip, update or merge.** `mem_search` the topic before `mem_add` (`mem_add` also lists similar memories). Store it if nothing covers it; skip it if a memory already says it; `mem_update` that id if the fact changed; merge overlapping memories into one with `mem_update` and `mem_delete` the rest. `mem_delete` a memory that is now wrong.
- **Never save secrets** or what git/the repo already records.
- **Session summary.** Before ending a session (or before compaction) that moved a project forward, save or update one `project` status memory: done, decided, open, next step.
- Without MCP tools: `python3 {MEM} search|add|update ...`. Full rules: the `shared-memory-mcp` skill.
{BLOCK_END}
"""


def load_env():
    """(url, key), resolved exactly as mem.py resolves them."""
    cfg = mem.load_config()
    return cfg["url"], cfg["key"]


def old_url():
    """A retired server URL that Codex's config.toml may still hold (SHARED_MEMORY_OLD_URL in instance.env), or ''."""
    return mem.read_env_file(mem.INSTANCE_FILE).get("SHARED_MEMORY_OLD_URL", "")


def follow_instance_url(inst):
    """The saved env file still holds the URL that instance.env retired: point it at the current one."""
    old = old_url()
    if not (old and inst.url and inst.url != old and mem.read_env_file(mem.ENV_FILE).get("SHARED_MEMORY_URL") == old):
        return
    with open(mem.ENV_FILE) as f:
        text = f.read()
    pattern = r"(?m)^(\s*(?:export\s+)?SHARED_MEMORY_URL\s*=\s*)(['\"]?)" + re.escape(old) + r"\2(?=\s*(?:#.*)?$)"
    inst.write(mem.ENV_FILE, re.sub(pattern, lambda m: m.group(1) + m.group(2) + inst.url + m.group(2), text), mode=0o600)


def orca_codex_homes():
    """CODEX_HOME directories Orca creates for the Codex panes it runs."""
    root = f"{APP_SUPPORT}/orca"
    homes = [f"{root}/codex-runtime-home/home"]
    accounts = f"{root}/codex-accounts"
    if os.path.isdir(accounts):
        homes += [f"{accounts}/{a}/home" for a in sorted(os.listdir(accounts))]
    return [h for h in homes if os.path.isfile(f"{h}/config.toml")]


OPENCODE2_EXPORT = """
// OpenCode 2: a default plugin object (id + server plugin + setup). Added by install.py only
// when OpenCode 2 is installed; OpenCode 1 calls every export and would fail on an object.
export default { id: "shared-memory", server: SharedMemory, setup: async () => () => {} }
"""


def opencode_major():
    exe = shutil.which("opencode")
    if not exe:
        return 1
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return 1
    m = re.search(r"(\d+)\.\d+", out)
    return int(m.group(1)) if m else 1


class Installer:
    def __init__(self, dry):
        self.dry = dry
        self.notes = []
        self.url, self.key = load_env()

    # ---------- file helpers ----------
    def backup(self, path):
        if os.path.exists(path) and not self.dry:
            shutil.copy2(path, f"{path}.bak.{TS}")

    def write(self, path, text, mode=None):
        old = open(path).read() if os.path.exists(path) else None
        if old == text:
            return False
        print(f"  {'would write' if self.dry else 'write'} {path.replace(HOME, '~')}")
        if not self.dry:
            self.backup(path)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(text)
            if mode:
                os.chmod(path, mode)
        return True

    def read_json(self, path):
        if not os.path.exists(path):
            return {}
        text = open(path).read().strip()
        return json.loads(text) if text else {}

    def write_json(self, path, data):
        return self.write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    def link(self, target, link_path):
        if os.path.islink(link_path) and os.path.realpath(link_path) == os.path.realpath(target):
            return
        if os.path.exists(link_path) and not os.path.islink(link_path):
            self.notes.append(f"skipped link {link_path}: a real directory is already there")
            return
        print(f"  {'would link' if self.dry else 'link'} {link_path.replace(HOME, '~')} -> {target.replace(HOME, '~')}")
        if not self.dry:
            os.makedirs(os.path.dirname(link_path), exist_ok=True)
            if os.path.islink(link_path):
                os.unlink(link_path)
            os.symlink(target, link_path)

    def rules(self, path, whole_file=False):
        """Insert or refresh the marked rules block (or own the whole file)."""
        if whole_file:
            self.write(path, RULES_BLOCK)
            return
        old = open(path).read() if os.path.exists(path) else ""
        pattern = re.compile(re.escape(BLOCK_START) + r".*?" + re.escape(BLOCK_END) + r"\n?", re.S)
        new = pattern.sub(RULES_BLOCK, old) if pattern.search(old) else (old.rstrip() + "\n\n" + RULES_BLOCK if old.strip() else RULES_BLOCK)
        self.write(path, new)

    # ---------- MCP server entries ----------
    def mcp_json(self, path, section, entry, create=True):
        """Set data[section...]["shared-memory"] = entry in a JSON config. section may be "a.b"."""
        if not self.key:
            return
        if not os.path.exists(path) and not create:
            return
        data = self.read_json(path)
        keys = section.split(".")
        node = data
        for k in keys:
            node = node.setdefault(k, {})
        if node.get(SERVER) == entry:
            return  # already right; don't reformat a file other tools also write
        node[SERVER] = entry
        self.write_json(path, data)

    def mcp_toml(self, path):
        """Codex: replace the [mcp_servers.shared-memory] table (and its sub-tables) in config.toml."""
        if not self.key:
            return
        text = open(path).read() if os.path.exists(path) else ""
        old = old_url()
        if old:  # exact quoted values only: "https://h/mcp" must not touch "https://h/mcp-admin"
            text = re.sub(r"""(["'])""" + re.escape(old) + r"\1", lambda m: m.group(1) + self.url + m.group(1), text)
        out, skip = [], False
        for line in text.splitlines():
            head = re.match(r"\s*\[([^\[\]]+)\]\s*(#.*)?$", line)
            if head:
                name = head.group(1).strip()
                skip = name in (f"mcp_servers.{SERVER}", f'mcp_servers."{SERVER}"') or name.startswith(
                    (f"mcp_servers.{SERVER}.", f'mcp_servers."{SERVER}".'))
            if not skip:
                out.append(line)
        block = f'[mcp_servers.{SERVER}]\nurl = "{self.url}"\nhttp_headers = {{ "X-API-Key" = "{self.key}" }}\n'
        self.write(path, "\n".join(out).rstrip() + "\n\n" + block)

    def http_entry(self, url_key="url", **extra):
        return {**extra, url_key: self.url, "headers": {"X-API-Key": self.key}}

    # ---------- Claude-style hook merging ----------
    @staticmethod
    def handler_cmd(h):
        return h.get("command") or h.get("prompt") or ""

    def merge_hooks(self, hooks, event, command, matcher=None, extra=None):
        """Drop our old entries + retired echo nudges for this event, then add ours."""
        groups = []
        for g in hooks.get(event, []):
            kept = [h for h in g.get("hooks", []) if MARK not in self.handler_cmd(h) and not OLD_ECHO.search(self.handler_cmd(h))]
            if kept:
                groups.append({**g, "hooks": kept})
        group = {"hooks": [{"type": "command", "command": command, **(extra or {})}]}
        if matcher is not None:
            group = {"matcher": matcher, **group}
        return {**hooks, event: groups + [group]}

    def strip_old_echo(self, hooks):
        out = {}
        for event, groups in hooks.items():
            kept_groups = []
            for g in groups:
                kept = [h for h in g.get("hooks", []) if not OLD_ECHO.search(self.handler_cmd(h))]
                if kept:
                    kept_groups.append({**g, "hooks": kept})
            if kept_groups:
                out[event] = kept_groups
        return out

    # ---------- tools ----------
    def claude(self):
        path = f"{HOME}/.claude/settings.json"
        data = self.read_json(path)
        hooks = data.get("hooks", {})
        for event, ev in (("SessionStart", "session-start"), ("UserPromptSubmit", "prompt"), ("Stop", "stop")):
            hooks = self.merge_hooks(hooks, event, f"python3 {MEM} hook {ev} --tool claude", extra={"timeout": 20})
        self.write_json(path, {**data, "hooks": hooks})
        local = f"{HOME}/.claude/settings.local.json"
        if os.path.exists(local):
            ldata = self.read_json(local)
            if "hooks" in ldata:
                cleaned = self.strip_old_echo(ldata["hooks"])
                self.write_json(local, {**{k: v for k, v in ldata.items() if k != "hooks"}, **({"hooks": cleaned} if cleaned else {})})
        self.rules(f"{HOME}/.claude/rules/shared-memory.md", whole_file=True)
        self.link(SKILL_DIR, f"{HOME}/.claude/skills/shared-memory-mcp")
        self.mcp_json(f"{HOME}/.claude.json", "mcpServers", self.http_entry(type="http"))

    def codex_home(self, home, label):
        """Hooks + MCP for one CODEX_HOME (~/.codex, or one Orca creates)."""
        path = f"{home}/hooks.json"
        data = self.read_json(path)
        hooks = data.get("hooks", {})
        for event, ev in (("SessionStart", "session-start"), ("UserPromptSubmit", "prompt"), ("Stop", "stop")):
            hooks = self.merge_hooks(hooks, event, f"python3 {MEM} hook {ev} --tool codex", extra={"timeout": 20})
        if self.write_json(path, {**data, "hooks": hooks}):
            self.notes.append(f"{label}: open Codex there, run /hooks, and trust the 3 shared-memory hooks (untrusted hooks never run).")
        self.mcp_toml(f"{home}/config.toml")

    def codex(self):
        self.codex_home(f"{HOME}/.codex", "Codex")
        self.rules(f"{HOME}/.codex/AGENTS.md")

    def orca(self):
        # Orca starts Codex panes with their own CODEX_HOME (one runtime home, one per account).
        # Claude Code panes use ~/.claude and OpenCode mirrors ~/.config/opencode, so only Codex needs this.
        for home in orca_codex_homes():
            self.codex_home(home, f"Orca Codex ({home.replace(HOME, '~')})")
            self.link(SKILL_DIR, f"{home}/skills/shared-memory-mcp")
            agents = f"{home}/AGENTS.md"
            if os.path.islink(agents) or not os.path.exists(agents):
                self.link(f"{HOME}/.codex/AGENTS.md", agents)  # Orca's own pattern: share the user's AGENTS.md
            else:
                self.rules(agents)

    def gemini(self):
        path = f"{HOME}/.gemini/settings.json"
        data = self.read_json(path)
        hooks = data.get("hooks", {})
        hooks = self.merge_hooks(hooks, "SessionStart", f"python3 {MEM} hook session-start --tool gemini", matcher="", extra={"name": "shared-memory", "timeout": 20000})
        hooks = self.merge_hooks(hooks, "BeforeAgent", f"python3 {MEM} hook prompt --tool gemini", extra={"name": "shared-memory-recall", "timeout": 20000})
        self.write_json(path, {**data, "hooks": hooks})
        self.rules(f"{HOME}/.gemini/GEMINI.md")
        self.mcp_json(path, "mcpServers", self.http_entry(url_key="httpUrl"))

    def zcode(self):
        path = f"{HOME}/.zcode/cli/config.json"
        data = self.read_json(path)
        hooks = data.get("hooks", {})
        events = hooks.get("events", {})
        events = self.merge_hooks(events, "SessionStart", f"python3 {MEM} hook session-start --tool zcode", matcher="startup|resume|clear|compact", extra={"timeout": 20})
        events = self.merge_hooks(events, "UserPromptSubmit", f"python3 {MEM} hook prompt --tool zcode", extra={"timeout": 20})
        events = self.merge_hooks(events, "Stop", f"python3 {MEM} hook stop --tool zcode", extra={"timeout": 20})
        self.write_json(path, {**data, "hooks": {**hooks, "enabled": True, "events": events}})
        self.rules(f"{HOME}/.zcode/AGENTS.md")
        self.mcp_json(path, "mcp.servers", self.http_entry(type="remote"))

    def opencode(self):
        # OpenCode 2.x loads ~/.config/opencode/plugins/; 1.x used plugin/. Keep exactly one copy.
        base = f"{HOME}/.config/opencode"
        src = open(os.path.join(SKILL_DIR, "scripts", "opencode-plugin.ts")).read()
        if opencode_major() >= 2:  # 2.x validates a default plugin object; 1.x would try to call it
            src += OPENCODE2_EXPORT
        self.write(f"{base}/plugins/shared-memory.ts", src)
        legacy = f"{base}/plugin/shared-memory.ts"
        if os.path.exists(legacy):
            print(f"  {'would remove' if self.dry else 'remove'} {legacy.replace(HOME, '~')}")
            if not self.dry:
                self.backup(legacy)
                os.remove(legacy)
        self.rules(f"{base}/AGENTS.md")
        self.mcp_json(f"{base}/opencode.json", "mcp", {"type": "remote", "url": self.url, "enabled": True,
                                                        "headers": {"X-API-Key": self.key}})

    def hermes(self):
        path = f"{HOME}/.hermes/config.yaml"
        command = f"python3 {MEM} hook session-start --tool hermes --once"
        text = open(path).read()
        if MARK not in text:
            if re.search(r"^hooks:", text, re.M):
                self.notes.append(f"Hermes: config.yaml already has a `hooks:` block; add pre_llm_call -> `{command}` by hand.")
            else:
                self.write(path, text.rstrip() + f"\n\n# shared-memory: inject project memories on the first turn\nhooks:\n  pre_llm_call:\n    - command: \"{command}\"\n      timeout: 20\n")
        allow = f"{HOME}/.hermes/shell-hooks-allowlist.json"
        data = self.read_json(allow) or {"approvals": []}
        if not any(a.get("event") == "pre_llm_call" and a.get("command") == command for a in data.get("approvals", [])):
            approvals = [a for a in data.get("approvals", []) if MARK not in a.get("command", "")]
            self.write_json(allow, {**data, "approvals": approvals + [{"event": "pre_llm_call", "command": command}]})
        self.rules(f"{HOME}/.hermes/SOUL.md")
        self.link(SKILL_DIR, f"{HOME}/.hermes/skills/shared-memory-mcp")

    def cline(self):
        # Cline only injects context from PreToolUse/PostToolUse; inject once per task on the first tool call.
        path = f"{HOME}/.cline/hooks/PreToolUse"
        if os.path.exists(path) and MARK not in open(path).read():
            self.notes.append(f"Cline: {path} exists and isn't ours; left it alone.")
        else:
            self.write(path, f"#!/usr/bin/env bash\nexec python3 {MEM} hook session-start --tool cline --once\n", mode=0o755)
        self.rules(f"{HOME}/.cline/rules/shared-memory.md", whole_file=True)
        self.mcp_json(f"{HOME}/.cline/data/settings/cline_mcp_settings.json", "mcpServers",
                      self.http_entry(type="streamableHttp"))

    def antigravity(self):
        path = f"{HOME}/.gemini/config/hooks.json"
        data = self.read_json(path)
        entry = {"PreInvocation": [{"type": "command", "command": f"python3 {MEM} hook session-start --tool antigravity --cached", "timeout": 20}]}
        self.write_json(path, {**data, "shared-memory": entry})
        # The CLI reads ~/.gemini/antigravity-cli/skills (seen on macOS, agy 1.3); older builds used config/skills.
        cli_skills = f"{HOME}/.gemini/antigravity-cli/skills"
        self.link(SKILL_DIR, f"{cli_skills if os.path.isdir(cli_skills) else HOME + '/.gemini/config/skills'}/shared-memory-mcp")
        self.mcp_json(f"{HOME}/.gemini/config/mcp_config.json", "mcpServers", self.http_entry(url_key="serverUrl"))

    def cursor(self):
        # Cursor imports ~/.claude/settings.json hooks (thirdPartyExtensibilityEnabled, default on);
        # a ~/.cursor/hooks.json copy would run them twice. mem.py detects Cursor's payload.
        self.mcp_json(f"{HOME}/.cursor/mcp.json", "mcpServers", self.http_entry())
        self.notes.append("Cursor: uses the Claude Code hooks (no separate file). Add the rules text under Settings > Rules > User Rules if you want it in Cursor's system prompt.")

    def vscode(self):
        # MCP only: VS Code (Copilot Chat) has no user-level hooks.
        self.mcp_json(f"{APP_SUPPORT}/Code/User/mcp.json", "servers", self.http_entry(type="http"))

    def copilot(self):
        # GitHub Copilot CLI: MCP, user instructions, skills.
        self.mcp_json(f"{HOME}/.copilot/mcp-config.json", "mcpServers", self.http_entry(type="http", tools=["*"]))
        self.rules(f"{HOME}/.copilot/copilot-instructions.md")
        self.link(SKILL_DIR, f"{HOME}/.copilot/skills/shared-memory-mcp")


TOOLS = {
    "claude": f"{HOME}/.claude",
    "codex": f"{HOME}/.codex",
    "gemini": f"{HOME}/.gemini/settings.json",
    "zcode": f"{HOME}/.zcode/cli",
    "opencode": f"{HOME}/.config/opencode",
    "hermes": f"{HOME}/.hermes/config.yaml",
    "cline": f"{HOME}/.cline",
    "antigravity": f"{HOME}/.gemini/antigravity-cli",
    "cursor": f"{HOME}/.cursor",
    "vscode": f"{APP_SUPPORT}/Code/User",
    "copilot": f"{HOME}/.copilot",
    "orca": f"{APP_SUPPORT}/orca",
}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--only", help="comma-separated tool names")
    o = p.parse_args()
    inst = Installer(o.dry_run)

    if not inst.url:
        sys.exit("No server URL. Re-run with SHARED_MEMORY_URL=https://your-host/mcp set "
                 "(or add it to ~/.config/shared-memory/env).")
    if "SHARED_MEMORY_API_KEY" in mem.read_env_file(mem.INSTANCE_FILE):
        inst.notes.append("instance.env contains SHARED_MEMORY_API_KEY, which is ignored. "
                          "Remove it so the key is not stored in git.")
    if not os.path.exists(mem.ENV_FILE):
        if not inst.key:
            sys.exit(f"Missing {mem.ENV_FILE}. Re-run with SHARED_MEMORY_API_KEY=... set.")
        inst.write(mem.ENV_FILE, f"SHARED_MEMORY_URL={inst.url}\nSHARED_MEMORY_API_KEY={inst.key}\n", mode=0o600)
    else:
        follow_instance_url(inst)

    print("skill")
    inst.link(SKILL_DIR, SKILL_LINK)  # read by Codex, Gemini, Cursor, OpenCode, Cline, ZCode
    wanted = set(o.only.split(",")) if o.only else set(TOOLS)
    for name, marker in TOOLS.items():
        if name not in wanted:
            continue
        if not os.path.exists(marker):
            print(f"{name}: not installed, skipped")
            continue
        print(name)
        try:
            getattr(inst, name)()
        except Exception as e:  # one broken config must not stop the rest
            inst.notes.append(f"{name}: FAILED ({e}); nothing else changed for it")
    if inst.notes:
        print("\nnotes:")
        for n in inst.notes:
            print(f"  - {n}")


if __name__ == "__main__":
    main()
