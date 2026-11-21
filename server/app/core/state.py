from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from app.core.logs import log, now_ms
from app.core.sio import emit_room, emit_to, is_connected

users: dict[str, dict] = {}
push_tokens: dict[str, str] = {}

socket_to_user_id: dict[str, str] = {}
GRACE_MS = 5 * 60 * 1000


@dataclass
class Profil:
    pseudo: str
    code: str
    last_seen: int = 0
    online: bool = False
    offline_timer: asyncio.TimerHandle | None = None


profiles: dict[str, Profil] = {}
queues: dict[str, list[dict]] = {}


pilotes: dict[str, str] = {}
spectateurs: dict[str, set[str]] = {}
en_attente: dict[str, dict[str, dict]] = {}
robots: set[str] = set()


def groupe_spectateurs(code: str) -> set[str]:
    return spectateurs.setdefault(code, set())


def file_attente(code: str) -> dict[str, dict]:
    return en_attente.setdefault(code, {})


def pilote_present(code: str) -> bool:
    sid = pilotes.get(code)
    if not sid:
        return False
    if is_connected(sid):
        return True
    pilotes.pop(code, None)
    return False


def est_pilote(sid: str) -> bool:
    info = users.get(sid)
    return bool(info) and pilotes.get(info["code"]) == sid


async def reattribuer_pilote(code: str) -> bool:
    grp = groupe_spectateurs(code)
    for sid in list(grp):
        grp.discard(sid)
        if not is_connected(sid):
            continue
        pilotes[code] = sid
        pseudo = (users.get(sid) or {}).get("pseudo")
        await emit_to(sid, "role_acces", {"role": "pilote", "raison": "le pilote precedent est parti"})
        await emit_room(code, "pilote_change", {"pseudo": pseudo})
        log(f"[ROLE] {code} : {pseudo or sid} devient pilote.")
        return True
    pilotes.pop(code, None)
    log(f"[ROLE] {code} : plus de pilote, le prochain arrivant prendra la main.")
    return False


async def marquer_robot(sid: str) -> None:
    if sid in robots:
        return
    robots.add(sid)
    info = users.get(sid)
    if not info:
        return
    if pilotes.get(info["code"]) == sid:
        pilotes.pop(info["code"], None)
        log(f"[ROLE] {info['code']} : le robot avait pris la place de pilote, elle est rendue.")
        await reattribuer_pilote(info["code"])
    groupe_spectateurs(info["code"]).discard(sid)


async def refuse_si_pas_pilote(sid: str, nom: str) -> bool:
    if sid in robots:
        return False
    if est_pilote(sid):
        return False
    info = users.get(sid) or {}
    log(f"[ROLE] commande \"{nom}\" refusee a {info.get('pseudo') or sid} : spectateur.")
    await emit_to(sid, "acces_refuse_commande", {"commande": nom})
    return True


def sids_du_salon(code: str, sauf: str | None = None) -> list[str]:
    return [s for s, u in users.items() if u.get("code") == code and s != sauf]


room_messages: dict[str, list[dict]] = {}
ROOM_LOG_LIMIT = 500


def log_room_event(code: str, type_: str, payload: Any) -> None:
    if not code:
        return
    arr = room_messages.setdefault(code, [])
    arr.append({"ts": now_ms(), "type": type_, "payload": payload})
    if len(arr) > ROOM_LOG_LIMIT:
        del arr[: len(arr) - ROOM_LOG_LIMIT]


def get_events_since(code: str, since_ts: Any) -> list[dict]:
    arr = room_messages.get(code) or []
    if not since_ts:
        return list(arr)
    return [e for e in arr if e["ts"] > since_ts]


def user_id_of(code: str, pseudo: str) -> str:
    return f"{code}::{pseudo}"


def ensure_profile(code: str, pseudo: str) -> tuple[str, Profil]:
    uid = user_id_of(code, pseudo)
    p = profiles.get(uid)
    if not p:
        p = Profil(pseudo=pseudo, code=code, last_seen=now_ms())
        profiles[uid] = p
    return uid, p


def enqueue_for(user_id: str, item: dict) -> None:
    queues.setdefault(user_id, []).append(item)


_TYPES_FILE = {
    "buzz", "meet_request", "meet_accepted", "meet_declined",
    "meet_canceled", "peer_location", "lobby_state",
}


async def deliver_queue_to(user_id: str, socket_ids: list[str]) -> None:
    q = queues.get(user_id)
    if not q:
        return
    if not socket_ids:
        return
    cible = socket_ids[0]
    for item in q:
        if item.get("type") in _TYPES_FILE:
            await emit_to(cible, item["type"], item.get("payload"))
    queues[user_id] = []


def mark_online(user_id: str) -> None:
    p = profiles.get(user_id)
    if not p:
        return
    p.last_seen = now_ms()
    p.online = True
    if p.offline_timer:
        p.offline_timer.cancel()
        p.offline_timer = None


def plan_mark_offline(user_id: str) -> None:
    p = profiles.get(user_id)
    if not p:
        return
    if p.offline_timer:
        p.offline_timer.cancel()

    def _verifier():
        if now_ms() - p.last_seen >= GRACE_MS:
            p.online = False
            from app.core.sio import tache

            tache(emit_room(p.code, "user_left"))

    p.offline_timer = asyncio.get_running_loop().call_later(GRACE_MS / 1000, _verifier)
