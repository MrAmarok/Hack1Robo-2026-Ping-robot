"""Build an occupancy grid from HC-SR04 readings with known poses."""

import argparse
import base64
import csv
import io
import json
import math
import tempfile
import time
from collections import defaultdict
from dataclasses import dataclass
from itertools import groupby
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

FIELDS = ("x_m", "y_m", "heading_deg", "sensor_angle_deg", "distance_cm")
BEAM_HALF_ANGLE = math.radians(7.5)
UNKNOWN, FREE, OCCUPIED = 160, 255, 0


@dataclass(frozen=True)
class Reading:
    x: float
    y: float
    angle: float
    range_m: float


@dataclass(frozen=True)
class Tolerances:
    range_m: float = 0.0
    position_m: float = 0.0
    heading_deg: float = 0.0


def parse_reading(x: float, y: float, heading: float, sensor_angle: float, distance: float) -> Reading | None:
    if 2 <= distance <= 400:
        angle = math.radians((heading % 360 + sensor_angle % 360) % 360)
        return Reading(x, y, angle, distance / 100)
    return None


def load_readings(path: Path) -> list[Reading]:
    readings = []
    with path.open(newline="", encoding="utf-8-sig") as source:
        rows = csv.DictReader(source)
        if not set(FIELDS).issubset(rows.fieldnames or ()):
            raise ValueError(f"expected columns {', '.join(FIELDS)}")
        for row in rows:
            try:
                x, y, heading, sensor_angle = (float(row[name]) for name in FIELDS[:-1])
                distance = float(row["distance_cm"]) if row["distance_cm"] != "" else 0
                if not all(map(math.isfinite, (x, y, heading, sensor_angle, distance))):
                    raise ValueError("values must be finite")
            except (TypeError, ValueError) as error:
                raise ValueError(f"CSV line {rows.line_num}: {error}") from error
            reading = parse_reading(x, y, heading, sensor_angle, distance)
            if reading is not None:
                readings.append(reading)
    if not readings:
        raise ValueError("no valid HC-SR04 echoes (2–400 cm)")
    return readings


def build_map(
    readings: list[Reading],
    resolution: float,
    *,
    extent: list[Reading] | None = None,
    tolerances: Tolerances = Tolerances(),
) -> tuple[Image.Image, tuple[float, float]]:
    bounds_readings = extent if extent is not None else readings
    range_padding = tolerances.range_m + tolerances.position_m
    margin = (
        max(reading.range_m for reading in bounds_readings)
        + 2 * resolution
        + range_padding
    )
    left = min(reading.x for reading in bounds_readings) - margin
    bottom = min(reading.y for reading in bounds_readings) - margin
    width_cells = (
        max(reading.x for reading in bounds_readings) + margin - left
    ) / resolution
    height_cells = (
        max(reading.y for reading in bounds_readings) + margin - bottom
    ) / resolution
    if not all(1 <= size <= 1_000_000 for size in (width_cells, height_cells)):
        raise ValueError(
            "invalid map dimensions. Check --resolution and the input coordinates"
        )
    width, height = math.ceil(width_cells), math.ceil(height_cells)
    if width * height > 1_000_000:
        raise ValueError(
            "map exceeds one million cells. Increase --resolution or check the input coordinates"
        )

    evidence = defaultdict(int)
    half_cell = resolution / 2
    hit_half_width = half_cell + range_padding
    beam_slope = math.tan(BEAM_HALF_ANGLE)
    widened_beam = BEAM_HALF_ANGLE + math.radians(tolerances.heading_deg)
    for reading in readings:
        forward_x, forward_y = math.cos(reading.angle), math.sin(reading.angle)
        reach = reading.range_m + hit_half_width
        min_col = math.floor((reading.x - reach - left) / resolution)
        max_col = math.floor((reading.x + reach - left) / resolution)
        min_row = math.floor((reading.y - reach - bottom) / resolution)
        max_row = math.floor((reading.y + reach - bottom) / resolution)
        for row in range(min_row, max_row + 1):
            dy = bottom + (row + 0.5) * resolution - reading.y
            for col in range(min_col, max_col + 1):
                dx = left + (col + 0.5) * resolution - reading.x
                along = dx * forward_x + dy * forward_y
                across = abs(dy * forward_x - dx * forward_y)
                inside_beam = along > 0 and across <= max(half_cell, along * beam_slope)
                if not inside_beam and not (
                    tolerances.heading_deg or tolerances.position_m
                ):
                    continue

                distance = math.hypot(dx, dy)
                if not inside_beam:
                    # A position error also changes the apparent bearing of nearby cells.
                    position_angle = 0.0
                    if tolerances.position_m:
                        position_angle = (
                            math.pi
                            if distance <= tolerances.position_m
                            else math.asin(tolerances.position_m / distance)
                        )
                    if math.atan2(across, along) > widened_beam + position_angle:
                        continue

                if abs(distance - reading.range_m) <= hit_half_width:
                    evidence[col, row] += 2
                elif distance < reading.range_m - hit_half_width:
                    evidence[col, row] -= 1

    image = Image.new("L", (width, height), UNKNOWN)
    for (col, row), score in evidence.items():
        if score:
            image.putpixel((col, height - 1 - row), OCCUPIED if score > 0 else FREE)

    if extent is not None:
        return image, (left, bottom)

    bounds = image.point(lambda pixel: 255 if pixel != UNKNOWN else 0).getbbox()
    if bounds:
        x0, y0, x1, y1 = bounds
        x0, y0 = max(0, x0 - 1), max(0, y0 - 1)
        x1, y1 = min(width, x1 + 1), min(height, y1 + 1)
        image = image.crop((x0, y0, x1, y1))
        left += x0 * resolution
        bottom += (height - y1) * resolution
    return image, (left, bottom)


