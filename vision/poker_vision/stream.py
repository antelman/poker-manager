"""Publishing the live table state so something else can read it.

Two ways out, both optional:

* `StateWriter` keeps a JSON file up to date (atomically, so a reader never
  catches a half-written file).
* `StateServer` serves the same JSON on http://localhost:PORT/state with CORS
  open, which is what the web app would poll if it ever grows a live view.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class StateWriter:
    """Mirrors the latest state into a JSON file."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, state: dict) -> None:
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, self.path)


class StateServer:
    """Tiny read-only HTTP endpoint holding the most recent state."""

    def __init__(self, port: int, host: str = "127.0.0.1"):
        self.state: dict = {"ready": False}
        self._lock = threading.Lock()
        server_self = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - name fixed by BaseHTTPRequestHandler
                if self.path.split("?")[0] not in ("/", "/state"):
                    self.send_error(404)
                    return
                with server_self._lock:
                    body = json.dumps(server_self.state, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # keep the console for the game
                pass

        self.httpd = ThreadingHTTPServer((host, port), Handler)
        self.url = f"http://{host}:{self.httpd.server_address[1]}/state"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def start(self) -> "StateServer":
        self.thread.start()
        return self

    def publish(self, state: dict) -> None:
        with self._lock:
            self.state = state

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
