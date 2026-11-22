from dataclasses import dataclass
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, create_model

PREFIXE = "/socket"


def modele(nom: str, exemple: Optional[dict] = None, **champs) -> type[BaseModel]:
    definitions = {}
    for cle, spec in champs.items():
        typ, desc, *reste = spec
        options = reste[0] if reste else {}
        defaut = options.get("defaut", ...)
        alias = options.get("alias")
        definitions[cle] = (typ, Field(defaut, description=desc, alias=alias))
    config = ConfigDict(json_schema_extra={"examples": [exemple]} if exemple else None, populate_by_name=True)
    return create_model(nom, __config__=config, **definitions)


OPT = {"defaut": None}
CODE = (str, "Code du salon, le même pour l'app et le robot.")
ON = (bool, "Activer (true) ou arrêter (false).")
JPEG = (bytes, "Image JPEG en binaire (Buffer côté Node).")

Coords = modele(
    "Coords",
    latitude=(float, "Latitude en degrés."),
    longitude=(float, "Longitude en degrés."),
)
Membre = modele("MembreSalon", pseudo=(str, "Pseudo du membre."))
EvenementJournal = modele(
    "EvenementJournal",
    ts=(int, "Horodatage en millisecondes."),
    type=(str, "Nom de l'événement journalisé (robot_drive, buzz, robot_alerte…)."),
    payload=(dict, "Contenu de l'événement au moment où il a été journalisé."),
)
EtatRobot = modele(
    "EtatRobot",
    {"fix": True, "coords": {"latitude": 48.85, "longitude": 2.35}, "gpsAgeMs": 800, "heading": 90,
     "speedKnots": 0.2, "obstacleCm": 120, "modeAbsent": False, "arduinoConnected": True,
     "navActive": False, "sharing": True},
    fix=(bool, "Le GPS a une position."),
    coords=(Optional[Coords], "Dernière position GPS.", OPT),
    gpsAgeMs=(Optional[int], "Âge de la position GPS en ms.", OPT),
    heading=(Optional[float], "Cap en degrés (0 = nord).", OPT),
    speedKnots=(Optional[float], "Vitesse en nœuds.", OPT),
    obstacleCm=(Optional[float], "Distance mesurée par le capteur à ultrasons, en cm.", OPT),
    modeAbsent=(Optional[bool], "Mode surveillance « absent » actif.", OPT),
    arduinoConnected=(bool, "L'Arduino des moteurs est connecté."),
    navActive=(Optional[bool], "Navigation GPS en cours.", OPT),
    sharing=(Optional[bool], "Partage de position en cours.", OPT),
)
EtatRonde = modele(
    "EtatRonde",
    {"apprentissage": False, "enCours": True, "points": 42, "longueurM": 180.5, "toursFaits": 3, "prochainDansS": 0},
    apprentissage=(bool, "Le robot enregistre un nouveau circuit."),
    enCours=(bool, "Une ronde tourne."),
    points=(int, "Nombre de points du circuit appris."),
    longueurM=(float, "Longueur du circuit en mètres."),
    toursFaits=(int, "Tours effectués depuis le démarrage."),
    prochainDansS=(int, "Secondes avant le prochain départ (0 = en train de rouler)."),
)
EtatEnregistrement = modele(
    "EtatEnregistrement",
    {"actif": False, "fichier": None, "secondes": 0, "termine": "robot-1234-20261121-103000.mp4", "mo": 12.4},
    actif=(bool, "Un enregistrement est en cours."),
    fichier=(Optional[str], "Nom du fichier en cours.", OPT),
    secondes=(int, "Durée écoulée en secondes."),
    erreur=(Optional[str], "Raison de l'échec, si l'enregistrement a échoué.", OPT),
    termine=(Optional[str], "Nom du fichier qui vient d'être terminé.", OPT),
    mo=(Optional[float], "Taille du fichier terminé, en Mo.", OPT),
)
ReponseMediaMTX = modele(
    "ReponseMediaMTX",
    {"status": 201, "sdp": "v=0\r\n…", "location": "/robot-1234/whep/5f2c…"},
    status=(int, "Code HTTP renvoyé par MediaMTX (201 = accepté, 404 = le robot ne publie pas, 502 = MediaMTX injoignable)."),
    sdp=(Optional[str], "Réponse SDP à appliquer côté app.", OPT),
    location=(Optional[str], "Ressource de session, à renvoyer dans rtc_stop pour fermer.", OPT),
)
EtatAppel = modele(
    "EtatAppelAlerte",
    {"actif": True, "configure": True},
    actif=(bool, "Les appels sont activés pour ce salon."),
    configure=(bool, "Twilio est configuré sur le serveur."),
)
EtatVeille = modele(
    "EtatVeille",
    {"eveille": False, "veille": True, "phrase": "Salut Solana"},
    eveille=(bool, "L'assistant écoute (mot de réveil entendu)."),
    veille=(bool, "Le mode veille est actif."),
    phrase=(str, "Mot de réveil à prononcer."),
)
Vide = modele("Vide")
RobotStatusRecu = create_model(
    "RobotStatusRecu",
    __base__=EtatRobot,
    by=(str, Field(..., description="Robot, ou « serveur » si aucun robot n'est connecté.")),
    ts=(int, Field(..., description="Horodatage serveur (ms).")),
    error=(Optional[str], Field(None, description="« Aucun robot connecte avec ce code » si le serveur répond seul.")),
)
RobotRondeStatusEmis = create_model(
    "RobotRondeStatusEmis",
    __base__=EtatRonde,
    code=(str, Field(..., description=CODE[1])),
)


SonarScanSession = modele("SonarScanSession", session=(str, "Scan session ID."))
SonarScanStatusRequest = modele(
    "SonarScanStatusRequest",
    preview=(Optional[bool], "Include a live map preview.", OPT),
)
SonarScanStatus = modele(
    "SonarScanStatus",
    session=(Optional[str], "Active scan session ID.", OPT),
    saving=(Optional[bool], "Whether map generation is running.", OPT),
    recordingError=(Optional[str], "Reason recording stopped early.", OPT),
    readingCount=(Optional[int], "Number of valid echoes recorded.", OPT),
    snapshot=(Optional[dict], "Live map preview in the sonar_map_snapshot format.", OPT),
    error=(Optional[str], "Reason the request failed.", OPT),
)
SonarScanResult = modele(
    "SonarScanResult",
    session=(Optional[str], "Saved scan session ID.", OPT),
    snapshot=(Optional[dict], "Occupancy map in the sonar_map_snapshot format.", OPT),
    mapError=(Optional[str], "Reason the saved scan could not produce a map.", OPT),
    error=(Optional[str], "Reason the request failed.", OPT),
)
SonarScanEntry = modele(
    "SonarScanEntry",
    session=(str, "Saved scan session ID."),
    savedAt=(int, "Save time in Unix milliseconds."),
)
SonarScanHistory = modele(
    "SonarScanHistory",
    scans=(Optional[list[SonarScanEntry]], "Saved scans, newest first.", OPT),
    error=(Optional[str], "Reason the request failed.", OPT),
)


@dataclass
class Evenement:
    nom: str
    theme: str
    resume: str
    description: str
    emis: Optional[type[BaseModel]] = None
    emis_par: str = ""
    recu: Optional[type[BaseModel]] = None
    recu_par: str = ""
    ack: Any = None
    ack_description: str = "Aucun accusé de réception."
    pilote: bool = False
    robot_seulement: bool = False
    sans_corps_recu: bool = False


