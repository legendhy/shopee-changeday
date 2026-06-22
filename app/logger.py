"""Shared logger: writes to a file and keeps an in-memory ring buffer
so the web dashboard can show the live tail.
"""
from __future__ import annotations

import logging
import time
from collections import deque
from pathlib import Path
from threading import Lock

_buffer: "deque[dict]" = deque(maxlen=1000)
_lock = Lock()


class BufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        entry = {
            "ts": record.created,
            "level": record.levelname,
            "msg": self.format(record),
        }
        with _lock:
            _buffer.append(entry)


def setup_logging() -> None:
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s",
                            "%H:%M:%S")

    Path("logs").mkdir(exist_ok=True)
    fh = logging.FileHandler("logs/run.log", encoding="utf-8")
    fh.setFormatter(fmt)

    bh = BufferHandler()
    bh.setFormatter(logging.Formatter("%(message)s"))

    # idempotent: don't add duplicates on re-init
    if not any(isinstance(h, BufferHandler) for h in root.handlers):
        root.addHandler(fh)
        root.addHandler(bh)


def recent_logs(since_ts: float = 0.0) -> list[dict]:
    with _lock:
        return [e for e in _buffer if e["ts"] > since_ts]


def all_logs() -> list[dict]:
    with _lock:
        return list(_buffer)


def now_ts() -> float:
    return time.time()
