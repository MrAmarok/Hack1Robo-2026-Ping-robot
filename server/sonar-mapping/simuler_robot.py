from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import os
import random
import sys
import time
from collections import deque
from dataclasses import dataclass
from itertools import islice
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urlunsplit

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

try:
    import socketio
except ImportError:
    socketio = None


@dataclass(frozen=True)
class Rect:
    nom: str
    x0: float
    y0: float
    x1: float
    y1: float

    def segments(self):
        coins = [(self.x0, self.y0), (self.x1, self.y0), (self.x1, self.y1), (self.x0, self.y1)]
        return [(*coins[i], *coins[(i + 1) % 4]) for i in range(4)]


ICI = Path(__file__).resolve().parent
SORTIES = ICI / ".simulation.ignore"

PIECE = Rect("piece", 0.0, 0.0, 5.0, 4.0)
OBSTACLES = [
    Rect("canape", 0.3, 3.2, 2.1, 3.7),
    Rect("table", 2.8, 1.8, 3.8, 2.6),
    Rect("carton", 1.3, 1.0, 1.7, 1.4),
]
SEGMENTS = [s for r in (PIECE, *OBSTACLES) for s in r.segments()]
PARCOURS = [(0.6, 0.5), (4.4, 0.5), (4.4, 3.4), (2.5, 3.0), (2.4, 1.6), (0.6, 2.6), (0.6, 0.5)]

RAYON_ROBOT = 0.15
PORTEE_MIN_CM, PORTEE_MAX_CM = 2.0, 400.0
VITESSE_MAX = 0.35
ROTATION_MAX = 90.0
ROTATION_SCAN = 60.0
BALAYAGE = [-45, -30, -15, 0, 15, 30, 45]

DT = 0.1
PERIODE_ENVOI = 0.2
MAX_LOT = 500
DELAI_ACK = 10.0
INACTIVITE_DRIVE = 1.0


def log(*parts) -> None:
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


def lancer_rayon(x: float, y: float, angle: float) -> tuple[float, float] | None:
    dx, dy = math.cos(angle), math.sin(angle)
    meilleur = None
    for ax, ay, bx, by in SEGMENTS:
        ex, ey = bx - ax, by - ay
        den = dx * ey - dy * ex
        if abs(den) < 1e-12:
            continue
        wx, wy = ax - x, ay - y
        t = (wx * ey - wy * ex) / den
        u = (wx * dy - wy * dx) / den
        if t > 1e-9 and 0.0 <= u <= 1.0 and (meilleur is None or t < meilleur[0]):
            cos_incidence = abs(den) / math.hypot(ex, ey)
            meilleur = (t, math.acos(min(1.0, cos_incidence)))
    return meilleur


def position_libre(x: float, y: float) -> bool:
    if not (PIECE.x0 + RAYON_ROBOT <= x <= PIECE.x1 - RAYON_ROBOT
            and PIECE.y0 + RAYON_ROBOT <= y <= PIECE.y1 - RAYON_ROBOT):
        return False
    for o in OBSTACLES:
        px, py = min(max(x, o.x0), o.x1), min(max(y, o.y0), o.y1)
        if math.hypot(x - px, y - py) < RAYON_ROBOT:
            return False
    return True


class Sonar:
    def __init__(self, rng: random.Random, bruit: bool):
        self.rng, self.bruit = rng, bruit

    def mesurer(self, x: float, y: float, angle_deg: float) -> float | None:
        impact = lancer_rayon(x, y, math.radians(angle_deg))
        if impact is None:
            return None
        distance, incidence = impact[0] * 100, impact[1]
        if self.bruit:
            if self.rng.random() < 0.02:
                return None
            if incidence > math.radians(55) and self.rng.random() < 0.6:
                return None
            distance += self.rng.gauss(0, 0.5 + 0.01 * distance)
        if distance > PORTEE_MAX_CM:
            return None
        return max(PORTEE_MIN_CM, distance)


