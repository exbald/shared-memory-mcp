#!/usr/bin/env python3
"""Shared-memory MCP client and universal hook entry point (stdlib only).

CLI:   mem.py search|add|update|get|delete|list|stats|context ...
Hooks: mem.py hook <session-start|prompt|stop> --tool <tool>
       Reads the tool's hook JSON on stdin, prints that tool's expected output.
Config: SHARED_MEMORY_URL, SHARED_MEMORY_API_KEY (env or ~/.config/shared-memory/env).
        The URL can also come from instance.env next to SKILL.md; a key never does.
"""
import argparse
import atexit
import http.client
import io
import json
import os
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
INSTANCE_FILE = os.path.join(SKILL_DIR, "instance.env")  # optional, for a private copy: SHARED_MEMORY_URL=...
ENV_FILE = os.path.expanduser("~/.config/shared-memory/env")
STATE_DIR = os.path.expanduser("~/.cache/shared-memory")
TIMEOUT = 8
STOP_NUDGE_AFTER = 10  # tool calls since the last memory save
SNIPPET = 400  # chars per memory in injected context

RULES = (
    "Shared memory (cross-agent MCP `shared-memory`): search it (mem_search) before "
    "answering about any project, person, or past decision; save durable decisions, "
    "preferences, project status changes, and costly-to-rediscover facts with mem_add "
    "(category + project-slug tag + agent name); mem_search first, then store, skip what is "
    "already saved, or mem_update/merge instead of duplicating; never save secrets. "
    "Before ending a session that moved a project "
    "forward, save or update one project status summary. Full rules: shared-memory-mcp skill."
)

AGENT_NAMES = {
    "claude": "claude-code", "codex": "codex", "gemini": "gemini-cli",
    "cursor": "cursor", "opencode": "opencode", "cline": "cline",
    "hermes": "hermes", "zcode": "zcode", "antigravity": "antigravity",
}


# ---------- config + transport ----------

class ConfigError(RuntimeError):
    """The server URL or key is missing or malformed."""


ENV_LINE = re.compile(r"\s*(?:export\s+)?(\w+)\s*=(.*)$")


def env_value(raw):
    """The value in KEY=value: quotes removed, an unquoted trailing ' # comment' dropped."""
    raw = raw.strip()
    if raw[:1] in ("'", '"'):
        end = raw.find(raw[0], 1)
        return raw[1:end] if end != -1 else raw[1:]
    return re.split(r"\s+#", raw, maxsplit=1)[0].strip()


def read_env_file(path):
    """KEY=value pairs from a shell-style env file; {} when it is missing or unreadable."""
    vals = {}
    try:
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                m = ENV_LINE.match(line)
                if m:
                    vals[m.group(1)] = env_value(m.group(2))
    except (OSError, UnicodeError):
        return {}
    return vals


def load_config():
    """Server URL and API key: environment first, then ~/.config/shared-memory/env.
    Surrounding whitespace is ignored, and an empty or blank value counts as unset.
    The URL alone may also come from instance.env next to SKILL.md. A key never does.
    A saved URL that instance.env lists as retired (SHARED_MEMORY_OLD_URL) is skipped,
    so moving the server only means editing instance.env."""
    saved, instance = read_env_file(ENV_FILE), read_env_file(INSTANCE_FILE)
    saved_url = saved.get("SHARED_MEMORY_URL", "")
    if saved_url and saved_url == instance.get("SHARED_MEMORY_OLD_URL", ""):
        saved_url = ""
    url = (os.environ.get("SHARED_MEMORY_URL", "").strip() or saved_url
           or instance.get("SHARED_MEMORY_URL", ""))
    key = os.environ.get("SHARED_MEMORY_API_KEY", "").strip() or saved.get("SHARED_MEMORY_API_KEY", "")
    return {"url": url, "key": key}


# One keep-alive connection, reused for the life of the process. The session-start hook makes
# two calls, and every new HTTPS connection costs a TCP and a TLS handshake before the request
# (about half a second from Asia to a server in Europe).
_conn = {"origin": None, "conn": None}
READ_ONLY = {"mem_search", "mem_list", "mem_get", "mem_stats"}


def _discard():
    """Close and forget the connection: after any error it may hold half a request."""
    if _conn["conn"]:
        _conn["conn"].close()
    _conn.update(origin=None, conn=None)


atexit.register(_discard)


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Following a redirect would turn the POST into a GET and could carry the API key to
    another host. Returning None makes urllib raise HTTPError, as the direct path does."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _uses_proxy(parts):
    """http.client ignores proxy settings, so a configured proxy means urllib does the request.
    The bypass check gets host[:port], as urllib's own does, so NO_PROXY entries with a port match."""
    host = parts.netloc.rpartition("@")[2]
    return bool(urllib.request.getproxies().get(parts.scheme)) and not urllib.request.proxy_bypass(host)


