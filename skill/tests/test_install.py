"""install.py as a new machine runs it: throwaway HOME, dummy key, a fresh copy of the skill.

Each test copies the skill (with or without instance.env), so results do not depend on which
repo the tests run in.

Run: python3 -m unittest discover -s tests
"""
import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import install  # noqa: E402
import mem  # noqa: E402

KEY = "dummy-key-not-real"
URL = "https://host.example/mcp"


def copy_skill(dest):
    """A fresh copy of the skill without instance.env, whichever repo the tests run in."""
    shutil.copytree(ROOT, dest, ignore=shutil.ignore_patterns(".git", "__pycache__", "instance.env"))


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith("SHARED_MEMORY_")}
    env.update(extra)
    return env


class Onboarding(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = os.path.join(tmp.name, "home")
        self.skill = os.path.join(tmp.name, "skill")
        self.python_flags = []
        os.makedirs(os.path.join(self.home, ".claude"))  # install.py only touches tools it finds
        copy_skill(self.skill)

    def run_install(self, *args, **env):
        script = os.path.join(self.skill, "scripts", "install.py")
        return subprocess.run([sys.executable, *self.python_flags, script, "--only", "claude", *args],
                              env=clean_env(HOME=self.home, **env), capture_output=True, text=True, timeout=60)

    def config_file(self):
        return os.path.join(self.home, ".config", "shared-memory", "env")

    def assert_installed(self, url):
        with open(self.config_file()) as f:
            saved = f.read()
        self.assertIn(f"SHARED_MEMORY_URL={url}", saved)
        self.assertIn(f"SHARED_MEMORY_API_KEY={KEY}", saved)
        self.assertEqual(stat.S_IMODE(os.stat(self.config_file()).st_mode), 0o600)
        link = os.path.join(self.home, ".agents", "skills", "shared-memory-mcp")
        self.assertEqual(os.path.realpath(link), os.path.realpath(self.skill))
        with open(os.path.join(self.home, ".claude", "settings.json")) as f:
            hooks = json.load(f)["hooks"]
        self.assertEqual(sorted(hooks), ["SessionStart", "Stop", "UserPromptSubmit"])
        with open(os.path.join(self.home, ".claude.json")) as f:
            entry = json.load(f)["mcpServers"]["shared-memory"]
        self.assertEqual((entry["url"], entry["headers"]["X-API-Key"]), (url, KEY))

    def test_without_a_url_it_stops_and_writes_nothing(self):
        r = self.run_install(SHARED_MEMORY_API_KEY=KEY)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("No server URL", r.stdout + r.stderr)
        self.assertFalse(os.path.exists(self.config_file()))

    def test_without_a_key_it_stops_and_writes_nothing(self):
        r = self.run_install(SHARED_MEMORY_URL=URL)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("SHARED_MEMORY_API_KEY", r.stdout + r.stderr)
        self.assertFalse(os.path.exists(self.config_file()))

    def test_url_and_key_install_everything(self):
        r = self.run_install(SHARED_MEMORY_URL=URL, SHARED_MEMORY_API_KEY=KEY)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assert_installed(URL)

    def test_instance_file_means_only_the_key_is_needed(self):
        with open(os.path.join(self.skill, "instance.env"), "w") as f:
            f.write("SHARED_MEMORY_URL=https://private.example/mcp\n")
        r = self.run_install(SHARED_MEMORY_API_KEY=KEY)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assert_installed("https://private.example/mcp")

    def test_dry_run_writes_nothing(self):
        r = self.run_install("--dry-run", SHARED_MEMORY_URL=URL, SHARED_MEMORY_API_KEY=KEY)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse(os.path.exists(self.config_file()))
        self.assertFalse(os.path.exists(os.path.join(self.home, ".claude", "settings.json")))

    def test_running_it_twice_changes_nothing_the_second_time(self):
        env = dict(SHARED_MEMORY_URL=URL, SHARED_MEMORY_API_KEY=KEY)
        first = self.run_install(**env)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        second = self.run_install(**env)
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        changed = [line for line in second.stdout.splitlines() if line.strip().startswith(("write", "link", "would"))]
        self.assertEqual(changed, [])
        backups = [name for name in os.listdir(os.path.join(self.home, ".claude")) if ".bak." in name]
        self.assertEqual(backups, [])

    def test_works_in_python_isolated_mode(self):
        self.python_flags = ["-I"]  # no script folder on the import path, no PYTHON* variables
        r = self.run_install(SHARED_MEMORY_URL=URL, SHARED_MEMORY_API_KEY=KEY)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assert_installed(URL)

    def test_key_in_instance_file_is_ignored_with_a_warning(self):
        with open(os.path.join(self.skill, "instance.env"), "w") as f:
            f.write("SHARED_MEMORY_URL=https://private.example/mcp\nSHARED_MEMORY_API_KEY=in-the-repo\n")
        r = self.run_install(SHARED_MEMORY_API_KEY=KEY)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("instance.env contains SHARED_MEMORY_API_KEY", r.stdout)
        self.assertNotIn("in-the-repo", r.stdout + r.stderr)
        self.assert_installed("https://private.example/mcp")

    def test_moving_the_server_updates_the_saved_url(self):
        instance = os.path.join(self.skill, "instance.env")
        with open(instance, "w") as f:
            f.write("SHARED_MEMORY_URL=https://old.example/mcp\n")
        first = self.run_install(SHARED_MEMORY_API_KEY=KEY)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        with open(instance, "w") as f:
            f.write("SHARED_MEMORY_URL=https://new.example/mcp\nSHARED_MEMORY_OLD_URL=https://old.example/mcp\n")
        second = self.run_install()  # no key and no URL given: both come from what is already saved
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assert_installed("https://new.example/mcp")


class Hooks(unittest.TestCase):
    """The hook runs on every agent session: it must exit 0 and print valid output."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = os.path.join(tmp.name, "home")
        self.skill = os.path.join(tmp.name, "skill")
        os.makedirs(self.home)
        copy_skill(self.skill)

    def run_hook(self, event, payload, **env):
        script = os.path.join(self.skill, "scripts", "mem.py")
        return subprocess.run([sys.executable, script, "hook", event, "--tool", "claude"], input=json.dumps(payload),
                              env=clean_env(HOME=self.home, **env), capture_output=True, text=True, timeout=60)

    def test_session_start_when_unconfigured_says_so_and_exits_zero(self):
        r = self.run_hook("session-start", {"session_id": "t", "cwd": self.home})
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(out["hookEventName"], "SessionStart")
        self.assertIn("not configured", out["additionalContext"])

    def test_session_start_with_an_unreachable_server_fails_soft(self):
        r = self.run_hook("session-start", {"session_id": "t", "cwd": self.home},
                          SHARED_MEMORY_URL="http://127.0.0.1:9/mcp", SHARED_MEMORY_API_KEY=KEY)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("unreachable", json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"])

    def test_prompt_and_stop_hooks_stay_silent_when_there_is_nothing_to_do(self):
        for event, payload in (("prompt", {"session_id": "t", "prompt": "hello"}), ("stop", {"session_id": "t"})):
            r = self.run_hook(event, payload)
            self.assertEqual((r.returncode, r.stdout), (0, ""), event)


class CodexConfig(unittest.TestCase):
    def configure(self, tmp, old_url, config_text, new_url="https://new.example/mcp"):
        """Run mcp_toml on a config.toml and return the resulting text."""
        instance = os.path.join(tmp, "instance.env")
        config = os.path.join(tmp, "config.toml")
        with open(instance, "w") as f:
            f.write(f"SHARED_MEMORY_URL={new_url}\n" + (f"SHARED_MEMORY_OLD_URL={old_url}\n" if old_url else ""))
        with open(config, "w") as f:
            f.write(config_text)
        env = clean_env(SHARED_MEMORY_URL=new_url, SHARED_MEMORY_API_KEY="k")
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(mem, "INSTANCE_FILE", instance), \
                mock.patch.object(mem, "ENV_FILE", os.path.join(tmp, "no-such-env")), \
                contextlib.redirect_stdout(io.StringIO()):
            install.Installer(False).mcp_toml(config)
        with open(config) as f:
            return f.read()

    def test_retired_url_is_rewritten_and_the_shared_memory_table_replaced(self):
        config = ('[mcp_servers.other]\nurl = "https://old.example/mcp"\n\n'
                  '[mcp_servers.shared-memory]\nurl = "https://stale.example/mcp"\n')
        with tempfile.TemporaryDirectory() as tmp:
            text = self.configure(tmp, "https://old.example/mcp", config)
        self.assertNotIn("old.example", text)
        self.assertNotIn("stale.example", text)
        self.assertEqual(text.count("[mcp_servers.shared-memory]"), 1)
        self.assertIn('url = "https://new.example/mcp"', text)

    def test_without_a_retired_url_other_tables_are_left_alone(self):
        original = '[mcp_servers.other]\nurl = "https://other.example/mcp"\nname = ""\nnote = \'\'\n'  # empty strings must survive
        with tempfile.TemporaryDirectory() as tmp:
            text = self.configure(tmp, "", original)
        self.assertTrue(text.startswith(original), text)
        self.assertEqual(text.count("https://new.example/mcp"), 1)  # only in our own table

    def test_only_exact_quoted_urls_are_rewritten_and_a_rerun_is_stable(self):
        config = ('[mcp_servers.a]\nurl = "https://h.example/mcp"\n'
                  '[mcp_servers.b]\nurl = "https://h.example/mcp-admin"\n'
                  "[mcp_servers.c]\nurl = 'https://h.example/mcp'\n")
        new = "https://h.example/mcp/v2"
        with tempfile.TemporaryDirectory() as tmp:
            first = self.configure(tmp, "https://h.example/mcp", config, new_url=new)
            second = self.configure(tmp, "https://h.example/mcp", first, new_url=new)
        self.assertIn(f'[mcp_servers.a]\nurl = "{new}"', first)
        self.assertIn(f"[mcp_servers.c]\nurl = '{new}'", first)
        self.assertIn('url = "https://h.example/mcp-admin"', first)
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
