from __future__ import annotations

import asyncio
import csv
import json
import re
from pathlib import Path

from app.core.config import env
from app.core.logs import log
from app.core.sio import emit_to, on, payload, room_sids
from app.core.state import est_pilote, groupe_spectateurs, users
from app.services import capteur, sonar_scans

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
    if (
        not isinstance(image, dict)
        or image.get("format") not in ("png", "svg")
        or not isinstance(image.get("data"), str)
    ):
        return None
    if not all(
        type(snapshot.get(key)) is int
        for key in ("readingCount", "totalReadings", "updatedAt")
    ):
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
            log(f"[SONAR][LIVE] Snapshot loaded updated_at={snapshot['updatedAt']} "
                f"readings={snapshot['readingCount']} format={snapshot['image']['format']}")
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
        log(f"[SONAR][LIVE] Snapshot requested available={_latest is not None}")
        await send_latest(sid, code)


def _scan_room(sid: str, *, pilot_only: bool = False) -> str | None:
    code = (users.get(sid) or {}).get("code")
    if not code or not re.fullmatch(r"[A-Za-z0-9_-]+", code) or sid not in room_sids(code):
        return None
    if est_pilote(sid) or (not pilot_only and sid in groupe_spectateurs(code)):
        return code
    return None


def _scan_status(code: str) -> dict:
    scan = sonar_scans.active.get(code)
    return {
        "session": scan.session if scan else None,
        "saving": bool(scan and scan.saving),
        "recordingError": scan.error if scan else None,
    }


@on("sonar_scan_status")
async def _status(sid, _data):
    code = _scan_room(sid)
    return _scan_status(code) if code else {"error": "Join the pairing room to view scans."}


@on("sonar_scan_start")
async def _start(sid, _data):
    code = _scan_room(sid, pilot_only=True)
    if not code:
        return {"error": "Only the pilot can start a scan."}
    try:
        sonar_scans.start(code)
    except OSError as error:
        log(f"[SONAR] Could not start scan: {error}")
        return {"error": "Could not start recording."}
    return _scan_status(code)


@on("sonar_scan_save")
async def _save(sid, data):
    code = _scan_room(sid, pilot_only=True)
    session = payload(data).get("session")
    if not code:
        return {"error": "Only the pilot can save a scan."}
    if not capteur.id_valide(session):
        return {"error": "Select a scan to save."}
    scan = sonar_scans.active.get(code)
    if not scan or scan.session != session:
        return await _saved_scan(code, session)
    if scan.saving:
        return {"error": "The scan is being saved."}
    scan.saving = True
    try:
        result = await asyncio.to_thread(sonar_scans.render, code, scan.session)
    except (OSError, csv.Error) as error:
        log(f"[SONAR] Could not save scan {session}: {error}")
        return {"error": "Could not save the scan. Try again."}
    finally:
        scan.saving = False
    del sonar_scans.active[code]
    return result


@on("sonar_scan_list")
async def _history(sid, _data):
    code = _scan_room(sid)
    if not code:
        return {"error": "Join the pairing room to view scans."}
    try:
        return {"scans": await asyncio.to_thread(sonar_scans.history, code)}
    except OSError as error:
        log(f"[SONAR] Could not list scans: {error}")
        return {"error": "Could not load saved scans."}


async def _saved_scan(code: str, session: str) -> dict:
    try:
        result = await asyncio.to_thread(sonar_scans.read, code, session)
    except (OSError, ValueError) as error:
        log(f"[SONAR] Could not open scan {session}: {error}")
        return {"error": "Could not open the saved scan."}
    return result if result is not None else {"error": "Scan not found."}


@on("sonar_scan_open")
async def _open(sid, data):
    code = _scan_room(sid)
    session = payload(data).get("session")
    if not code or not capteur.id_valide(session):
        return {"error": "Scan not found."}
    return await _saved_scan(code, session)
