"""Config resolution for mem.py and install.py.

Order: environment, then ~/.config/shared-memory/env, then instance.env next to SKILL.md.
instance.env supplies the server URL (and an optional retired URL); a key is never read from it.

Run: python3 -m unittest discover -s tests
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import install  # noqa: E402
import mem  # noqa: E402


class ConfigChain(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.env_file = os.path.join(tmp.name, "env")
        self.instance_file = os.path.join(tmp.name, "instance.env")
        for name, value in (("ENV_FILE", self.env_file), ("INSTANCE_FILE", self.instance_file)):
            patcher = mock.patch.object(mem, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        clean = {k: v for k, v in os.environ.items() if not k.startswith("SHARED_MEMORY_")}
        env = mock.patch.dict(os.environ, clean, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def write(self, path, text):
        with open(path, "w") as f:
            f.write(text)

    def assert_both(self, url, key):
        """mem.py and install.py must resolve the same (url, key)."""
        cfg = mem.load_config()
        self.assertEqual((cfg["url"], cfg["key"]), (url, key), "mem.py")
        self.assertEqual(install.load_env(), (url, key), "install.py")

    def test_url_comes_from_instance_file_when_nothing_else_is_set(self):
        self.write(self.instance_file, "SHARED_MEMORY_URL=https://private.example/mcp\n")
        self.assert_both("https://private.example/mcp", "")

    def test_config_file_beats_instance_file(self):
        self.write(self.instance_file, "SHARED_MEMORY_URL=https://private.example/mcp\n")
        self.write(self.env_file, "SHARED_MEMORY_URL=https://saved.example/mcp\nSHARED_MEMORY_API_KEY=saved-key\n")
        self.assert_both("https://saved.example/mcp", "saved-key")

    def test_environment_beats_config_file(self):
        self.write(self.env_file, "SHARED_MEMORY_URL=https://saved.example/mcp\nSHARED_MEMORY_API_KEY=saved-key\n")
        with mock.patch.dict(os.environ, {"SHARED_MEMORY_URL": "https://env.example/mcp", "SHARED_MEMORY_API_KEY": "env-key"}):
            self.assert_both("https://env.example/mcp", "env-key")

    def test_empty_environment_variable_counts_as_unset(self):
        self.write(self.instance_file, "SHARED_MEMORY_URL=https://private.example/mcp\n")
        with mock.patch.dict(os.environ, {"SHARED_MEMORY_URL": ""}):
            self.assert_both("https://private.example/mcp", "")

    def test_key_is_never_read_from_instance_file(self):
        self.write(self.instance_file, "SHARED_MEMORY_URL=https://private.example/mcp\nSHARED_MEMORY_API_KEY=leaked\n")
        self.assert_both("https://private.example/mcp", "")

    def test_export_prefix_and_quotes_are_accepted(self):
        self.write(self.env_file, "export SHARED_MEMORY_URL='https://quoted.example/mcp'\nexport SHARED_MEMORY_API_KEY=\"k\"\n")
        self.assert_both("https://quoted.example/mcp", "k")

    def test_no_url_anywhere_is_empty_and_a_call_explains_why(self):
        self.assert_both("", "")
        with self.assertRaises(mem.ConfigError) as ctx:
            mem.call("mem_stats", {})
        self.assertIn("SHARED_MEMORY_URL", str(ctx.exception))

    def test_session_start_says_it_is_not_configured_instead_of_failing(self):
        text, shown = mem.project_context("/tmp")
        self.assertIn("not configured", text)
        self.assertEqual(shown, set())

    def test_old_url_comes_only_from_instance_file(self):
        self.assertEqual(install.old_url(), "")
        self.write(self.instance_file, "SHARED_MEMORY_URL=https://new.example/mcp\nSHARED_MEMORY_OLD_URL=https://old.example/mcp\n")
        self.assertEqual(install.old_url(), "https://old.example/mcp")

    def test_old_url_ignores_the_environment_and_the_saved_file(self):
        self.write(self.env_file, "SHARED_MEMORY_OLD_URL=https://saved-old.example/mcp\n")
        with mock.patch.dict(os.environ, {"SHARED_MEMORY_OLD_URL": "https://env-old.example/mcp"}):
            self.assertEqual(install.old_url(), "")

    def test_values_from_the_environment_are_stripped(self):
        with mock.patch.dict(os.environ, {"SHARED_MEMORY_URL": "  https://env.example/mcp \n", "SHARED_MEMORY_API_KEY": "k\r\n"}):
            self.assert_both("https://env.example/mcp", "k")

    def test_whitespace_only_values_count_as_unset(self):
        self.write(self.instance_file, "SHARED_MEMORY_URL=https://private.example/mcp\n")
        with mock.patch.dict(os.environ, {"SHARED_MEMORY_URL": "   "}):
            self.assert_both("https://private.example/mcp", "")

    def test_empty_key_variable_counts_as_unset(self):
        self.write(self.env_file, "SHARED_MEMORY_URL=https://saved.example/mcp\nSHARED_MEMORY_API_KEY=saved-key\n")
        with mock.patch.dict(os.environ, {"SHARED_MEMORY_API_KEY": ""}):
            self.assert_both("https://saved.example/mcp", "saved-key")

    def test_env_file_survives_a_bom_comments_and_quoted_hashes(self):
        self.write(self.env_file, "﻿SHARED_MEMORY_URL=https://saved.example/mcp  # prod\n"
                                  "# SHARED_MEMORY_API_KEY=commented-out\n"
                                  "SHARED_MEMORY_API_KEY=\"has # inside\"\n")
        self.assert_both("https://saved.example/mcp", "has # inside")

    def test_empty_value_in_the_saved_file_falls_through_to_instance_file(self):
        self.write(self.instance_file, "SHARED_MEMORY_URL=https://private.example/mcp\n")
        self.write(self.env_file, "SHARED_MEMORY_URL=\n")
        self.assert_both("https://private.example/mcp", "")

    def test_unreadable_env_file_is_ignored(self):
        with open(self.env_file, "wb") as f:
            f.write(b"\xff\xfe\x00\x80 not utf-8")
        self.write(self.instance_file, "SHARED_MEMORY_URL=https://private.example/mcp\n")
        self.assert_both("https://private.example/mcp", "")

    def test_saved_url_that_instance_file_retired_is_ignored(self):
        self.write(self.instance_file, "SHARED_MEMORY_URL=https://new.example/mcp\nSHARED_MEMORY_OLD_URL=https://old.example/mcp\n")
        self.write(self.env_file, "SHARED_MEMORY_URL=https://old.example/mcp\nSHARED_MEMORY_API_KEY=saved-key\n")
        self.assert_both("https://new.example/mcp", "saved-key")
        with mock.patch.dict(os.environ, {"SHARED_MEMORY_URL": "https://old.example/mcp"}):  # an explicit choice still wins
            self.assert_both("https://old.example/mcp", "saved-key")

    def test_a_malformed_key_is_never_echoed(self):
        env = {"SHARED_MEMORY_URL": "http://127.0.0.1:9/mcp", "SHARED_MEMORY_API_KEY": "SECRETKEY\nTAIL"}
        with mock.patch.dict(os.environ, env):
            with self.assertRaises(mem.ConfigError) as ctx:
                mem.call("mem_stats", {})
        self.assertNotIn("SECRETKEY", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
