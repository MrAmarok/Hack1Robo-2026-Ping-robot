from __future__ import annotations

import asyncio
import itertools

import httpx
import pytest
import socketio

pytestmark = pytest.mark.asyncio

_codes = itertools.count(1000)


def nouveau_code() -> str:
    return f"T{next(_codes)}"


class Client:
    def __init__(self):
        self.sio = socketio.AsyncClient(reconnection=False)
        self.recus: list[tuple[str, object]] = []

        @self.sio.on("*")
        async def _tout(event, *args):
            self.recus.append((event, args[0] if args else None))

    async def connecter(self, url: str):
        await self.sio.connect(url, transports=["websocket"])
        return self

    async def attendre(self, event: str, timeout: float = 3, filtre=None):
        fin = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < fin:
            for ev, data in self.recus:
                if ev == event and (filtre is None or filtre(data)):
                    return data
            await asyncio.sleep(0.02)
        raise AssertionError(
            f"'{event}' non recu ; recu : {[e for e, _ in self.recus]}"
        )

    def a_recu(self, event: str) -> bool:
        return any(ev == event for ev, _ in self.recus)

    async def fermer(self):
        await self.sio.disconnect()


async def salon(serveur, code):
    pilote = await Client().connecter(serveur)
    await pilote.sio.emit("pair", {"pseudo": "Andy", "code": code})
    assert (await pilote.attendre("role_acces"))["role"] == "pilote"
    robot = await Client().connecter(serveur)
    await robot.sio.emit("pair", {"pseudo": "Robot", "code": code, "robot": True})
    await pilote.attendre("user_joined", filtre=lambda d: d["pseudo"] == "Robot")
    return pilote, robot


