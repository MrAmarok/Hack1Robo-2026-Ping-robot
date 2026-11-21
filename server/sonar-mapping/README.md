# HC-SR04 occupancy mapping

The mapper uses Astral's [standalone script workflow](https://docs.astral.sh/uv/guides/scripts/). The inline metadata in `map_sonar.py` declares Pillow, and `map_sonar.py.lock` pins the resolved dependency. Run from the repository root with `uv`.

```sh
uv run --locked --script server/sonar-mapping/map_sonar.py server/sonar-mapping/samples/bench-wall.csv /tmp/bench-wall.png --resolution 0.01
uv run --locked --script server/sonar-mapping/map_sonar.py server/sonar-mapping/samples/simulated-room.csv /tmp/simulated-room.png
```

The PNG uses one pixel per cell. Black is likely occupied, white is likely free, and gray is unknown. The PNG stores the cell size and world coordinates of the lower-left corner as metadata. The command also prints them. Image rows increase downward, while world Y increases upward.

## Sample data

- [bench-wall.csv](samples/bench-wall.csv) uses the eight mean HC-SR04 distances published by the [Barkhausen Institut](https://www.barkhauseninstitut.org/research/lab-1/our-blog/distance-sensor-research). The source reports perpendicular measurements against a flat target. The CSV reconstructs the sensor positions from the reference distances by putting that target at X = 0 and the sensor on the negative X axis. This is a range replay along one line.
- [simulated-room.csv](samples/simulated-room.csv) contains idealized sweeps from five positions in a 4 m × 3 m rectangle. Its distances come from intersecting each beam centerline with the nearest wall. It exercises mapping from several positions. Real sonar can miss oblique walls or detect other reflectors.

## Record your own readings

Use the same CSV header. Enter the sensor's world position in meters, the robot heading counterclockwise from +X, and the beam angle relative to the robot heading. If the sensor is fixed facing forward, set `sensor_angle_deg` to 0 and record the heading after each turn. Use the centimeters from the Arduino's `D:<cm>` message directly. Leave the distance blank for a missing echo. Values outside 2–400 cm are skipped.

For each echo, the mapper uses a 15° cone approximation. Cells before the echo receive free-space evidence. Cells near the echo distance receive occupied evidence. Overlapping readings combine their evidence. This is offline mapping with supplied poses. For a first robot run, mark positions and headings on the floor and take readings while stationary.