class Robot:
    def __init__(self, sonar: Sonar):
        self.x, self.y = PARCOURS[0]
        self.cap = 0.0
        self.servo = 0
        self._balayage = 3
        self._sens = 1
        self.sonar = sonar
        self.derniere_distance: float | None = None
        self.mode = "auto"
        self.vitesse_pwm = 180
        self.lineaire = 0.0
        self.angulaire = 0.0
        self.dernier_ordre = 0.0
        self.bloque = False

    def avancer_servo(self) -> None:
        if not 0 <= self._balayage + self._sens < len(BALAYAGE):
            self._sens = -self._sens
        self._balayage += self._sens
        self.servo = BALAYAGE[self._balayage]

    def mesure(self) -> str:
        distance = self.sonar.mesurer(self.x, self.y, self.cap + self.servo)
        if self.servo == 0:
            self.derniere_distance = distance
        texte = "" if distance is None else f"{distance:.1f}"
        return f"{self.x:.3f},{self.y:.3f},{self.cap % 360:.1f},{self.servo},{texte}"

    def deplacer(self, distance: float) -> bool:
        nx = self.x + distance * math.cos(math.radians(self.cap))
        ny = self.y + distance * math.sin(math.radians(self.cap))
        if not position_libre(nx, ny):
            return False
        self.x, self.y = nx, ny
        return True

    def ordre(self, cmd: str) -> bool:
        self.dernier_ordre = time.monotonic()
        if cmd == "S":
            self.lineaire = self.angulaire = 0.0
        elif cmd in "FB" and len(cmd) == 1:
            self.lineaire, self.angulaire = (1.0 if cmd == "F" else -1.0), 0.0
        elif cmd in "LR" and len(cmd) == 1:
            self.lineaire, self.angulaire = 0.0, (1.0 if cmd == "L" else -1.0)
        elif cmd in ("+", "-"):
            self.vitesse_pwm = max(0, min(255, self.vitesse_pwm + (25 if cmd == "+" else -25)))
        elif cmd.startswith("V") and cmd[1:].isdigit():
            self.vitesse_pwm = max(0, min(255, int(cmd[1:])))
        elif cmd.startswith("M") and "," in cmd:
            try:
                gauche, droite = (max(-255, min(255, int(v))) / 255 for v in cmd[1:].split(","))
            except ValueError:
                return False
            self.lineaire, self.angulaire = (gauche + droite) / 2, (droite - gauche) / 2
        else:
            return False
        if self.mode == "auto" and (self.lineaire or self.angulaire):
            log("Pilote : ordre recu, le robot passe en pilotage manuel.")
            self.mode = "pilote"
        return True

    def pas_manuel(self, dt: float) -> None:
        if time.monotonic() - self.dernier_ordre > INACTIVITE_DRIVE:
            self.lineaire = self.angulaire = 0.0
        echelle = self.vitesse_pwm / 255
        self.cap = (self.cap + self.angulaire * ROTATION_MAX * echelle * dt) % 360
        if self.lineaire:
            bloque = not self.deplacer(self.lineaire * VITESSE_MAX * echelle * dt)
            if bloque and not self.bloque:
                log(f"Pilote : obstacle, le robot est bloque en ({self.x:.2f}, {self.y:.2f}).")
            self.bloque = bloque
        self.avancer_servo()

    def statut(self) -> dict:
        return {
            "fix": False,
            "coords": None,
            "gpsAgeMs": None,
            "heading": round(self.cap % 360, 1),
            "speedKnots": None,
            "obstacleCm": None if self.derniere_distance is None else round(self.derniere_distance),
            "modeAbsent": False,
            "arduinoConnected": True,
            "navActive": self.mode == "auto",
            "sharing": False,
        }


def parcours_auto(robot: Robot, dt: float, vitesse: float):
    def tour_complet():
        robot.servo = 0
        depart = robot.cap
        pas = ROTATION_SCAN * dt
        for i in range(round(360 / pas)):
            robot.cap = (depart + i * pas) % 360
            yield
        robot.cap = depart

    def tourner_vers(cible: float):
        robot.servo = 0
        pas = ROTATION_MAX * dt
        while True:
            ecart = (cible - robot.cap + 180) % 360 - 180
            if abs(ecart) <= pas:
                robot.cap = cible % 360
                return
            robot.cap = (robot.cap + math.copysign(pas, ecart)) % 360
            yield

    def aller_a(cx: float, cy: float):
        while True:
            reste = math.hypot(cx - robot.x, cy - robot.y)
            robot.avancer_servo()
            if reste <= vitesse * dt:
                robot.x, robot.y = cx, cy
                yield
                return
            if not robot.deplacer(vitesse * dt):
                log(f"Auto : chemin bloque vers ({cx}, {cy}), etape suivante.")
                return
            yield

    yield from tour_complet()
    for n, (cx, cy) in enumerate(PARCOURS[1:], start=2):
        log(f"Auto : etape {n}/{len(PARCOURS)} -> ({cx}, {cy})")
        yield from tourner_vers(math.degrees(math.atan2(cy - robot.y, cx - robot.x)))
        yield from aller_a(cx, cy)
        yield from tour_complet()


