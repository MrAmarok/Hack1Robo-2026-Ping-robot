from __future__ import annotations

import importlib
import socket
from contextlib import asynccontextmanager

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import DEFAULT_PORT, PORT
from app.core.logs import log
from app.core.sio import sio

from app.websocket import robot, salon
from app.services import alertes, push
from app.api.routes import router as http_router

GESTIONNAIRES_SOCKET = (robot, salon, alertes)


_OPTIONNELS = [
    ("app.services.voice_brain", "attach_voice_brain", "[VOICE]", "assistant vocal non demarre"),
    ("app.services.realtime_voix", "attach_realtime_voix", "[VOICE]", "conversation en direct non demarree"),
    ("app.services.appel_direct", "attach_appel_direct", "[TEL]", "conversation telephonique non demarree"),
    ("app.services.enregistrement", "attach_enregistrement", "[REC]", "enregistrement non demarre"),
]

_modules_charges: dict[str, object] = {}
_port_ecoute: int | None = None
for _nom, _fn, _prefixe, _msg in _OPTIONNELS:
    try:
        _modules_charges[_nom] = importlib.import_module(_nom)
    except Exception as e:
        log(f"{_prefixe} {_msg} : {e!r}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    push.charger_tokens()
    alertes.charger_historique()
    for nom, fn, prefixe, msg in _OPTIONNELS:
        mod = _modules_charges.get(nom)
        if mod is None:
            continue
        try:
            getattr(mod, fn)()
        except Exception as e:
            log(f"{prefixe} {msg} : {e!r}")
    log("✅ Serveur prêt" + (f" sur le port {_port_ecoute}" if _port_ecoute else ""))
    yield


fastapi_app = FastAPI(title="Ping server", version="2.0.0", lifespan=lifespan)
fastapi_app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
fastapi_app.include_router(http_router)

_appel = _modules_charges.get("app.services.appel_direct")
if _appel is not None and getattr(_appel, "router", None) is not None:
    fastapi_app.include_router(_appel.router)

app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app, socketio_path="socket.io")


def _port_libre(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def main() -> None:
    import uvicorn

    port = PORT
    if not _port_libre(port):
        if port != DEFAULT_PORT:
            log(f"Port {port} deja utilise, bascule sur le port robot {DEFAULT_PORT}.")
            port = DEFAULT_PORT
        if not _port_libre(port):
            log(f"Port {port} deja utilise. Arrete le process qui occupe ce port ou change PORT.")
            raise SystemExit(1)
    global _port_ecoute
    _port_ecoute = port
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    main()