def _connection(parts):
    origin = (parts.scheme, parts.hostname, parts.port)
    if _conn["origin"] != origin:
        _discard()
        # An explicit port: http.client would read the last group of a bare IPv6 address as one.
        # A port written in the URL is kept as written, even 0.
        port = parts.port if parts.port is not None else (443 if parts.scheme == "https" else 80)
        cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
        _conn.update(origin=origin, conn=cls(parts.hostname, port, timeout=TIMEOUT))
    return _conn["conn"]


def post(url, body, headers, retry=False):
    """POST and return the raw response body, over the kept-alive connection.

    With retry (read-only tools only): a reused connection that fails while sending or before
    the response's status line was most likely closed by the server while idle, so the request
    goes out once more on a fresh connection. A write is never sent again, because a server
    that saved it and then died looks the same. Timeouts and breaks after the answer started
    are never retried either.
    Raises ValueError for a malformed URL or header, and HTTPError for a status other than 2xx."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("not an http(s) URL")
    if _uses_proxy(parts):  # a fresh opener reads the current proxy settings
        opener = urllib.request.build_opener(_RefuseRedirects)
        with opener.open(urllib.request.Request(url, data=body, method="POST", headers=headers), timeout=TIMEOUT) as resp:
            return resp.read()
    target = (parts.path or "/") + ("?" + parts.query if parts.query else "")
    for attempt in (1, 2):
        conn = _connection(parts)
        reused = conn.sock is not None
        try:
            conn.request("POST", target, body=body, headers=headers)
            resp = conn.getresponse()
        except OSError as err:  # includes a reset, a broken pipe, an SSL EOF and a timeout
            _discard()
            if retry and reused and attempt == 1 and not isinstance(err, socket.timeout):
                continue
            raise
        except BaseException:
            _discard()
            raise
        try:
            data = resp.read()
        except BaseException:
            _discard()
            raise
        if not 200 <= resp.status < 300:
            raise urllib.error.HTTPError(url, resp.status, resp.reason, resp.headers, io.BytesIO(data))
        return data


def call(tool, args):
    """Call one MCP tool over Streamable HTTP; return its text output."""
    cfg = load_config()
    if not cfg["url"]:
        raise ConfigError("SHARED_MEMORY_URL is not set. Export it, or add SHARED_MEMORY_URL=... "
                          "to ~/.config/shared-memory/env.")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}).encode()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-API-Key": cfg["key"],
        "User-Agent": "shared-memory-mem.py",
    }
    try:
        data = post(cfg["url"], body, headers, retry=tool in READ_ONLY)
    except ValueError:  # http.client rejects control characters and quotes the whole key in its message
        raise ConfigError("SHARED_MEMORY_URL is not a valid http(s) URL, or the URL or API key "
                          "contains invalid characters.") from None
    raw = data.decode()
    payload = raw
    if "data:" in raw:  # SSE framing; split on "\n" only (splitlines also breaks on U+2028 & co.)
        payload = "\n".join(l[5:].strip() for l in raw.split("\n") if l.startswith("data:"))
    msg = json.loads(payload)
    if "error" in msg:
        raise RuntimeError(msg["error"].get("message", str(msg["error"])))
    result = msg["result"]
    text = "\n".join(c.get("text", "") for c in result.get("content", []))
    if result.get("isError"):
        raise RuntimeError(text)
    return text


# ---------- memory parsing ----------

MEM_LINE = re.compile(r"^\[([0-9a-f-]{36})\]\s")


def split_memories(text):
    """Split tool output into (id, line) pairs; one memory per '[uuid] ...' line.

    Only "\\n" ends a line: content holding U+001E or U+2028 must not pose as a second memory."""
    out = []
    for line in (l.rstrip("\r") for l in text.split("\n")):
        m = MEM_LINE.match(line)
        if m:
            out.append((m.group(1), line))
        elif out and line.strip():
            out[-1] = (out[-1][0], out[-1][1] + " " + line.strip())
    return out


def clip(line, n=SNIPPET):
    return line if len(line) <= n else line[: n - 1].rstrip() + "…"


# ---------- project detection ----------

def project_name(cwd):
    cwd = cwd or os.getcwd()
    if os.path.realpath(cwd) == os.path.realpath(os.path.expanduser("~")):
        return None
    try:
        url = subprocess.run(["git", "-C", cwd, "remote", "get-url", "origin"],
                             capture_output=True, text=True, timeout=3).stdout.strip()
        if url:
            return re.sub(r"\.git$", "", url.rstrip("/").split("/")[-1].split(":")[-1])
        top = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=3).stdout.strip()
        if top:
            return os.path.basename(top)
    except (OSError, subprocess.SubprocessError):
        pass
    return os.path.basename(os.path.normpath(cwd))


def project_context(cwd, max_items=8):
    """Return (context_text, shown_ids) for the session-start injection."""
    name = project_name(cwd)
    seen, items = set(), []
    queries = []
    mentions = lambda line: True
    if name:
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        # Vector search returns near-misses for vague names; keep only lines that name the project.
        pattern = re.compile(re.escape(slug).replace(r"\-", r"[-_ ]?"), re.I)
        mentions = pattern.search
        queries = [{"tag": slug, "max": max_items}, {"query": name, "max": max_items * 2}]
    else:
        queries = [{"max": 5}]
    for q in queries:
        try:
            text = call("mem_search" if name else "mem_list", q)
        except ConfigError as e:
            return f"Shared memory is not configured. {e}", set()
        except Exception as e:  # network down must never break the session
            return f"Shared memory: unreachable ({e.__class__.__name__}). {RULES}", set()
        for mid, line in split_memories(text):
            if "tag" not in q and not mentions(line):
                continue
            if mid not in seen and len(items) < max_items:
                seen.add(mid)
                items.append(clip(line))
    header = (f"Shared memory: {len(items)} memories for project '{name}'"
              if name else "Shared memory: most recent memories (no project detected)")
    body = "\n".join(f"- {i}" for i in items) or "- (none yet)"
    return f"{header}\n{body}\n\n{RULES}", seen


# ---------- per-session state ----------

def state_path(session_id):
    os.makedirs(STATE_DIR, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", session_id or "default")[:80]
    return os.path.join(STATE_DIR, safe + ".json")


def load_state(session_id):
    try:
        with open(state_path(session_id)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(session_id, state):
    tmp = state_path(session_id) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, state_path(session_id))


# ---------- transcript scan (stop hook) ----------

TOOL_NAME_KEYS = ("name", "tool_name", "toolName")


def tool_calls(transcript_path):
    """Ordered list of tool names called in a JSONL transcript (Claude/Codex style)."""
    names = []
    try:
        with open(transcript_path) as f:
            for line in f:
                found = re.findall(r'"type"\s*:\s*"(?:tool_use|function_call|custom_tool_call)"[^{}]*?"name"\s*:\s*"([^"]+)"', line)
                # A shell call running `mem.py add|update` is a save too.
                if found and re.search(r"mem\.py\\?\"?\s+(?:add|update)\b", line):
                    found[-1] = "mem_add (via mem.py)"
                names.extend(found)
    except OSError:
        return []
    return names


def calls_since_save(names):
    for i in range(len(names) - 1, -1, -1):
        if re.search(r"mem_(add|update)", names[i]):
            return len(names) - 1 - i
    return len(names)


# ---------- hook output formats ----------

def emit_context(tool, event, text):
    """Print text in the shape each tool injects into the model's context."""
    if tool in ("claude", "codex", "zcode", "gemini"):
        names = {"gemini": {"session-start": "SessionStart", "prompt": "BeforeAgent"}}
        name = names.get(tool, {"session-start": "SessionStart", "prompt": "UserPromptSubmit"})[event]
        out = {"hookSpecificOutput": {"hookEventName": name, "additionalContext": text}}
    elif tool == "cursor":
        out = {"additional_context": text}
    elif tool == "cline":  # only honoured from PreToolUse/PostToolUse
        out = {"contextModification": text}
    elif tool == "hermes":  # pre_llm_call
        out = {"context": text}
    elif tool == "antigravity":  # PreInvocation
        out = {"injectSteps": [{"ephemeralMessage": text}]}
    else:
        print(text)
        return
    print(json.dumps(out))


