# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11,<13"]
# ///

"""Build an occupancy grid from HC-SR04 readings with known poses."""

import argparse
import csv
import math
from collections import defaultdict
from dataclasses import dataclass
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
            if 2 <= distance <= 400:
                angle = math.radians((heading % 360 + sensor_angle % 360) % 360)
                readings.append(Reading(x, y, angle, distance / 100))
    if not readings:
        raise ValueError("no valid HC-SR04 echoes (2–400 cm)")
    return readings


def build_map(readings: list[Reading], resolution: float) -> tuple[Image.Image, tuple[float, float]]:
    margin = max(reading.range_m for reading in readings) + 2 * resolution
    left = min(reading.x for reading in readings) - margin
    bottom = min(reading.y for reading in readings) - margin
    width_cells = (max(reading.x for reading in readings) + margin - left) / resolution
    height_cells = (max(reading.y for reading in readings) + margin - bottom) / resolution
    if not all(1 <= size <= 1_000_000 for size in (width_cells, height_cells)):
        raise ValueError("invalid map dimensions. Check --resolution and the input coordinates")
    width, height = math.ceil(width_cells), math.ceil(height_cells)
    if width * height > 1_000_000:
        raise ValueError("map exceeds one million cells. Increase --resolution or check the input coordinates")

    evidence = defaultdict(int)
    half_cell = resolution / 2
    beam_slope = math.tan(BEAM_HALF_ANGLE)
    for reading in readings:
        forward_x, forward_y = math.cos(reading.angle), math.sin(reading.angle)
        reach = reading.range_m + half_cell
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
                if along <= 0 or across > max(half_cell, along * beam_slope):
                    continue

                distance = math.hypot(dx, dy)
                if abs(distance - reading.range_m) <= half_cell:
                    evidence[col, row] += 2
                elif distance < reading.range_m - half_cell:
                    evidence[col, row] -= 1

    image = Image.new("L", (width, height), UNKNOWN)
    for (col, row), score in evidence.items():
        if score:
            image.putpixel((col, height - 1 - row), OCCUPIED if score > 0 else FREE)

    bounds = image.point(lambda pixel: 255 if pixel != UNKNOWN else 0).getbbox()
    if bounds:
        x0, y0, x1, y1 = bounds
        x0, y0 = max(0, x0 - 1), max(0, y0 - 1)
        x1, y1 = min(width, x1 + 1), min(height, y1 + 1)
        image = image.crop((x0, y0, x1, y1))
        left += x0 * resolution
        bottom += (height - y1) * resolution
    return image, (left, bottom)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path, help="CSV of sonar readings and poses")
    parser.add_argument("png", type=Path, help="output occupancy map")
    parser.add_argument("--resolution", type=float, default=0.05, help="meters per grid cell (default: 0.05)")
    args = parser.parse_args()
    if not math.isfinite(args.resolution) or args.resolution < 0.01:
        parser.error("--resolution must be at least 0.01 m")
    if args.png.suffix.lower() != ".png":
        parser.error("output must have a .png extension")

    try:
        readings = load_readings(args.csv)
        image, (left, bottom) = build_map(readings, args.resolution)
        metadata = PngInfo()
        metadata.add_text("resolution_m", str(args.resolution))
        metadata.add_text("origin_x_m", str(left))
        metadata.add_text("origin_y_m", str(bottom))
        image.save(args.png, pnginfo=metadata)
    except (OSError, ValueError, csv.Error) as error:
        parser.exit(1, f"Error: {error}\n")
    print(f"{args.png}: {len(readings)} echoes, {image.width} × {image.height} cells "
          f"at {args.resolution:g} m/cell. Lower-left corner: ({left:.3f}, {bottom:.3f}) m.")


if __name__ == "__main__":
    main()