async def test_election_du_pilote_et_admission(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    assert not robot.a_recu("role_acces")

    invite = await Client().connecter(serveur)
    await invite.sio.emit("pair", {"pseudo": "Zoe", "code": code})
    assert (await invite.attendre("role_acces"))["role"] == "attente"
    demande = await pilote.attendre("acces_demande")
    assert demande["pseudo"] == "Zoe"

    await pilote.sio.emit("acces_reponse", {"id": demande["id"], "accepte": True})
    assert await invite.attendre(
        "role_acces", filtre=lambda d: d["role"] == "spectateur"
    )
    await invite.sio.emit("robot_drive", {"code": code, "cmd": "F"})
    assert (await invite.attendre("acces_refuse_commande"))["commande"] == "robot_drive"

    await pilote.fermer()
    promu = await invite.attendre("role_acces", filtre=lambda d: d["role"] == "pilote")
    assert promu["raison"] == "le pilote precedent est parti"
    for c in (robot, invite):
        await c.fermer()


async def test_pilotage_relaye_au_robot(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)

    await pilote.sio.emit("robot_drive", {"code": code, "cmd": "m100,-40", "id": "c1"})
    recu = await robot.attendre("robot_drive")
    assert recu == {"id": "c1", "cmd": "M100,-40", "by": "Andy"}
    assert (await pilote.attendre("robot_drive_confirmation"))["ok"] is True

    await pilote.sio.emit("robot_drive", {"code": code, "cmd": "BOUM", "id": "c2"})
    await asyncio.sleep(0.3)
    assert [d["id"] for e, d in robot.recus if e == "robot_drive"] == ["c1"]

    await robot.sio.emit(
        "robot_drive_status", {"code": code, "cmd": "M100,-40", "ok": True, "id": "c1"}
    )
    st = await pilote.attendre("robot_drive_status")
    assert st["ok"] is True and st["by"] == "Robot"
    for c in (pilote, robot):
        await c.fermer()


async def test_robot_status_et_cam_move(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)

    await robot.sio.emit(
        "robot_status", {"code": code, "status": {"fix": True, "obstacleCm": 40}}
    )
    st = await pilote.attendre("robot_status")
    assert (
        st["fix"] is True
        and st["obstacleCm"] == 40
        and st["by"] == "Robot"
        and st["ts"] > 0
    )

    await pilote.sio.emit(
        "robot_cam_move",
        {"code": code, "pan": 250, "tilt": "45.4", "view": "rear", "id": "k"},
    )
    mv = await robot.attendre("robot_cam_move")
    assert mv == {"center": False, "id": "k", "pan": 180, "tilt": 45, "view": "rear"}
    for c in (pilote, robot):
        await c.fermer()


async def test_image_binaire_et_accuse(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    image = b"\xff\xd8\xff" + bytes(range(256)) * 10

    accuse = await robot.sio.call(
        "robot_frame", {"code": code, "jpeg": image}, timeout=3
    )
    assert accuse is None
    recu = await pilote.attendre("robot_frame")
    assert recu["jpeg"] == image
    for c in (pilote, robot):
        await c.fermer()


async def test_webrtc_sans_mediamtx(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    r = await pilote.sio.call("rtc_offer", {"code": code, "sdp": "v=0"}, timeout=5)
    assert r == {"status": 502}
    r = await pilote.sio.call("rtc_offer", {"code": code}, timeout=5)
    assert r == {"status": 400}
    for c in (pilote, robot):
        await c.fermer()


async def test_arret_urgence(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    await pilote.sio.emit("robot_stop_all", {"code": code})
    await robot.attendre("robot_stop_all")
    assert (await robot.attendre("robot_drive"))["cmd"] == "S"
    assert (await robot.attendre("robot_nav"))["on"] is False
    assert (await robot.attendre("robot_ronde"))["action"] == "arreter"
    assert (await robot.attendre("robot_rt"))["on"] is False
    for c in (pilote, robot):
        await c.fermer()


async def test_rattrapage_et_sync(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    await pilote.sio.emit("robot_mode", {"code": code, "absent": True})
    await robot.attendre("robot_mode")
    await pilote.sio.emit("sync", {"code": code, "since": 0})
    lot = await pilote.attendre("sync_batch")
    assert any(i["type"] == "robot_mode" for i in lot["items"])
    for c in (pilote, robot):
        await c.fermer()


async def test_routes_http(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    async with httpx.AsyncClient(base_url=serveur) as http:
        assert (await http.get("/")).text == "OK"
        r = await http.post(
            "/robot-drive", json={"code": code, "cmd": "s", "from": "test"}
        )
        assert r.status_code == 200 and r.json()["recipients"] == 2
        assert (await robot.attendre("robot_drive"))["by"] == "test"
        assert (
            await http.post("/robot-drive", json={"code": code, "cmd": "??"})
        ).status_code == 400
        assert (await http.get("/alertes", params={"code": code})).json() == {
            "alertes": []
        }
        assert (await http.get("/alertes")).status_code == 400
        assert (
            await http.get("/alerte-photo", params={"code": code})
        ).status_code == 404
        assert (await http.get("/enregistrements", params={"code": code})).json() == {
            "videos": []
        }
        assert (
            await http.get("/enregistrement", params={"f": "../x.mp4"})
        ).status_code == 400
        assert (await http.post("/register-token", json={})).status_code == 400
        r = await http.post(
            "/register-token",
            json={"token": "ExponentPushToken[abc]", "code": code, "pseudo": "Andy"},
        )
        assert r.json() == {"message": "Token enregistré"}
        r = await http.get("/rtc/robot-x/whep")
        assert r.status_code == 502
        assert "ping://" in (await http.get("/ouvrir", params={"code": code})).text
    for c in (pilote, robot):
        await c.fermer()


async def test_alerte_refusee_si_pas_robot(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    await pilote.sio.emit("robot_alerte", {"code": code, "type": "bruit"})
    await asyncio.sleep(0.3)
    assert not robot.a_recu("robot_alerte")
    await robot.sio.emit(
        "robot_alerte", {"code": code, "type": "mouvement", "niveau": 3}
    )
    al = await pilote.attendre("robot_alerte")
    assert al == {"type": "mouvement", "niveau": 3, "photo": False}
    async with httpx.AsyncClient(base_url=serveur) as http:
        for _ in range(50):
            hist = (await http.get("/alertes", params={"code": code})).json()["alertes"]
            if hist:
                break
            await asyncio.sleep(0.1)
    assert hist and hist[0]["type"] == "mouvement" and hist[0]["categorie"] == "rien"
    for c in (pilote, robot):
        await c.fermer()
