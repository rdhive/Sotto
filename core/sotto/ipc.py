"""Core <-> shell transport: newline-delimited JSON over loopback TCP.

Deliberately not WebSocket. The UI is a local process, the payloads are
tiny, and Electron's `net` module speaks raw TCP out of the box. This is
fewer dependencies, less asyncio, and a shorter path per message.

Core pushes events (state changes, audio level, results). Shell pushes
commands (get_config, set_config, list_devices).
"""
from __future__ import annotations

import json
import socket
import threading
from typing import Any, Callable

from . import log

_log = log.get("ipc")


class IpcServer:
    def __init__(
        self,
        host: str,
        port: int,
        on_command: Callable[[dict], dict | None] | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self._on_command = on_command
        self._sock: socket.socket | None = None
        self._clients: list[socket.socket] = []
        self._lock = threading.Lock()
        self._running = False

    def start(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        # NOT SO_REUSEADDR. On Windows that flag lets a second process bind a
        # port another process is already listening on - so a second engine
        # starts silently, installs its own keyboard hook, and both fight over
        # the same shell. SO_EXCLUSIVEADDRUSE makes the second bind fail
        # instead, which is what we want: one engine, or a clear error.
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            self._sock.bind((self.host, self.port))
        except OSError as exc:
            self._sock.close()
            raise RuntimeError(
                f"port {self.port} is already in use - another Sotto engine "
                f"is running. Close it first."
            ) from exc
        self._sock.listen(4)
        self._running = True
        threading.Thread(target=self._accept_loop, name="ipc", daemon=True).start()
        _log.info("listening on %s:%d", self.host, self.port)

    def stop(self) -> None:
        self._running = False
        with self._lock:
            for c in self._clients:
                try:
                    c.close()
                except OSError:
                    pass
            self._clients.clear()
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass

    @property
    def client_count(self) -> int:
        with self._lock:
            return len(self._clients)

    def broadcast(self, event: dict[str, Any]) -> None:
        line = (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")
        with self._lock:
            dead = []
            for c in self._clients:
                try:
                    c.sendall(line)
                except OSError:
                    dead.append(c)
            for c in dead:
                self._clients.remove(c)

    # -- internals ---------------------------------------------------------
    def _accept_loop(self) -> None:
        while self._running:
            try:
                conn, _ = self._sock.accept()
            except OSError:
                break
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            with self._lock:
                self._clients.append(conn)
            _log.info("shell connected (%d client(s))", len(self._clients))
            threading.Thread(
                target=self._client_loop, args=(conn,), daemon=True
            ).start()

    def _client_loop(self, conn: socket.socket) -> None:
        buf = b""
        try:
            while self._running:
                chunk = conn.recv(8192)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    self._handle(conn, line)
        except OSError:
            pass
        finally:
            with self._lock:
                if conn in self._clients:
                    self._clients.remove(conn)
            try:
                conn.close()
            except OSError:
                pass
            _log.info("shell disconnected")

    def _handle(self, conn: socket.socket, line: bytes) -> None:
        try:
            msg = json.loads(line.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            _log.warning("bad message from shell: %r", line[:120])
            return
        if self._on_command is None:
            return
        try:
            reply = self._on_command(msg)
        except Exception:
            _log.exception("command %r failed", msg.get("cmd"))
            reply = {"type": "error", "message": "command failed"}
        if reply is not None:
            if "id" in msg:
                reply["id"] = msg["id"]
            try:
                conn.sendall(
                    (json.dumps(reply, ensure_ascii=False) + "\n").encode("utf-8")
                )
            except OSError:
                pass
