from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Iterable

import httpx

from app.core.config import PUSH_FICHIER
from app.core.logs import log
from app.core.state import push_tokens, users
from app.core.sio import tache

EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send"
EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
_TAILLE_LOT = 100

persistent_push_tokens: dict[str, dict[str, set[str]]] = {}

_UUID = re.compile(r"^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$", re.I)


def is_expo_push_token(token: Any) -> bool:
    if not isinstance(token, str):
        return False
    if (
        token.startswith("ExponentPushToken[") or token.startswith("ExpoPushToken[")
    ) and token.endswith("]"):
        return True
    return bool(_UUID.match(token))


def sauver_tokens() -> None:
    try:
        plat = {
            code: {p: sorted(s) for p, s in par.items()}
            for code, par in persistent_push_tokens.items()
        }
        with open(PUSH_FICHIER, "w", encoding="utf8") as f:
            json.dump(plat, f)
    except OSError as e:
        log("[PUSH] enregistrement des jetons impossible :", e)


def charger_tokens() -> None:
    try:
        with open(PUSH_FICHIER, encoding="utf8") as f:
            plat = json.load(f)
    except (OSError, ValueError):
        log("[PUSH] aucun jeton enregistre (premier demarrage ?).")
        return
    n = 0
    for code, par in (plat or {}).items():
        m = {}
        for pseudo, arr in (par or {}).items():
            m[pseudo] = set(arr)
            n += len(arr)
        persistent_push_tokens[code] = m
    log(f"[PUSH] {n} jeton(s) restaure(s) depuis le disque.")


def add_persistent_token(code: str, pseudo: str, token: str) -> None:
    if not code or not pseudo or not token:
        return
    s = persistent_push_tokens.setdefault(code, {}).setdefault(pseudo, set())
    avant = len(s)
    s.add(token)
    if len(s) != avant:
        sauver_tokens()


def retirer_jeton_mort(token: str) -> None:
    retire = False
    for par in persistent_push_tokens.values():
        for s in par.values():
            if token in s:
                s.discard(token)
                retire = True
    for sid, t in list(push_tokens.items()):
        if t == token:
            push_tokens.pop(sid, None)
            retire = True
    if retire:
        sauver_tokens()
        log(f"[PUSH] jeton mort retire : {str(token)[-9:]}")


def get_tokens_for_room(code: str) -> list[str]:
    par = persistent_push_tokens.get(code) or {}
    return [t for s in par.values() for t in s]


def get_tokens_for_pseudos(code: str, pseudos: Iterable[str]) -> list[str]:
    par = persistent_push_tokens.get(code) or {}
    out: list[str] = []
    for p in pseudos:
        out.extend(par.get(p, ()))
    return out


async def send_push_notifications(messages: list[dict]) -> list[dict]:
    tickets: list[dict] = []
    async with httpx.AsyncClient(timeout=15) as client:
        for i in range(0, len(messages), _TAILLE_LOT):
            lot = messages[i : i + _TAILLE_LOT]
            try:
                r = await client.post(
                    EXPO_SEND_URL,
                    json=lot,
                    headers={
                        "Accept": "application/json",
                        "Accept-Encoding": "gzip, deflate",
                    },
                )
                data = r.json().get("data")
                if isinstance(data, list):
                    tickets.extend(data)
                else:
                    msg = (r.json().get("errors") or [{}])[0].get(
                        "message", f"HTTP {r.status_code}"
                    )
                    tickets.extend({"status": "error", "message": msg} for _ in lot)
            except Exception as e:
                tickets.extend({"status": "error", "message": str(e)} for _ in lot)
    return tickets


async def get_push_receipts(ids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=15) as client:
        for i in range(0, len(ids), 300):
            r = await client.post(EXPO_RECEIPTS_URL, json={"ids": ids[i : i + 300]})
            out.update(r.json().get("data") or {})
    return out


def message_push(
    token: str,
    title: str,
    body: str,
    data: dict | None = None,
    sound: str = "default",
    image: str | None = None,
) -> dict:
    m = {
        "to": token,
        "sound": sound,
        "title": title,
        "body": body,
        "data": data or {},
        "priority": "high",
        "channelId": "default",
        "interruptionLevel": "time-sensitive",
    }
    if image:
        m["richContent"] = {"image": image}
    return m


