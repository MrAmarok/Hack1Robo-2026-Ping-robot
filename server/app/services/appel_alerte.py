from __future__ import annotations

import asyncio
import importlib
import json
import math
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from app.core.config import SERVER_DIR, env, env_float
from app.core.logs import log, now_ms

FICHIER_REGLAGES = SERVER_DIR / "appel-alerte.json"

_dernier_appel = 0

_coupes: set[str] = set()


def _charger() -> None:
    global _coupes
    try:
        lu = json.loads(Path(FICHIER_REGLAGES).read_text("utf8"))
        if isinstance(lu.get("coupes"), list):
            _coupes = {str(c) for c in lu["coupes"]}
    except Exception:
        pass


_charger()


def _sauver() -> None:
    try:
        Path(FICHIER_REGLAGES).write_text(
            json.dumps(
                {"coupes": list(_coupes)}, ensure_ascii=False, separators=(",", ":")
            ),
            "utf8",
        )
    except Exception as e:
        log("[APPEL] reglage non enregistre :", str(e))


def _configure() -> bool:
    return bool(
        env("TWILIO_ACCOUNT_SID")
        and env("TWILIO_AUTH_TOKEN")
        and env("TWILIO_FROM")
        and env("ALERTE_APPEL_NUMERO")
    )


def etat_appel(code: Any) -> dict:
    return {"actif": str(code) not in _coupes, "configure": _configure()}


def regler_appel(code: Any, actif: bool) -> dict:
    if actif:
        _coupes.discard(str(code))
    else:
        _coupes.add(str(code))
    _sauver()
    return etat_appel(code)


def xml(t: Any) -> str:
    return (
        str(t)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _say_deux_fois(texte: str) -> str:
    return (
        "<Response>"
        f'<Say language="fr-FR" voice="Polly.Lea">{xml(texte)}</Say>'
        '<Pause length="1"/>'
        f'<Say language="fr-FR" voice="Polly.Lea">{xml(texte)}</Say>'
        "</Response>"
    )


async def appeler_alerte(code: Any, heure: Any, phrase: Any = None) -> bool:
    global _dernier_appel
    c = str(code)
    if c in _coupes:
        log(f"[APPEL] {c} : appels coupes par l'utilisateur, pas d'appel.")
        return False
    if not _configure():
        log(
            "[APPEL] non configure (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM / "
            "ALERTE_APPEL_NUMERO absents du .env)."
        )
        return False
    cadence = env_float("ALERTE_APPEL_CADENCE_MS", 600000)
    t = now_ms()
    avant = _dernier_appel
    if avant and t - avant < cadence:
        log(
            f"[APPEL] {c} : deja appele il y a {math.floor((t - avant) / 1000 + 0.5)} s, pas de nouvel appel."
        )
        return False
    _dernier_appel = t

    message = (
        f"Alerte du robot. Quelqu'un a été vu dans la maison à {heure}. "
        + (f"{phrase} " if phrase else "")
        + "La photo est dans l'application."
    )
    appel_direct = importlib.import_module("app.services.appel_direct")
    twiml = appel_direct.twiml_conversation(c, heure, phrase) or _say_deux_fois(message)

    r = await lancer_appel_twilio(env("ALERTE_APPEL_NUMERO"), twiml)
    if not r.get("ok"):
        if _dernier_appel == t:
            _dernier_appel = 0
        return False
    log(f"[APPEL] {c} : appel lance ({r.get('sid') or 'sans identifiant'}).")
    return True


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=10)


async def lancer_appel_twilio(to: Any, twiml: str) -> dict:
    sid = env("TWILIO_ACCOUNT_SID") or ""
    jeton = env("TWILIO_AUTH_TOKEN") or ""
    try:
        async with _client() as client:
            r = await asyncio.wait_for(
                client.post(
                    f"https://api.twilio.com/2010-04-01/Accounts/{quote(sid, safe=_SURS_URI)}/Calls.json",
                    auth=(sid, jeton),
                    data={"To": to, "From": env("TWILIO_FROM"), "Twiml": twiml},
                ),
                10,
            )
        try:
            j = r.json()
        except Exception:
            j = {}
        if not isinstance(j, dict):
            j = {}
        if not r.is_success:
            log(
                f"[APPEL] refus Twilio (HTTP {r.status_code}) : {j.get('message') or 'sans detail'}"
            )
            return {"ok": False}
        return {"ok": True, "sid": j.get("sid")}
    except Exception as e:
        log("[APPEL] appel impossible :", str(e) or e.__class__.__name__)
        return {"ok": False}


_SURS_URI = "-_.!~*'()"
