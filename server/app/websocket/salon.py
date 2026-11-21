from __future__ import annotations

import asyncio

from app.core import config
from app.core.logs import log, now_ms, robot_log
from app.core.sio import (
    emit_room,
    emit_to,
    enter_room,
    is_connected,
    leave_room,
    on,
    on_connect,
    on_disconnect,
    payload,
    room_sids,
    tache,
)
from app.core.state import (
    GRACE_MS,
    cle_robot_valide,
    deliver_queue_to,
    enqueue_for,
    ensure_profile,
    est_pilote,
    file_attente,
    get_events_since,
    groupe_spectateurs,
    log_room_event,
    mark_online,
    pilote_present,
    pilotes,
    plan_mark_offline,
    profiles,
    push_tokens,
    reattribuer_pilote,
    refuse_si_pas_pilote,
    robots,
    sids_du_salon,
    socket_to_user_id,
    user_id_of,
    users,
)
from app.services.push import (
    add_persistent_token,
    get_tokens_for_room,
    is_expo_push_token,
    send_silent_sync_push_to_room,
    send_visible_push_to_pseudos,
    send_visible_push_to_room,
)
from app.websocket.sonar import send_latest


@on_connect
async def _connexion(sid, environ):
    log(f"[CONNEXION] Utilisateur connecté : {sid}")


@on("pair")
async def _pair(sid, data):
    p = payload(data)
    pseudo, code = p.get("pseudo"), p.get("code")
    if not pseudo or not code:
        return
    code = str(code)

    if p.get("robot"):
        if not cle_robot_valide(p.get("cle")):
            log(f"[ROLE] {code} : '{pseudo}' se declare robot sans la bonne cle, refuse.")
            await emit_to(sid, "pair_refuse", {"raison": "cle robot invalide"})
            return
        if not config.ROBOT_KEY:
            log(f"[ROLE] {code} : robot '{pseudo}' accepte sans cle (ROBOT_KEY non configuree).")
        robots.add(sid)

    if sid not in robots:
        if not pilote_present(code):
            pilotes[code] = sid
            await emit_to(sid, "role_acces", {"role": "pilote"})
            log(f"[ROLE] {code} : '{pseudo}' est pilote.")
        elif pilotes.get(code) != sid:
            file_attente(code)[sid] = {"pseudo": pseudo, "ts": now_ms()}
            users[sid] = {"pseudo": pseudo, "code": code}
            await emit_to(sid, "role_acces", {"role": "attente"})
            await emit_to(pilotes[code], "acces_demande", {"id": sid, "pseudo": pseudo})
            log(
                f"[ROLE] {code} : '{pseudo}' demande a entrer, le pilote doit repondre."
            )
            return

    users[sid] = {"pseudo": pseudo, "code": code}
    await enter_room(sid, code)
    await send_latest(sid, code)
    uid, _ = ensure_profile(code, pseudo)
    socket_to_user_id[sid] = uid
    mark_online(uid)

    log(f"[PAIR] '{pseudo}' a rejoint la room '{code}'")
    await emit_room(code, "user_joined", {"pseudo": pseudo}, skip_sid=sid)

    dans_salon = room_sids(code)
    for autre in dans_salon:
        if autre != sid:
            info = users.get(autre)
            if info:
                await emit_to(sid, "user_joined", {"pseudo": info["pseudo"]})

    await deliver_queue_to(uid, [s for s in dans_salon if s == sid])

    last_seen = p.get("lastSeen")
    if isinstance(last_seen, (int, float)) and not isinstance(last_seen, bool):
        rates = get_events_since(code, last_seen)
        if rates:
            await emit_to(sid, "sync_batch", {"since": last_seen or 0, "items": rates})


@on("start_typing")
async def _start_typing(sid, data):
    room = payload(data).get("code") or (users.get(sid) or {}).get("code")
    if room:
        await emit_room(room, "user_is_typing", skip_sid=sid)


