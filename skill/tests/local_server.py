"""A local stand-in for the MCP endpoint, for transport tests: answers each POST with one SSE
frame, counts the TCP connections it accepts, and can misbehave on cue.

plan entries, used one per request: "ok" (default), "ok-then-close" (answer, then close the
connection without announcing it, as a server does with an idle keep-alive connection),
"ok-close-announced" (answer with Connection: close), "slow" (answer after 0.6 s),
"drop" (close without answering), "not-utf8" (a body that is not UTF-8), "reset-mid-body"
(start answering, then reset the connection), or an int (answer with that HTTP status).
"""
import http.server
import json
import socket
import struct
import threading
import time


class Endpoint:
    def __init__(self, text=None):
        self.connections = 0
        self.requests = []  # (headers, JSON-RPC body) per request that reached the server
        self.paths = []
        self.gets = []  # (path, headers) of GET requests: redirects that were followed
        self.plan = []
        self.text = text
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.httpd.handle_error = lambda request, address: None  # a client that hung up is expected here
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    @property
    def url(self):
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/mcp"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()

    def _handler(self):
        endpoint = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"  # keep-alive

            def setup(self):
                super().setup()
                endpoint.connections += 1

            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                endpoint.requests.append((dict(self.headers), body))
                endpoint.paths.append(self.path)
                how = endpoint.plan.pop(0) if endpoint.plan else "ok"
                if how == "drop":
                    self.close_connection = True
                    return
                if isinstance(how, int):  # a 3xx points at a page that would answer a GET
                    extra = {"Location": "http://redirect.example/landing"} if 300 <= how < 400 else {}
                    self.reply(how, "application/json", b'{"error": "Unauthorized"}', **extra)
                    return
                if how == "slow":  # longer than the client's timeout in the tests that use it
                    time.sleep(0.6)
                    how = "ok"
                if how == "not-utf8":
                    self.reply(200, "text/event-stream", b"data: \xff\xfe\n\n")
                    return
                if how == "reset-mid-body":  # the request ran; the connection breaks while answering
                    self.send_response(200)
                    self.send_header("Content-Length", "1000")
                    self.end_headers()
                    self.wfile.write(b"event: message\ndata: {")
                    self.wfile.flush()
                    time.sleep(0.2)  # let the client get past the status line first
                    self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                    self.connection.close()  # RST, not FIN
                    self.close_connection = True
                    return
                params = body["params"]
                text = endpoint.text if endpoint.text is not None else f"{params['name']} {json.dumps(params['arguments'])}"
                result = {"jsonrpc": "2.0", "id": body["id"], "result": {"content": [{"type": "text", "text": text}]}}
                frame = "event: message\ndata: " + json.dumps(result, ensure_ascii=False) + "\n\n"
                self.reply(200, "text/event-stream", frame.encode(), close=how == "ok-close-announced")
                if how in ("ok-then-close", "ok-close-announced"):
                    self.close_connection = True

            def do_GET(self):  # only a client that followed a redirect sends a GET
                endpoint.gets.append((self.path, dict(self.headers)))
                result = {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "redirect target"}]}}
                self.reply(200, "text/event-stream", ("data: " + json.dumps(result) + "\n\n").encode())

            def reply(self, status, content_type, data, close=False, **extra):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                for name, value in extra.items():
                    self.send_header(name, value)
                if close:
                    self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(data)

        return Handler
