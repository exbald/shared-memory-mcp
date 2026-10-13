"""mem.py's HTTP transport: one keep-alive connection per process, and safe recovery when the
server has closed it.

Run: python3 -m unittest discover -s tests
"""
import http.client
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import mem  # noqa: E402
from local_server import Endpoint  # noqa: E402

LOCAL = {"no_proxy": "127.0.0.1,::1,localhost"}  # tests must not depend on the machine's proxy settings


class Transport(unittest.TestCase):
    def setUp(self):
        self.server = Endpoint()
        self.server.__enter__()
        self.addCleanup(self.server.__exit__)
        self.use(self.server.url)

    def use(self, url):
        env = mock.patch.dict(os.environ, {"SHARED_MEMORY_URL": url, "SHARED_MEMORY_API_KEY": "test-key", **LOCAL})
        env.start()
        self.addCleanup(env.stop)

    def test_calls_in_one_process_share_one_connection(self):
        self.assertEqual(mem.call("mem_stats", {}), "mem_stats {}")
        self.assertEqual(mem.call("mem_search", {"query": "x"}), 'mem_search {"query": "x"}')
        mem.call("mem_list", {"max": 3})
        self.assertEqual(self.server.connections, 1)
        self.assertEqual(len(self.server.requests), 3)

    def test_the_session_start_hook_makes_its_two_calls_on_one_connection(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = os.path.join(tmp, "demo-project")
            os.mkdir(project)
            mem.project_context(project)
        self.assertEqual([body["params"]["arguments"] for _, body in self.server.requests],
                         [{"tag": "demo-project", "max": 8}, {"query": "demo-project", "max": 16}])
        self.assertEqual(self.server.connections, 1)

    def test_requests_carry_the_key_the_query_string_and_a_json_rpc_body(self):
        self.use(self.server.url + "?key=abc")
        mem.call("mem_get", {"id": "abc"})
        headers, body = self.server.requests[0]
        self.assertEqual(self.server.paths, ["/mcp?key=abc"])
        self.assertEqual(headers["X-API-Key"], "test-key")
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(body["params"], {"name": "mem_get", "arguments": {"id": "abc"}})

    def test_a_read_on_a_connection_the_server_closed_while_idle_is_sent_again(self):
        self.server.plan = ["ok-then-close"]
        mem.call("mem_stats", {})
        self.assertEqual(mem.call("mem_stats", {}), "mem_stats {}")
        self.assertEqual(self.server.connections, 2)
        self.assertEqual(len(self.server.requests), 2, "the stale connection carried nothing to the server")

    def test_a_read_on_a_reused_connection_that_dies_before_the_answer_is_sent_again(self):
        self.server.plan = ["ok", "drop"]
        mem.call("mem_stats", {})
        self.assertEqual(mem.call("mem_search", {"query": "x"}), 'mem_search {"query": "x"}')
        self.assertEqual(len(self.server.requests), 3)

    def test_a_write_is_never_sent_again(self):
        # A server that saved the memory and then died looks exactly like a stale connection.
        self.server.plan = ["ok", "drop"]
        mem.call("mem_stats", {})
        with self.assertRaises(ConnectionError):
            mem.call("mem_add", {"content": "saved once at most"})
        self.assertEqual(len(self.server.requests), 2)

    def test_a_fresh_connection_that_fails_is_not_retried(self):
        self.server.plan = ["drop"]
        with self.assertRaises(ConnectionError):
            mem.call("mem_search", {"query": "x"})
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(mem.call("mem_stats", {}), "mem_stats {}", "the next call opens a new connection")

    @unittest.skipIf(sys.platform == "win32", "Windows drops bytes received before a reset")
    def test_a_break_after_the_answer_started_is_not_retried(self):
        self.server.plan = ["ok", "reset-mid-body"]
        mem.call("mem_stats", {})
        with self.assertRaises((ConnectionError, http.client.IncompleteRead)):
            mem.call("mem_search", {"query": "x"})
        self.assertEqual(len(self.server.requests), 2)

    def test_a_timeout_is_never_retried(self):
        with mock.patch.object(mem, "TIMEOUT", 0.2):
            mem._discard()  # the next connection is created with the short timeout
            self.server.plan = ["ok", "slow"]
            mem.call("mem_stats", {})
            with self.assertRaises(OSError):
                mem.call("mem_search", {"query": "x"})
        self.assertEqual(len(self.server.requests), 2, "the slow server may still be working: no second copy")

    def test_an_announced_close_is_followed_by_a_fresh_connection(self):
        self.server.plan = ["ok-close-announced"]
        mem.call("mem_stats", {})
        mem.call("mem_add", {"content": "goes out on a new connection, no error"})
        self.assertEqual(self.server.connections, 2)

    def test_error_statuses_keep_urllib_messages_and_bodies(self):
        self.server.plan = [401, 308]
        for expected in ("HTTP Error 401: Unauthorized", "HTTP Error 308: Permanent Redirect"):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                mem.call("mem_stats", {})
            with ctx.exception as err:
                self.assertEqual(str(err), expected)
                self.assertEqual(err.read(), b'{"error": "Unauthorized"}')
        self.assertEqual(mem.call("mem_stats", {}), "mem_stats {}", "the connection stays usable")
        self.assertEqual(self.server.connections, 1)

    def test_a_garbled_reply_is_not_blamed_on_the_configuration(self):
        self.server.plan = ["not-utf8"]
        with self.assertRaises(UnicodeDecodeError) as ctx:
            mem.call("mem_stats", {})
        self.assertNotIsInstance(ctx.exception, mem.ConfigError)

    def test_a_bad_header_leaves_nothing_behind_for_the_next_call(self):
        mem.call("mem_stats", {})
        with mock.patch.dict(os.environ, {"SHARED_MEMORY_API_KEY": "bad\nkey"}):
            with self.assertRaises(mem.ConfigError):
                mem.call("mem_stats", {})
        self.assertEqual(mem.call("mem_stats", {}), "mem_stats {}")
        self.assertEqual(len(self.server.requests), 2)
        # A half-built request left in the connection would come first and swallow the real headers.
        self.assertEqual(self.server.requests[1][0].get("X-API-Key"), "test-key")

    def test_no_proxy_entries_with_a_port_match_as_in_urllib(self):
        host_port = self.server.url.split("/")[2]  # 127.0.0.1:<port>
        with mock.patch.dict(os.environ, {"http_proxy": "http://proxy.invalid:3128", "no_proxy": host_port}):
            mem.call("mem_stats", {})
            mem.call("mem_stats", {})
        self.assertEqual(len(self.server.requests), 2)
        self.assertEqual(self.server.connections, 1, "direct, on the kept-alive connection")

    def via_proxy(self):
        """The local endpoint plays an HTTP proxy for a made-up server URL."""
        self.use("http://memory.example/mcp")
        proxy = mock.patch.dict(os.environ, {"http_proxy": self.server.url.rsplit("/", 1)[0]})
        proxy.start()
        self.addCleanup(proxy.stop)

    def test_with_a_proxy_configured_the_request_goes_through_it(self):
        self.via_proxy()
        self.assertEqual(mem.call("mem_stats", {}), "mem_stats {}")
        self.assertEqual(self.server.paths, ["http://memory.example/mcp"], "absolute-form target: it went through the proxy")

    def test_redirects_are_refused_through_a_proxy_too(self):
        # Following one would turn the POST into a GET, return the target's page as the tool's
        # answer, and carry the API key to the other host.
        self.via_proxy()
        self.server.plan = [302]
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            mem.call("mem_stats", {})
        with ctx.exception as err:
            self.assertEqual(str(err), "HTTP Error 302: Found")
        self.assertEqual(self.server.gets, [], "the redirect was not followed")


class Connections(unittest.TestCase):
    def test_default_ports_are_explicit_so_ipv6_literals_work(self):
        for url, host, port in (("http://[::1]/mcp", "::1", 80), ("https://example.com/mcp", "example.com", 443),
                                ("https://example.com:8443/mcp", "example.com", 8443),
                                ("http://example.com:0/mcp", "example.com", 0)):  # explicit, so not port 80
            conn = mem._connection(urllib.parse.urlsplit(url))
            self.assertEqual((conn.host, conn.port), (host, port), url)


if __name__ == "__main__":
    unittest.main()