class ErreurFatale(Exception):
    pass


class EnvoiCapteur:
    def __init__(self, base_url: str, code: str, session: str | None, cle: str | None):
        self.base_url, self.code, self.session, self.cle = base_url, code, session, cle
        self.file: deque[str] = deque()
        self.envoyees = self.acceptees = self.refusees = 0
        self.connecte = False
        self.total_serveur = 0

    def envoyer(self, ligne: str) -> None:
        self.file.append(ligne)
        self.envoyees += 1

    def url(self) -> str:
        parts = urlsplit(self.base_url)
        schema = {"https": "wss", "http": "ws"}.get(parts.scheme, parts.scheme)
        params = {"code": self.code}
        if self.session:
            params["session"] = self.session
        if self.cle:
            params["cle"] = self.cle
        chemin = parts.path.rstrip("/") + "/ws/capteur"
        return urlunsplit((schema, parts.netloc, chemin, urlencode(params), ""))

    async def tourner(self, fini: asyncio.Event) -> None:
        delai = 1.0
        while not (fini.is_set() and not self.file):
            try:
                async with connect(self.url(), open_timeout=5, max_size=None) as ws:
                    bonjour = json.loads(await asyncio.wait_for(ws.recv(), DELAI_ACK))
                    if bonjour.get("type") == "erreur":
                        raise ErreurFatale(bonjour.get("erreur"))
                    self.session = bonjour.get("session")
                    self.total_serveur = bonjour.get("lignes", 0)
                    self.connecte, delai = True, 1.0
                    log(f"Capteur : connecte a {self.url()} (session {self.session}, "
                        f"{self.total_serveur} lignes deja sur le serveur).")
                    await self._boucle(ws, fini)
                    return
            except ErreurFatale:
                raise
            except (OSError, ConnectionClosed, InvalidStatus, asyncio.TimeoutError) as erreur:
                if self.connecte:
                    log(f"Capteur : connexion perdue ({erreur}), {len(self.file)} ligne(s) en attente.")
                else:
                    log(f"Capteur : serveur injoignable ({erreur}), nouvel essai dans {delai:.0f} s.")
                self.connecte = False
                await asyncio.sleep(delai)
                delai = min(10.0, delai * 2)

    async def _boucle(self, ws, fini: asyncio.Event) -> None:
        while True:
            if not self.file:
                if fini.is_set():
                    return
                await asyncio.sleep(PERIODE_ENVOI)
                continue
            lot = list(islice(self.file, MAX_LOT))
            await ws.send("\n".join(lot))
            reponse = json.loads(await asyncio.wait_for(ws.recv(), DELAI_ACK))
            if reponse.get("type") == "erreur":
                raise ErreurFatale(reponse.get("erreur"))
            for _ in lot:
                self.file.popleft()
            self.acceptees += reponse.get("recues", 0)
            self.refusees += reponse.get("rejetees", 0)
            self.total_serveur = reponse.get("total", self.total_serveur)
            if reponse.get("erreurs"):
                log(f"Capteur : {reponse['rejetees']} ligne(s) refusee(s) : {reponse['erreurs']}")
            await asyncio.sleep(PERIODE_ENVOI)


