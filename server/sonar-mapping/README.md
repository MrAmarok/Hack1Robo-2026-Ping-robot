# HC-SR04 occupancy mapping

The mapper uses Astral's [standalone script workflow](https://docs.astral.sh/uv/guides/scripts/). The inline metadata in `map_sonar.py` declares Pillow, and `map_sonar.py.lock` pins the resolved dependency. Run from the repository root with `uv`.

```sh
uv run --locked --script server/sonar-mapping/map_sonar.py server/sonar-mapping/samples/bench-wall.csv /tmp/bench-wall.png --resolution 0.01
uv run --locked --script server/sonar-mapping/map_sonar.py server/sonar-mapping/samples/simulated-room.csv /tmp/simulated-room.png
```

The PNG uses one pixel per cell. Black is likely occupied, white is likely free, and gray is unknown. The PNG stores the cell size and world coordinates of the lower-left corner as metadata. The command also prints them. Image rows increase downward, while world Y increases upward.

## Watch a replay in Ping

Run each command in a separate terminal from the repository root. Use the same snapshot path in the server and replay commands. Choose a fresh path for each demo.

On NixOS, prefix the `uv` commands with `UV_PYTHON="$(command -v python3)"` to use the system Python.

1. Start the server with a pairing room and a snapshot file.

   ```sh
   SONAR_MAP_ROOM=sonar-demo SONAR_SNAPSHOT_FILE=/tmp/ping-sonar-demo.json \
     PORT=3002 uv run --project server ping-server
   ```

2. Start Expo and press `w` to open the browser.

   ```sh
   cd mobile
   EXPO_PUBLIC_PING_SERVER_ORIGIN=http://localhost:3002 npm start
   ```

   For a phone on the same network, substitute the server computer's LAN address for `localhost`. The phone build must allow an HTTP connection to the development server. With the deployed Ping server, leave the Expo override unset and configure the snapshot file and room on that server.

3. Enter a nickname and the shared code `sonar-demo`, then click **S’APPARIER**. Once connected to the robot, expand **Camera** with **⛶** and tap **Indoor map** in the guidance toolbar.

   To try the replay without hardware, run this in another terminal from the repository root and leave it running while you pair.

   ```sh
   cd mobile
   node -e 'const s = require("socket.io-client").io("http://localhost:3002"); s.on("connect", () => s.emit("pair", { code: "sonar-demo", pseudo: "Demo Robot", robot: true }));'
   ```

4. Start the replay.

   ```sh
   uv run --locked --script server/sonar-mapping/map_sonar.py \
     server/sonar-mapping/samples/simulated-room.csv /tmp/ping-sonar-demo.json --live
   ```

The replay adds 12 readings per frame with a one-second pause between frames. The map keeps the same extent throughout and stays visible when the replay ends. Use a CSV recorded at known poses to replay actual measurements.

Add `--format svg` to replay with SVG snapshots. An external mapper can also publish either format by atomically replacing the configured JSON file. Include `image` with `format` set to `svg` or `png` and `data` set to raw SVG markup or base64 PNG bytes. Include `readingCount`, `totalReadings`, `resolutionM`, and `updatedAt` in Unix milliseconds. Use SVGs with a `viewBox` and inline shapes.

## Simulated robot

[simuler_robot.py](simuler_robot.py) acts as the robot without hardware. It joins the pairing room over Socket.IO and streams sonar readings to `/ws/capteur` while it drives through a furnished 5 m × 4 m virtual room. The pilot can also drive it from the app. Usage and options are in the [server README](../README.md#tester-sans-robot--le-simulateur).

```sh
uv run --project server python server/sonar-mapping/simuler_robot.py --url http://localhost:3000 --code sonar-demo --accel 5
```

Add `--scan` to have the simulator start and save a scan itself, the way **Start scan** and **Save scan** do in the app. It pairs a second socket as the pilot, so the app must not already be the pilot of that room. The server builds the map with `sonar_mapper`, and the simulator writes the PNG to `.simulation.ignore/carte-<scan>.png`.

[simuler_drift.py](simuler_drift.py) runs offline. It drives the same tour with a fixed forward sensor and adds drift to the reported pose (odometry heading bias, scale error, wheel slip, direct x/y drift) or to the distances (bias or scale growing over time, random walk). It maps each example with `sonar_mapper.build_map` and scores the map against the true room. Results, including `donnees.csv` to replay against the server with `simuler_robot.py --csv … --scan`, go to `.simulation.ignore/drift/`. Git ignores `.simulation.ignore/`.

```sh
uv run --project server python server/sonar-mapping/simuler_drift.py
```

## Sample data

- [bench-wall.csv](samples/bench-wall.csv) uses the eight mean HC-SR04 distances published by the [Barkhausen Institut](https://www.barkhauseninstitut.org/research/lab-1/our-blog/distance-sensor-research). The source reports perpendicular measurements against a flat target. The CSV reconstructs the sensor positions from the reference distances by putting that target at X = 0 and the sensor on the negative X axis. This is a range replay along one line.
- [simulated-room.csv](samples/simulated-room.csv) contains idealized sweeps from five positions in a 4 m × 3 m rectangle. Its distances come from intersecting each beam centerline with the nearest wall. It exercises mapping from several positions. Real sonar can miss oblique walls or detect other reflectors.

## Record your own readings

Use the same CSV header. Enter the sensor's world position in meters, the robot heading counterclockwise from +X, and the beam angle relative to the robot heading. If the sensor is fixed facing forward, set `sensor_angle_deg` to 0 and record the heading after each turn. Use the centimeters from the Arduino's `D:<cm>` message directly. Leave the distance blank for a missing echo. Values outside 2–400 cm are skipped.

For each echo, the mapper uses a 15° cone approximation. Cells before the echo receive free-space evidence. Cells near the echo distance receive occupied evidence. Overlapping readings combine their evidence. This is offline mapping with supplied poses. For a first robot run, mark positions and headings on the floor and take readings while stationary.
