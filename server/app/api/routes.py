from __future__ import annotations

import asyncio
import hmac
import os
import re
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
    StreamingResponse,
)
from starlette.background import BackgroundTask

from app.api.doc_http import DOC
from app.core import config
from app.core.config import (
    DOSSIER_ALERTES,
    MTX_HOST,
    MTX_HTTP_PORT,
    PUBLIC_URL,
    REC_DOSSIER,
)
from app.core.logs import log, now_ms, robot_log
from app.core.sio import emit_to
from app.core.state import (
    ensure_profile,
    log_room_event,
    mark_online,
    push_tokens,
    robot_du_salon,
)
from app.services.alertes import historique_alertes
from app.services.push import (
    add_persistent_token,
    get_tokens_for_room,
    is_expo_push_token,
)
from app.websocket.robot import is_drive_cmd
from app.websocket.salon import lobbies

router = APIRouter()

_PAS_CODE = re.compile(r"[^A-Za-z0-9_-]")


def _code(req: Request) -> str:
    return _PAS_CODE.sub("", str(req.query_params.get("code") or ""))


def _jeton_http_valide(req: Request) -> bool:
    if not config.ROBOT_HTTP_TOKEN:
        return False
    recu = req.headers.get("authorization", "")
    return hmac.compare_digest(recu.encode(), f"Bearer {config.ROBOT_HTTP_TOKEN}".encode())


_HOP = {"host", "content-length", "transfer-encoding", "connection", "keep-alive"}
_mtx_client: httpx.AsyncClient | None = None


def _client_mtx() -> httpx.AsyncClient:
    global _mtx_client
    if _mtx_client is None:
        _mtx_client = httpx.AsyncClient(
            base_url=f"http://{MTX_HOST}:{MTX_HTTP_PORT}", timeout=30
        )
    return _mtx_client


@router.api_route(
    "/rtc/{chemin:path}", methods=["POST"], operation_id="rtc_post", **DOC["rtc"]
)
@router.api_route(
    "/rtc/{chemin:path}", methods=["PATCH"], operation_id="rtc_patch", **DOC["rtc"]
)
@router.api_route(
    "/rtc/{chemin:path}", methods=["DELETE"], operation_id="rtc_delete", **DOC["rtc"]
)
@router.api_route(
    "/rtc/{chemin:path}",
    methods=["GET", "OPTIONS", "PUT", "HEAD"],
    include_in_schema=False,
)
async def rtc_proxy(chemin: str, request: Request):
    url = "/" + chemin + (f"?{request.url.query}" if request.url.query else "")
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP}
    headers["host"] = f"{MTX_HOST}:{MTX_HTTP_PORT}"
    client = _client_mtx()
    try:
        up_req = client.build_request(
            request.method, url, headers=headers, content=await request.body()
        )
        up = await client.send(up_req, stream=True)
    except httpx.HTTPError:
        return JSONResponse({"error": "mediamtx injoignable"}, status_code=502)
    out_headers = {k: v for k, v in up.headers.items() if k.lower() not in _HOP}
    loc = up.headers.get("location")
    if loc and not re.match(r"^https?:", loc, re.I):
        out_headers["location"] = "/rtc" + loc
    return StreamingResponse(
        up.aiter_raw(),
        status_code=up.status_code,
        headers=out_headers,
        background=BackgroundTask(up.aclose),
    )


@router.get("/alerte-photo", **DOC["alerte_photo"])
async def alerte_photo(request: Request):
    code = _code(request)
    if not code:
        return PlainTextResponse("code requis", status_code=400)
    nom = _PAS_CODE.sub("", str(request.query_params.get("f") or ""))
    fichier = nom if nom and nom.startswith(f"{code}-") else code
    chemin = Path(DOSSIER_ALERTES) / f"{fichier}.jpg"
    if not chemin.is_file():
        return PlainTextResponse("aucune photo", status_code=404)
    return FileResponse(chemin, media_type="image/jpeg")


@router.get("/alertes", **DOC["alertes"])
async def alertes(request: Request):
    code = _code(request)
    if not code:
        return JSONResponse({"erreur": "code requis"}, status_code=400)
    hist = list(reversed(historique_alertes.get(code) or []))

    def _url_photo(photo):
        if not photo:
            return None
        nom = re.sub(r"\.jpg$", "", str(photo))
        return f"{PUBLIC_URL}/alerte-photo?code={quote(code, safe='')}&f={quote(nom, safe='')}"

    return {
        "alertes": [
            {
                "ts": a.get("ts"),
                "type": a.get("type"),
                "capteurs": a.get("capteurs"),
                "categorie": a.get("categorie"),
                "phrase": a.get("phrase"),
                "notifiee": a.get("notifiee"),
                "photo": _url_photo(a.get("photo")),
            }
            for a in hist
        ]
    }


