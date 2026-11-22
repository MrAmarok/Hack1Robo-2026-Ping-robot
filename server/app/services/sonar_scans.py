from __future__ import annotations

import asyncio
import json
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

from app.core.logs import log
from app.services import capteur, sonar_mapper

RESOLUTION_M = 0.05
PREVIEW_RESOLUTION_M = 0.15
PREVIEW_SAMPLE_LIMIT = 384


@dataclass
class Scan:
    session: str
    saving: bool = False
    error: str | None = None
    reading_count: int = 0
    preview_stride: int = 1
    preview_readings: list[sonar_mapper.Reading] = field(default_factory=list)
    preview_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    preview_revision: int = 0
    preview_snapshot: dict | None = None


active: dict[str, Scan] = {}


def directory(code: str) -> Path:
    return capteur.dossier(code) / "sonar-scans"


def start(code: str) -> Scan:
    if code not in active:
        scan = Scan(uuid4().hex)
        capteur.ajouter_csv(directory(code) / f"{scan.session}.csv", [])
        active[code] = scan
        log(f"[SONAR][SCAN] Recording started session={scan.session}")
    return active[code]


def record(code: str, rows: list[str]) -> None:
    scan = active.get(code)
    if not scan or scan.saving or scan.error:
        return
    try:
        capteur.ajouter_csv(directory(code) / f"{scan.session}.csv", rows)
    except (OSError, capteur.TropVolumineux) as error:
        log(f"[SONAR] Recording stopped for scan {scan.session}: {error}")
        scan.error = "Recording stopped early. Save the readings collected so far."
    else:
        for row in rows:
            reading = sonar_mapper.parse_reading(*(float(value or 0) for value in row.split(",")))
            if reading is None:
                continue
            if scan.reading_count % scan.preview_stride == 0:
                scan.preview_readings.append(reading)
                if len(scan.preview_readings) > PREVIEW_SAMPLE_LIMIT:
                    scan.preview_readings = scan.preview_readings[::2]
                    scan.preview_stride *= 2
            scan.reading_count += 1
        log(f"[SONAR][SCAN] Recorded session={scan.session} rows={len(rows)}")


def _build_preview(code: str, readings: list[sonar_mapper.Reading], count: int) -> dict:
    image, _ = sonar_mapper.build_map(readings, PREVIEW_RESOLUTION_M)
    return {
        "code": code,
        "image": {"format": "png", "data": sonar_mapper.encode_snapshot(image, "png")},
        "readingCount": len(readings),
        "totalReadings": count,
        "resolutionM": PREVIEW_RESOLUTION_M,
        "updatedAt": time.time_ns() // 1_000_000,
    }


async def preview(code: str, scan: Scan) -> dict | None:
    async with scan.preview_lock:
        if scan.preview_revision != scan.reading_count and not scan.saving:
            count = scan.reading_count
            try:
                scan.preview_snapshot = await asyncio.to_thread(
                    _build_preview, code, scan.preview_readings.copy(), count
                )
            except ValueError as error:
                log(f"[SONAR][MAP] Preview failed session={scan.session}: {error}")
            scan.preview_revision = count
        return scan.preview_snapshot


def render(code: str, session: str) -> dict:
    started = time.monotonic()
    log(f"[SONAR][MAP] Building session={session}")
    folder = directory(code)
    result = {"session": session, "snapshot": None, "mapError": None}
    try:
        readings = sonar_mapper.load_readings(folder / f"{session}.csv")
        image, _ = sonar_mapper.build_map(readings, RESOLUTION_M)
    except ValueError as error:
        result["mapError"] = f"Map unavailable: {error}."
        log(f"[SONAR][MAP] Build failed session={session}: {error}")
    else:
        result["snapshot"] = {
            "code": code,
            "image": {"format": "png", "data": sonar_mapper.encode_snapshot(image, "png")},
            "readingCount": len(readings),
            "totalReadings": len(readings),
            "resolutionM": RESOLUTION_M,
            "updatedAt": time.time_ns() // 1_000_000,
        }

    file = tempfile.NamedTemporaryFile(dir=folder, mode="w", encoding="utf-8", delete=False)
    temporary = Path(file.name)
    try:
        with file:
            json.dump(result, file)
        temporary.replace(folder / f"{session}.json")
    finally:
        temporary.unlink(missing_ok=True)
    duration_ms = round((time.monotonic() - started) * 1000)
    if result["snapshot"] is not None:
        log(f"[SONAR][MAP] Saved session={session} readings={len(readings)} "
            f"size={image.width}x{image.height} duration_ms={duration_ms}")
    return result


def history(code: str) -> list[dict]:
    saved = [
        {"session": path.stem, "savedAt": path.stat().st_mtime_ns // 1_000_000}
        for path in directory(code).glob("*.json")
    ]
    return sorted(saved, key=lambda scan: scan["savedAt"], reverse=True)


def read(code: str, session: str) -> dict | None:
    try:
        return json.loads((directory(code) / f"{session}.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
