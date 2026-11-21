from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

SERVER_DIR = Path(__file__).resolve().parents[2]

ENV_FILE = Path(os.environ.get("ENV_FILE") or (SERVER_DIR / ".env"))
load_dotenv(ENV_FILE, override=False)


def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v


def env_int(name: str, default: int) -> int:
    try:
        return int(float(env(name, str(default))))
    except (TypeError, ValueError):
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(env(name, str(default)))
    except (TypeError, ValueError):
        return default


def env_bool(name: str, default: bool = False) -> bool:
    v = env(name)
    if v is None:
        return default
    return str(v).strip().lower() == "true"


DEFAULT_PORT = 3002
PORT = env_int("PORT", DEFAULT_PORT)

PUBLIC_URL = env("PUBLIC_URL", "https://api.ping-app.org")

ROBOT_DEBUG_LOGS = env_bool("ROBOT_DEBUG_LOGS", False)

MTX_HOST = env("MTX_HOST", "127.0.0.1")
MTX_HTTP_PORT = env_int("MTX_HTTP_PORT", 8889)
MTX_USER = env("MTX_USER", "robot")


def _mtx_pass() -> str:
    if env("MTX_PASS"):
        return env("MTX_PASS") or ""
    try:
        return Path("/opt/mediamtx/publish-pass.txt").read_text("utf8").strip()
    except OSError:
        return ""


MTX_PASS = _mtx_pass()

# Secret partage avec les robots, a envoyer dans `pair` (champ `cle`). Vide = mode compatible :
# tout socket qui se declare robot est cru, comme avant. A remplir une fois les robots a jour.
ROBOT_KEY = env("ROBOT_KEY", "") or ""
# Jeton pour piloter par HTTP (POST /robot-drive, en-tete `Authorization: Bearer <jeton>`).
# Vide = la route repond mais ne relaie plus rien.
ROBOT_HTTP_TOKEN = env("ROBOT_HTTP_TOKEN", "") or ""

DOSSIER_ALERTES = env("ALERTES_DIR", "/root/server/alertes")
FICHIER_ALERTES = env("ALERTES_FICHIER", "/root/server/alertes.json")
PUSH_FICHIER = env("PUSH_FICHIER", str(SERVER_DIR / "push-tokens.json"))
REC_DOSSIER = env("REC_DOSSIER", "/root/enregistrements")
CAPTEUR_DIR = env("CAPTEUR_DIR", str(SERVER_DIR / "capteur"))
CAPTEUR_MAX_MO = env_int("CAPTEUR_MAX_MO", 50)