def encode_snapshot(image: Image.Image, image_format: str) -> str:
    if image_format == "png":
        with io.BytesIO() as buffer:
            image.save(buffer, format="PNG")
            return base64.b64encode(buffer.getvalue()).decode("ascii")

    width, height = image.size
    pixels = image.tobytes()
    paths: dict[int, list[str]] = {FREE: [], OCCUPIED: []}
    for y in range(height):
        x = 0
        for pixel, group in groupby(pixels[y * width : (y + 1) * width]):
            length = sum(1 for _ in group)
            if pixel != UNKNOWN:
                paths[pixel].append(f"M{x} {y}h{length}v1h-{length}z")
            x += length

    free = "".join(paths[FREE])
    occupied = "".join(paths[OCCUPIED])
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        'shape-rendering="crispEdges">'
        f'<rect width="{width}" height="{height}" fill="#a0a0a0"/>'
        f'<path fill="#fff" d="{free}"/><path fill="#000" d="{occupied}"/></svg>'
    )


def replay(
    readings: list[Reading],
    resolution: float,
    output: Path,
    image_format: str,
    tolerances: Tolerances,
) -> None:
    step = 12
    total = len(readings)
    for end in range(step, total + step, step):
        count = min(end, total)
        image, _ = build_map(
            readings[:count], resolution, extent=readings, tolerances=tolerances
        )
        snapshot = {
            "image": {
                "format": image_format,
                "data": encode_snapshot(image, image_format),
            },
            "readingCount": count,
            "totalReadings": total,
            "resolutionM": resolution,
            "updatedAt": time.time_ns() // 1_000_000,
        }
        with tempfile.NamedTemporaryFile(
            dir=output.parent, delete=False, mode="w", encoding="utf-8"
        ) as file:
            temporary = Path(file.name)
            try:
                json.dump(snapshot, file)
                file.close()
                temporary.replace(output)
            finally:
                temporary.unlink(missing_ok=True)
        if count < total:
            time.sleep(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path, help="CSV of sonar readings and poses")
    parser.add_argument(
        "output", type=Path, help="output PNG, or snapshot JSON in live replay mode"
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="replay the CSV and publish updated snapshots",
    )
    parser.add_argument(
        "--format",
        choices=("png", "svg"),
        default="png",
        help="image format for live snapshots",
    )
    parser.add_argument(
        "--resolution",
        type=float,
        default=0.05,
        help="meters per grid cell (default: 0.05)",
    )
    parser.add_argument(
        "--range-tolerance-m",
        type=float,
        default=0.0,
        help="sonar distance error in meters",
    )
    parser.add_argument(
        "--position-tolerance-m",
        type=float,
        default=0.0,
        help="sensor position error in meters",
    )
    parser.add_argument(
        "--heading-tolerance-deg",
        type=float,
        default=0.0,
        help="heading error in degrees",
    )
    args = parser.parse_args()
    if not math.isfinite(args.resolution) or args.resolution < 0.01:
        parser.error("--resolution must be at least 0.01 m")
    for option, value in (
        ("--range-tolerance-m", args.range_tolerance_m),
        ("--position-tolerance-m", args.position_tolerance_m),
        ("--heading-tolerance-deg", args.heading_tolerance_deg),
    ):
        if not math.isfinite(value) or value < 0:
            parser.error(f"{option} must be finite and non-negative")
    if args.heading_tolerance_deg > 180:
        parser.error("--heading-tolerance-deg must be at most 180")
    tolerances = Tolerances(
        args.range_tolerance_m, args.position_tolerance_m, args.heading_tolerance_deg
    )
    suffix = ".json" if args.live else ".png"
    if args.output.suffix.lower() != suffix:
        parser.error(f"output must have a {suffix} extension")

    try:
        readings = load_readings(args.csv)
        if args.live:
            replay(readings, args.resolution, args.output, args.format, tolerances)
            print(f"Replayed {len(readings)} echoes to {args.output}.")
            return
        image, (left, bottom) = build_map(
            readings, args.resolution, tolerances=tolerances
        )
        metadata = PngInfo()
        metadata.add_text("resolution_m", str(args.resolution))
        metadata.add_text("origin_x_m", str(left))
        metadata.add_text("origin_y_m", str(bottom))
        image.save(args.output, pnginfo=metadata)
    except (OSError, ValueError, csv.Error) as error:
        parser.exit(1, f"Error: {error}\n")
    print(
        f"{args.output}: {len(readings)} echoes, {image.width} × {image.height} cells "
        f"at {args.resolution:g} m/cell. Lower-left corner: ({left:.3f}, {bottom:.3f}) m."
    )


if __name__ == "__main__":
    main()