@on("stop_typing")
async def _stop_typing(sid, data):
    room = payload(data).get("code") or (users.get(sid) or {}).get("code")
    if room:
        await emit_room(room, "user_stopped_typing", skip_sid=sid)


@on("sync")
async def _sync(sid, data):
    p = payload(data)
    try:
        items = get_events_since(p.get("code"), p.get("since"))
        await emit_to(sid, "sync_batch", {"since": p.get("since") or 0, "items": items})
    except Exception as e:
        log("[SYNC] error", e)


@on("nudge")
async def _nudge(sid, data):
    p = payload(data)
    code, sender_pseudo = p.get("code"), p.get("senderPseudo")
    if not code:
        return
    log(f"[NUDGE] Reçu de '{sender_pseudo}' pour la room '{code}'.")
    message = f"⚡ {sender_pseudo} t’a envoyé un rappel."
    for autre in sids_du_salon(code, sauf=sid):
        await emit_to(autre, "buzz", {"message": message})
    log_room_event(code, "buzz", {"message": message})

    await send_visible_push_to_room(
        room_code=code,
        exclude_sid=sid,
        title="Rappel ⚡",
        body=f"{sender_pseudo} t’a rappelé.",
        data={"type": "nudge"},
        sound="default",
    )
    await send_silent_sync_push_to_room(code, sid)
    await emit_to(
        sid, "buzz_sent_confirmation", {"status": "succès", "text": "Rappel envoyé."}
    )


_BUZZ_COMMANDES = ("PING_ROBOT_DRIVE:", "PING_ROBOT_CAM:")


@on("buzz")
async def _buzz(sid, data):
    p = payload(data)
    sender = users.get(sid)
    code, message = p.get("code"), p.get("message")
    if not sender or not code:
        return
    # Ancien canal de secours du pilotage et de la camera : memes regles que robot_drive. Refus silencieux :
    # l'app envoie la meme commande par robot_drive, dont le refus s'affiche deja.
    if str(message or "").startswith(_BUZZ_COMMANDES) and await refuse_si_pas_pilote(
            sid, "buzz", data, prevenir=False):
        return
    interne = str(message or "").startswith("PING_ROBOT_")
    if interne:
        robot_log(
            f"[BUZZ][ROBOT_INTERNAL] from={sender['pseudo']} code={code} message={message}"
        )

    await emit_room(code, "buzz", {"message": message}, skip_sid=sid)
    if interne:
        await emit_to(
            sid,
            "buzz_sent_confirmation",
            {"status": "succès", "text": "Message robot interne transmis."},
        )
        return
    log_room_event(code, "buzz", {"message": message})

    await send_visible_push_to_room(
        room_code=code,
        exclude_sid=sid,
        title=f"⚡ Buzz de {sender['pseudo']}",
        body=message,
        data={"type": "buzz"},
    )
    await send_silent_sync_push_to_room(code, sid)
    await emit_to(
        sid, "buzz_sent_confirmation", {"status": "succès", "text": "Buzz envoyé !"}
    )


@on("app_diag")
async def _app_diag(sid, data):
    p = payload(data)
    log(
        f"[DIAG] {p.get('sujet') or '?'} — {p.get('plateforme') or '?'} {p.get('version') or ''} "
        f"(code={p.get('code') or '-'} pseudo={p.get('pseudo') or '-'}) : {str(p.get('detail') or '')[:300]}"
    )


@on("acces_reponse")
async def _acces_reponse(sid, data):
    p = payload(data)
    info = users.get(sid)
    if not info or not est_pilote(sid):
        return
    code = info["code"]
    file = file_attente(code)
    cible = p.get("id")
    dem = file.pop(cible, None) if cible else None
    if not dem:
        return
    if not is_connected(cible):
        return

    if p.get("accepte"):
        await enter_room(cible, code)
        groupe_spectateurs(code).add(cible)
        await emit_to(cible, "role_acces", {"role": "spectateur"})
        await send_latest(cible, code)
        await emit_room(code, "user_joined", {"pseudo": dem["pseudo"]})
        log(f"[ROLE] {code} : '{dem['pseudo']}' accepte comme spectateur.")
    else:
        await emit_to(cible, "acces_refuse", {})
        log(f"[ROLE] {code} : '{dem['pseudo']}' refuse par le pilote.")


