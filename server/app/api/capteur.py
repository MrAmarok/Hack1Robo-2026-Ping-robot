from __future__ import annotations

import asyncio
import re
import time

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

from app.api.doc_capteur import DOC
from app.core.logs import log
from app.core.state import cle_robot_valide
from app.services import capteur, sonar_scans

router = APIRouter()
_PAS_CODE = re.compile(r"[^A-Za-z0-9_-]")
MAX_ERREURS = 5


def _code(valeur) -> str:
    return _PAS_CODE.sub("", str(valeur or ""))


@router.api_route("/ws/capteur", methods=["GET", "POST"], include_in_schema=False)
async def capteur_en_http():
    return JSONResponse({"erreur": "connexion WebSocket attendue : ws://<serveur>/ws/capteur?code=<code>"},
                        status_code=426)


@router.websocket("/ws/capteur")
async def capteur_ws(ws: WebSocket):
    await ws.accept()
    origine = f"{ws.client.host}:{ws.client.port}" if ws.client else "?"
    code = _code(ws.query_params.get("code"))
    session = ws.query_params.get("session") or None
    erreur = ("code requis" if not code
              else "cle robot invalide" if not cle_robot_valide(ws.query_params.get("cle"))
              else "session invalide ([A-Za-z0-9_-], 64 caracteres max)" if session and not capteur.id_valide(session)
              else None)
    if erreur:
        log(f"[CAPTEUR] connexion refusee depuis {origine} : {erreur}.")
        await ws.send_json({"type": "erreur", "erreur": erreur})
        await ws.close(code=1008)
        return

    session = session or capteur.nouvelle_session(code)
    total = await asyncio.to_thread(capteur.compter, code, session)
    debut = time.monotonic()
    recues_connexion = 0
    stats = {"messages": 0, "lignes": 0, "refusees": 0, "total": total}
    log(f"[CAPTEUR] {code} : robot connecte depuis {origine}, session {session} ({total} lignes deja recues).")
    await ws.send_json({"type": "bonjour", "code": code, "session": session, "lignes": total})
    resume = asyncio.ensure_future(_resume_par_seconde(code, stats))
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            texte = message.get("text")
            if texte is None and message.get("bytes") is not None:
                texte = message["bytes"].decode("utf8", "replace")
            valides, erreurs = capteur.decouper(texte or "")
            if valides:
                try:
                    total = capteur.ajouter(code, session, valides)
                    sonar_scans.record(code, valides)
                except capteur.TropVolumineux as e:
                    log(f"[CAPTEUR] {code} : session {session} refusee ({e}), connexion fermee.")
                    await ws.send_json({"type": "erreur", "erreur": str(e)})
                    await ws.close(code=1009)
                    return
                except OSError as error:
                    log(f"[CAPTEUR] CSV write failed session={session}: {error}")
                    raise
            recues_connexion += len(valides)
            stats["messages"] += 1
            stats["lignes"] += len(valides)
            stats["refusees"] += len(erreurs)
            stats["total"] = total
            derniere = valides[-1] if valides else "-"
            log(f"[CAPTEUR] {code} : message recu, {len(valides)} ligne(s) acceptee(s), "
                f"{len(erreurs)} refusee(s), total {total} - derniere : {derniere} (session={session})")
            accuse = {"type": "ack", "recues": len(valides), "rejetees": len(erreurs), "total": total}
            if erreurs:
                accuse["erreurs"] = erreurs[:MAX_ERREURS]
                log(f"[CAPTEUR] {code} : {len(erreurs)} ligne(s) refusee(s), ex. {erreurs[0]}.")
            await ws.send_json(accuse)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        resume.cancel()
        duree = round(time.monotonic() - debut)
        log(f"[CAPTEUR] {code} : robot deconnecte (session {session}, {recues_connexion} ligne(s) recue(s) "
            f"pendant cette connexion, {total} au total, connecte {duree} s).")


async def _resume_par_seconde(code: str, stats: dict) -> None:
    while True:
        await asyncio.sleep(1)
        if not stats["messages"]:
            continue
        log(f"[CAPTEUR] {code} : resume 1 s -> {stats['messages']} message(s), {stats['lignes']} ligne(s) "
            f"acceptee(s), {stats['refusees']} refusee(s), total {stats['total']}")
        stats.update(messages=0, lignes=0, refusees=0)


@router.get("/capteur", **DOC["liste"])
async def liste(request: Request):
    code = _code(request.query_params.get("code"))
    if not code:
        return JSONResponse({"erreur": "code requis"}, status_code=400)
    return {"sessions": await asyncio.to_thread(capteur.lister, code)}


@router.get("/capteur/{session}", **DOC["telecharger"])
async def telecharger(session: str, request: Request):
    code = _code(request.query_params.get("code"))
    if not code:
        return JSONResponse({"erreur": "code requis"}, status_code=400)
    if not capteur.id_valide(session):
        return JSONResponse({"erreur": "session invalide"}, status_code=400)
    fichier = capteur.chemin(code, session)
    if not fichier.is_file():
        return JSONResponse({"erreur": "session introuvable"}, status_code=404)
    return FileResponse(fichier, media_type="text/csv", filename=f"{session}.csv")