def brancher_socketio(code: str, pseudo: str, cle: str | None, robot: Robot):
    if socketio is None:
        log("Socket.IO : python-socketio absent (uv sync), le robot n'apparaitra pas dans l'app.")
        return None
    sio = socketio.AsyncClient(reconnection=True, reconnection_delay=1, reconnection_delay_max=5)

    async def statut():
        await sio.emit("robot_status", {"code": code, "status": robot.statut()})

    @sio.event
    async def connect():
        appairage = {"pseudo": pseudo, "code": code, "robot": True}
        if cle:
            appairage["cle"] = cle
        await sio.emit("pair", appairage)
        log(f"Socket.IO : connecte, appairage envoye (salon {code}, pseudo {pseudo}).")
        await asyncio.sleep(0.5)
        await statut()

    @sio.event
    async def disconnect(*_):
        log("Socket.IO : deconnecte.")

    @sio.on("pair_refuse")
    async def pair_refuse(data):
        log(f"Socket.IO : appairage refuse ({(data or {}).get('raison')}). Passe --cle <ROBOT_KEY>.")

    @sio.on("user_joined")
    async def user_joined(data):
        log(f"Socket.IO : {(data or {}).get('pseudo', 'quelqu un')} a rejoint le salon.")

    @sio.on("drive")
    async def drive(data):
        cmd = str((data or {}).get("cmd") or "").strip().upper()
        ok = robot.ordre(cmd)
        return {"ok": ok, "cmd": cmd, "arduino": True} if ok else {"ok": False, "erreur": "commande inconnue"}

    @sio.on("robot_drive")
    async def robot_drive(data):
        data = data or {}
        cmd = str(data.get("cmd") or "").strip().upper()
        ok = robot.ordre(cmd)
        await sio.emit("robot_drive_status", {
            "code": code, "id": data.get("id") or f"{cmd}-{int(time.time() * 1000)}", "cmd": cmd, "ok": ok,
            "message": "Commande recue par le robot simule" if ok else "Commande inconnue",
        })
        await statut()

    @sio.on("robot_status_request")
    async def robot_status_request(_data=None):
        await statut()

    return sio


class ScanServeur:
    def __init__(self, url: str, code: str, pseudo: str):
        self.url, self.code, self.pseudo = url, code, pseudo
        self.sio = socketio.AsyncClient(reconnection=False)
        self.session: str | None = None

    async def demarrer(self) -> bool:
        role = asyncio.get_running_loop().create_future()
        sio = self.sio

        @sio.on("role_acces")
        async def role_acces(data):
            if not role.done():
                role.set_result((data or {}).get("role"))

        @sio.on("acces_demande")
        async def acces_demande(data):
            data = data or {}
            await sio.emit("acces_reponse", {"id": data.get("id"), "accepte": True})
            log(f"Scan : {data.get('pseudo', 'quelqu un')} rejoint le salon comme spectateur.")

        try:
            await sio.connect(self.url, transports=["websocket"],
                              socketio_path=urlsplit(self.url).path.rstrip("/") + "/socket.io",
                              wait_timeout=5)
            await sio.call("pair", {"pseudo": self.pseudo, "code": self.code}, timeout=10)
            obtenu = await asyncio.wait_for(role, 5)
        except Exception as erreur:
            log(f"Scan : connexion impossible ({erreur}), pas de scan.")
            await self.fermer()
            return False
        if obtenu != "pilote":
            log(f"Scan : quelqu'un est deja pilote du salon {self.code} (l'app ?), seul le pilote peut lancer "
                "un scan. Ferme l'app et relance, ou fais Start scan / Save scan depuis l'app.")
            await self.fermer()
            return False
        try:
            statut = await sio.call("sonar_scan_start", {}, timeout=10)
        except Exception as erreur:
            log(f"Scan : pas de reponse a sonar_scan_start ({erreur}).")
            await self.fermer()
            return False
        if statut.get("error") or not statut.get("session"):
            log(f"Scan : refuse par le serveur ({statut.get('error')}).")
            await self.fermer()
            return False
        self.session = statut["session"]
        log(f"Scan : demarre (scan {self.session}), chaque mesure recue part aussi dans la carte.")
        return True

    async def enregistrer(self, fichier: Path | None) -> Path | None:
        log("Scan : Save scan, le serveur calcule la carte...")
        try:
            resultat = await self.sio.call("sonar_scan_save", {"session": self.session}, timeout=120)
        except Exception as erreur:
            log(f"Scan : pas de reponse a sonar_scan_save ({erreur}).")
            return None
        if resultat.get("error") or resultat.get("mapError"):
            log(f"Scan : pas de carte ({resultat.get('error') or resultat.get('mapError')}).")
            return None
        snapshot = resultat["snapshot"]
        fichier = fichier or SORTIES / f"carte-{self.session}.png"
        fichier.parent.mkdir(parents=True, exist_ok=True)
        fichier.write_bytes(base64.b64decode(snapshot["image"]["data"]))
        log(f"Scan : carte de {snapshot['readingCount']} mesures ({snapshot['resolutionM'] * 100:g} cm/pixel) "
            f"ecrite dans {fichier.resolve()}.")
        return fichier

    async def fermer(self) -> None:
        if self.sio.connected:
            await self.sio.disconnect()


