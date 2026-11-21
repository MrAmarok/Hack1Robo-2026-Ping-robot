from __future__ import annotations

import base64
import re

import httpx

from app.core.config import MTX_HOST, MTX_HTTP_PORT, MTX_PASS, MTX_USER
from app.core.logs import log, now_ms, robot_log
from app.core.sio import call, emit_room, emit_to, on, payload
from app.core.state import (
    est_pilote, log_room_event, marquer_robot, refuse_si_pas_pilote, robot_du_salon, users,
)

MTX_BASE = f"http://{MTX_HOST}:{MTX_HTTP_PORT}"

_RE_V = re.compile(r"^V\d{2,3}$")
_RE_M = re.compile(r"^M-?\d{1,3},-?\d{1,3}$")


def is_drive_cmd(c: str) -> bool:
    return (len(c) == 1 and c in "FBLRS+-") or bool(_RE_V.match(c)) or bool(_RE_M.match(c))


def _clamp_servo(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")):
        return None
    return max(0, min(180, round(n)))


DRIVE_ACK_TIMEOUT_S = 1.5


@on("drive")
async def _drive(sid, data):
    """Canal unique de pilotage.

    Le salon est celui de la session (le `code` du message est ignore) et seul son pilote conduit.
    Avec `ack: true` (appui, relachement, vitesse), le serveur attend la reponse du robot et la renvoie
    dans l'accuse. Sans (maintien du bouton, ~4/s), il relaie au robot sans rien attendre.
    """
    info = users.get(sid)
    if not info or not est_pilote(sid):
        robot_log(f"[DRIVE][REFUS] socket={sid} : pas pilote.")
        return {"ok": False, "erreur": "seul le pilote peut conduire"}
    code = info["code"]
    p = payload(data)
    cmd = str(p.get("cmd") or "").strip().upper()
    if not is_drive_cmd(cmd):
        return {"ok": False, "cmd": cmd, "erreur": "commande inconnue"}
    robot = robot_du_salon(code)
    if not robot:
        return {"ok": False, "cmd": cmd, "erreur": "robot hors ligne"}
    if not p.get("ack"):
        await emit_to(robot, "drive", {"cmd": cmd})
        return None

    log_room_event(code, "robot_drive", {"cmd": cmd, "by": info["pseudo"]})
    r = await call(robot, "drive", {"cmd": cmd}, timeout=DRIVE_ACK_TIMEOUT_S)
    robot_log(f"[DRIVE] {code} {cmd} par {info['pseudo']} -> {r!r}")
    if not isinstance(r, dict):
        return {"ok": False, "cmd": cmd, "erreur": "le robot n'a pas repondu"}
    rep = {"ok": bool(r.get("ok")), "cmd": cmd}
    if "arduino" in r:
        rep["arduino"] = bool(r["arduino"])
    if not rep["ok"]:
        rep["erreur"] = str(r.get("erreur") or "commande non transmise a l'Arduino")[:200]
    return rep


@on("robot_drive")
async def _robot_drive(sid, data):
    """Ancien canal, garde pour les versions de l'app qui ne connaissent pas `drive`."""
    if await refuse_si_pas_pilote(sid, "robot_drive", data):
        return
    p = payload(data)
    sender = users.get(sid)
    cmd = str(p.get("cmd") or "").strip().upper()
    cmd_id = str(p.get("id") or f"{cmd}-{now_ms()}")
    code = (sender or {}).get("code")
    robot_log(f"[ROBOT_DRIVE][IN] id={cmd_id} socket={sid} sender={(sender or {}).get('pseudo', '?')} "
              f"code={code or '?'} cmd={cmd}")
    if not sender or not code or not is_drive_cmd(cmd):
        robot_log(f"[ROBOT_DRIVE][DROP] id={cmd_id} sender={bool(sender)} code={bool(code)} cmd={cmd}")
        return

    robot = robot_du_salon(code)
    if not robot:
        robot_log(f"[ROBOT_DRIVE][NO_ROBOT] id={cmd_id} code={code}")
        await emit_to(sid, "robot_drive_status", {
            "id": cmd_id, "cmd": cmd, "ok": False,
            "message": "Aucun robot connecte avec ce code", "by": "serveur",
        })
        return

    await emit_to(robot, "robot_drive", {"id": cmd_id, "cmd": cmd, "by": sender["pseudo"]})
    log_room_event(code, "robot_drive", {"cmd": cmd, "by": sender["pseudo"]})
    robot_log(f"[ROBOT_DRIVE][EMIT] id={cmd_id} cmd={cmd} by={sender['pseudo']} -> {robot}")
    await emit_to(sid, "robot_drive_confirmation", {"id": cmd_id, "ok": True, "cmd": cmd})


@on("robot_drive_status")
async def _robot_drive_status(sid, data):
    p = payload(data)
    sender = users.get(sid)
    code = p.get("code")
    cmd = str(p.get("cmd") or "").strip().upper()
    cmd_id = str(p.get("id") or f"{cmd}-{now_ms()}")
    robot_log(f"[ROBOT_DRIVE_STATUS][IN] id={cmd_id} from={(sender or {}).get('pseudo', '?')} code={code or '?'} "
              f"cmd={cmd} ok={bool(p.get('ok'))} msg={p.get('message') or ''}")
    if not code or not is_drive_cmd(cmd):
        robot_log(f"[ROBOT_DRIVE_STATUS][DROP] id={cmd_id} code={bool(code)} cmd={cmd}")
        return
    await emit_room(code, "robot_drive_status", {
        "id": cmd_id, "cmd": cmd, "ok": bool(p.get("ok")),
        "message": p.get("message") or "", "by": (sender or {}).get("pseudo") or "Robot",
    }, skip_sid=sid)


@on("robot_status_request")
async def _robot_status_request(sid, data):
    code = payload(data).get("code")
    sender = users.get(sid)
    robot_log(f"[ROBOT_STATUS_REQUEST][IN] socket={sid} sender={(sender or {}).get('pseudo', '?')} code={code or '?'}")
    if not sender or not code:
        return
    destinataires = sids_du_salon(code, sauf=sid)
    if not destinataires:
        robot_log(f"[ROBOT_STATUS_REQUEST][NO_RECIPIENT] code={code}")
        await emit_to(sid, "robot_status", {
            "fix": False, "coords": None, "arduinoConnected": False, "by": "serveur",
            "error": "Aucun robot connecte avec ce code", "ts": now_ms(),
        })
        return
    robot_log(f"[ROBOT_STATUS_REQUEST][EMIT] recipients={len(destinataires)}")
    await emit_room(code, "robot_status_request", {"by": sender["pseudo"]}, skip_sid=sid)


@on("robot_status")
async def _robot_status(sid, data):
    await marquer_robot(sid)
    p = payload(data)
    sender = users.get(sid)
    code, status = p.get("code"), p.get("status")
    st = status if isinstance(status, dict) else {}
    robot_log(f"[ROBOT_STATUS][IN] from={(sender or {}).get('pseudo', '?')} code={code or '?'} "
              f"fix={'yes' if st.get('fix') else 'no'} arduino={'yes' if st.get('arduinoConnected') else 'no'}")
    if not code or not status:
        return
    await emit_room(code, "robot_status", {**st, "by": (sender or {}).get("pseudo") or "Robot", "ts": now_ms()},
                    skip_sid=sid)


@on("robot_frame")
async def _robot_frame(sid, data):
    p = payload(data)
    code, jpeg = p.get("code"), p.get("jpeg")
    if code and jpeg:
        await emit_room(code, "robot_frame", {"jpeg": jpeg}, skip_sid=sid)


@on("robot_camera")
async def _robot_camera(sid, data):
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_camera", {"on": bool(p.get("on"))}, skip_sid=sid)


@on("robot_cam_move")
async def _robot_cam_move(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_cam_move", data):
        return
    p = payload(data)
    code = p.get("code")
    if not code:
        return
    out = {"center": bool(p.get("center")), "id": str(p.get("id") or f"cam-{now_ms()}")}
    pan, tilt = _clamp_servo(p.get("pan")), _clamp_servo(p.get("tilt"))
    if pan is not None:
        out["pan"] = pan
    if tilt is not None:
        out["tilt"] = tilt
    if p.get("view") in ("front", "rear", "both"):
        out["view"] = p["view"]
    await emit_room(code, "robot_cam_move", out, skip_sid=sid)


@on("robot_audio")
async def _robot_audio(sid, data):
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_audio", {"on": bool(p.get("on"))}, skip_sid=sid)


@on("robot_rtc")
async def _robot_rtc(sid, data):
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_rtc", {"on": bool(p.get("on"))}, skip_sid=sid)


async def _post_sdp(path: str, sdp: str, auth: str | None = None) -> dict:
    headers = {"Content-Type": "application/sdp"}
    if auth:
        headers["Authorization"] = auth
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(f"{MTX_BASE}{path}", content=sdp.encode(), headers=headers)
    return {"status": r.status_code, "sdp": r.text, "location": r.headers.get("location")}


@on("rtc_offer")
async def _rtc_offer(sid, data):
    p = payload(data)
    code, sdp, kind = p.get("code"), p.get("sdp"), p.get("kind")
    if not code or not sdp or not isinstance(sdp, str):
        return {"status": 400}
    chemin = f"robot-{code}-audio" if kind == "audio" else f"robot-{code}"
    try:
        return await _post_sdp(f"/{chemin}/whep", sdp)
    except Exception:
        return {"status": 502}


@on("rtc_publish_offer")
async def _rtc_publish_offer(sid, data):
    if await refuse_si_pas_pilote(sid, "rtc_publish_offer", data):
        return
    p = payload(data)
    code, sdp = p.get("code"), p.get("sdp")
    if not code or not sdp or not isinstance(sdp, str):
        log(f"[TALK] offre invalide (code={code or '-'}, sdp={type(sdp).__name__}).")
        return {"status": 400}
    log(f"[TALK] offre de publication pour {code} ({len(sdp)} octets de SDP).")
    auth = "Basic " + base64.b64encode(f"{MTX_USER}:{MTX_PASS}".encode()).decode()
    try:
        r = await _post_sdp(f"/robot-{code}-talk/whip", sdp, auth)
    except Exception as e:
        log(f"[TALK] MediaMTX injoignable : {e}")
        return {"status": 502}
    if 200 <= r["status"] < 300:
        log(f"[TALK] MediaMTX accepte la publication ({r['status']}).")
    else:
        log(f"[TALK] MediaMTX REFUSE ({r['status']}) : {r['sdp'][:200]}")
    return r


@on("robot_talk_live")
async def _robot_talk_live(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_talk_live", data):
        return
    p = payload(data)
    log(f"[TALK] lecture par le robot : {'DEMARRER' if p.get('on') else 'ARRETER'} ({p.get('code') or '-'}).")
    if p.get("code"):
        await emit_room(p["code"], "robot_talk_live", {"on": bool(p.get("on"))}, skip_sid=sid)


_RE_WHEP = re.compile(r"^/robot-[A-Za-z0-9_-]+/whep/[A-Za-z0-9-]+$")


@on("rtc_stop")
async def _rtc_stop(sid, data):
    location = payload(data).get("location")
    if not isinstance(location, str) or not _RE_WHEP.match(location):
        return
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.delete(f"{MTX_BASE}{location}")
    except Exception:
        pass


@on("robot_listen")
async def _robot_listen(sid, data):
    code = payload(data).get("code")
    if code:
        await emit_room(code, "robot_listen", {}, skip_sid=sid)


@on("robot_say")
async def _robot_say(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_say", data):
        return
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_say", {"text": str(p.get("text") or "")[:300]}, skip_sid=sid)


@on("robot_voice")
async def _robot_voice(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_voice", data):
        return
    p = payload(data)
    code, b64 = p.get("code"), p.get("b64")
    if not code or not b64 or not isinstance(b64, str):
        return
    if len(b64) > 2 * 1024 * 1024:
        return
    ext = re.sub(r"[^a-z0-9]", "", str(p.get("ext") or "m4a"), flags=re.I)[:5]
    await emit_room(code, "robot_voice", {"b64": b64, "ext": ext}, skip_sid=sid)


@on("robot_nav")
async def _robot_nav(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_nav", data):
        return
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_nav", {"target": p.get("target"), "on": bool(p.get("on"))}, skip_sid=sid)


@on("robot_nav_status")
async def _robot_nav_status(sid, data):
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_nav_status",
                        {"arrived": bool(p.get("arrived")), "on": bool(p.get("on"))}, skip_sid=sid)


@on("robot_rt")
async def _robot_rt(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_rt", data):
        return
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_rt", {"on": bool(p.get("on"))}, skip_sid=sid)


@on("robot_record_hd")
async def _robot_record_hd(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_record_hd", data):
        return
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_record_hd", {"on": bool(p.get("on"))}, skip_sid=sid)


@on("robot_record_hd_status")
async def _robot_record_hd_status(sid, data):
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_record_hd_status", p, skip_sid=sid)


@on("robot_ronde")
async def _robot_ronde(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_ronde", data):
        return
    p = payload(data)
    if not p.get("code") or not p.get("action"):
        return
    await emit_room(p["code"], "robot_ronde", {"action": str(p["action"])}, skip_sid=sid)


@on("robot_ronde_status")
async def _robot_ronde_status(sid, data):
    p = dict(payload(data))
    code = p.pop("code", None)
    if code:
        await emit_room(code, "robot_ronde_status", p, skip_sid=sid)


@on("robot_stop_all")
async def _robot_stop_all(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_stop_all", data):
        return
    code = payload(data).get("code")
    if not code:
        return
    try:
        from app.services import voice_brain

        await voice_brain.tout_arreter(code)
    except Exception as e:
        log("[STOP] voice-brain indisponible :", e)
    await emit_room(code, "robot_stop_all", {}, skip_sid=sid)
    await emit_room(code, "robot_drive", {"id": f"stopall-{now_ms()}", "cmd": "S", "by": "arret-urgence"}, skip_sid=sid)
    await emit_room(code, "robot_nav", {"on": False}, skip_sid=sid)
    await emit_room(code, "robot_ronde", {"action": "arreter"}, skip_sid=sid)
    await emit_room(code, "robot_rt", {"on": False}, skip_sid=sid)
    log_room_event(code, "robot_stop_all", {})


@on("robot_mode")
async def _robot_mode(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_mode", data):
        return
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_mode", {"absent": bool(p.get("absent"))}, skip_sid=sid)
        log_room_event(p["code"], "robot_mode", {"absent": bool(p.get("absent"))})


@on("robot_mode_status")
async def _robot_mode_status(sid, data):
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_mode_status", {"absent": bool(p.get("absent"))}, skip_sid=sid)


@on("robot_alarme")
async def _robot_alarme(sid, data):
    if await refuse_si_pas_pilote(sid, "robot_alarme", data):
        return
    p = payload(data)
    if p.get("code"):
        out = {"on": bool(p.get("on"))}
        if "texte" in p:
            out["texte"] = p.get("texte")
        await emit_room(p["code"], "robot_alarme", out, skip_sid=sid)
        log_room_event(p["code"], "robot_alarme", {"on": bool(p.get("on"))})


@on("robot_alarme_status")
async def _robot_alarme_status(sid, data):
    p = payload(data)
    if p.get("code"):
        await emit_room(p["code"], "robot_alarme_status", {"on": bool(p.get("on"))}, skip_sid=sid)
