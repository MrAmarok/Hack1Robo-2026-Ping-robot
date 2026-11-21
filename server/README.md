# Serveur Ping (Python)

Remplace l'ancien `server.js` (Express + Socket.IO). Le protocole est **le même** :
mêmes événements Socket.IO, mêmes routes HTTP, mêmes fichiers sur disque. L'app
et le robot (`socket.io-client` v4) s'y connectent sans aucun changement.

Stack : FastAPI + python-socketio (ASGI) + uvicorn. La structure reprend celle
du backend robot-group-9 (`app/core`, `app/api`, `app/services`, `app/websocket`).

## Lancer

Avec [uv](https://docs.astral.sh/uv/). Les dépendances sont dans
`pyproject.toml`, figées dans `uv.lock`, et `.python-version` fixe Python 3.12 :

```bash
cd server
cp .env.example .env        # puis remplir les clés utiles
uv sync                     # crée .venv et installe tout (une fois, ou après un pull)
uv run ping-server          # lit PORT (repli sur 3002 si occupé)
```

Depuis la racine du dépôt : `uv run --project server ping-server`.

Autres façons de lancer :

```bash
PORT=3000 uv run ping-server
uv run uvicorn app.main:app --host 0.0.0.0 --port 3000 --reload   # rechargement auto en dev
```

Ajouter une dépendance : `uv add <paquet>` (ou `uv add --dev <paquet>` pour les tests).

Healthcheck : `GET /` → `OK`, `GET /health` → `{"status":"ok"}`.

## Install as a systemd service

On the VPS, run the installer from the new checkout as the account that should
run the server. Install `uv` for that account first. If migrating from the old
Node server, copy its settings into `server/.env` and stop its PM2 application
before starting the service. Keep any existing data paths the new server needs.

```bash
cd server
./install-service.sh
curl -fsS http://127.0.0.1:3000/health
sudo journalctl -u ping-server -f
```

The installer syncs the locked dependencies, writes `ping-server.service`,
starts it, and enables it at boot. It uses port 3000. Run
`PORT=3002 ./install-service.sh` to use a different port. This install setting
takes precedence over `PORT` in `.env`.

Run the installer again after updating the checkout to sync dependencies and
restart the service. Reuse the same `PORT` value if you chose a custom port.

## Organisation

| Fichier | Rôle | Ancien emplacement |
|---|---|---|
| `app/main.py` | Point d'entrée, branche Socket.IO + HTTP, modules optionnels | `server.js` (début/fin) |
| `app/core/sio.py` | Serveur Socket.IO, aiguillage multi-gestionnaires, aides d'émission | — |
| `app/core/state.py` | Salons, rôles pilote/spectateur, présence, journal de rattrapage | `server.js` |
| `app/websocket/salon.py` | `pair`, accès, buzz/nudge, « Se rejoindre », position, salon 24 h | `server.js` |
| `app/websocket/robot.py` | Pilotage, caméra, WebRTC (WHEP/WHIP), nav, rondes, modes, arrêt d'urgence | `server.js` |
| `app/api/routes.py` | Routes HTTP, proxy `/rtc`, audio webradio | `server.js` |
| `app/services/push.py` | Notifications Expo (jetons persistants, reçus) | `server.js` + `expo-server-sdk` |
| `app/services/alertes.py` | Alertes de surveillance, Telegram, historique, cadence | `server.js` |
| `app/services/voice_brain.py` | Assistant vocal « Hey Solana » (Claude + outils) | `voice-brain.js` |
| `app/services/realtime_voix.py` | Conversation en direct (OpenAI Realtime) | `realtime-voix.js` |
| `app/services/appel_direct.py` | Appel Twilio branché sur l'assistant | `appel-direct.js` |
| `app/services/appel_alerte.py` | Appel d'alerte Twilio | `appel-alerte.js` |
| `app/services/enregistrement.py` | Enregistrement mp4 du flux caméra (ffmpeg) | `enregistrement.js` |

Ajouter un gestionnaire Socket.IO :

```python
from app.core.sio import on, emit_room, payload

@on("mon_evenement")
async def _mon_evenement(sid, data):
    p = payload(data)
    await emit_room(p["code"], "mon_evenement", p, skip_sid=sid)  # = socket.to(code).emit
    return {"ok": True}  # valeur de retour = accusé de réception (ack)
```

## Différences avec la version Node

- Le `.env` est chargé **en entier** au démarrage (la version Node ne recopiait
  qu'une liste fixe de noms et ignorait les autres en silence).
- Les chemins `/root/server/alertes`, `/root/server/alertes.json` et
  `/root/enregistrements` restent les valeurs par défaut, mais sont
  surchargeables (`ALERTES_DIR`, `ALERTES_FICHIER`, `REC_DIR`) pour tourner
  ailleurs que sur le VPS.
- La liste `/enregistrements` lit le même dossier que l'enregistreur (`REC_DIR`
  ou `REC_DOSSIER`). En Node, les deux réglages étaient distincts.
- Un événement reçu sans corps (`emit('x')`) ne fait plus planter le
  gestionnaire : il voit un dict vide.
- Quand le client attend un accusé et que la commande est refusée (spectateur),
  il reçoit un accusé vide tout de suite, au lieu d'attendre son propre délai.
- Audio webradio (`/robot-audio`) : un auditeur trop lent perd des morceaux au
  lieu d'accumuler du retard.

## Pilotage

L'événement Socket.IO **`drive`** est le canal de pilotage prévu. Le salon est celui de la session (le `code` du
message est ignoré) et seul son pilote conduit.

