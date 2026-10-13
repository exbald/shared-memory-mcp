"""The stop hook: one nudge per session, and only for a session that has saved nothing.

A save counts only when a memory write (an MCP save tool, or a shell call running mem.py or mem.sh)
gets the server's confirmation ("Saved [cat] (id: ...)" or "Updated [id]") as its own result. A
command that mentions mem.py add, never ran or failed is not a save, nor is confirmation-shaped text
in the result of any other call.

Run: python3 -m unittest discover -s tests
"""
import contextlib
import io
import itertools
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import mem  # noqa: E402

ID = "3a131e42-1489-4208-9ef4-5aeb4a1eaf5e"
SAVED = f"Saved [decision] (id: {ID})\nChose Postgres\ntags: db\n[embedded]"
UPDATED = f"Updated [{ID}]\nChose Postgres\ntags: db"
_ids = itertools.count(1)


def tool_use(name, call_id="toolu_0", **tool_input):
    """An assistant line of a Claude Code transcript calling one tool."""
    return json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": call_id, "name": name, "input": tool_input}]}})


def tool_result(call_id, text, as_list=False):
    """The user line carrying a tool's result; MCP tools give a list of text parts, Bash a string."""
    content = [{"type": "text", "text": text}] if as_list else text
    return json.dumps({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": call_id, "content": content}]}})


def claude_call(name, result, as_list=False, **tool_input):
    """A Claude Code tool call and its result, linked by id."""
    call_id = f"toolu_{next(_ids)}"
    return [tool_use(name, call_id, **tool_input), tool_result(call_id, result, as_list)]


def codex_call(script, output):
    """A Codex shell call and its output, as two rollout lines linked by call_id."""
    call_id = f"call_{next(_ids)}"
    call = {"type": "response_item", "payload": {"type": "function_call", "name": "shell", "call_id": call_id,
                                                 "arguments": json.dumps({"command": ["bash", "-lc", script]})}}
    out = {"type": "response_item", "payload": {"type": "function_call_output", "call_id": call_id,
                                                "output": json.dumps({"output": output, "metadata": {"exit_code": 0}})}}
    return [json.dumps(call), json.dumps(out)]


WORK = claude_call("Read", "file text", file_path="a") * 12


class CliWrites(unittest.TestCase):
    """A shell call is a memory write only when mem.py/mem.sh add|update is the command being run."""

    def test_commands_that_run_a_write(self):
        for command in [
            "~/.agents/skills/shared-memory-mcp/scripts/mem.py add 'Decision: y' --category decision",
            'python3 mem.py update abc --content "x"',
            "SHARED_MEMORY_AGENT=codex python3 -u scripts/mem.py add z",
            "cd ~/x && /usr/bin/python3 mem.py add z",
            "python3 mem.py add z | tail -1",
            "ls\npython3 mem.py add 'on the second line'",
            "( cd x; python mem.py update id --tags a )",
            "env python3.12 mem.py add z",
            "~/.hermes/skills/productivity/shared-memory/scripts/mem.sh add x",
            "bash scripts/mem.sh update id 'new text'",
            "cat <<EOF > notes\nmem.py add inside\nEOF\npython3 mem.py add after-the-heredoc",
        ]:
            self.assertTrue(mem._runs_cli_write(command), command)

    def test_commands_that_only_mention_one(self):
        for command in [
            "rg 'mem.py add' skill/",
            "echo mem.py add",
            "printf '%s\\n' mem.py update",
            "grep -n mem.py add",
            "cat old-session.log # mem.py add",
            "cat >notes <<'EOF'\nmem.py add x\nEOF",
            "cat <<-EOF\n\tpython3 mem.py add x\n\tEOF",
            "git commit -m 'teach mem.py add'",
            "python3 -c 'print(1)' mem.py add",
            "vim mem.py",
            "python3 mem.py search add",
            "echo 'unbalanced",
        ]:
            self.assertFalse(mem._runs_cli_write(command), command)


class StopHook(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        patcher = mock.patch.object(mem, "STATE_DIR", os.path.join(tmp.name, "state"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def stop(self, lines, session="s1", **extra):
        """Write the transcript so far, run the stop hook, return what it printed."""
        path = os.path.join(self.dir, f"{session}.jsonl")
        with open(path, "w") as f:
            f.write("\n".join(lines) + "\n")
        payload = {"session_id": session, "transcript_path": path, **extra}
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), contextlib.redirect_stdout(out):
            mem.hook("stop", "claude")
        return out.getvalue()

    def assert_nudged(self, output, msg=None):
        self.assertTrue(output, msg or "expected a nudge")
        self.assertEqual(json.loads(output)["decision"], "block")
        self.assertIn("saved nothing", json.loads(output)["reason"])

    def test_quiet_until_ten_tool_calls(self):
        self.assertEqual(self.stop([tool_use("Bash", command="ls")] * 9), "")
        self.assert_nudged(self.stop([tool_use("Bash", command="ls")] * 10))

    def test_nudges_once_per_session_however_long_it_runs(self):
        self.assert_nudged(self.stop(WORK))
        for extra in (10, 25, 200):
            self.assertEqual(self.stop(WORK + [tool_use("Edit", file_path="a")] * extra), "", extra)

    def test_a_confirmed_save_from_any_client_means_no_nudge(self):
        saves = {
            "mcp-add": claude_call("mcp__shared-memory__mem_add", SAVED, as_list=True, content="x"),
            "mcp-update": claude_call("mcp__shared-memory__mem_update", UPDATED, as_list=True, id=ID),
            "cli": claude_call("Bash", SAVED, command="python3 ~/x/scripts/mem.py add 'x' --category decision"),
            "mem.sh": claude_call("Bash", SAVED, command="~/.hermes/skills/productivity/shared-memory/scripts/mem.sh add x"),
            "codex": codex_call("python3 mem.py update x --content y", UPDATED),
        }
        for session, lines in saves.items():
            self.assertEqual(self.stop(lines + WORK, session=session), "", session)

    def test_a_save_that_did_not_happen_does_not_count(self):
        attempts = {
            "mention": claude_call("Bash", "skill/SKILL.md:12: mem.py add ...", command="rg 'mem.py add' skill/"),
            "heredoc": claude_call("Bash", "", command="cat >notes <<'EOF'\nmem.py add x\nEOF"),
            "short-circuit": claude_call("Bash", "Exit code 1", command="false && python3 mem.py add x"),
            "failed": claude_call("Bash", "shared-memory error: <urlopen error [Errno 61] Connection refused>",
                                  command="python3 mem.py add x"),
            "mcp-error": claude_call("mcp__shared-memory__mem_add", "Error: content must not be empty", True, content=""),
            "codex-mention": codex_call("rg 'mem.py add'", "README.md: mem.py add"),
            "quoted-in-input": claude_call("Write", "File created", file_path="notes.md", content=SAVED),
            "structured-input": claude_call("mcp__notes__store", "stored", record={"type": "tool_result", "content": SAVED}),
            # Confirmation-shaped text in the result of a call that is not a memory write:
            "log-read": claude_call("Read", "earlier run:\n" + SAVED, file_path="~/.cache/run.log"),
            "memory-quotes-it": claude_call("mcp__shared-memory__mem_get", json.dumps({"content": UPDATED}), True, id=ID),
            "search-quotes-it": claude_call("mcp__shared-memory__mem_search", f"Found 1 memory:\n[{ID}] {SAVED}", True, query="x"),
            "failed-then-unrelated": claude_call("Bash", "shared-memory error: timed out", command="python3 mem.py add x")
                                     + claude_call("Read", SAVED, file_path="notes.md"),
            "cli-search-quotes-it": claude_call("Bash", f"Found 1 memory:\n[{ID}] {SAVED}", command="python3 mem.py search postgres"),
            "comment-mention-with-old-log": claude_call("Bash", "old run:\n" + SAVED, command="cat old-session.log # mem.py add"),
            "failed-with-fallback": claude_call("Bash", "shared-memory error: timed out\nSaved nothing",
                                                command="python3 mem.py add x || echo 'Saved nothing'"),
        }
        for session, lines in attempts.items():
            self.assert_nudged(self.stop(lines + WORK, session=session), session)

    def test_a_save_is_remembered_so_later_stops_do_not_rescan(self):
        saved = claude_call("mcp__shared-memory__mem_add", SAVED, as_list=True, content="x") + WORK
        self.assertEqual(self.stop(saved), "")
        with mock.patch.object(mem, "scan_transcript", side_effect=AssertionError("transcript scanned again")):
            self.assertEqual(self.stop(saved + [tool_use("Read", file_path="b")] * 5), "")

    def test_each_session_gets_its_own_nudge(self):
        self.assert_nudged(self.stop(WORK, session="first"))
        self.assert_nudged(self.stop(WORK, session="second"))

    def test_a_session_nudged_by_the_old_rule_is_not_nudged_again(self):
        with open(mem.state_path("old"), "w") as f:
            json.dump({"started": True, "nudged_at": 120}, f)
        self.assertEqual(self.stop([tool_use("Bash", command="ls")] * 300, session="old"), "")

    def test_never_while_the_stop_hook_itself_is_being_answered(self):
        self.assertEqual(self.stop([tool_use("Bash", command="ls")] * 20, stop_hook_active=True), "")


if __name__ == "__main__":
    unittest.main()