@on("register_token")
async def _register_token(sid, data):
    p = payload(data)
    token = p.get("token")
    if not token:
        return
    token = str(token)
    push_tokens[sid] = token
    pseudo = str(p.get("pseudo") or "").strip()
    code = p.get("code")
    if code and pseudo:
        add_persistent_token(str(code).strip(), pseudo, token)
    log(
        f"[PUSH] jeton recu par socket (…{token[-9:]} code={code or '-'} pseudo={p.get('pseudo') or '-'} "
        f"valide={str(is_expo_push_token(token)).lower()} total_salon={len(get_tokens_for_room(str(code or '')))})"
    )
    await emit_to(sid, "register_token_ok", {"ok": True})


@on("leave")
async def _leave(sid, data):
    code = payload(data).get("code")
    user = users.get(sid)
    if user:
        log(f"[LEAVE] '{user['pseudo']}' a quitté volontairement la room.")
        await emit_room(code, "user_left", skip_sid=sid)
        push_tokens.pop(sid, None)
        uid = socket_to_user_id.get(sid)
        if uid and uid in profiles:
            profiles[uid].online = False
            profiles[uid].last_seen = now_ms()
        users.pop(sid, None)
        socket_to_user_id.pop(sid, None)
    if code:
        await leave_room(sid, code)


@on_disconnect
async def _deconnexion(sid):
    info = users.get(sid)
    code = info and info.get("code")
    robots.discard(sid)
    if code:
        file_attente(code).pop(sid, None)
        groupe_spectateurs(code).discard(sid)
        if pilotes.get(code) == sid:
            pilotes.pop(code, None)
            log(
                f"[ROLE] {code} : le pilote '{(info or {}).get('pseudo') or '?'}' est parti."
            )
            await reattribuer_pilote(code)

    user = users.get(sid)
    if not user:
        return
    log(
        f"[DECONNEXION] '{user['pseudo']}' s'est déconnecté. Tolérance {GRACE_MS // 60000} min."
    )
    uid = socket_to_user_id.get(sid)
    if uid and uid in profiles:
        profiles[uid].last_seen = now_ms()
        plan_mark_offline(uid)
    users.pop(sid, None)
    socket_to_user_id.pop(sid, None)


async def _relayer_ou_mettre_en_file(sid, code, event, data, exclure_pseudo=None):
    livre = False
    for autre in sids_du_salon(code, sauf=sid):
        await emit_to(autre, event, data)
        livre = True
    if not livre:
        for pr in list(profiles.values()):
            if pr.code == code and (
                exclure_pseudo is None or pr.pseudo != exclure_pseudo
            ):
                enqueue_for(
                    user_id_of(code, pr.pseudo),
                    {"type": event, "payload": data if data is not None else {}},
                )


@on("request_meet")
async def _request_meet(sid, data):
    p = payload(data)
    code = p.get("code")
    if not code:
        return
    sender = users.get(sid) or {}
    demandeur = p.get("from") or sender.get("pseudo") or "Ton contact"
    await _relayer_ou_mettre_en_file(
        sid, code, "meet_request", {"from": demandeur}, exclure_pseudo=demandeur
    )
    log_room_event(code, "meet_request", {"from": demandeur})
    await send_visible_push_to_room(
        room_code=code,
        exclude_sid=sid,
        title="Demande “Se rejoindre”",
        body=f"{demandeur} veut te rejoindre.",
        data={"type": "meet_request"},
    )
    await send_silent_sync_push_to_room(code, sid)