def lire_csv(fichier: Path) -> list[str]:
    lignes = [l.strip() for l in fichier.read_text(encoding="utf-8-sig").splitlines()]
    return [l for l in lignes if l and not l.replace(" ", "").startswith("x_m,")]


async def simuler(args) -> int:
    rng = random.Random(args.graine)
    robot = Robot(Sonar(rng, bruit=not args.sans_bruit))
    if args.pilote:
        robot.mode = "pilote"
    session = args.session or time.strftime("sim-%Y%m%d-%H%M%S")
    scan = None
    if args.scan:
        scan = ScanServeur(args.url, args.code, args.pseudo_scan)
        if not await scan.demarrer():
            return 1
    envoi = EnvoiCapteur(args.url, args.code, session, args.cle)
    fini = asyncio.Event()
    tache_envoi = asyncio.create_task(envoi.tourner(fini))

    sio = None if args.sans_socketio else brancher_socketio(args.code, args.pseudo, args.cle, robot)
    if sio is not None:
        try:
            await sio.connect(args.url, transports=["websocket"],
                              socketio_path=urlsplit(args.url).path.rstrip("/") + "/socket.io",
                              wait_timeout=5)
        except Exception as erreur:
            log(f"Socket.IO : connexion impossible ({erreur}), on continue sans.")
            sio = None

    if args.csv:
        a_rejouer = lire_csv(args.csv)
        log(f"Rejeu de {len(a_rejouer)} lignes de {args.csv} a {args.frequence:g} lignes/s.")
    else:
        log(f"Piece {PIECE.x1:g} m x {PIECE.y1:g} m, meubles : "
            + ", ".join(f"{o.nom} [{o.x0}-{o.x1}] x [{o.y0}-{o.y1}]" for o in OBSTACLES))
        log("Mode pilote : conduis le robot depuis l'app (Ctrl+C pour finir)." if robot.mode == "pilote"
            else f"Mode auto : tour de la piece en {len(PARCOURS)} etapes (x{args.accel:g}).")

    pas_auto = parcours_auto(robot, DT, VITESSE_MAX * 0.85)
    dernier_bilan = time.monotonic()
    try:
        if args.csv:
            periode = 1 / args.frequence
            while True:
                for ligne in a_rejouer:
                    if tache_envoi.done():
                        break
                    envoi.envoyer(ligne)
                    await asyncio.sleep(periode)
                if not args.boucle or tache_envoi.done():
                    break
        else:
            while not tache_envoi.done():
                if robot.mode == "auto":
                    try:
                        next(pas_auto)
                    except StopIteration:
                        if not args.boucle:
                            break
                        log("Auto : tour termine, on recommence.")
                        pas_auto = parcours_auto(robot, DT, VITESSE_MAX * 0.85)
                        continue
                else:
                    robot.pas_manuel(DT)
                envoi.envoyer(robot.mesure())
                if time.monotonic() - dernier_bilan >= 2:
                    dernier_bilan = time.monotonic()
                    log(f"Robot ({robot.x:.2f}, {robot.y:.2f}) cap {robot.cap % 360:5.1f} | "
                        f"{envoi.envoyees} mesures, {envoi.acceptees} acceptees, {len(envoi.file)} en attente"
                        + ("" if envoi.connecte else " (hors ligne)"))
                await asyncio.sleep(DT / args.accel)
    except asyncio.CancelledError:
        pass

    fini.set()
    if not tache_envoi.done() and envoi.file:
        log(f"Envoi des {len(envoi.file)} dernieres lignes...")
    try:
        await asyncio.wait_for(asyncio.shield(tache_envoi), timeout=15)
    except asyncio.TimeoutError:
        log(f"Serveur toujours injoignable, {len(envoi.file)} ligne(s) non envoyee(s).")
        tache_envoi.cancel()
    except ErreurFatale as erreur:
        log(f"Capteur : le serveur a refuse la connexion : {erreur}")
        if sio is not None:
            await sio.disconnect()
        if scan is not None:
            await scan.fermer()
        return 1
    if sio is not None:
        await sio.disconnect()

    log(f"Termine : {envoi.envoyees} mesures, {envoi.acceptees} acceptees, {envoi.refusees} refusees, "
        f"{envoi.total_serveur} lignes dans la session {envoi.session}.")
    if scan is not None:
        carte = await scan.enregistrer(args.carte) if envoi.acceptees else None
        await scan.fermer()
        if carte is None:
            return 1
        print(f"\n  Carte : {carte.resolve()}\n"
              "  Elle est aussi dans l'historique des scans de l'app (Indoor map).\n")
        return 0
    if not envoi.acceptees:
        return 1
    base = args.url.rstrip("/")
    dossier = os.path.relpath(SORTIES)
    print(f'\n  curl --create-dirs -o {dossier}/{envoi.session}.csv "{base}/capteur/{envoi.session}?code={args.code}"\n'
          f"  uv run --locked --script {os.path.relpath(ICI / 'map_sonar.py')} {dossier}/{envoi.session}.csv "
          f"{dossier}/carte-{envoi.session}.png\n")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Robot Ping simule : envoie des mesures sonar au serveur.")
    p.add_argument("--url", default=os.environ.get("SERVER_URL", "http://localhost:8000"),
                   help="adresse du serveur (defaut : $SERVER_URL ou http://localhost:8000)")
    p.add_argument("--code", default=os.environ.get("CODE", "1234"), help="code du salon (defaut : 1234)")
    p.add_argument("--session", help="nom de la session cote serveur (defaut : sim-AAAAMMJJ-hhmmss)")
    p.add_argument("--cle", default=os.environ.get("ROBOT_KEY") or None, help="ROBOT_KEY si configuree")
    p.add_argument("--pseudo", default="Robot simule")
    p.add_argument("--pilote", action="store_true", help="attendre les ordres de l'app au lieu du tour auto")
    p.add_argument("--boucle", action="store_true", help="recommencer le tour (ou le CSV) indefiniment")
    p.add_argument("--accel", type=float, default=1.0, help="facteur de vitesse du temps simule (mode auto)")
    p.add_argument("--csv", type=Path, help="rejouer ce fichier CSV au lieu de simuler")
    p.add_argument("--frequence", type=float, default=10.0, help="lignes par seconde avec --csv")
    p.add_argument("--sans-bruit", action="store_true", help="mesures parfaites, sans bruit ni echo perdu")
    p.add_argument("--sans-socketio", action="store_true", help="n'ouvrir que le WebSocket capteur")
    p.add_argument("--graine", type=int, help="graine aleatoire pour des mesures reproductibles")
    p.add_argument("--scan", action="store_true",
                   help="faire Start scan / Save scan comme l'app et ecrire la carte calculee par le serveur")
    p.add_argument("--carte", type=Path, help="fichier PNG de la carte avec --scan (defaut : .simulation.ignore/carte-<scan>.png)")
    p.add_argument("--pseudo-scan", default="Pilote simule", help="pseudo du pilote qui lance le scan")
    args = p.parse_args()
    if args.accel <= 0 or args.frequence <= 0:
        p.error("--accel et --frequence doivent etre positifs")
    if args.scan and socketio is None:
        p.error("--scan a besoin de python-socketio (uv sync)")
    if args.scan and args.pilote:
        p.error("--scan prend la place du pilote, l'app ne pourrait plus conduire : "
                "avec --pilote, fais Start scan / Save scan depuis l'app")
    if args.carte and not args.scan:
        p.error("--carte ne sert qu'avec --scan")
    if args.csv and not args.csv.is_file():
        p.error(f"fichier introuvable : {args.csv}")
    try:
        return asyncio.run(simuler(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