def emit_stop_block(tool, reason):
    if tool == "cursor":
        print(json.dumps({"followup_message": reason}))
    elif tool in ("claude", "codex", "zcode"):
        print(json.dumps({"decision": "block", "reason": reason}))


STOP_REASON = (
    "Before finishing: this session did real work and saved nothing to shared memory. "
    "If it produced decisions, preferences, project status changes, or costly-to-rediscover "
    "facts, mem_search the topic and then mem_add or mem_update them (and update the "
    "project's status summary). If nothing is worth keeping, say so in one line and stop."
)


def first(data, *keys):
    for k in keys:
        v = data.get(k)
        if isinstance(v, list):
            v = v[0] if v else None
        if v:
            return v
    return None


def hook(event, tool, once=False, cached=False):
    """once: emit session-start context only the first time per session (per-turn hook events).
    cached: re-emit the stored context on every call without refetching (ephemeral injections)."""
    try:
        data = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    except ValueError:
        data = {}
    if tool == "claude" and ("cursor_version" in data or "workspace_roots" in data):
        tool = "cursor"  # Cursor runs ~/.claude/settings.json hooks too
    session_id = first(data, "session_id", "sessionId", "conversation_id", "conversationId", "taskId") or ""
    cwd = first(data, "cwd", "workspace_roots", "workspaceRoots", "workspacePaths") or os.getcwd()
    state = load_state(session_id)

    if event == "session-start":
        if cached and state.get("context"):
            emit_context(tool, event, state["context"])
            return
        if once and (state.get("started") or (data.get("extra") or {}).get("is_first_turn") is False):
            return
        text, ids = project_context(cwd)
        state.update(started=True, context=text,
                     shown=sorted(set(state.get("shown", [])) | ids))
        save_state(session_id, state)
        emit_context(tool, event, text)

    elif event == "prompt":
        if os.environ.get("SHARED_MEMORY_PROMPT_RECALL") != "1":
            return
        prompt = (data.get("prompt") or data.get("user_prompt") or "").strip()
        if len(prompt) < 20:
            return
        try:
            hits = split_memories(call("mem_search", {"query": prompt[:300], "max": 5}))
        except Exception:
            return
        shown = set(state.get("shown", []))
        new = [(i, l) for i, l in hits if i not in shown][:3]
        if new:
            state["shown"] = sorted(shown | {i for i, _ in new})
            save_state(session_id, state)
            emit_context(tool, event, "Possibly relevant shared memories:\n" +
                         "\n".join(f"- {clip(l, 300)}" for _, l in new))

    elif event == "stop":
        if data.get("stop_hook_active"):
            return
        path = data.get("transcript_path") or data.get("transcriptPath")
        if not path:
            return
        names = tool_calls(path)
        work = calls_since_save(names)
        nudged_at = state.get("nudged_at", -1)
        if work >= STOP_NUDGE_AFTER and len(names) - nudged_at >= STOP_NUDGE_AFTER:
            state["nudged_at"] = len(names)
            save_state(session_id, state)
            emit_stop_block(tool, STOP_REASON)


