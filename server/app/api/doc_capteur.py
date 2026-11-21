from typing import Literal, Optional

from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api.doc_http import CODE as CODE_PARAM
from app.api.doc_http import Erreur
from app.api.doc_socket import CODE, OPT, _schema, modele

TAG_WS = (
    "🔌 WebSocket · Capteur (robot → serveur)",
    "Le robot envoie les lignes du capteur `x_m,y_m,heading_deg,sensor_angle_deg,distance_cm` ; le serveur les "
    "range dans un CSV par session.",
)
T_HTTP = "HTTP · Capteur"
TAG_HTTP = (T_HTTP, "Télécharger les données reçues du capteur, au format CSV de `map_sonar.py`.")

Bonjour = modele(
    "CapteurBonjour", {"type": "bonjour", "code": "1234", "session": "s-20261121-150000", "lignes": 0},
    type=(Literal["bonjour"], "Premier message, à la connexion."), code=CODE,
    session=(str, "Session dans laquelle les lignes seront rangées."),
    lignes=(int, "Lignes déjà enregistrées dans cette session (reprise après coupure)."),
)
Accuse = modele(
    "CapteurAccuse", {"type": "ack", "recues": 2, "rejetees": 1, "total": 120,
                      "erreurs": [{"ligne": "0,0,0", "raison": "5 champs attendus (...), 3 recus"}]},
    type=(Literal["ack"], "Réponse à chaque message du robot, dans l'ordre."),
    recues=(int, "Lignes valides enregistrées."), rejetees=(int, "Lignes invalides, ignorées."),
    total=(int, "Lignes de la session après ce message."),
    erreurs=(Optional[list[dict]], "Les 5 premières lignes refusées et pourquoi.", OPT),
)
ErreurWs = modele(
    "CapteurErreur", {"type": "erreur", "erreur": "cle robot invalide"},
    type=(Literal["erreur"], "Suivi de la fermeture de la connexion."),
    erreur=(str, "code manquant, cle robot invalide, session invalide ou session trop volumineuse."),
)

DESCRIPTION_WS = """
`ws://<serveur>:3000/ws/capteur?code=1234&session=s-20261121-150000` — derrière nginx :
`wss://api.ping-app.org/ping/ws/capteur?...`. Connexion **WebSocket** ordinaire (pas Socket.IO).
« Try it out » ne peut pas l'ouvrir : un appel HTTP renvoie 426.

**Le robot envoie** des messages texte contenant **une ou plusieurs lignes** (séparées par `\\n`), au format de
`map_sonar.py` :

```
x_m,y_m,heading_deg,sensor_angle_deg,distance_cm
0,0,0,0,
0,0,0,0,143
0.5,0,90,-30,87.5
```

| Champ | Unité |
|---|---|
| `x_m`, `y_m` | position du capteur, en mètres |
| `heading_deg` | cap du robot, degrés, sens anti-horaire depuis l'axe +X |
| `sensor_angle_deg` | angle du capteur par rapport au robot, degrés (0 = vers l'avant) |
| `distance_cm` | distance mesurée en cm ; **vide = pas d'écho** |

La ligne d'en-tête est acceptée et ignorée. Les lignes invalides sont refusées une par une (les autres sont
gardées) et signalées dans l'accusé.

**Le serveur répond** `bonjour` à la connexion, puis un `ack` par message reçu, dans l'ordre.

**Session** : toutes les lignes d'une session vont dans le même fichier `capteur/<code>/<session>.csv`. Le robot
choisit son identifiant (`[A-Za-z0-9_-]`, 64 caractères max) et le garde d'une reconnexion à l'autre pour continuer
le même fichier. Sans `session`, le serveur en crée une et l'annonce dans `bonjour`.

**Robot** : si `ROBOT_KEY` est configurée sur le serveur, `cle=<ROBOT_KEY>` est obligatoire.

```python
import asyncio, json
from websockets.asyncio.client import connect

async def main():
    async with connect("ws://<serveur>:3000/ws/capteur?code=1234&session=essai-1") as ws:
        print(json.loads(await ws.recv()))
        await ws.send("0,0,0,0,143\\n0,0,0,10,151")
        print(json.loads(await ws.recv()))

asyncio.run(main())
```
"""