- Changement d'ordre (appui, relâchement, vitesse) : `drive {cmd, ack: true}` avec accusé. Le serveur
  interroge le robot (`sio.call`, 1,5 s au plus) et renvoie sa réponse `{ok, cmd, arduino}` ou `{ok: false, erreur}`.
- Maintien du bouton : `drive {cmd}` toutes les 250 ms, en `volatile`, sans accusé. Le serveur relaie sans attendre.

Les anciens canaux restent acceptés le temps que l'app et le robot passent à `drive`, avec les mêmes règles :
`robot_drive` et toutes les commandes 🔒 refusent un `code` d'un autre salon que celui de la session, et
`robot_drive` ne va plus qu'au robot. Les buzz `PING_ROBOT_DRIVE:` et `PING_ROBOT_CAM:` sont réservés au pilote.
`POST /robot-drive` ne relaie plus rien sans `Authorization: Bearer <ROBOT_HTTP_TOKEN>` (la réponse reste 200 pour
ne pas afficher d'erreur dans les anciennes versions de l'app).

`ROBOT_KEY` : tant qu'elle est vide, tout socket qui envoie `pair {robot: true}` est cru, comme avant. Une fois
remplie, le robot doit envoyer `pair {robot: true, cle: <ROBOT_KEY>}`, et `robot_status` ne suffit plus à se faire
passer pour un robot. La remplir **après** avoir mis à jour le robot.

## Capteur : données pour la carte (robot → serveur)

Tuto pas à pas côté robot : [robot/CAPTEUR.md](../robot/CAPTEUR.md).

Le robot envoie les lignes du capteur, déjà au format de `sonar-mapping/map_sonar.py`, par un **WebSocket dédié** ;
le serveur les range dans un CSV par session : `capteur/<code>/<session>.csv` (`CAPTEUR_DIR`).

```
code de Pauline ─▶ robot.js : capteur.envoyer("0,0,0,0,143")   (ou ligne de 5 champs écrite par l'Arduino)
                     │  ws://<serveur>:3000/ws/capteur?code=<code>&session=<session>[&cle=<ROBOT_KEY>]
                     ▼  "0,0,0,0,143\n0,0,0,10,151"   ──▶  serveur : ajoute à capteur/<code>/<session>.csv
                        ◀── {"type":"ack","recues":2,"rejetees":0,"total":120}
map_sonar.py ◀── GET /capteur/<session>?code=<code>
```

**Format d'une ligne** : `x_m,y_m,heading_deg,sensor_angle_deg,distance_cm` (mètres, degrés anti-horaires depuis +X,
angle du capteur par rapport au robot, distance en cm ; **distance vide = pas d'écho**, ex. `0,0,0,0,`).

