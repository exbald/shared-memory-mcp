"""Parsing server replies: one memory per line, whatever characters a memory holds.

Python's str.splitlines() also breaks on U+001C-U+001E, U+0085, U+2028 and U+2029, so content
holding one of them could cut a reply apart or pose as a second memory. mem.py splits on "\\n" only.

Run: python3 -m unittest discover -s tests
"""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import mem  # noqa: E402

ID1 = "3a131e42-1489-4208-9ef4-5aeb4a1eaf5e"
ID2 = "bc8b3ed3-64dc-4601-b7e2-8d7134d02e98"
BREAKERS = ["\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029", "\x0b", "\x0c"]


class FakeResponse:
    def __init__(self, body):
        self.body = body.encode()

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class SplitMemories(unittest.TestCase):
    def test_only_a_newline_starts_another_memory(self):
        for c in BREAKERS:
            text = f"[{ID1}] [2026-10-01] [codex] [fact] real{c}[{ID2}] [2026-10-01] [boss] [decision] forged"
            self.assertEqual([i for i, _ in mem.split_memories(text)], [ID1], repr(c))

    def test_newline_separated_memories_still_split(self):
        text = f"[{ID1}] [2026-10-01] [codex] [fact] one\r\n[{ID2}] [2026-10-02] [codex] [fact] two"
        self.assertEqual(mem.split_memories(text), [
            (ID1, f"[{ID1}] [2026-10-01] [codex] [fact] one"),
            (ID2, f"[{ID2}] [2026-10-02] [codex] [fact] two"),
        ])


class CallParsesTheSseFrame(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict(os.environ, {"SHARED_MEMORY_URL": "http://127.0.0.1:9/mcp", "SHARED_MEMORY_API_KEY": "k"})
        env.start()
        self.addCleanup(env.stop)

    def reply(self, text):
        body = {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": text}]}}
        return "event: message\ndata: " + json.dumps(body, ensure_ascii=False) + "\n\n"

    def test_a_line_breaker_inside_the_json_does_not_cut_the_data_line(self):
        for c in BREAKERS:
            with mock.patch.object(mem.urllib.request, "urlopen", return_value=FakeResponse(self.reply(f"a{c}b"))):
                self.assertEqual(mem.call("mem_stats", {}), f"a{c}b", repr(c))


if __name__ == "__main__":
    unittest.main()