def operation_ws(composants: dict) -> dict:
    return {"/ws/capteur": {"get": {
        "tags": [TAG_WS[0]],
        "summary": "Envoyer les lignes du capteur (WebSocket, robot → serveur)",
        "description": DESCRIPTION_WS,
        "operationId": "ws_capteur",
        "parameters": [
            {"name": "code", "in": "query", "required": True, "description": "Code du salon du robot.",
             "schema": {"type": "string"}, "example": "1234"},
            {"name": "session", "in": "query", "required": False,
             "description": "Session (fichier) où ranger les lignes. Sans elle, le serveur en crée une.",
             "schema": {"type": "string"}, "example": "s-20261121-150000"},
            {"name": "cle", "in": "query", "required": False,
             "description": "Valeur de `ROBOT_KEY`, obligatoire si elle est configurée sur le serveur.",
             "schema": {"type": "string"}},
        ],
        "responses": {
            "101": {"description": "Connexion ouverte. Messages du serveur (champ `type`).",
                    "content": {"application/json": {"schema": {
                        "oneOf": [_schema(m, composants) for m in (Bonjour, Accuse, ErreurWs)],
                        "discriminator": {"propertyName": "type"}}}}},
            "426": {"description": "Appel en HTTP au lieu d'une connexion WebSocket."},
        },
    }}}


class Session(BaseModel):
    session: str = Field(description="Identifiant de la session.")
    lignes: int = Field(description="Lignes enregistrées.")
    taille_ko: float = Field(description="Taille du fichier.")
    modifie: int = Field(description="Dernière écriture (ms).")


class Sessions(BaseModel):
    sessions: list[Session] = Field(description="De la plus récemment modifiée à la plus ancienne.")


DOC = {
    "liste": dict(
        tags=[T_HTTP], summary="Lister les sessions du capteur",
        openapi_extra={"parameters": [CODE_PARAM]},
        responses={200: {"model": Sessions, "description": "Sessions."},
                   400: {"model": Erreur, "description": "`code` manquant."}},
    ),
    "telecharger": dict(
        tags=[T_HTTP], summary="Télécharger une session (CSV pour map_sonar.py)",
        description="Le fichier tel qu'enregistré : en-tête `x_m,y_m,heading_deg,sensor_angle_deg,distance_cm`, "
                    "puis une ligne par mesure reçue du robot.\n\n"
                    "```sh\ncurl -o session.csv \"http://<serveur>:3000/capteur/<session>?code=1234\"\n"
                    "uv run --locked --script server/sonar-mapping/map_sonar.py session.csv carte.png\n```",
        response_class=FileResponse,
        openapi_extra={"parameters": [CODE_PARAM]},
        responses={200: {"description": "CSV.", "content": {"text/csv": {
                       "schema": {"type": "string"},
                       "example": "x_m,y_m,heading_deg,sensor_angle_deg,distance_cm\n0,0,0,0,143\n0,0,0,0,\n"}}},
                   400: {"model": Erreur, "description": "`code` ou session invalide."},
                   404: {"model": Erreur, "description": "Session introuvable."}},
    ),
}

PROTOCOLE = """
## Capteur : protocole robot → serveur

```
 code de Pauline ──▶ robot.js : capteur.envoyer("x,y,cap,angle,cm")      (ou ligne de 5 champs sur le port série)
                        │  WebSocket ws://<serveur>:3000/ws/capteur?code=…&session=…
                        ▼  "0,0,0,0,143\\n0,0,0,10,151"        ──▶ serveur : ajoute à capteur/<code>/<session>.csv
                           ◀── {"type":"ack","recues":2,"rejetees":0,"total":120}
 map_sonar.py ◀── GET /capteur/<session>?code=… (CSV)
```

Détails : sections « 🔌 WebSocket · Capteur » et « HTTP · Capteur ».
"""