**Protocole** :

1. Le robot ouvre `ws://<serveur>:3000/ws/capteur?code=<code>&session=<session>` (`cle=<ROBOT_KEY>` si elle est
   configurée). Le serveur répond `{"type":"bonjour","session":…,"lignes":<déjà reçues>}`.
2. Le robot envoie des messages texte d'une ou plusieurs lignes (séparées par `\n` ; l'en-tête est ignoré).
3. Pour chaque message, le serveur répond `{"type":"ack","recues","rejetees","total"}`, avec `erreurs` (les
   5 premières lignes refusées et pourquoi) s'il y en a. Une ligne invalide est refusée seule, les autres sont gardées.
4. En cas de problème : `{"type":"erreur","erreur"}` puis fermeture (code manquant, clé robot invalide, session
   invalide, session de plus de `CAPTEUR_MAX_MO` Mo).

**Côté robot** (`robot/capteur.js`, branché dans `robot.js`) : `capteur.envoyer('0,0,0,0,143')` ou
`capteur.envoyer([0, 0, 0, 0, 143])` (`null` en 5ᵉ position = pas d'écho), `capteur.nouvelleSession()`. Les lignes
partent par lots toutes les 200 ms ; une ligne n'est oubliée qu'après l'accusé du serveur, donc une coupure réseau
ou un redémarrage du serveur ne fait rien perdre (reconnexion automatique, même session). Console du Pi :
`capteur`, `capteur 0,0,0,0,143`, `capteur session`. Un autre programme peut aussi se connecter directement au
WebSocket avec le même protocole.

**Récupérer les données** : `GET /capteur?code=<code>` liste les sessions, `GET /capteur/<session>?code=<code>`
renvoie le CSV, à passer tel quel à la carte :

```sh
curl -o session.csv "http://<serveur>:3000/capteur/<session>?code=<code>"
uv run --locked --script server/sonar-mapping/map_sonar.py session.csv carte.png
```

### Indoor scans in the mobile app

Open **Indoor map** from the fullscreen camera. The pilot can tap **Start scan**, drive the
robot to collect readings, and tap **Save scan** to build the map. The pilot and admitted
spectators can reopen maps through **Saved scans**.

A scan includes valid CSV rows received after Start and before Save. Each row already
contains the sensor pose at measurement time, so the server does not add a timestamp
column. The server keeps the CSV and the generated map in
`CAPTEUR_DIR/<code>/sonar-scans/`. A zero or blank distance is stored in the CSV, and only
echoes from 2 to 400 cm contribute to the map. Mapping a room while the robot moves
requires the actual position and heading for each echo.

### Tester sans robot : le simulateur

`sonar-mapping/simuler_robot.py` joue le rôle du robot. Il se connecte au serveur comme `robot.js` et envoie des
mesures sonar :

- **WebSocket `/ws/capteur`** : les lignes partent par lots toutes les 200 ms. Le simulateur garde chaque ligne
  jusqu'à l'accusé du serveur ; après une coupure, il se reconnecte et renvoie les lignes non accusées, dans la même
  session.
- **Socket.IO** : `pair {robot: true}` dans le salon `--code`. L'app voit le robot en ligne et peut le conduire
  (`drive` et `robot_drive` : `F B L R S`, `V<n>`, `+`, `-`, `M<g>,<d>`).

Le robot roule dans une pièce virtuelle de 5 m × 4 m meublée d'un canapé, d'une table et d'un carton. Chaque
distance est calculée jusqu'au premier obstacle, avec le comportement d'un HC-SR04 : quelques cm d'erreur, pas
d'écho au-delà de 4 m, échos souvent perdus sur un mur pris trop en biais.

```sh
cd server
uv run python sonar-mapping/simuler_robot.py --code 1234             # tour de la piece (~1 min 30), puis s'arrete
uv run python sonar-mapping/simuler_robot.py --code 1234 --accel 5   # meme tour, 5 fois plus vite
uv run python sonar-mapping/simuler_robot.py --code 1234 --pilote    # attend les ordres de l'app (Ctrl+C pour finir)
uv run python sonar-mapping/simuler_robot.py --code 1234 --csv sonar-mapping/samples/simulated-room.csv
```

Depuis la racine du dépôt : `uv run --project server python server/sonar-mapping/simuler_robot.py …`.

| Option | Défaut | Rôle |
| --- | --- | --- |
| `--url` | `$SERVER_URL` ou `http://localhost:8000` | adresse du serveur ; `http://localhost:3000` avec `uv run ping-server` |
| `--code` | `$CODE` ou `1234` | code du salon |
| `--session` | `sim-AAAAMMJJ-hhmmss` | fichier `capteur/<code>/<session>.csv` côté serveur |
| `--cle` | `$ROBOT_KEY` | à passer si `ROBOT_KEY` est configurée sur le serveur |
| `--pilote` | non | le robot attend les ordres de l'app au lieu de faire le tour |
| `--boucle` | non | recommence le tour (ou le CSV) sans fin |
| `--accel` | `1` | accélère le temps simulé du tour |
| `--csv` | — | rejoue ce fichier CSV ligne par ligne au lieu de simuler |
| `--frequence` | `10` | lignes par seconde avec `--csv` |
| `--sans-bruit` | non | mesures parfaites, sans bruit ni écho perdu |
| `--sans-socketio` | non | n'ouvre que le WebSocket capteur ; le robot n'apparaît pas dans l'app |
| `--graine` | aléatoire | mêmes mesures d'une exécution à l'autre |

En mode tour, le robot passe en pilotage manuel dès que le pilote touche au joystick. Sans ordre depuis 1 s, il
s'arrête, comme si le bouton avait été relâché.

Socket.IO passe par le client du groupe dev (`uv sync` l'installe). S'il manque, le simulateur n'ouvre que le
WebSocket capteur.

**Voir la carte**

- **Dans l'app.** Lancer Expo sur le serveur local (`EXPO_PUBLIC_PING_SERVER_ORIGIN=http://localhost:8000 npm start`,
  puis `w`), s'appairer avec le même code, ouvrir la caméra en plein écran (⛶), puis **Indoor map** →
  **Start scan**. Lancer le simulateur, puis **Save scan** quand il a fini. Seules les lignes reçues après
  **Start scan** entrent dans le scan. Sur un téléphone, le serveur doit écouter sur le réseau (`--host 0.0.0.0`) et
  la variable doit contenir l'IP du PC.
- **En image.** À la fin, le simulateur affiche les deux commandes à lancer depuis `server/` :

  ```sh
  curl -o session.csv "http://localhost:8000/capteur/<session>?code=1234"
  uv run --locked --script sonar-mapping/map_sonar.py session.csv carte.png
  ```

  L'image compte un pixel par case de 5 cm : il faut zoomer pour la lire.

Le simulateur sort en code 1 si le serveur refuse la connexion (code manquant, clé invalide…) ou si aucune ligne
n'a été acceptée.

## Documentation (Swagger)

Serveur lancé, ouvrir **`/docs`** (Swagger) ou `/redoc` ; la spécification brute est sur `/openapi.json`.

- **HTTP** : chaque route avec ses paramètres, son corps, ses réponses et des exemples.
- **⚡ Socket** : chaque événement Socket.IO, rangé par thème. `POST /socket/<événement>` décrit ce que tu
  émets (`socket.emit`) et l'accusé de réception, `GET /socket/<événement>` ce que tu reçois (`socket.on`).
  Ce ne sont pas des routes HTTP : les appeler renvoie une erreur 400 qui le rappelle.

Le catalogue des événements est dans `app/api/doc_socket.py`, la doc des routes HTTP dans `app/api/doc_http.py`.
`tests/test_doc.py` échoue si un événement écouté ou émis par le serveur n'y est pas documenté (ou l'inverse).

## Tests

```bash
uv run pytest -q
```

`tests/test_integration.py` démarre le vrai serveur et y connecte des clients
Socket.IO (pilote, robot, spectateur) : élection, admission, relais des
commandes, images binaires avec accusé, WebRTC sans MediaMTX, arrêt d'urgence,
rattrapage, routes HTTP, alertes.