T_SALON = "⚡ Socket · Salon et rôles"
T_MESSAGES = "⚡ Socket · Messages et « Se rejoindre »"
T_LOBBY = "⚡ Socket · Salon 24 h"
T_PILOTAGE = "⚡ Socket · Pilotage"
T_CAMERA = "⚡ Socket · Caméra et photos"
T_RTC = "⚡ Socket · WebRTC et audio"
T_NAV = "⚡ Socket · Navigation et rondes"
T_ALERTES = "⚡ Socket · Surveillance et alertes"
T_REC = "⚡ Socket · Enregistrement vidéo"
T_VOIX = "⚡ Socket · Assistant vocal"
T_RT = "⚡ Socket · Conversation en direct"
T_SONAR = "⚡ Socket · Carte sonar"

THEMES = [
    (T_SALON, "Appairage au salon, élection du pilote, admission des spectateurs, rattrapage des événements manqués."),
    (T_MESSAGES, "Buzz, rappels, demandes « Se rejoindre » et partage de position."),
    (T_LOBBY, "Salon partagé de 24 h avec hôtes et membres."),
    (T_PILOTAGE, "Commandes moteur, état du robot, arrêt d'urgence, mode surveillance."),
    (T_CAMERA, "Images JPEG de secours, orientation de la caméra, captures demandées par l'assistant."),
    (T_RTC, "Négociation WebRTC avec MediaMTX (la vidéo elle-même ne passe pas par ce serveur), talkie-walkie, clips vocaux."),
    (T_NAV, "Navigation GPS vers une destination et rondes apprises."),
    (T_ALERTES, "Alertes du mode absent, alarme, appels téléphoniques."),
    (T_REC, "Enregistrement mp4 sur le VPS et enregistrement HD sur le robot."),
    (T_VOIX, "« Hey Solana » : questions vocales tour par tour et vision d'évitement d'obstacles."),
    (T_RT, "Conversation vocale continue avec OpenAI Realtime."),
    (T_SONAR, "Carte d'occupation calculée par map_sonar.py, poussée en direct à l'app (salon SONAR_MAP_ROOM)."),
]

A_PILOTE = "app (pilote)"
A_APP = "app"
A_ROBOT = "robot"
A_TOUS = "app ou robot"
A_SALON = "les autres membres du salon"
A_APPS = "les apps du salon"