# ---------- CLI ----------

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("search"); s.add_argument("query", nargs="?")
    s.add_argument("--tag"); s.add_argument("--category"); s.add_argument("--max", type=int, default=10)
    a = sub.add_parser("add"); a.add_argument("content")
    a.add_argument("--category", default="general"); a.add_argument("--tags", default="")
    a.add_argument("--agent", default=os.environ.get("SHARED_MEMORY_AGENT", "unknown"))
    u = sub.add_parser("update"); u.add_argument("id"); u.add_argument("--content")
    u.add_argument("--category"); u.add_argument("--tags"); u.add_argument("--agent")
    g = sub.add_parser("get"); g.add_argument("id")
    d = sub.add_parser("delete"); d.add_argument("id")
    l = sub.add_parser("list"); l.add_argument("--max", type=int, default=10)
    l.add_argument("--category"); l.add_argument("--agent")
    sub.add_parser("stats")
    c = sub.add_parser("context"); c.add_argument("--cwd")
    h = sub.add_parser("hook"); h.add_argument("event", choices=["session-start", "prompt", "stop"])
    h.add_argument("--tool", required=True, choices=sorted(AGENT_NAMES))
    h.add_argument("--once", action="store_true", help="session-start only on the first call per session")
    h.add_argument("--cached", action="store_true", help="re-emit stored session context on every call")

    o = p.parse_args()
    drop_none = lambda d: {k: v for k, v in d.items() if v not in (None, "")}
    tags = lambda t: [x.strip() for x in t.split(",") if x.strip()] if t is not None else None

    if o.cmd == "hook":
        try:
            hook(o.event, o.tool, once=o.once, cached=o.cached)
        except Exception as e:  # a hook must never break the host tool
            print(f"shared-memory hook error: {e}", file=sys.stderr)
        return
    if o.cmd == "context":
        print(project_context(o.cwd)[0]); return
    args = {
        "search": lambda: ("mem_search", drop_none({"query": o.query, "tag": o.tag, "category": o.category, "max": o.max})),
        "add": lambda: ("mem_add", {"content": o.content, "category": o.category, "tags": tags(o.tags), "agent": o.agent}),
        "update": lambda: ("mem_update", drop_none({"id": o.id, "content": o.content, "category": o.category, "tags": tags(o.tags), "agent": o.agent})),
        "get": lambda: ("mem_get", {"id": o.id}),
        "delete": lambda: ("mem_delete", {"id": o.id}),
        "list": lambda: ("mem_list", drop_none({"max": o.max, "category": o.category, "agent": o.agent})),
        "stats": lambda: ("mem_stats", {}),
    }[o.cmd]()
    try:
        print(call(*args))
    except Exception as e:
        sys.exit(f"shared-memory error: {e}")


if __name__ == "__main__":
    main()
