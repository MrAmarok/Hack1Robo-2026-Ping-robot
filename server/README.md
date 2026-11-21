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

## Tests

```bash
uv run pytest -q
```

`tests/test_integration.py` démarre le vrai serveur et y connecte des clients
Socket.IO (pilote, robot, spectateur) : élection, admission, relais des
commandes, images binaires avec accusé, WebRTC sans MediaMTX, arrêt d'urgence,
rattrapage, routes HTTP, alertes.