EVENEMENTS: list[Evenement] = [
    Evenement(
        "pair", T_SALON, "Rejoindre un salon",
        "Premier message à envoyer après la connexion. Le premier humain arrivé devient **pilote** ; les suivants "
        "attendent que le pilote les accepte (`role_acces` = `attente`). Le robot envoie `robot: true` et reste hors "
        "de l'élection ; si `ROBOT_KEY` est configurée sur le serveur, il doit aussi envoyer `cle`, sinon il reçoit "
        "`pair_refuse`. Avec `lastSeen`, le serveur renvoie aussitôt les événements manqués dans `sync_batch`.",
        emis=modele("Pair", {"pseudo": "Andy", "code": "1234", "lastSeen": 1795250000000},
                    pseudo=(str, "Nom affiché."), code=CODE,
                    lastSeen=(Optional[int], "Dernier événement vu (ms) : déclenche le rattrapage.", OPT),
                    robot=(Optional[bool], "true pour le robot.", OPT),
                    cle=(Optional[str], "Robot seulement : valeur de `ROBOT_KEY`.", OPT)),
        emis_par=A_TOUS,
    ),
    Evenement(
        "pair_refuse", T_SALON, "Robot refusé",
        "Un socket s'est déclaré robot sans la bonne `cle`. Il n'entre pas dans le salon.",
        recu=modele("PairRefuse", {"raison": "cle robot invalide"}, raison=(str, "Pourquoi.")),
        recu_par=A_ROBOT,
    ),
    Evenement(
        "role_acces", T_SALON, "Rôle attribué",
        "Envoyé à l'arrivée dans le salon, à l'admission, ou quand un spectateur est promu pilote.",
        recu=modele("RoleAcces", {"role": "pilote"},
                    role=(Literal["pilote", "attente", "spectateur"], "Rôle obtenu."),
                    raison=(Optional[str], "Pourquoi le rôle change (promotion).", OPT)),
        recu_par=A_APP,
    ),
    Evenement(
        "acces_demande", T_SALON, "Quelqu'un demande à entrer",
        "Envoyé au pilote. Répondre avec `acces_reponse`.",
        recu=modele("AccesDemande", {"id": "jvG0aGVPsPQBjwdQAAAD", "pseudo": "Zoe"},
                    id=(str, "Identifiant du socket qui demande."), pseudo=(str, "Son pseudo.")),
        recu_par=A_PILOTE,
    ),
    Evenement(
        "acces_reponse", T_SALON, "Accepter ou refuser une arrivée",
        "Réservé au pilote. Accepté : le demandeur rejoint le salon en spectateur (`role_acces`) et tout le salon "
        "reçoit `user_joined`. Refusé : il reçoit `acces_refuse`.",
        emis=modele("AccesReponse", {"id": "jvG0aGVPsPQBjwdQAAAD", "accepte": True},
                    id=(str, "Identifiant reçu dans acces_demande."), accepte=(bool, "true pour accepter.")),
        emis_par=A_PILOTE,
    ),
    Evenement("acces_refuse", T_SALON, "Entrée refusée", "Le pilote a refusé l'entrée.",
              recu=Vide, recu_par=A_APP),
    Evenement(
        "acces_refuse_commande", T_SALON, "Commande refusée",
        "Un spectateur a envoyé une commande réservée au pilote.",
        recu=modele("AccesRefuseCommande", {"commande": "robot_drive"}, commande=(str, "Événement refusé.")),
        recu_par=A_APP,
    ),
    Evenement(
        "pilote_change", T_SALON, "Nouveau pilote", "Le pilote est parti et un spectateur a pris sa place.",
        recu=modele("PiloteChange", {"pseudo": "Zoe"}, pseudo=(Optional[str], "Nouveau pilote.")),
        recu_par=A_SALON,
    ),
    Evenement(
        "user_joined", T_SALON, "Un membre est arrivé",
        "Aussi envoyé au nouvel arrivant pour chaque membre déjà présent.",
        recu=modele("UserJoined", {"pseudo": "Robot"}, pseudo=(str, "Pseudo du membre.")),
        recu_par=A_SALON,
    ),
    Evenement("user_left", T_SALON, "Un membre est parti",
              "Sans contenu. Après une déconnexion, envoyé seulement si le membre n'est pas revenu en 5 minutes.",
              recu=Vide, recu_par=A_SALON, sans_corps_recu=True),
    Evenement("leave", T_SALON, "Quitter le salon volontairement", "Les autres reçoivent `user_left`.",
              emis=modele("Leave", {"code": "1234"}, code=CODE), emis_par=A_TOUS),
    Evenement(
        "sync", T_SALON, "Demander les événements manqués",
        "Le serveur garde les 500 derniers événements de chaque salon. Réponse : `sync_batch`.",
        emis=modele("Sync", {"code": "1234", "since": 1795250000000}, code=CODE,
                    since=(Optional[int], "Ne renvoyer que les événements postérieurs (ms).", OPT)),
        emis_par=A_APP,
    ),
    Evenement(
        "sync_batch", T_SALON, "Événements manqués", "Réponse à `sync` ou à `pair` avec `lastSeen`.",
        recu=modele("SyncBatch", {"since": 0, "items": [{"ts": 1795250000000, "type": "robot_mode",
                                                         "payload": {"absent": True}}]},
                    since=(int, "Point de départ demandé."), items=(list[EvenementJournal], "Événements.")),
        recu_par=A_APP,
    ),
    Evenement("start_typing", T_SALON, "Commence à écrire",
              "Les autres reçoivent `user_is_typing` (sans contenu).",
              emis=modele("Typing", {"code": "1234"}, code=(Optional[str], "Code du salon (sinon celui du socket).", OPT)),
              emis_par=A_APP),
    Evenement("stop_typing", T_SALON, "Arrête d'écrire",
              "Les autres reçoivent `user_stopped_typing` (sans contenu).",
              emis=modele("TypingStop", {"code": "1234"}, code=(Optional[str], "Code du salon.", OPT)),
              emis_par=A_APP),
    Evenement("user_is_typing", T_SALON, "Un membre écrit", "Sans contenu.",
              recu=Vide, recu_par=A_SALON, sans_corps_recu=True),
    Evenement("user_stopped_typing", T_SALON, "Un membre a arrêté d'écrire", "Sans contenu.",
              recu=Vide, recu_par=A_SALON, sans_corps_recu=True),
    Evenement(
        "register_token", T_SALON, "Enregistrer le jeton de notification",
        "Jeton Expo du téléphone, gardé sur disque pour notifier même app fermée. Passe par le socket car iOS bloque "
        "les requêtes `http://`. Réponse : `register_token_ok`.",
        emis=modele("RegisterToken", {"code": "1234", "pseudo": "Andy", "token": "ExponentPushToken[xxxx]"},
                    code=CODE, pseudo=(str, "Pseudo du propriétaire."), token=(str, "Jeton Expo.")),
        emis_par=A_APP,
    ),
    Evenement("register_token_ok", T_SALON, "Jeton enregistré", "",
              recu=modele("RegisterTokenOk", {"ok": True}, ok=(bool, "Toujours true.")), recu_par=A_APP),
    Evenement(
        "app_diag", T_SALON, "Diagnostic de l'app", "Écrit simplement une ligne dans les logs du serveur.",
        emis=modele("AppDiag", {"sujet": "push", "detail": "permission refusée", "plateforme": "ios", "version": "1.4.0"},
                    code=(Optional[str], "Code du salon.", OPT), pseudo=(Optional[str], "Pseudo.", OPT),
                    sujet=(Optional[str], "Sujet.", OPT), detail=(Optional[str], "Détail (300 caractères max).", OPT),
                    plateforme=(Optional[str], "ios / android.", OPT), version=(Optional[str], "Version de l'app.", OPT)),
        emis_par=A_APP,
    ),

    Evenement(
        "buzz", T_MESSAGES, "Message (buzz)",
        "Relayé au salon et envoyé en notification. Les messages commençant par `PING_ROBOT_` sont internes au robot : "
        "relayés sans notification ni journal. Les commandes `PING_ROBOT_DRIVE:` et `PING_ROBOT_CAM:` (ancien canal "
        "de secours) sont réservées au pilote du salon ; sinon elles sont ignorées sans message, le refus étant déjà "
        "signalé par `robot_drive`. L'émetteur reçoit "
        "`buzz_sent_confirmation`.",
        emis=modele("BuzzEmis", {"code": "1234", "message": "J'arrive"}, code=CODE, message=(str, "Texte.")),
        emis_par=A_TOUS,
        recu=modele("BuzzRecu", {"message": "J'arrive"}, message=(str, "Texte.")),
        recu_par=A_SALON,
    ),
    Evenement(
        "nudge", T_MESSAGES, "Rappel",
        "Les autres reçoivent un `buzz` « ⚡ X t'a envoyé un rappel. » et une notification.",
        emis=modele("Nudge", {"code": "1234", "senderPseudo": "Andy"}, code=CODE, senderPseudo=(str, "Ton pseudo.")),
        emis_par=A_APP,
    ),
    Evenement(
        "buzz_sent_confirmation", T_MESSAGES, "Buzz envoyé", "",
        recu=modele("BuzzConfirmation", {"status": "succès", "text": "Buzz envoyé !"},
                    status=(str, "Toujours « succès »."), text=(str, "Message à afficher.")),
        recu_par="l'émetteur",
    ),
    Evenement(
        "request_meet", T_MESSAGES, "Demander à se rejoindre",
        "Les autres reçoivent `meet_request` (ou à leur prochaine connexion s'ils sont absents) et une notification.",
        emis=modele("RequestMeet", {"code": "1234", "from": "Andy"}, code=CODE,
                    de=(Optional[str], "Pseudo du demandeur (sinon celui du socket).", {"defaut": None, "alias": "from"})),
        emis_par=A_TOUS,
    ),
    Evenement("meet_request", T_MESSAGES, "Demande « Se rejoindre » reçue", "",
              recu=modele("MeetRequest", {"from": "Andy"}, de=(str, "Demandeur.", {"alias": "from"})), recu_par=A_SALON),
    Evenement("accept_meet", T_MESSAGES, "Accepter la demande", "Les autres reçoivent `meet_accepted`.",
              emis=modele("AcceptMeet", {"code": "1234"}, code=CODE), emis_par=A_TOUS),
    Evenement("meet_accepted", T_MESSAGES, "Demande acceptée", "",
              recu=modele("MeetAccepted", {"by": "Robot"}, by=(str, "Qui a accepté.")), recu_par=A_SALON),
    Evenement("decline_meet", T_MESSAGES, "Refuser la demande", "Les autres reçoivent `meet_declined`.",
              emis=modele("DeclineMeet", {"code": "1234"}, code=CODE), emis_par=A_TOUS),
    Evenement("meet_declined", T_MESSAGES, "Demande refusée", "",
              recu=modele("MeetDeclined", {"by": "Robot"}, by=(str, "Qui a refusé.")), recu_par=A_SALON),
    Evenement("cancel_meet", T_MESSAGES, "Annuler la demande", "Les autres reçoivent `meet_canceled`.",
              emis=modele("CancelMeet", {"code": "1234"}, code=CODE), emis_par=A_TOUS),
    Evenement("meet_canceled", T_MESSAGES, "Demande annulée", "Sans contenu.",
              recu=Vide, recu_par=A_SALON, sans_corps_recu=True),
    Evenement(
        "share_location", T_MESSAGES, "Partager sa position",
        "Le robot l'envoie toutes les 5 s. Les autres reçoivent `peer_location`.",
        emis=modele("ShareLocation", {"code": "1234", "coords": {"latitude": 48.85, "longitude": 2.35}},
                    code=CODE, coords=(Coords, "Position.")),
        emis_par=A_TOUS,
    ),
    Evenement("peer_location", T_MESSAGES, "Position d'un membre", "",
              recu=modele("PeerLocation", {"coords": {"latitude": 48.85, "longitude": 2.35}},
                          coords=(Coords, "Position.")),
              recu_par=A_SALON),

    Evenement(
        "lobby_join", T_LOBBY, "Rejoindre le salon 24 h",
        "Avec `asHost`, démarre le salon pour 24 h s'il n'existe pas. Le salon reçoit `lobby_member_joined` "
        "et `lobby_state`.",
        emis=modele("LobbyJoin", {"code": "1234", "pseudo": "Andy", "asHost": True}, code=CODE,
                    pseudo=(str, "Pseudo."), asHost=(Optional[bool], "Rejoindre comme hôte.", OPT)),
        emis_par=A_APP,
    ),
    Evenement(
        "lobby_request", T_LOBBY, "Demander à entrer dans le salon 24 h",
        "Envoyé par un visiteur ; seuls les hôtes reçoivent `lobby_request` (et une notification).",
        emis=modele("LobbyRequestEmis", {"code": "1234", "from": "Zoe"}, code=CODE,
                    de=(str, "Pseudo du demandeur.", {"alias": "from"})),
        emis_par=A_APP,
        recu=modele("LobbyRequestRecu", {"from": "Zoe", "code": "1234"},
                    de=(str, "Demandeur.", {"alias": "from"}), code=CODE),
        recu_par="les hôtes",
    ),
    Evenement("lobby_accept", T_LOBBY, "Accepter un membre (hôte)",
              "Réservé aux hôtes. Le salon reçoit `lobby_member_joined` et `lobby_state`.",
              emis=modele("LobbyAccept", {"code": "1234", "target": "Zoe"}, code=CODE, target=(str, "Pseudo accepté.")),
              emis_par="app (hôte)"),
    Evenement("lobby_decline", T_LOBBY, "Refuser un membre", "Le salon reçoit `lobby_declined`.",
              emis=modele("LobbyDecline", {"code": "1234", "target": "Zoe"}, code=CODE, target=(str, "Pseudo refusé.")),
              emis_par=A_APP),
    Evenement("lobby_declined", T_LOBBY, "Membre refusé", "",
              recu=modele("LobbyDeclined", {"code": "1234", "target": "Zoe"}, code=CODE, target=(str, "Pseudo refusé.")),
              recu_par=A_SALON),
    Evenement("lobby_heartbeat", T_LOBBY, "Signe de vie", "Marque le membre comme présent.",
              emis=modele("LobbyHeartbeat", {"code": "1234", "pseudo": "Andy"}, code=CODE, pseudo=(str, "Pseudo.")),
              emis_par=A_APP),
    Evenement(
        "lobby_leave", T_LOBBY, "Quitter le salon 24 h",
        "Le salon reçoit `lobby_member_left` puis `lobby_state`, ou `lobby_expired` si `expired`.",
        emis=modele("LobbyLeave", {"code": "1234"}, code=CODE,
                    expired=(Optional[bool], "Le salon a expiré côté app.", OPT)),
        emis_par=A_APP,
    ),
    Evenement("lobby_member_joined", T_LOBBY, "Membre arrivé", "",
              recu=modele("LobbyMemberJoined", {"code": "1234", "member": {"pseudo": "Zoe"}}, code=CODE,
                          member=(Membre, "Membre.")),
              recu_par=A_SALON),
    Evenement("lobby_member_left", T_LOBBY, "Membre parti", "",
              recu=modele("LobbyMemberLeft", {"code": "1234", "member": {"pseudo": "Zoe"}}, code=CODE,
                          member=(Membre, "Membre.")),
              recu_par=A_SALON),
    Evenement("lobby_state", T_LOBBY, "État du salon 24 h", "",
              recu=modele("LobbyState", {"code": "1234", "members": [{"pseudo": "Andy"}], "expiresAt": 1795336400000},
                          code=CODE, members=(list[Membre], "Membres."),
                          expiresAt=(int, "Expiration (ms), 0 si aucun salon.")),
              recu_par=A_SALON),
    Evenement("lobby_expired", T_LOBBY, "Salon expiré", "Au bout de 24 h, ou quand un membre le signale.",
              recu=modele("LobbyExpired", {"code": "1234"}, code=CODE), recu_par=A_SALON),

    Evenement(
        "drive", T_PILOTAGE, "Piloter le robot (canal unique)",
        "Remplace `robot_drive`, le buzz `PING_ROBOT_DRIVE` et `POST /robot-drive`. Mêmes commandes que "
        "`robot_drive`. Le salon est celui de la session : un éventuel `code` dans le message est ignoré.\n\n"
        "* **Changement d'ordre** (appui, relâchement, vitesse) : envoyer `ack: true` et attendre l'accusé. Le "
        "serveur transmet au robot, attend sa réponse (1,5 s au plus) et la renvoie. Côté app, prévoir un délai "
        "d'au moins 2 s.\n"
        "* **Maintien du bouton** : répéter l'ordre toutes les 250 ms en `socket.volatile.emit('drive', { cmd })`, "
        "sans `ack` ni accusé. Le serveur relaie sans attendre.\n\n"
        "🔒 Réservé au **pilote** : sinon l'accusé contient `ok: false`.\n\n"
        "**Le robot doit répondre par l'accusé** quand on le lui demande : `{ ok, arduino }`, et `erreur` si "
        "`ok` vaut false. Il s'arrête de lui-même s'il ne reçoit plus rien pendant 800 ms.",
        emis=modele("DriveEmis", {"cmd": "F", "ack": True},
                    cmd=(str, "Commande : F, B, L, R, S, +, -, V<n> ou M<gauche>,<droite>."),
                    ack=(Optional[bool], "true pour attendre la réponse du robot.", OPT)),
        emis_par=A_PILOTE,
        recu=modele("DriveRecu", {"cmd": "F"}, cmd=(str, "Commande normalisée (majuscules).")),
        recu_par=A_ROBOT,
        ack=modele("DriveReponse", {"ok": True, "cmd": "F", "arduino": True},
                   ok=(bool, "Le robot a transmis la commande à l'Arduino."),
                   cmd=(Optional[str], "Commande normalisée.", OPT),
                   arduino=(Optional[bool], "L'Arduino est connecté.", OPT),
                   erreur=(Optional[str], "« seul le pilote peut conduire », « commande inconnue », « robot hors "
                                          "ligne », « le robot n'a pas repondu »… Absent si ok.", OPT)),
        ack_description="Seulement avec `ack: true`. Réponse du robot, ou erreur du serveur.",
    ),
    Evenement(
        "robot_drive", T_PILOTAGE, "Commande moteur",
        "Commandes : `F` avancer, `B` reculer, "
        "`L`/`R` tourner, `S` stop, `+`/`-` vitesse, `V<n>` vitesse absolue (`V180`), `M<gauche>,<droite>` pilotage "
        "différentiel (`M100,-40`). Mise en majuscules ; une commande invalide est ignorée. Transmis au seul robot du "
        "salon de la session. L'émetteur reçoit `robot_drive_confirmation`, ou `robot_drive_status` avec `ok: false` "
        "si aucun robot n'est connecté. Avec `feedback: false`, le serveur relaie l'ordre sans envoyer sa propre "
        "confirmation ou erreur. L'assistant vocal et l'arrêt d'urgence émettent aussi cet événement "
        "(`by` = `solana` ou `arret-urgence`).",
        emis=modele("RobotDriveEmis", {"code": "1234", "cmd": "M100,-40", "id": "c-1795250000000"}, code=CODE,
                    cmd=(str, "Commande."), id=(Optional[str], "Identifiant de la commande.", OPT),
                    feedback=(Optional[bool], "Retour direct du serveur, activé par défaut.", OPT)),
        emis_par=A_PILOTE,
        recu=modele("RobotDriveRecu", {"id": "c-1795250000000", "cmd": "M100,-40", "by": "Andy"},
                    id=(str, "Identifiant."), cmd=(str, "Commande normalisée."), by=(str, "Qui a commandé.")),
        recu_par=A_ROBOT,
        pilote=True,
    ),
    Evenement("robot_drive_confirmation", T_PILOTAGE, "Commande transmise", "",
              recu=modele("RobotDriveConfirmation", {"id": "c-1", "ok": True, "cmd": "F"},
                          id=(str, "Identifiant."), ok=(bool, "true."), cmd=(str, "Commande.")),
              recu_par="l'émetteur"),
    Evenement(
        "robot_drive_status", T_PILOTAGE, "Résultat d'une commande moteur",
        "Le robot indique si la commande a été transmise à l'Arduino. Relayé aux autres membres du salon.",
        emis=modele("RobotDriveStatusEmis", {"code": "1234", "cmd": "F", "ok": True, "id": "c-1"}, code=CODE,
                    cmd=(str, "Commande."), ok=(bool, "Transmise à l'Arduino."),
                    message=(Optional[str], "Détail.", OPT), id=(Optional[str], "Identifiant.", OPT)),
        emis_par=A_ROBOT,
        recu=modele("RobotDriveStatusRecu", {"id": "c-1", "cmd": "F", "ok": True, "message": "", "by": "Robot"},
                    id=(str, "Identifiant."), cmd=(str, "Commande."), ok=(bool, "Résultat."),
                    message=(str, "Détail."), by=(str, "Robot, ou « serveur » si aucun robot n'est connecté.")),
        recu_par=A_SALON,
    ),
    Evenement(
        "robot_status_request", T_PILOTAGE, "Demander l'état du robot",
        "Relayé au robot, qui répond par `robot_status`. Sans robot dans le salon, le serveur répond lui-même "
        "un `robot_status` avec `error`.",
        emis=modele("RobotStatusRequestEmis", {"code": "1234"}, code=CODE), emis_par=A_APP,
        recu=modele("RobotStatusRequestRecu", {"by": "Andy"}, by=(str, "Qui demande.")), recu_par=A_ROBOT,
    ),
    Evenement(
        "robot_status", T_PILOTAGE, "État du robot",
        "Envoyé par le robot après chaque changement. Sans `ROBOT_KEY` configurée, un socket qui envoie cet "
        "événement est reconnu comme robot ; avec, seul `pair` avec la bonne `cle` le permet.",
        emis=modele("RobotStatusEmis", {"code": "1234", "status": {"fix": True, "arduinoConnected": True}},
                    code=CODE, status=(EtatRobot, "État.")),
        emis_par=A_ROBOT,
        recu=RobotStatusRecu,
        recu_par=A_APPS,
    ),
    Evenement(
        "robot_stop_all", T_PILOTAGE, "Arrêt d'urgence",
        "Coupe d'abord les boucles qui tournent sur le serveur (suivi de personne, déplacement vers un objet), puis "
        "envoie au robot `robot_stop_all`, `robot_drive` `S`, `robot_nav` `on: false`, `robot_ronde` `arreter` et "
        "`robot_rt` `on: false`.",
        emis=modele("RobotStopAll", {"code": "1234"}, code=CODE), emis_par=A_PILOTE,
        recu=Vide, recu_par=A_ROBOT, pilote=True,
    ),
    Evenement(
        "robot_mode", T_PILOTAGE, "Mode surveillance normal / absent",
        "En mode absent, le robot surveille bruit et mouvement et envoie des `robot_alerte`.",
        emis=modele("RobotModeEmis", {"code": "1234", "absent": True}, code=CODE, absent=(bool, "Mode absent.")),
        emis_par=A_PILOTE,
        recu=modele("RobotModeRecu", {"absent": True}, absent=(bool, "Mode absent.")), recu_par=A_ROBOT, pilote=True,
    ),
    Evenement("robot_mode_status", T_PILOTAGE, "Mode actuel du robot", "",
              emis=modele("RobotModeStatusEmis", {"code": "1234", "absent": True}, code=CODE, absent=(bool, "Mode absent.")),
              emis_par=A_ROBOT,
              recu=modele("RobotModeStatusRecu", {"absent": True}, absent=(bool, "Mode absent.")), recu_par=A_APPS),
    Evenement("robot_say", T_PILOTAGE, "Faire parler le robot", "Texte tronqué à 300 caractères.",
              emis=modele("RobotSayEmis", {"code": "1234", "text": "Bonjour !"}, code=CODE, text=(str, "Texte.")),
              emis_par=A_PILOTE,
              recu=modele("RobotSayRecu", {"text": "Bonjour !"}, text=(str, "Texte à prononcer.")),
              recu_par=A_ROBOT, pilote=True),
    Evenement("robot_listen", T_PILOTAGE, "Réveiller l'assistant du robot",
              "Comme si on avait dit le mot-clé.",
              emis=modele("RobotListen", {"code": "1234"}, code=CODE), emis_par=A_APP,
              recu=Vide, recu_par=A_ROBOT),

    Evenement(
        "robot_frame", T_CAMERA, "Image de la caméra (secours)",
        "Le robot envoie des JPEG un par un ; il attend l'accusé avant d'envoyer le suivant. Quand le WebRTC "
        "fonctionne, il ralentit à ~1 image/s (sert au bouton photo). Non journalisé.",
        emis=modele("RobotFrameEmis", {"code": "1234", "jpeg": "<binaire>"}, code=CODE, jpeg=JPEG),
        emis_par=A_ROBOT,
        recu=modele("RobotFrameRecu", {"jpeg": "<binaire>"}, jpeg=JPEG), recu_par=A_APPS,
        ack=Vide, ack_description="Accusé vide, renvoyé une fois l'image relayée.",
    ),
    Evenement("robot_camera", T_CAMERA, "Allumer / éteindre la caméra", "",
              emis=modele("RobotCameraEmis", {"code": "1234", "on": True}, code=CODE, on=ON), emis_par=A_APP,
              recu=modele("RobotCameraRecu", {"on": True}, on=ON), recu_par=A_ROBOT),
    Evenement(
        "robot_cam_move", T_CAMERA, "Orienter la caméra",
        "Angles servo absolus, bornés entre 0 et 180. Les angles absents ou invalides sont omis.",
        emis=modele("RobotCamMoveEmis", {"code": "1234", "pan": 90, "tilt": 45, "view": "front"}, code=CODE,
                    pan=(Optional[float], "Angle horizontal.", OPT), tilt=(Optional[float], "Angle vertical.", OPT),
                    center=(Optional[bool], "Recentrer.", OPT),
                    view=(Optional[Literal["front", "rear", "both"]], "Caméra avant, arrière ou les deux.", OPT),
                    id=(Optional[str], "Identifiant.", OPT)),
        emis_par=A_PILOTE,
        recu=modele("RobotCamMoveRecu", {"pan": 90, "tilt": 45, "center": False, "view": "front", "id": "cam-1"},
                    pan=(Optional[int], "0-180.", OPT), tilt=(Optional[int], "0-180.", OPT),
                    center=(bool, "Recentrer."),
                    view=(Optional[Literal["front", "rear", "both"]], "Caméra.", OPT), id=(str, "Identifiant.")),
        recu_par=A_ROBOT, pilote=True,
    ),
    Evenement(
        "robot_grab_frame", T_CAMERA, "Capture demandée par le serveur",
        "Le serveur demande une photo au robot (assistant vocal, suivi, vision). Le robot répond **par l'accusé "
        "de réception** avec un JPEG binaire, ou `null`. Délai : 8 s.",
        recu=Vide, recu_par=A_ROBOT,
    ),

    Evenement(
        "rtc_offer", T_RTC, "Lire la vidéo ou le micro du robot (WHEP)",
        "L'app envoie son offre SDP ; le serveur la transmet à MediaMTX (local au VPS) et renvoie la réponse dans "
        "l'accusé. `kind: \"audio\"` = micro du robot (chemin séparé). La vidéo circule ensuite directement entre "
        "MediaMTX et l'app.",
        emis=modele("RtcOffer", {"code": "1234", "sdp": "v=0\r\n…", "kind": "video"}, code=CODE,
                    sdp=(str, "Offre SDP."), kind=(Optional[Literal["video", "audio"]], "Flux voulu.", OPT)),
        emis_par=A_APP, ack=ReponseMediaMTX,
        ack_description="Réponse de MediaMTX (`status` 400 si la requête est incomplète).",
    ),
    Evenement("rtc_stop", T_RTC, "Fermer une session WHEP",
              "Seules les ressources `/robot-<code>/whep/<id>` sont acceptées.",
              emis=modele("RtcStop", {"location": "/robot-1234/whep/5f2c"},
                          location=(str, "Valeur `location` reçue dans l'accusé de rtc_offer.")),
              emis_par=A_APP),
    Evenement(
        "rtc_publish_offer", T_RTC, "Talkie-walkie en direct (WHIP)",
        "L'app publie son micro vers MediaMTX ; le mot de passe de publication reste sur le serveur. Ensuite, "
        "prévenir le robot avec `robot_talk_live`.",
        emis=modele("RtcPublishOffer", {"code": "1234", "sdp": "v=0\r\n…"}, code=CODE, sdp=(str, "Offre SDP.")),
        emis_par=A_PILOTE, ack=ReponseMediaMTX, ack_description="Réponse de MediaMTX.", pilote=True,
    ),
    Evenement("robot_talk_live", T_RTC, "Le robot doit jouer le talkie-walkie", "",
              emis=modele("RobotTalkLiveEmis", {"code": "1234", "on": True}, code=CODE, on=ON), emis_par=A_PILOTE,
              recu=modele("RobotTalkLiveRecu", {"on": True}, on=ON), recu_par=A_ROBOT, pilote=True),
    Evenement("robot_rtc", T_RTC, "La vidéo WebRTC fonctionne",
              "Le robot réduit alors ses images `robot_frame` à ~1/s.",
              emis=modele("RobotRtcEmis", {"code": "1234", "on": True}, code=CODE, on=ON), emis_par=A_APP,
              recu=modele("RobotRtcRecu", {"on": True}, on=ON), recu_par=A_ROBOT),
    Evenement("robot_audio", T_RTC, "Activer le flux audio du robot",
              "Le robot envoie alors son micro en MP3 sur `POST /robot-audio`.",
              emis=modele("RobotAudioEmis", {"code": "1234", "on": True}, code=CODE, on=ON), emis_par=A_APP,
              recu=modele("RobotAudioRecu", {"on": True}, on=ON), recu_par=A_ROBOT),
    Evenement(
        "robot_voice", T_RTC, "Clip vocal à jouer sur le robot",
        "Ignoré au-delà de 2 millions de caractères base64 (~1,5 Mo d'audio).",
        emis=modele("RobotVoiceEmis", {"code": "1234", "b64": "AAAAGGZ0eXBtNGEg…", "ext": "m4a"}, code=CODE,
                    b64=(str, "Audio en base64."), ext=(Optional[str], "Extension (m4a par défaut).", OPT)),
        emis_par=A_PILOTE,
        recu=modele("RobotVoiceRecu", {"b64": "AAAAGGZ0eXBtNGEg…", "ext": "m4a"}, b64=(str, "Audio."),
                    ext=(str, "Extension, 5 caractères alphanumériques max.")),
        recu_par=A_ROBOT, pilote=True,
    ),

    Evenement(
        "robot_nav", T_NAV, "Navigation GPS",
        "`on: true` + `target` : le robot part vers la destination (en suivant les chemins OpenStreetMap si "
        "possible). `on: false` : arrêt.",
        emis=modele("RobotNavEmis", {"code": "1234", "target": {"latitude": 48.85, "longitude": 2.35}, "on": True},
                    code=CODE, target=(Optional[Coords], "Destination.", OPT), on=ON),
        emis_par=A_PILOTE,
        recu=modele("RobotNavRecu", {"target": {"latitude": 48.85, "longitude": 2.35}, "on": True},
                    target=(Optional[Coords], "Destination.", OPT), on=ON),
        recu_par=A_ROBOT, pilote=True,
    ),
    Evenement("robot_nav_status", T_NAV, "Fin de navigation", "",
              emis=modele("RobotNavStatusEmis", {"code": "1234", "arrived": True, "on": False}, code=CODE,
                          arrived=(bool, "Arrivé à destination."), on=(bool, "Navigation encore active.")),
              emis_par=A_ROBOT,
              recu=modele("RobotNavStatusRecu", {"arrived": True, "on": False},
                          arrived=(bool, "Arrivé."), on=(bool, "Active.")),
              recu_par=A_APPS),
    Evenement(
        "robot_ronde", T_NAV, "Commander une ronde",
        "`apprendre_debut` : le robot enregistre le trajet pendant qu'on le pilote. `apprendre_fin` : enregistre le "
        "circuit. `demarrer` / `arreter` : rejouer en boucle. `oublier` : effacer. `etat` : demander l'état. "
        "Le robot répond toujours par `robot_ronde_status`.",
        emis=modele("RobotRondeEmis", {"code": "1234", "action": "demarrer"}, code=CODE,
                    action=(Literal["apprendre_debut", "apprendre_fin", "demarrer", "arreter", "oublier", "etat"],
                            "Action.")),
        emis_par=A_PILOTE,
        recu=modele("RobotRondeRecu", {"action": "demarrer"}, action=(str, "Action.")),
        recu_par=A_ROBOT, pilote=True,
    ),
    Evenement("robot_ronde_status", T_NAV, "État de la ronde", "Le robot envoie aussi `code` ; il est retiré au relais.",
              emis=RobotRondeStatusEmis,
              emis_par=A_ROBOT, recu=EtatRonde, recu_par=A_APPS),

    Evenement(
        "robot_alerte", T_ALERTES, "Alerte du mode absent",
        "Accepté uniquement d'un robot appairé à ce salon. Le serveur enregistre la photo, la fait décrire par "
        "Claude (personne / animal / rien), prévient par Telegram, garde l'alerte dans l'historique "
        "(`GET /alertes`), envoie une notification (avec un délai minimum par catégorie) et appelle si une personne "
        "est vue.",
        emis=modele("RobotAlerteEmis", {"code": "1234", "type": "presence", "niveau": 3, "photo": "/9j/4AAQ…",
                                        "capteurs": ["radar"]},
                    code=CODE, type=(Literal["bruit", "mouvement", "presence"], "Ce que le capteur a senti."),
                    niveau=(Optional[float], "Intensité.", OPT),
                    photo=(Optional[str], "Photo JPEG en base64.", OPT),
                    capteurs=(Optional[list[str]], "Capteurs déclenchés.", OPT)),
        emis_par=A_ROBOT,
        recu=modele("RobotAlerteRecu", {"type": "presence", "niveau": 3, "photo": True},
                    type=(str, "Type."), niveau=(Optional[float], "Intensité.", OPT),
                    photo=(bool, "Une photo est disponible via GET /alerte-photo.")),
        recu_par=A_APPS, robot_seulement=True,
    ),
    Evenement("robot_alarme", T_ALERTES, "Déclencher l'alarme", "",
              emis=modele("RobotAlarmeEmis", {"code": "1234", "on": True, "texte": "Sortez !"}, code=CODE, on=ON,
                          texte=(Optional[str], "Texte à annoncer.", OPT)),
              emis_par=A_PILOTE,
              recu=modele("RobotAlarmeRecu", {"on": True, "texte": "Sortez !"}, on=ON,
                          texte=(Optional[str], "Texte.", OPT)),
              recu_par=A_ROBOT, pilote=True),
    Evenement("robot_alarme_status", T_ALERTES, "État de l'alarme", "",
              emis=modele("RobotAlarmeStatusEmis", {"code": "1234", "on": False}, code=CODE, on=ON), emis_par=A_ROBOT,
              recu=modele("RobotAlarmeStatusRecu", {"on": False}, on=ON), recu_par=A_APPS),
    Evenement(
        "alerte_appel", T_ALERTES, "Activer / couper les appels d'alerte",
        "Réservé au pilote, pour SON salon (le code du message est ignoré). Couper les appels ne coupe pas les "
        "notifications. Le salon reçoit `alerte_appel_etat`.",
        emis=modele("AlerteAppel", {"actif": False}, actif=(bool, "Appels actifs.")),
        emis_par=A_PILOTE, pilote=True,
    ),
    Evenement("alerte_appel_etat", T_ALERTES, "État des appels d'alerte",
              "Émis par l'app pour demander l'état ; la réponse revient à elle seule.",
              emis=modele("AlerteAppelEtatEmis", {"code": "1234"}, code=CODE), emis_par=A_APP,
              recu=EtatAppel, recu_par=A_APP),

    Evenement(
        "robot_record", T_REC, "Enregistrer la vidéo sur le VPS",
        "Le serveur recopie le flux de MediaMTX dans un mp4 (sans réencodage, 15 min max). Les vidéos se listent "
        "avec `GET /enregistrements`. Le salon reçoit `robot_record_status`.",
        emis=modele("RobotRecord", {"code": "1234", "on": True}, code=CODE, on=ON),
        emis_par=A_PILOTE, pilote=True,
    ),
    Evenement("robot_record_query", T_REC, "Demander l'état de l'enregistrement", "Réponse : `robot_record_status`.",
              emis=modele("RobotRecordQuery", {"code": "1234"}, code=CODE), emis_par=A_APP),
    Evenement("robot_record_status", T_REC, "État de l'enregistrement VPS", "",
              recu=EtatEnregistrement, recu_par=A_SALON),
    Evenement("robot_record_hd", T_REC, "Enregistrer en HD sur le robot", "Le fichier reste sur la carte SD du robot.",
              emis=modele("RobotRecordHdEmis", {"code": "1234", "on": True}, code=CODE, on=ON), emis_par=A_PILOTE,
              recu=modele("RobotRecordHdRecu", {"on": True}, on=ON), recu_par=A_ROBOT, pilote=True),
    Evenement("robot_record_hd_status", T_REC, "État de l'enregistrement HD", "Relayé tel quel, `code` compris.",
              emis=modele("RobotRecordHdStatus", {"code": "1234", "actif": True, "fichier": "hd-1.mp4", "secondes": 12},
                          code=CODE, actif=(bool, "En cours."), fichier=(Optional[str], "Fichier.", OPT),
                          secondes=(int, "Durée."), erreur=(Optional[str], "Erreur.", OPT)),
              emis_par=A_ROBOT, recu_par=A_APPS),

    Evenement(
        "voice_ask", T_VOIX, "Question vocale (« Hey Solana »)",
        "Le robot envoie l'audio enregistré après le mot-clé. Le serveur transcrit (Deepgram ou whisper), traite "
        "localement les commandes simples ou demande à Claude, exécute les outils (pilotage, navigation, caméra, "
        "ronde, suivi…) en émettant les événements habituels vers le robot, puis renvoie le texte à prononcer.",
        emis=modele("VoiceAsk", {"code": "1234", "audio": "<binaire>"}, code=CODE,
                    audio=(bytes, "Audio WAV."), frame=(Optional[bytes], "Image JPEG du moment.", OPT)),
        emis_par=A_ROBOT,
        ack=modele("VoiceAskReponse", {"text": "J'avance.", "heard": "avance", "local": True},
                   text=(Optional[str], "Phrase à prononcer.", OPT), heard=(Optional[str], "Transcription.", OPT),
                   local=(Optional[bool], "Traité sans Claude.", OPT), error=(Optional[str], "Erreur.", OPT)),
        ack_description="Réponse à prononcer, ou `error`.",
    ),
    Evenement(
        "vision_obstacle", T_VOIX, "La voie est-elle libre ?",
        "Pendant la navigation GPS, le robot envoie une image ; Claude estime la distance de l'obstacle. "
        "Accusé `null` sans clé Claude ou sans image.",
        emis=modele("VisionObstacle", {"code": "1234", "frame": "<binaire>", "nav": {"distanceM": 40, "capRelatif": -20}},
                    code=CODE, frame=JPEG,
                    nav=(Optional[dict], "Contexte de navigation : distanceM, capRelatif.", OPT)),
        emis_par=A_ROBOT,
        ack=modele("VisionObstacleReponse", {"libre": False, "distanceCm": 300, "coteLibre": "gauche"},
                   libre=(bool, "La voie est libre."), distanceCm=(int, "Distance estimée de l'obstacle."),
                   coteLibre=(Optional[str], "Côté par où passer.", OPT)),
        ack_description="Estimation, ou `null`.",
    ),

    Evenement("robot_rt", T_RT, "Activer / couper la conversation en direct",
              "Le robot ouvre ou ferme alors sa session avec `rt_start` / `rt_stop`. L'arrêt d'urgence envoie aussi "
              "`on: false`.",
              emis=modele("RobotRtEmis", {"code": "1234", "on": True}, code=CODE, on=ON), emis_par=A_PILOTE,
              recu=modele("RobotRtRecu", {"on": True}, on=ON), recu_par=A_ROBOT, pilote=True),
    Evenement("rt_start", T_RT, "Ouvrir la conversation en direct",
              "Ouvre la session OpenAI Realtime ; sans clé, le salon reçoit `rt_etat` avec `erreur`.",
              emis=modele("RtStart", {"code": "1234"}, code=CODE), emis_par=A_ROBOT),
    Evenement("rt_stop", T_RT, "Fermer la conversation", "Aussi fermée si plus personne n'est dans le salon.",
              emis=modele("RtStop", {"code": "1234"}, code=CODE), emis_par=A_ROBOT),
    Evenement("rt_audio", T_RT, "Morceau de micro", "PCM 16 bits mono 24 kHz, relayé à OpenAI.",
              emis=modele("RtAudio", {"code": "1234", "pcm": "<binaire>"}, code=CODE, pcm=(bytes, "PCM16 24 kHz.")),
              emis_par=A_ROBOT),
    Evenement("rt_frame", T_RT, "Image pour l'outil « regarder »", "Le serveur garde la dernière.",
              emis=modele("RtFrame", {"code": "1234", "frame": "<binaire>"}, code=CODE, frame=JPEG),
              emis_par=A_ROBOT),
    Evenement("rt_interrompre", T_RT, "On coupe la parole au robot", "Annule la réponse en cours côté OpenAI.",
              emis=modele("RtInterrompre", {"code": "1234"}, code=CODE), emis_par=A_ROBOT),
    Evenement("rt_veille_etat", T_RT, "Demander l'état de veille", "Réponse `rt_veille` à l'émetteur seul.",
              emis=modele("RtVeilleEtat", {"code": "1234"}, code=CODE), emis_par=A_TOUS),
    Evenement("rt_audio_out", T_RT, "Audio de réponse à jouer", "",
              recu=modele("RtAudioOut", {"pcm": "<binaire>"}, pcm=(bytes, "PCM16 24 kHz.")), recu_par=A_ROBOT),
    Evenement("rt_couper", T_RT, "Arrêter la lecture tout de suite", "L'utilisateur a repris la parole.",
              recu=Vide, recu_par=A_ROBOT),
    Evenement("rt_etat", T_RT, "État de la session", "",
              recu=modele("RtEtat", {"actif": True}, actif=(Optional[bool], "Session ouverte.", OPT),
                          finReponse=(Optional[bool], "Fin d'une réponse.", OPT),
                          erreur=(Optional[str], "Raison de l'échec.", OPT)),
              recu_par=A_SALON),
    Evenement("rt_entendu", T_RT, "Ce que l'assistant a compris", "",
              recu=modele("RtEntendu", {"texte": "quelle heure est-il"}, texte=(str, "Transcription.")),
              recu_par=A_SALON),
    Evenement("rt_veille", T_RT, "État de veille", "", recu=EtatVeille, recu_par=A_SALON),

    Evenement(
        "sonar_scan_status", T_SONAR, "Get scan status",
        "Returns the active scan status and optionally a live map preview.",
        emis=SonarScanStatusRequest, emis_par=A_APP,
        ack=SonarScanStatus, ack_description="Recording status or an error.",
    ),
    Evenement(
        "sonar_scan_start", T_SONAR, "Start a scan",
        "Records incoming sonar rows in the pilot's pairing room. Returns the existing scan if one is active.",
        emis=Vide, emis_par=A_PILOTE, pilote=True,
        ack=SonarScanStatus, ack_description="Recording status or an error.",
    ),
    Evenement(
        "sonar_scan_save", T_SONAR, "Save a scan",
        "Stops recording and builds the occupancy map from the session CSV.",
        emis=SonarScanSession,
        emis_par=A_PILOTE, pilote=True,
        ack=SonarScanResult, ack_description="Saved scan and occupancy map, or an error.",
    ),
    Evenement(
        "sonar_scan_list", T_SONAR, "List saved scans",
        "Lists saved scans in the pilot or admitted spectator's pairing room, newest first.",
        emis=Vide, emis_par=A_APP,
        ack=SonarScanHistory, ack_description="Saved scans or an error.",
    ),
    Evenement(
        "sonar_scan_open", T_SONAR, "Open a saved scan",
        "Returns the saved map for a scan in the pilot or admitted spectator's pairing room.",
        emis=SonarScanSession, emis_par=A_APP,
        ack=SonarScanResult, ack_description="Saved scan and occupancy map, or an error.",
    ),
    Evenement(
        "sonar_map_request", T_SONAR, "Demander la dernière carte sonar",
        "Seulement dans le salon `SONAR_MAP_ROOM` configuré sur le serveur, pour le pilote ou un spectateur "
        "admis. Le serveur répond par `sonar_map_snapshot` si une carte est disponible. Le contenu envoyé est "
        "ignoré.",
        emis=Vide, emis_par=A_APP,
    ),
    Evenement(
        "sonar_map_snapshot", T_SONAR, "Carte sonar",
        "Image de la carte d'occupation produite par `map_sonar.py` (fichier `SONAR_SNAPSHOT_FILE`, relu toutes "
        "les 0,5 s). Envoyée à chaque nouvelle carte au pilote et aux spectateurs du salon `SONAR_MAP_ROOM`, ou "
        "en réponse à `sonar_map_request`. Noir = occupé, blanc = libre, gris = inconnu.",
        recu=modele(
            "SonarMapSnapshot",
            {"image": {"format": "png", "data": "iVBORw0KGgo…"}, "readingCount": 48, "totalReadings": 360,
             "resolutionM": 0.05, "updatedAt": 1795268581450, "code": "sonar-demo"},
            image=(dict, "`format` (`png` ou `svg`) et `data` (PNG en base64, ou texte SVG)."),
            readingCount=(int, "Mesures prises en compte dans cette image."),
            totalReadings=(int, "Mesures disponibles au total."),
            resolutionM=(float, "Taille d'un pixel, en mètres."),
            updatedAt=(int, "Heure de calcul (ms)."),
            code=CODE,
        ),
        recu_par="app (pilote et spectateurs)",
    ),
]


