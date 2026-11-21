from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

from app.api.doc_capteur import DOC
from app.core.logs import log
from app.core.state import cle_robot_valide
from app.services import capteur

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
    code = _code(ws.query_params.get("code"))
    session = ws.query_params.get("session") or None
    erreur = ("code requis" if not code
              else "cle robot invalide" if not cle_robot_valide(ws.query_params.get("cle"))
              else "session invalide ([A-Za-z0-9_-], 64 caracteres max)" if session and not capteur.id_valide(session)
              else None)
    if erreur:
        await ws.send_json({"type": "erreur", "erreur": erreur})
        await ws.close(code=1008)
        return

    session = session or capteur.nouvelle_session(code)
    total = await asyncio.to_thread(capteur.compter, code, session)
    log(f"[CAPTEUR] {code} : robot connecte, session {session} ({total} lignes deja recues).")
    await ws.send_json({"type": "bonjour", "code": code, "session": session, "lignes": total})
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
                except capteur.TropVolumineux as e:
                    await ws.send_json({"type": "erreur", "erreur": str(e)})
                    await ws.close(code=1009)
                    return
            accuse = {"type": "ack", "recues": len(valides), "rejetees": len(erreurs), "total": total}
            if erreurs:
                accuse["erreurs"] = erreurs[:MAX_ERREURS]
                log(f"[CAPTEUR] {code} : {len(erreurs)} ligne(s) refusee(s), ex. {erreurs[0]}.")
            await ws.send_json(accuse)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        log(f"[CAPTEUR] {code} : robot deconnecte (session {session}, {total} lignes).")


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
