from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import quote

import httpx

from app.core.config import DOSSIER_ALERTES, FICHIER_ALERTES, PUBLIC_URL, env, env_int
from app.core.logs import log, now_ms
from app.core.sio import emit_room, emit_to, on, payload, tache
from app.core.state import log_room_event, refuse_si_pas_pilote, robots, users
from app.services.push import send_visible_push_to_room

ALERTES_GARDEES = env_int("ALERTES_GARDEES", 60)


async def envoyer_telegram(texte: str) -> bool:
    jeton = env("TELEGRAM_TOKEN")
    salon = env("TELEGRAM_CHAT_ID")
    if not jeton or not salon:
        log(
            "[TELEGRAM] non configure (TELEGRAM_TOKEN / TELEGRAM_CHAT_ID absents du .env)."
        )
        return False
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.post(
                f"https://api.telegram.org/bot{jeton}/sendMessage",
                json={"chat_id": salon, "text": texte},
            )
        try:
            j = r.json()
        except ValueError:
            j = {}
        if r.status_code >= 400 or j.get("ok") is False:
            log(
                f"[TELEGRAM] refus (HTTP {r.status_code}) : {j.get('description') or 'sans detail'}"
            )
            return False
        log("[TELEGRAM] alerte envoyee.")
        return True
    except Exception as e:
        log("[TELEGRAM] envoi impossible :", e)
        return False


CADENCE_NOTIF = {
    "personne": env_int("CADENCE_PERSONNE", 30000),
    "animal": env_int("CADENCE_ANIMAL", 900000),
    "rien": env_int("CADENCE_RIEN", 900000),
}
derniere_notif: dict[str, dict[str, int]] = {}


def notif_autorisee(code: str, categorie: str) -> bool:
    cat = categorie if categorie in CADENCE_NOTIF else "rien"
    par = derniere_notif.setdefault(code, {})
    t = now_ms()
    if par.get(cat) and t - par[cat] < CADENCE_NOTIF[cat]:
        return False
    par[cat] = t
    return True


historique_alertes: dict[str, list[dict]] = {}


def sauver_historique() -> None:
    try:
        Path(FICHIER_ALERTES).parent.mkdir(parents=True, exist_ok=True)
        with open(FICHIER_ALERTES, "w", encoding="utf8") as f:
            json.dump(historique_alertes, f)
    except OSError as e:
        log("[ALERTE] historique non enregistre :", e)


def charger_historique() -> None:
    try:
        with open(FICHIER_ALERTES, encoding="utf8") as f:
            plat = json.load(f)
    except (OSError, ValueError):
        return
    n = 0
    for c, liste in (plat or {}).items():
        if isinstance(liste, list):
            historique_alertes[c] = liste
            n += len(liste)
    if n:
        log(f"[ALERTE] {n} alerte(s) relue(s) depuis le disque.")


CODE_FICHIER_OK = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _enregistrer_photo(code: str, octets: bytes, ts: int) -> str | None:
    os.makedirs(DOSSIER_ALERTES, exist_ok=True)
    fichier = f"{code}-{ts}.jpg"
    Path(DOSSIER_ALERTES, fichier).write_bytes(octets)
    Path(DOSSIER_ALERTES, f"{code}.jpg").write_bytes(octets)
    prefixe = f"{code}-"
    vieilles = sorted(
        f
        for f in os.listdir(DOSSIER_ALERTES)
        if f.startswith(prefixe) and f.endswith(".jpg")
    )
    for f in vieilles[: max(0, len(vieilles) - ALERTES_GARDEES)]:
        try:
            os.unlink(os.path.join(DOSSIER_ALERTES, f))
        except OSError:
            pass
    return fichier