def _schema(modele_: type[BaseModel], composants: dict) -> dict:
    s = modele_.model_json_schema(ref_template="#/components/schemas/{model}", by_alias=True)
    for nom, d in s.pop("$defs", {}).items():
        composants.setdefault(nom, d)
    composants.setdefault(modele_.__name__, s)
    return {"$ref": f"#/components/schemas/{modele_.__name__}"}


def _contenu(modele_: type[BaseModel], composants: dict) -> dict:
    return {"application/json": {"schema": _schema(modele_, composants)}}


def operations(composants: dict) -> dict:
    chemins: dict[str, dict] = {}
    for e in EVENEMENTS:
        chemin = f"{PREFIXE}/{e.nom}"
        item = chemins.setdefault(chemin, {})
        regles = []
        if e.pilote:
            regles.append("🔒 Réservé au **pilote**, pour son propre salon (sinon `acces_refuse_commande`).")
        if e.robot_seulement:
            regles.append("🤖 Accepté uniquement d'un **robot** appairé à ce salon.")
        regles_md = ("\n\n" + "\n\n".join(regles)) if regles else ""
        if e.emis is not None:
            dest = f"\n\n**Reçu ensuite par :** {e.recu_par} (voir GET)." if e.recu is not None or e.recu_par else ""
            reponse_ack: dict = {"description": e.ack_description}
            if e.ack is not None:
                reponse_ack["content"] = _contenu(e.ack, composants)
            item["post"] = {
                "tags": [e.theme],
                "summary": f"{e.resume} — émis par {e.emis_par}",
                "description": (f"`socket.emit('{e.nom}', données{', accusé' if e.ack is not None else ''})`\n\n"
                                f"{e.description}{regles_md}{dest}"),
                "operationId": f"socket_emit_{e.nom}",
                "requestBody": {"required": True, "content": _contenu(e.emis, composants)},
                "responses": {"200": reponse_ack},
            }
        recu = e.recu if e.recu is not None else (e.emis if e.recu_par and e.emis is not None else None)
        if recu is not None:
            if e.sans_corps_recu:
                corps = {"description": "Événement **sans contenu**."}
            else:
                corps = {"description": f"Données reçues par {e.recu_par}.", "content": _contenu(recu, composants)}
            accuse = ""
            if e.nom == "robot_grab_frame":
                accuse = "\n\n**Le destinataire doit répondre par l'accusé de réception** (JPEG binaire ou null)."
            item["get"] = {
                "tags": [e.theme],
                "summary": f"{e.resume} — reçu par {e.recu_par}",
                "description": f"`socket.on('{e.nom}', (données) => …)`\n\n{e.description}{accuse}",
                "operationId": f"socket_on_{e.nom}",
                "responses": {"200": corps},
            }
    return chemins


