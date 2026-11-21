from __future__ import annotations

import asyncio
import json
from pathlib import Path

from app.core.config import env
from app.core.sio import emit_to, on, room_sids
from app.core.state import est_pilote, groupe_spectateurs, users

ROOM = env("SONAR_MAP_ROOM")
SNAPSHOT_FILE = env("SONAR_SNAPSHOT_FILE")
_latest: dict | None = None


def _read_snapshot(path: Path) -> dict | None:
    try:
        snapshot = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(snapshot, dict):
        return None
    image = snapshot.get("image")
    if not isinstance(image, dict) or image.get("format") not in ("png", "svg") or not isinstance(image.get("data"), str):
        return None
    if not all(type(snapshot.get(key)) is int for key in ("readingCount", "totalReadings", "updatedAt")):
        return None
    if type(snapshot.get("resolutionM")) not in (int, float):
        return None
    return snapshot


async def watch_snapshots() -> None:
    global _latest
    if not ROOM or not SNAPSHOT_FILE:
        return
    path = Path(SNAPSHOT_FILE)
    while True:
        snapshot = await asyncio.to_thread(_read_snapshot, path)
        if snapshot is not None and snapshot != _latest:
            _latest = snapshot
            for sid in room_sids(ROOM):
                await send_latest(sid, ROOM)
        await asyncio.sleep(0.5)


async def send_latest(sid: str, code: str) -> None:
    if (
        code == ROOM
        and _latest is not None
        and (users.get(sid) or {}).get("code") == code
        and (est_pilote(sid) or sid in groupe_spectateurs(code))
    ):
        await emit_to(sid, "sonar_map_snapshot", {**_latest, "code": code})


@on("sonar_map_request")
async def _request_snapshot(sid, _data):
    code = (users.get(sid) or {}).get("code")
    if code == ROOM and code and sid in room_sids(code):
        await send_latest(sid, code)
