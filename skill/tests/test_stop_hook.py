"""The stop hook: one nudge per session, and only for a session that has saved nothing.

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


def tool_use(name, **tool_input):
    """One assistant line of a Claude Code JSONL transcript."""
    return json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "toolu_1", "name": name, "input": tool_input}]}})


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

    def assert_nudged(self, output):
        self.assertEqual(json.loads(output)["decision"], "block")
        self.assertIn("saved nothing", json.loads(output)["reason"])

    def test_quiet_until_ten_tool_calls(self):
        self.assertEqual(self.stop([tool_use("Bash", command="ls")] * 9), "")
        self.assert_nudged(self.stop([tool_use("Bash", command="ls")] * 10))

    def test_nudges_once_per_session_however_long_it_runs(self):
        work = [tool_use("Read", file_path="a")] * 10
        self.assert_nudged(self.stop(work))
        for extra in (10, 25, 200):
            self.assertEqual(self.stop(work + [tool_use("Edit", file_path="a")] * extra), "", extra)

    def test_a_session_that_saved_anything_is_never_nudged(self):
        saved = [tool_use("mcp__shared-memory__mem_update", id="x")] + [tool_use("Bash", command="make")] * 50
        self.assertEqual(self.stop(saved), "")
        via_cli = [tool_use("Bash", command='python3 ~/x/scripts/mem.py add "Decision" --category decision')]
        self.assertEqual(self.stop(via_cli + [tool_use("Read", file_path="a")] * 30, session="s2"), "")

    def test_mentioning_mem_py_add_is_not_a_save(self):
        mentions = [
            tool_use("Bash", command="rg 'mem.py add' skill/"),
            tool_use("Bash", command='grep -n "mem.py update" README.md'),
            tool_use("Write", file_path="notes.md", content="Run python3 mem.py add to save.\n"),
            tool_use("Edit", file_path="a.py", old_string="x", new_string="subprocess.run(['mem.py', 'add'])"),
        ]
        self.assert_nudged(self.stop(mentions + [tool_use("Read", file_path="a")] * 10))

    def test_a_real_cli_save_counts_however_the_command_is_written(self):
        for i, command in enumerate([
                'cd ~/x && SHARED_MEMORY_AGENT=codex python3 scripts/mem.py update abc --content "x"',
                "~/.agents/skills/shared-memory-mcp/scripts/mem.py add 'Decision: y' --category decision",
                "python3 mem.py add z | tail -1"]):
            self.assertEqual(self.stop([tool_use("Bash", command=command)] + [tool_use("Read", file_path="a")] * 20,
                                       session=f"cli{i}"), "", command)

    def test_codex_shell_calls_are_read_too(self):
        def shell(script):
            return json.dumps({"type": "response_item", "payload": {"type": "function_call", "name": "shell",
                              "arguments": json.dumps({"command": ["bash", "-lc", script]})}})
        self.assertEqual(self.stop([shell("python3 mem.py add 'saved'")] + [shell("ls")] * 15, session="codex-save"), "")
        self.assert_nudged(self.stop([shell("rg 'mem.py add'")] + [shell("ls")] * 15, session="codex-mention"))

    def test_a_save_is_remembered_so_later_stops_do_not_rescan(self):
        saved = [tool_use("mcp__shared-memory__mem_add", content="x")] + [tool_use("Read", file_path="a")] * 12
        self.assertEqual(self.stop(saved), "")
        with mock.patch.object(mem, "tool_calls", side_effect=AssertionError("transcript scanned again")):
            self.assertEqual(self.stop(saved + [tool_use("Read", file_path="b")] * 5), "")

    def test_each_session_gets_its_own_nudge(self):
        work = [tool_use("Grep", pattern="x")] * 12
        self.assert_nudged(self.stop(work, session="first"))
        self.assert_nudged(self.stop(work, session="second"))

    def test_a_session_nudged_by_the_old_rule_is_not_nudged_again(self):
        with open(mem.state_path("old"), "w") as f:
            json.dump({"started": True, "nudged_at": 120}, f)
        self.assertEqual(self.stop([tool_use("Bash", command="ls")] * 300, session="old"), "")

    def test_never_while_the_stop_hook_itself_is_being_answered(self):
        self.assertEqual(self.stop([tool_use("Bash", command="ls")] * 20, stop_hook_active=True), "")


if __name__ == "__main__":
    unittest.main()