INTRODUCTION = """
Serveur qui relie l'app Ping (téléphone) et le robot (Raspberry Pi).

## Deux façons de lui parler

* **HTTP** : les routes classiques ci-dessous (historique des alertes, enregistrements, proxy WebRTC…).
* **Socket.IO** (client `socket.io-client` v4) : l'essentiel des échanges. Les entrées **⚡ Socket** de cette page
  documentent chaque événement ; ce ne sont **pas** des routes HTTP et « Try it out » ne s'y applique pas.
  * **POST** `/socket/<événement>` = ce que tu **émets** : `socket.emit('<événement>', données, accusé?)`.
    Le corps de la requête est le contenu à envoyer ; la réponse 200 décrit l'accusé de réception.
  * **GET** `/socket/<événement>` = ce que tu **reçois** : `socket.on('<événement>', (données) => …)`.

## Se connecter

```js
import { io } from 'socket.io-client';
const socket = io('https://api.ping-app.org', { path: '/ping/socket.io' }); // derrière nginx
// en local : io('http://localhost:3002')
socket.emit('pair', { pseudo: 'Andy', code: '1234' });            // app
socket.emit('pair', { pseudo: 'Robot', code: '1234', robot: true, cle: '<ROBOT_KEY>' }); // robot
```

Autres connexions WebSocket (hors Socket.IO) : `/ws/capteur`, par laquelle le robot envoie les lignes du capteur (protocole ci-dessous), et `/twilio-flux`, réservée aux appels Twilio.

Tout passe par un **salon** identifié par son `code`. Le premier humain arrivé est **pilote** : lui seul envoie les
commandes marquées 🔒. Les champs binaires (`jpeg`, `frame`, `audio`, `pcm`) voyagent en binaire Socket.IO
(Buffer / ArrayBuffer).
"""