def _jetons_connectes(
    code: str, exclude_sid: str | None, pseudos: set[str] | None = None
) -> list[str]:
    out = []
    for sid, info in users.items():
        if info.get("code") != code or sid == exclude_sid:
            continue
        if pseudos is not None and info.get("pseudo") not in pseudos:
            continue
        t = push_tokens.get(sid)
        if t:
            out.append(t)
    return out


async def send_silent_sync_push_to_room(
    code: str, exclude_sid: str | None = None
) -> None:
    vus: set[str] = set()
    notifs = []
    for t in _jetons_connectes(code, exclude_sid) + get_tokens_for_room(code):
        if is_expo_push_token(t) and t not in vus:
            notifs.append(
                {
                    "to": t,
                    "contentAvailable": True,
                    "priority": "high",
                    "data": {"type": "sync"},
                }
            )
            vus.add(t)
    if notifs:
        await send_push_notifications(notifs)


async def send_visible_push_to_room(
    room_code: str,
    title: str,
    body: str,
    exclude_sid: str | None = None,
    data: dict | None = None,
    sound: str = "default",
    image: str | None = None,
) -> None:
    vus: set[str] = set()
    notifs = []
    for t in _jetons_connectes(room_code, exclude_sid) + get_tokens_for_room(room_code):
        if is_expo_push_token(t) and t not in vus:
            notifs.append(message_push(t, title, body, data, sound, image))
            vus.add(t)
    if not notifs:
        log(
            f'[PUSH] AUCUN destinataire pour le salon {room_code} — "{title}" non envoyee.'
        )
        return
    tickets = await send_push_notifications(notifs)
    for t in tickets:
        if t.get("status") == "error":
            log(
                f"[PUSH] refus d'Expo : {t.get('message')} {json.dumps(t.get('details') or {})}"
            )
    vises = ", ".join(str(n["to"])[-9:] for n in notifs)
    log(f'[PUSH] "{title}" envoye a {len(notifs)} destinataire(s) : {vises}')

    jeton_du_ticket = {
        t["id"]: notifs[i]["to"]
        for i, t in enumerate(tickets)
        if t.get("status") == "ok" and t.get("id") and i < len(notifs)
    }
    if jeton_du_ticket:
        tache(_verifier_recus(jeton_du_ticket))


async def _verifier_recus(jeton_du_ticket: dict[str, str]) -> None:
    await asyncio.sleep(7)
    try:
        recus = await get_push_receipts(list(jeton_du_ticket))
    except Exception as e:
        log("[PUSH] recus illisibles :", e)
        return
    for rid, r in recus.items():
        jeton = jeton_du_ticket.get(rid)
        fin = str(jeton or "?")[-9:]
        if r.get("status") == "error":
            log(
                f"[PUSH] LIVRAISON ECHOUEE {fin} : {r.get('message')} {json.dumps(r.get('details') or {})}"
            )
            if (r.get("details") or {}).get("error") == "DeviceNotRegistered" and jeton:
                retirer_jeton_mort(jeton)
        else:
            log(f"[PUSH] livraison confirmee {fin}")


async def send_visible_push_to_pseudos(
    room_code: str,
    pseudos: Iterable[str],
    title: str,
    body: str,
    data: dict | None = None,
    sound: str = "default",
    image: str | None = None,
) -> None:
    cible = set(pseudos)
    vus: set[str] = set()
    notifs = []
    for t in _jetons_connectes(room_code, None, cible) + get_tokens_for_pseudos(
        room_code, cible
    ):
        if is_expo_push_token(t) and t not in vus:
            notifs.append(message_push(t, title, body, data, sound, image))
            vus.add(t)
    if not notifs:
        log(
            f"[PUSH] AUCUN destinataire pour le salon {room_code} — notification non envoyee."
        )
        return
    tickets = await send_push_notifications(notifs)
    for t in tickets:
        if t.get("status") == "error":
            log(
                f"[PUSH] refus d'Expo : {t.get('message')} {json.dumps(t.get('details') or {})}"
            )
    log(f'[PUSH] "{title}" envoye a {len(notifs)} destinataire(s).')