@on("robot_alerte")
async def _robot_alerte(sid, data):
    p = payload(data)
    code = p.get("code")
    type_ = p.get("type")
    photo = p.get("photo")
    capteurs = p.get("capteurs")
    if not code:
        return
    info = users.get(sid)
    if sid not in robots or not info or info.get("code") != code:
        log(f"[ALERTE] refusee : {sid} n'est pas le robot du salon '{str(code)[:64]}'.")
        return
    code = str(code)
    code_fichier_ok = bool(CODE_FICHIER_OK.match(code))
    if not code_fichier_ok:
        log(
            "[ALERTE] code de salon impropre a un nom de fichier : photo non enregistree."
        )
    ts_alerte = now_ms()
    fichier_photo = None
    octets = None
    if photo:
        try:
            octets = (
                photo
                if isinstance(photo, (bytes, bytearray))
                else base64.b64decode(str(photo) + "=" * (-len(str(photo)) % 4))
            )
        except (binascii.Error, ValueError, TypeError) as e:
            log("[ALERTE] photo illisible :", e)
            octets = None
    if octets and code_fichier_ok:
        try:
            fichier_photo = _enregistrer_photo(code, bytes(octets), ts_alerte)
        except OSError as e:
            log("[ALERTE] photo non enregistree :", e)

    await emit_room(
        code,
        "robot_alerte",
        {"type": type_, "niveau": p.get("niveau"), "photo": bool(photo)},
        skip_sid=sid,
    )
    log_room_event(
        code,
        "robot_alerte",
        {"type": type_, "niveau": p.get("niveau"), "capteurs": capteurs},
    )

    try:
        heure = time.strftime("%H:%M:%S")
        vu = None
        if octets:
            try:
                from app.services import voice_brain

                vu = await asyncio.wait_for(
                    voice_brain.decrire_scene(bytes(octets)), timeout=6
                )
                if vu:
                    log(f"[ALERTE] vu ({vu.get('categorie')}) : {vu.get('phrase')}")
            except asyncio.TimeoutError:
                vu = None
            except Exception as e:
                log("[ALERTE] analyse impossible :", e)

        t = str(type_)
        capteur = (
            "Presence detectee"
            if t == "presence"
            else "Mouvement detecte" if t == "mouvement" else "Bruit detecte"
        )

        categorie_vue = vu.get("categorie") if vu else None
        if categorie_vue == "personne":
            titre = "Quelqu un est chez vous"
        elif categorie_vue == "animal":
            titre = "Ce n est qu un animal"
        else:
            titre = f"{capteur} a la maison"

        if categorie_vue == "personne":
            from app.services import appel_alerte

            async def _appel():
                try:
                    await appel_alerte.appeler_alerte(code, heure, vu.get("phrase"))
                except Exception as e:
                    log("[APPEL] erreur :", e)

            tache(_appel())

        corps = (vu and vu.get("phrase")) or (
            "Le robot detecte quelqu un. Ouvre la camera."
            if t == "presence"
            else (
                "Le robot a vu quelque chose bouger. Ouvre la camera."
                if t == "mouvement"
                else "Le robot a entendu quelque chose. Ouvre la camera pour voir."
            )
        )
        await envoyer_telegram(
            f"{titre} a {heure}.\n{capteur}. {corps}\n"
            f"Voir la camera : {PUBLIC_URL}/ouvrir?code={quote(code, safe='')}"
        )
        categorie = categorie_vue or "rien"
        hist = historique_alertes.setdefault(code, [])
        entree = {
            "ts": ts_alerte,
            "type": str(type_ or "bruit"),
            "capteurs": capteurs if isinstance(capteurs, list) else [],
            "categorie": categorie,
            "phrase": (vu and vu.get("phrase")) or None,
            "photo": fichier_photo,
            "notifiee": False,
        }
        hist.append(entree)
        if len(hist) > ALERTES_GARDEES:
            del hist[: len(hist) - ALERTES_GARDEES]
        sauver_historique()

        if not notif_autorisee(code, categorie):
            log(
                f"[ALERTE] {categorie} : notification retenue (cadence), alerte conservee."
            )
            return
        entree["notifiee"] = True
        sauver_historique()

        await send_visible_push_to_room(
            room_code=code,
            exclude_sid=sid,
            title=titre,
            body=corps,
            data={"type": "alerte", "kind": str(type_ or "bruit")},
            image=(
                f"{PUBLIC_URL}/alerte-photo?code={quote(code, safe='')}&t={now_ms()}"
                if photo
                else None
            ),
        )
    except Exception as e:
        log("[ALERTE] notification non envoyee :", e)


@on("alerte_appel")
async def _alerte_appel(sid, data):
    p = payload(data)
    if sid in robots:
        return
    if await refuse_si_pas_pilote(sid, "alerte_appel", data):
        return
    code = (users.get(sid) or {}).get("code")
    if not code:
        return
    from app.services import appel_alerte

    etat = appel_alerte.regler_appel(code, bool(p.get("actif")))
    log(f"[APPEL] {code} : appels {'actifs' if etat.get('actif') else 'coupes'}.")
    await emit_room(code, "alerte_appel_etat", etat)


@on("alerte_appel_etat")
async def _alerte_appel_etat(sid, data):
    code = payload(data).get("code")
    if not code:
        return
    from app.services import appel_alerte

    await emit_to(sid, "alerte_appel_etat", appel_alerte.etat_appel(str(code)))
