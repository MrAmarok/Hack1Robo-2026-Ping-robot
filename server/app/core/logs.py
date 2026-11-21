from __future__ import annotations

import sys
import time

from app.core.config import ROBOT_DEBUG_LOGS


def log(*args) -> None:
    print(f"[{time.strftime('%H:%M:%S')}]", *args, flush=True)


def log_err(*args) -> None:
    print(f"[{time.strftime('%H:%M:%S')}]", *args, file=sys.stderr, flush=True)


def robot_log(*args) -> None:
    if ROBOT_DEBUG_LOGS:
        log(*args)


def now_ms() -> int:
    return int(time.time() * 1000)