@on("accept_meet")
async def _accept_meet(sid, data):
    code = payload(data).get("code")
    if not code:
        return
    accepteur = (users.get(sid) or {}).get("pseudo") or "Ton contact"
    await _relayer_ou_mettre_en_file(
        sid, code, "meet_accepted", {"by": accepteur}, exclure_pseudo=accepteur
    )
    log_room_event(code, "meet_accepted", {"by": accepteur})

    async def _push():
        try:
            await send_visible_push_to_room(
                room_code=code,
                exclude_sid=sid,
                title="Se rejoindre ✅",
                body=f"{accepteur} a accepté la demande.",
                data={"type": "meet_accepted"},
            )
        except Exception as e:
            log("[MEET][accept][PUSH] erreur:", e)
        try:
            await send_silent_sync_push_to_room(code, sid)
        except Exception:
            pass

    tache(_push())


@on("decline_meet")
async def _decline_meet(sid, data):
    code = payload(data).get("code")
    if not code:
        return
    refuseur = (users.get(sid) or {}).get("pseudo") or "Ton contact"
    await _relayer_ou_mettre_en_file(
        sid, code, "meet_declined", {"by": refuseur}, exclure_pseudo=refuseur
    )
    log_room_event(code, "meet_declined", {"by": refuseur})


@on("cancel_meet")
async def _cancel_meet(sid, data):
    code = payload(data).get("code")
    if not code:
        return
    livre = False
    for autre in sids_du_salon(code, sauf=sid):
        await emit_to(autre, "meet_canceled")
        livre = True
    if not livre:
        for pr in list(profiles.values()):
            if pr.code == code:
                enqueue_for(
                    user_id_of(code, pr.pseudo),
                    {"type": "meet_canceled", "payload": {}},
                )
    log_room_event(code, "meet_canceled", {})


@on("share_location")
async def _share_location(sid, data):
    p = payload(data)
    code, coords = p.get("code"), p.get("coords")
    if not code:
        return
    await emit_room(code, "peer_location", {"coords": coords}, skip_sid=sid)
    log_room_event(code, "peer_location", {"coords": coords})
    moi = users.get(sid)
    for pr in list(profiles.values()):
        if pr.code == code and (not moi or pr.pseudo != moi["pseudo"]):
            enqueue_for(
                user_id_of(code, pr.pseudo),
                {"type": "peer_location", "payload": {"coords": coords}},
            )


LOBBY_DURATION_MS = 24 * 60 * 60 * 1000
lobbies: dict[str, dict] = {}
lobby_timers: dict[str, asyncio.TimerHandle] = {}


def ensure_lobby(code: str) -> dict:
    lobby = lobbies.get(code)
    if not lobby:
        lobby = {"startedAt": 0, "expiresAt": 0, "hosts": set(), "members": set()}
        lobbies[code] = lobby
    return lobby


def start_lobby_if_needed(code: str, host_pseudo: str | None) -> dict:
    lobby = ensure_lobby(code)
    t = now_ms()
    if not lobby["startedAt"] or lobby["expiresAt"] <= t:
        lobby["startedAt"] = t
        lobby["expiresAt"] = t + LOBBY_DURATION_MS
        if code in lobby_timers:
            lobby_timers[code].cancel()
        lobby_timers[code] = asyncio.get_running_loop().call_later(
            (lobby["expiresAt"] - now_ms()) / 1000, lambda: tache(expire_lobby(code))
        )
    if host_pseudo:
        lobby["hosts"].add(host_pseudo)
    return lobby


async def expire_lobby(code: str) -> None:
    if code not in lobbies:
        return
    await emit_room(code, "lobby_expired", {"code": code})
    log_room_event(code, "lobby_expired", {})
    h = lobby_timers.pop(code, None)
    if h:
        h.cancel()
    lobbies.pop(code, None)


def lobby_state_payload(code: str) -> dict:
    lobby = lobbies.get(code)
    return {
        "code": code,
        "members": [{"pseudo": m} for m in lobby["members"]] if lobby else [],
        "expiresAt": lobby["expiresAt"] if lobby else 0,
    }


