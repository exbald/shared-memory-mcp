"""The stop hook: one nudge per session, and only for a session that has saved nothing.

A save counts only when a tool result holds the server's confirmation ("Saved [cat] (id: ...)" or
"Updated [id]"), however it was made. A command that mentions mem.py add, never ran, or failed is
not a save.

Run: python3 -m unittest discover -s tests
"""
import contextlib
import io
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


def tool_use(name, **tool_input):
    """An assistant line of a Claude Code transcript calling one tool."""
    return json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "toolu_1", "name": name, "input": tool_input}]}})


def tool_result(text, as_list=False):
    """The user line carrying a tool's result; MCP tools give a list of text parts, Bash a string."""
    content = [{"type": "text", "text": text}] if as_list else text
    return json.dumps({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": content}]}})


def codex_call(script, output):
    """A Codex shell call and its output, as two rollout lines."""
    call = {"type": "response_item", "payload": {"type": "function_call", "name": "shell", "call_id": "c1",
                                                 "arguments": json.dumps({"command": ["bash", "-lc", script]})}}
    out = {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "c1",
                                                "output": json.dumps({"output": output, "metadata": {"exit_code": 0}})}}
    return [json.dumps(call), json.dumps(out)]


WORK = [tool_use("Read", file_path="a"), tool_result("file text")] * 12


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
            "mcp-add": [tool_use("mcp__shared-memory__mem_add", content="x"), tool_result(SAVED, as_list=True)],
            "mcp-update": [tool_use("mcp__shared-memory__mem_update", id=ID), tool_result(UPDATED, as_list=True)],
            "cli": [tool_use("Bash", command="python3 ~/x/scripts/mem.py add 'x' --category decision"), tool_result(SAVED)],
            "codex": codex_call("python3 mem.py update x --content y", UPDATED),
        }
        for session, lines in saves.items():
            self.assertEqual(self.stop(lines + WORK, session=session), "", session)

    def test_a_save_that_did_not_happen_does_not_count(self):
        attempts = {
            "mention": [tool_use("Bash", command="rg 'mem.py add' skill/"), tool_result("skill/SKILL.md:12: mem.py add ...")],
            "heredoc": [tool_use("Bash", command="cat >notes <<'EOF'\nmem.py add x\nEOF"), tool_result("")],
            "short-circuit": [tool_use("Bash", command="false && python3 mem.py add x"), tool_result("Exit code 1")],
            "failed": [tool_use("Bash", command="python3 mem.py add x"),
                       tool_result("shared-memory error: <urlopen error [Errno 61] Connection refused>")],
            "mcp-error": [tool_use("mcp__shared-memory__mem_add", content=""), tool_result("Error: content must not be empty", True)],
            "codex-mention": codex_call("rg 'mem.py add'", "README.md: mem.py add"),
            "quoted-in-input": [tool_use("Write", file_path="notes.md", content=SAVED), tool_result("File created")],
            "structured-input": [tool_use("mcp__notes__store", record={"type": "tool_result", "content": SAVED}),
                                 tool_result("stored")],
        }
        for session, lines in attempts.items():
            self.assert_nudged(self.stop(lines + WORK, session=session), session)

    def test_a_save_is_remembered_so_later_stops_do_not_rescan(self):
        saved = [tool_use("mcp__shared-memory__mem_add", content="x"), tool_result(SAVED, as_list=True)] + WORK
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
