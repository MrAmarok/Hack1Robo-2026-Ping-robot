from typing import Optional

from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

T_ALERTES = "HTTP · Alertes"
T_REC = "HTTP · Enregistrements"
T_ROBOT = "HTTP · Robot"
T_NOTIF = "HTTP · Notifications et salon"
T_RTC = "HTTP · WebRTC (proxy MediaMTX)"
T_SANTE = "HTTP · Santé"

TAGS_HTTP = [
    (T_ALERTES, "Historique des alertes du mode absent et leurs photos."),
    (T_REC, "Vidéos enregistrées sur le VPS (événement Socket.IO `robot_record`)."),
    (T_ROBOT, "Pilotage par HTTP et flux audio du robot."),
    (T_NOTIF, "Jetons de notification Expo et présence dans le salon 24 h (quand l'app est fermée)."),
    (T_RTC, "Accès HTTP direct à MediaMTX. L'app actuelle passe plutôt par l'événement Socket.IO `rtc_offer`."),
    (T_SANTE, "Vérifier que le serveur tourne."),
]


class Erreur(BaseModel):
    erreur: str = Field(description="Message d'erreur.")


class ErreurEn(BaseModel):
    error: str = Field(description="Message d'erreur.")


class Alerte(BaseModel):
    ts: int = Field(description="Horodatage (ms).")
    type: str = Field(description="bruit, mouvement ou presence.")
    capteurs: list[str] = Field(description="Capteurs déclenchés.")
    categorie: str = Field(description="Ce que montre la photo selon Claude : personne, animal ou rien.")
    phrase: Optional[str] = Field(description="Description de la photo.")
    notifiee: bool = Field(description="Une notification est partie (sinon retenue par le délai minimum).")
    photo: Optional[str] = Field(description="URL de la photo.")


class AlertesReponse(BaseModel):
    alertes: list[Alerte] = Field(description="De la plus récente à la plus ancienne.")


class Video(BaseModel):
    nom: str = Field(description="Nom du fichier.")
    mo: float = Field(description="Taille en Mo.")
    url: str = Field(description="URL de téléchargement.")


class VideosReponse(BaseModel):
    videos: list[Video] = Field(description="De la plus récente à la plus ancienne.")


class RegisterTokenCorps(BaseModel):
    token: str = Field(description="Jeton Expo du téléphone.")
    code: Optional[str] = Field(None, description="Code du salon (avec pseudo : jeton gardé sur disque).")
    pseudo: Optional[str] = Field(None, description="Pseudo du propriétaire.")
    socketId: Optional[str] = Field(None, description="Ancien format : identifiant du socket.")


class MessageReponse(BaseModel):
    message: str


class CodePseudo(BaseModel):
    code: str = Field(description="Code du salon.")
    pseudo: str = Field(description="Pseudo.")


class HeartbeatReponse(BaseModel):
    ok: bool
    expiresAt: int = Field(description="Expiration du salon 24 h (ms), 0 s'il n'existe pas.")


class OkReponse(BaseModel):
    ok: bool


class RobotDriveCorps(BaseModel):
    code: str = Field(description="Code du salon.")
    cmd: str = Field(description="F, B, L, R, S, +, -, V<n> ou M<gauche>,<droite>.")
    id: Optional[str] = Field(None, description="Identifiant de la commande.")
    de: Optional[str] = Field(None, alias="from", description="Émetteur affiché (« HTTP » par défaut).")


class RobotDriveReponse(BaseModel):
    ok: bool = Field(description="true seulement si la commande a été transmise au robot.")
    id: str
    cmd: str = Field(description="Commande normalisée.")
    relaye: bool = Field(description="La commande a été transmise au robot du salon.")
    error: Optional[str] = Field(None, description="Pourquoi elle ne l'a pas été (jeton absent, aucun robot).")


class RobotDriveErreur(BaseModel):
    ok: bool = False
    error: str
    id: str


class Sante(BaseModel):
    status: str