async def broadcast_lobby_state(code: str) -> None:
    data = lobby_state_payload(code)
    await emit_room(code, "lobby_state", data)
    for m in data["members"]:
        enqueue_for(
            user_id_of(code, m["pseudo"]), {"type": "lobby_state", "payload": data}
        )


@on("lobby_join")
async def _lobby_join(sid, data):
    p = payload(data)
    code, pseudo, as_host = p.get("code"), p.get("pseudo"), p.get("asHost")
    if not code or not pseudo:
        return
    lobby = start_lobby_if_needed(code, pseudo) if as_host else ensure_lobby(code)
    lobby["members"].add(pseudo)
    if as_host:
        lobby["hosts"].add(pseudo)
    await enter_room(sid, code)
    await emit_room(
        code,
        "lobby_member_joined",
        {"code": code, "member": {"pseudo": pseudo}},
        skip_sid=sid,
    )
    log_room_event(code, "lobby_member_joined", {"member": {"pseudo": pseudo}})
    await broadcast_lobby_state(code)


@on("lobby_request")
async def _lobby_request(sid, data):
    p = payload(data)
    code, de = p.get("code"), p.get("from")
    if not code or not de:
        return
    lobby = lobbies.get(code)
    if not lobby or lobby["expiresAt"] <= now_ms():
        return
    for autre, info in list(users.items()):
        if info.get("code") == code and info.get("pseudo") in lobby["hosts"]:
            await emit_to(autre, "lobby_request", {"from": de, "code": code})
    await send_visible_push_to_pseudos(
        room_code=code,
        pseudos=list(lobby["hosts"]),
        title="Demande de connexion",
        body=f"{de} veut se connecter avec vous",
        data={"type": "lobby_request", "from": de},
    )
    log_room_event(code, "lobby_request", {"from": de})


@on("lobby_accept")
async def _lobby_accept(sid, data):
    p = payload(data)
    code, cible = p.get("code"), p.get("target")
    if not code or not cible:
        return
    lobby = lobbies.get(code)
    acteur = (users.get(sid) or {}).get("pseudo")
    if not lobby or not acteur or acteur not in lobby["hosts"]:
        return
    lobby["members"].add(cible)
    await emit_room(
        code, "lobby_member_joined", {"code": code, "member": {"pseudo": cible}}
    )
    await broadcast_lobby_state(code)
    log_room_event(code, "lobby_member_joined", {"member": {"pseudo": cible}})


@on("lobby_decline")
async def _lobby_decline(sid, data):
    p = payload(data)
    code, cible = p.get("code"), p.get("target")
    if not code or not cible:
        return
    await emit_room(code, "lobby_declined", {"code": code, "target": cible})
    log_room_event(code, "lobby_declined", {"target": cible})


@on("lobby_heartbeat")
async def _lobby_heartbeat(sid, data):
    p = payload(data)
    if not p.get("code") or not p.get("pseudo"):
        return
    uid, _ = ensure_profile(p["code"], p["pseudo"])
    mark_online(uid)


@on("lobby_leave")
async def _lobby_leave(sid, data):
    p = payload(data)
    code = p.get("code")
    if not code:
        return
    moi = (users.get(sid) or {}).get("pseudo")
    lobby = lobbies.get(code)
    if not lobby:
        return
    if moi:
        lobby["members"].discard(moi)
        lobby["hosts"].discard(moi)
        await emit_room(
            code, "lobby_member_left", {"code": code, "member": {"pseudo": moi}}
        )
        log_room_event(code, "lobby_member_left", {"member": {"pseudo": moi}})

    if p.get("expired"):
        await expire_lobby(code)
    else:
        await broadcast_lobby_state(code)
        if not lobby["members"] and not lobby["hosts"]:
            h = lobby_timers.pop(code, None)
            if h:
                h.cancel()
            lobbies.pop(code, None)