def _dossier_rec() -> str:
    return os.environ.get("REC_DOSSIER") or os.environ.get("REC_DIR") or REC_DOSSIER


@router.get("/enregistrement", **DOC["enregistrement"])
async def enregistrement(request: Request):
    nom = re.sub(r"[^A-Za-z0-9_.-]", "", str(request.query_params.get("f") or ""))
    if not nom or not nom.endswith(".mp4") or ".." in nom:
        return PlainTextResponse("nom invalide", status_code=400)
    chemin = Path(_dossier_rec()) / nom
    if not chemin.is_file():
        return PlainTextResponse("enregistrement introuvable", status_code=404)
    return FileResponse(chemin, media_type="video/mp4", filename=nom)


@router.get("/enregistrements", **DOC["enregistrements"])
async def enregistrements(request: Request):
    code = _code(request)
    if not code:
        return JSONResponse({"erreur": "code requis"}, status_code=400)
    dossier = _dossier_rec()
    try:
        noms = sorted(
            (
                f
                for f in os.listdir(dossier)
                if f.startswith(f"robot-{code}-") and f.endswith(".mp4")
            ),
            reverse=True,
        )
    except OSError:
        noms = []
    videos = []
    for f in noms:
        try:
            mo = round(os.path.getsize(os.path.join(dossier, f)) / 1048576, 1)
        except OSError:
            mo = 0
        videos.append(
            {
                "nom": f,
                "mo": mo,
                "url": f"{PUBLIC_URL}/ping/enregistrement?f={quote(f, safe='')}",
            }
        )
    return {"videos": videos}


@router.get("/ouvrir", response_class=HTMLResponse, **DOC["ouvrir"])
async def ouvrir(request: Request):
    code = quote(str(request.query_params.get("code") or ""), safe="")
    return HTMLResponse(
        f"""<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ouvrir Ping</title>
<style>
  body{{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;
       justify-content:center;gap:18px;background:#070E13;color:#E8FFF8;
       font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:24px}}
  img{{max-width:100%;border-radius:14px;border:1px solid #1F3C49}}
  a{{display:block;padding:18px 34px;border-radius:14px;background:rgba(0,229,160,.16);
    border:2px solid #00E5A0;color:#E8FFF8;font-weight:800;font-size:18px;text-decoration:none}}
  p{{color:#8FB3C2;font-size:14px;margin:0}}
</style>
<h2>Alerte a la maison</h2>
<img src="/alerte-photo?code={code}&t={now_ms()}"
     alt="" onerror="this.style.display='none'">
<a href="ping://">Ouvrir Ping</a>
<p>Si rien ne se passe, ouvre l'application manuellement.</p>
<script>setTimeout(function(){{ location.href = 'ping://'; }}, 250);</script>"""
    )


async def _corps_json(request: Request) -> dict:
    try:
        b = await request.json()
        return b if isinstance(b, dict) else {}
    except Exception:
        return {}


@router.post("/register-token", **DOC["register_token"])
async def register_token(request: Request):
    b = await _corps_json(request)
    token = b.get("token")
    if not token:
        return JSONResponse({"error": "token manquant"}, status_code=400)
    if b.get("socketId"):
        push_tokens[str(b["socketId"])] = str(token)
    code, pseudo = b.get("code"), b.get("pseudo")
    if code and pseudo:
        add_persistent_token(str(code), str(pseudo), str(token))
    log(
        f"[PUSH] jeton recu (code={code or '-'} pseudo={pseudo or '-'} "
        f"valide={str(is_expo_push_token(str(token))).lower()} total_salon={len(get_tokens_for_room(str(code or '')))})"
    )
    return {"message": "Token enregistré"}


@router.post("/lobby-heartbeat", **DOC["lobby_heartbeat"])
async def lobby_heartbeat(request: Request):
    b = await _corps_json(request)
    code, pseudo = b.get("code"), b.get("pseudo")
    if not code or not pseudo:
        return JSONResponse({"error": "code/pseudo requis"}, status_code=400)
    uid, _ = ensure_profile(code, pseudo)
    mark_online(uid)
    lobby = lobbies.get(code)
    if lobby and lobby["expiresAt"] > now_ms():
        lobby["members"].add(pseudo)
    return {"ok": True, "expiresAt": lobby["expiresAt"] if lobby else 0}