def _param(nom: str, description: str, requis: bool = False, exemple: Optional[str] = None) -> dict:
    p = {"name": nom, "in": "query", "required": requis, "description": description, "schema": {"type": "string"}}
    if exemple is not None:
        p["example"] = exemple
    return p


def _corps(modele: type[BaseModel], exemple: dict) -> dict:
    return {"requestBody": {"required": True, "content": {"application/json": {
        "schema": modele.model_json_schema(by_alias=True), "example": exemple}}}}


CODE = _param("code", "Code du salon (caractères autres que lettres, chiffres, _ et - ignorés).", True, "1234")
BINAIRE = {"schema": {"type": "string", "format": "binary"}}

DOC = {
    "alerte_photo": dict(
        response_class=FileResponse,
        tags=[T_ALERTES], summary="Photo d'une alerte",
        description="Par défaut la dernière photo du salon ; avec `f`, une photo précise de l'historique.",
        openapi_extra={"parameters": [
            CODE,
            _param("f", "Nom de la photo (champ `photo` de /alertes, sans .jpg).", exemple="1234-1795250000000"),
            _param("t", "Ignoré : sert à contourner le cache du téléphone."),
        ]},
        responses={200: {"description": "Image JPEG.", "content": {"image/jpeg": BINAIRE}},
                   400: {"description": "`code requis` (texte)."}, 404: {"description": "`aucune photo` (texte)."}},
    ),
    "alertes": dict(
        tags=[T_ALERTES], summary="Historique des alertes",
        description="Tout ce que le robot a signalé, y compris les alertes qui n'ont pas déclenché de notification "
                    "(60 dernières par salon).",
        openapi_extra={"parameters": [CODE]},
        responses={200: {"model": AlertesReponse, "description": "Alertes."},
                   400: {"model": Erreur, "description": "`code` manquant."}},
    ),
    "enregistrement": dict(
        response_class=FileResponse,
        tags=[T_REC], summary="Télécharger une vidéo",
        openapi_extra={"parameters": [_param("f", "Nom du fichier .mp4 (champ `nom` de /enregistrements).", True,
                                             "robot-1234-20261121-103000.mp4")]},
        responses={200: {"description": "Vidéo mp4.", "content": {"video/mp4": BINAIRE}},
                   400: {"description": "`nom invalide` (texte)."},
                   404: {"description": "`enregistrement introuvable` (texte)."}},
    ),
    "enregistrements": dict(
        tags=[T_REC], summary="Lister les vidéos d'un salon",
        openapi_extra={"parameters": [CODE]},
        responses={200: {"model": VideosReponse, "description": "Vidéos."},
                   400: {"model": Erreur, "description": "`code` manquant."}},
    ),
    "ouvrir": dict(
        tags=[T_ALERTES], summary="Page qui ouvre l'app depuis un lien Telegram",
        description="Affiche la dernière photo d'alerte et redirige vers `ping://`.",
        openapi_extra={"parameters": [_param("code", "Code du salon.", exemple="1234")]},
        responses={200: {"description": "Page HTML.", "content": {"text/html": {"schema": {"type": "string"}}}}},
    ),
    "register_token": dict(
        tags=[T_NOTIF], summary="Enregistrer un jeton de notification",
        description="Équivalent HTTP de l'événement Socket.IO `register_token` (bloqué sur iOS en `http://`).",
        openapi_extra=_corps(RegisterTokenCorps, {"token": "ExponentPushToken[xxxx]", "code": "1234", "pseudo": "Andy"}),
        responses={200: {"model": MessageReponse, "description": "`Token enregistré`."},
                   400: {"model": ErreurEn, "description": "`token manquant`."}},
    ),
    "lobby_heartbeat": dict(
        tags=[T_NOTIF], summary="Signe de vie dans le salon 24 h",
        description="Utilisé quand l'app est fermée (tâche de fond).",
        openapi_extra=_corps(CodePseudo, {"code": "1234", "pseudo": "Andy"}),
        responses={200: {"model": HeartbeatReponse, "description": "Présence enregistrée."},
                   400: {"model": ErreurEn, "description": "`code/pseudo requis`."}},
    ),
    "bg_sync": dict(
        tags=[T_NOTIF], summary="Synchronisation en tâche de fond",
        description="Appelée après une notification silencieuse. Ne fait que valider la requête pour l'instant.",
        openapi_extra=_corps(CodePseudo, {"code": "1234", "pseudo": "Andy"}),
        responses={200: {"model": OkReponse, "description": "OK."},
                   400: {"model": ErreurEn, "description": "`code/pseudo requis`."}},
    ),
    "robot_drive": dict(
        tags=[T_ROBOT], summary="Envoyer une commande moteur par HTTP",
        description="Pour les tests à la main. Sans session, pas de contrôle du pilote possible : la commande n'est "
                    "transmise au robot du salon qu'avec l'en-tête `Authorization: Bearer <ROBOT_HTTP_TOKEN>`. "
                    "Sans jeton valide, la réponse est quand même 200 (avec `relaye: false`), car les anciennes "
                    "versions de l'app appellent cette route à chaque commande. L'app doit utiliser l'événement "
                    "Socket.IO `drive`.",
        openapi_extra=_corps(RobotDriveCorps, {"code": "1234", "cmd": "F", "from": "test"}),
        responses={200: {"model": RobotDriveReponse, "description": "Commande transmise, ou ignorée (`relaye`)."},
                   400: {"model": RobotDriveErreur, "description": "`code/cmd invalide`."}},
    ),
    "robot_audio_post": dict(
        response_class=Response,
        tags=[T_ROBOT], summary="Le robot envoie son micro (MP3 continu)",
        description="Requête longue : le robot pousse un flux MP3 sans fin ; chaque morceau est redistribué aux "
                    "auditeurs de `GET /robot-audio`. Démarré par l'événement Socket.IO `robot_audio`.",
        openapi_extra={"parameters": [_param("code", "Code du salon.", True, "1234")],
                       "requestBody": {"required": True, "content": {"audio/mpeg": BINAIRE}}},
        responses={200: {"description": "Flux terminé."}, 400: {"description": "`code` manquant."}},
    ),
    "robot_audio_get": dict(
        response_class=StreamingResponse,
        tags=[T_ROBOT], summary="Écouter le micro du robot (webradio)",
        description="Flux MP3 sans fin. Un auditeur trop lent perd des morceaux au lieu d'accumuler du retard.",
        openapi_extra={"parameters": [_param("code", "Code du salon.", True, "1234")]},
        responses={200: {"description": "Flux MP3.", "content": {"audio/mpeg": BINAIRE}},
                   400: {"description": "`code` manquant."}},
    ),
    "rtc": dict(
        response_class=StreamingResponse,
        tags=[T_RTC], summary="Relais vers MediaMTX (WHEP / WHIP)",
        description="Transmet la requête telle quelle à MediaMTX (`127.0.0.1:8889`), qui n'est pas exposé sur "
                    "Internet. Exemple : `POST /rtc/robot-1234/whep` avec une offre SDP pour lire la vidéo. "
                    "Les en-têtes `Location` renvoyés restent derrière `/rtc`.",
        openapi_extra={"requestBody": {"content": {"application/sdp": {"schema": {"type": "string"},
                                                                        "example": "v=0\r\n…"}}}},
        responses={201: {"description": "Réponse SDP de MediaMTX.",
                         "content": {"application/sdp": {"schema": {"type": "string"}}}},
                   502: {"model": ErreurEn, "description": "`mediamtx injoignable`."}},
    ),
    "racine": dict(tags=[T_SANTE], summary="Le serveur répond", description="Renvoie `OK` en texte."),
    "health": dict(tags=[T_SANTE], summary="État du serveur",
                   responses={200: {"model": Sante, "description": "`{\"status\": \"ok\"}`."}}),
}

