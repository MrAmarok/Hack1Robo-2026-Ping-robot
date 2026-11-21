from __future__ import annotations

import asyncio
import os
import signal
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.core.config import env, env_int
from app.core.logs import log, now_ms
from app.core.sio import emit_room, on, payload, tache
from app.core.state import refuse_si_pas_pilote

DOSSIER = env("REC_DIR") or env("REC_DOSSIER") or "/root/enregistrements"
RTSP = env("REC_RTSP", "rtsp://127.0.0.1:3002")
DUREE_MAX_MS = env_int("REC_MAX_MS", 15 * 60 * 1000)


@dataclass
class _Session:
    proc: asyncio.subprocess.Process
    fichier: str
    debut: int
    minuteur: asyncio.TimerHandle | None = None
    err: str = ""
    taches: list = field(default_factory=list)


en_cours: dict[str, _Session] = {}


def horodatage() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


async def etat(code: str, **extra) -> None:
    s = en_cours.get(code)
    await emit_room(code, "robot_record_status", {
        "actif": bool(s),
        "fichier": os.path.basename(s.fichier) if s else None,
        "secondes": round((now_ms() - s.debut) / 1000) if s else 0,
        **extra,
    })


async def _lire_erreurs(code: str, s: _Session) -> None:
    assert s.proc.stderr is not None
    while True:
        ligne = await s.proc.stderr.readline()
        if not ligne:
            return
        t = ligne.decode("utf8", "replace").strip()[:200]
        if t:
            s.err = t
            log(f"[REC] code={code} ffmpeg: {t}")


async def _attendre_fin(code: str, s: _Session) -> None:
    sortie = await s.proc.wait()
    if en_cours.get(code) is not s:
        return
    if s.minuteur:
        s.minuteur.cancel()
    en_cours.pop(code, None)
    try:
        taille = os.path.getsize(s.fichier)
    except OSError:
        taille = 0
    secondes = round((now_ms() - s.debut) / 1000)
    log(
        f"[REC] code={code} termine : {os.path.basename(s.fichier)} "
        f"({secondes}s, {taille / 1048576:.1f} Mo, code={sortie})"
    )
    if taille < 1024:
        try:
            os.unlink(s.fichier)
        except OSError:
            pass
        if s.err:
            raison = f"Flux illisible : {s.err[:140]}"
        elif secondes < 3:
            raison = (f"Enregistrement trop court ({secondes}s) : il faut quelques "
                      "secondes avant la premiere image complete.")
        else:
            raison = "Aucun flux : allume la camera avant d enregistrer."
        log(f"[REC] code={code} echec : {raison}")
        await etat(code, erreur=raison)
    else:
        await etat(code, termine=os.path.basename(s.fichier), mo=round(taille / 1048576, 1))


async def demarrer(code: str) -> None:
    if en_cours.get(code):
        return
    fichier = str(Path(DOSSIER) / f"robot-{code}-{horodatage()}.mp4")
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-loglevel", "error",
            "-rtsp_transport", "tcp",
            "-i", f"{RTSP}/robot-{code}",
            "-c", "copy",
            "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
            "-f", "mp4", fichier,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as e:
        log(f"[REC] code={code} ffmpeg introuvable : {e}")
        return

    s = _Session(proc=proc, fichier=fichier, debut=now_ms())
    en_cours[code] = s
    s.taches = [tache(_lire_erreurs(code, s)), tache(_attendre_fin(code, s))]

    def _duree_max():
        log(f"[REC] code={code} duree maximale atteinte -> arret.")
        arreter(code)

    s.minuteur = asyncio.get_running_loop().call_later(DUREE_MAX_MS / 1000, _duree_max)
    log(f"[REC] code={code} enregistrement demarre -> {os.path.basename(fichier)}")
    await etat(code)


def arreter(code: str) -> None:
    s = en_cours.get(code)
    if not s:
        return
    if s.minuteur:
        s.minuteur.cancel()
    try:
        s.proc.send_signal(signal.SIGINT)
    except ProcessLookupError:
        return

    def _tuer():
        if s.proc.returncode is None:
            try:
                s.proc.kill()
            except ProcessLookupError:
                pass

    asyncio.get_running_loop().call_later(4, _tuer)


@on("robot_record")
async def _robot_record(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_record"):
        return
    p = payload(data)
    code = p.get("code")
    if not code:
        return
    if p.get("on"):
        await demarrer(str(code))
    else:
        arreter(str(code))


@on("robot_record_query")
async def _robot_record_query(sid, data):
    p = payload(data)
    if p.get("code"):
        await etat(str(p["code"]))


def attach_enregistrement() -> None:
    try:
        Path(DOSSIER).mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log(f"[REC] dossier {DOSSIER} inaccessible : {e}")
    log(f"[REC] Enregistrement video pret (dossier {DOSSIER}, max {round(DUREE_MAX_MS / 60000)} min).")