@router.post("/robot-drive", **DOC["robot_drive"])
async def robot_drive(request: Request):
    b = await _corps_json(request)
    code, de = b.get("code"), b.get("from")
    cmd = str(b.get("cmd") or "").strip().upper()
    cmd_id = str(b.get("id") or f"{cmd}-{now_ms()}")
    robot_log(
        f"[HTTP_ROBOT_DRIVE][IN] id={cmd_id} from={de or '?'} code={code or '?'} cmd={cmd}"
    )
    if not code or not is_drive_cmd(cmd):
        robot_log(f"[HTTP_ROBOT_DRIVE][DROP] id={cmd_id} code={bool(code)} cmd={cmd}")
        return JSONResponse(
            {"ok": False, "error": "code/cmd invalide", "id": cmd_id}, status_code=400
        )
    if not _jeton_http_valide(request):
        # Pas de session ici, donc pas de controle du pilote possible : sans jeton on ne relaie plus.
        # Reponse 200 quand meme : les anciennes versions de l'app appellent cette route a chaque commande
        # (en doublon du socket) et afficheraient une erreur pour tout autre code.
        robot_log(
            f"[HTTP_ROBOT_DRIVE][IGNORE] id={cmd_id} code={code} : pas de jeton, non relaye."
        )
        return {
            "ok": False,
            "id": cmd_id,
            "cmd": cmd,
            "relaye": False,
            "error": "pilotage HTTP desactive sans jeton : utiliser l'evenement Socket.IO drive",
        }
    robot = robot_du_salon(str(code))
    if not robot:
        return {
            "ok": False,
            "id": cmd_id,
            "cmd": cmd,
            "relaye": False,
            "error": "aucun robot connecte",
        }
    await emit_to(robot, "robot_drive", {"id": cmd_id, "cmd": cmd, "by": de or "HTTP"})
    log_room_event(str(code), "robot_drive", {"id": cmd_id, "cmd": cmd, "by": de or "HTTP"})
    robot_log(f"[HTTP_ROBOT_DRIVE][EMIT] id={cmd_id} cmd={cmd} -> {robot}")
    return {"ok": True, "id": cmd_id, "cmd": cmd, "relaye": True}


@router.post("/bg-sync", **DOC["bg_sync"])
async def bg_sync(request: Request):
    b = await _corps_json(request)
    if not b.get("code") or not b.get("pseudo"):
        return JSONResponse({"error": "code/pseudo requis"}, status_code=400)
    return {"ok": True}


audio_consumers: dict[str, set[asyncio.Queue]] = {}
_FILE_MAX = 64


@router.post("/robot-audio", **DOC["robot_audio_post"])
async def robot_audio_post(request: Request):
    code = str(request.query_params.get("code") or "").strip()
    if not code:
        return Response(status_code=400)
    log(f"[AUDIO] producteur connecte code={code}")
    try:
        async for morceau in request.stream():
            if not morceau:
                continue
            for q in list(audio_consumers.get(code, ())):
                if q.qsize() >= _FILE_MAX:
                    continue
                q.put_nowait(morceau)
    except Exception:
        pass
    log(f"[AUDIO] producteur deconnecte code={code}")
    return Response(status_code=200)


@router.get("/robot-audio", **DOC["robot_audio_get"])
async def robot_audio_get(request: Request):
    code = str(request.query_params.get("code") or "").strip()
    if not code:
        return Response(status_code=400)
    q: asyncio.Queue = asyncio.Queue()
    audio_consumers.setdefault(code, set()).add(q)
    log(f"[AUDIO] auditeur connecte code={code} (total={len(audio_consumers[code])})")

    def _nettoyer():
        s = audio_consumers.get(code)
        if s:
            s.discard(q)
            if not s:
                audio_consumers.pop(code, None)

    async def _flux():
        try:
            while True:
                if await request.is_disconnected():
                    return
                try:
                    yield await asyncio.wait_for(q.get(), timeout=5)
                except asyncio.TimeoutError:
                    continue
        finally:
            _nettoyer()

    return StreamingResponse(
        _flux(),
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-cache, no-store", "Connection": "keep-alive"},
    )


@router.get("/", response_class=PlainTextResponse, **DOC["racine"])
async def racine():
    return "OK"


@router.get("/health", **DOC["health"])
async def health():
    return {"status": "ok"}


@router.api_route("/socket/{evenement}", methods=["GET", "POST"], include_in_schema=False)
async def socket_pas_http(evenement: str):
    nom = re.sub(r"[^a-z_]", "", evenement)[:64]
    return JSONResponse(
        {"erreur": f"« {nom} » est un événement Socket.IO, pas une route HTTP : "
                   f"socket.emit('{nom}', données) ou socket.on('{nom}', …). Voir /docs."},
        status_code=400,
    )
