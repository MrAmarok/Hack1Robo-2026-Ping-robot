from __future__ import annotations

import asyncio

import httpx
import pytest

from app.core import config
from tests.test_integration import Client, nouveau_code, salon

pytestmark = pytest.mark.asyncio


async def spectateur(serveur, code, pilote) -> Client:
    invite = await Client().connecter(serveur)
    await invite.sio.emit("pair", {"pseudo": "Zoe", "code": code})
    demande = await pilote.attendre("acces_demande")
    await pilote.sio.emit("acces_reponse", {"id": demande["id"], "accepte": True})
    await invite.attendre("role_acces", filtre=lambda d: d["role"] == "spectateur")
    return invite


async def pilote_ailleurs(serveur) -> Client:
    autre = await Client().connecter(serveur)
    await autre.sio.emit("pair", {"pseudo": "Eve", "code": nouveau_code()})
    assert (await autre.attendre("role_acces"))["role"] == "pilote"
    return autre


def robot_qui_repond(robot: Client, reponse: dict | None) -> list:
    """Branche un gestionnaire `drive` sur le robot de test ; il note chaque ordre recu."""
    recus: list = []

    @robot.sio.on("drive")
    async def _drive(data):
        recus.append(data)
        return reponse

    return recus


async def attendre_liste(liste: list, n: int = 1, timeout: float = 2) -> None:
    fin = asyncio.get_running_loop().time() + timeout
    while len(liste) < n and asyncio.get_running_loop().time() < fin:
        await asyncio.sleep(0.02)


async def fermer(*clients: Client) -> None:
    for c in clients:
        await c.fermer()


async def test_drive_accuse_de_bout_en_bout(serveur):
    pilote, robot = await salon(serveur, nouveau_code())
    recus = robot_qui_repond(robot, {"ok": True, "arduino": True})
    r = await pilote.sio.call("drive", {"cmd": "f", "ack": True}, timeout=3)
    assert r == {"ok": True, "cmd": "F", "arduino": True}
    assert recus == [{"cmd": "F"}]
    await fermer(pilote, robot)


async def test_drive_erreur_remontee_par_le_robot(serveur):
    pilote, robot = await salon(serveur, nouveau_code())
    robot_qui_repond(robot, {"ok": False, "arduino": False})
    r = await pilote.sio.call("drive", {"cmd": "S", "ack": True}, timeout=3)
    assert r == {"ok": False, "cmd": "S", "arduino": False, "erreur": "commande non transmise a l'Arduino"}
    await fermer(pilote, robot)


async def test_drive_maintien_sans_accuse(serveur):
    pilote, robot = await salon(serveur, nouveau_code())
    recus = robot_qui_repond(robot, None)
    for _ in range(3):
        await pilote.sio.emit("drive", {"cmd": "M100,-40"})
    await attendre_liste(recus, 3)
    assert recus == [{"cmd": "M100,-40"}] * 3
    await fermer(pilote, robot)


async def test_drive_robot_sans_gestionnaire(serveur):
    # Robot pas encore mis a jour : il ne connait pas `drive`.
    pilote, robot = await salon(serveur, nouveau_code())
    r = await pilote.sio.call("drive", {"cmd": "F", "ack": True}, timeout=3)
    assert r == {"ok": False, "cmd": "F", "erreur": "le robot n'a pas repondu"}
    await fermer(pilote, robot)


async def test_drive_reserve_au_pilote_de_son_salon(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    recus = robot_qui_repond(robot, {"ok": True})
    spect = await spectateur(serveur, code, pilote)
    r = await spect.sio.call("drive", {"cmd": "F", "ack": True}, timeout=3)
    assert r == {"ok": False, "erreur": "seul le pilote peut conduire"}

    # Le code du message est ignore : le pilote d'un autre salon ne vise que le sien.
    autre = await pilote_ailleurs(serveur)
    r = await autre.sio.call("drive", {"code": code, "cmd": "F", "ack": True}, timeout=3)
    assert r == {"ok": False, "cmd": "F", "erreur": "robot hors ligne"}

    r = await pilote.sio.call("drive", {"cmd": "??", "ack": True}, timeout=3)
    assert r == {"ok": False, "cmd": "??", "erreur": "commande inconnue"}
    await asyncio.sleep(0.2)
    assert recus == []
    await fermer(pilote, robot, spect, autre)


async def test_robot_drive_reste_dans_son_salon_et_va_au_seul_robot(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    spect = await spectateur(serveur, code, pilote)

    autre = await pilote_ailleurs(serveur)
    await autre.sio.emit("robot_drive", {"code": code, "cmd": "F", "id": "intrus"})
    assert (await autre.attendre("acces_refuse_commande"))["commande"] == "robot_drive"

    await pilote.sio.emit("robot_drive", {"code": code, "cmd": "F", "id": "c1"})
    assert (await robot.attendre("robot_drive"))["id"] == "c1"
    await robot.sio.emit("robot_drive_status", {"code": code, "cmd": "F", "ok": True, "id": "c1"})
    await pilote.attendre("robot_drive_status")
    await asyncio.sleep(0.2)
    assert [d["id"] for e, d in robot.recus if e == "robot_drive"] == ["c1"]
    assert not spect.a_recu("robot_drive")
    assert not robot.a_recu("robot_drive_status")

    # Les autres commandes du pilote suivent la meme regle.
    await autre.sio.emit("robot_stop_all", {"code": code})
    await autre.attendre("acces_refuse_commande", filtre=lambda d: d["commande"] == "robot_stop_all")
    await asyncio.sleep(0.2)
    assert not robot.a_recu("robot_stop_all")
    await fermer(pilote, robot, spect, autre)


async def test_robot_drive_hold_can_skip_server_feedback(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    try:
        for cmd_id, feedback in (("hold", False), ("stop", True)):
            await pilote.sio.emit(
                "robot_drive", {"code": code, "cmd": "S", "id": cmd_id, "feedback": feedback}
            )
            relayed = await robot.attendre("robot_drive", filtre=lambda d: d["id"] == cmd_id)
            assert relayed["cmd"] == "S"
        await pilote.attendre("robot_drive_confirmation", filtre=lambda d: d["id"] == "stop")
        confirmations = [d["id"] for e, d in pilote.recus if e == "robot_drive_confirmation"]
        assert confirmations == ["stop"]
    finally:
        await fermer(pilote, robot)


async def test_buzz_de_commande_reserve_au_pilote(serveur):
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    spect = await spectateur(serveur, code, pilote)

    await spect.sio.emit("buzz", {"code": code, "message": "PING_ROBOT_DRIVE:x1:F"})
    await pilote.sio.emit("buzz", {"code": code, "message": "PING_ROBOT_DRIVE:x2:F"})
    await robot.attendre("buzz")
    await spect.sio.emit("buzz", {"code": code, "message": "Coucou"})
    await robot.attendre("buzz", filtre=lambda d: d["message"] == "Coucou")
    assert [d["message"] for e, d in robot.recus if e == "buzz"] == ["PING_ROBOT_DRIVE:x2:F", "Coucou"]
    assert not spect.a_recu("acces_refuse_commande")  # refus silencieux, robot_drive le signale deja
    await fermer(pilote, robot, spect)


async def test_cle_robot(serveur, monkeypatch):
    monkeypatch.setattr(config, "ROBOT_KEY", "secret")
    code = nouveau_code()
    pilote = await Client().connecter(serveur)
    await pilote.sio.emit("pair", {"pseudo": "Andy", "code": code})
    await pilote.attendre("role_acces")

    faux = await Client().connecter(serveur)
    await faux.sio.emit("pair", {"pseudo": "Faux", "code": code, "robot": True, "cle": "mauvaise"})
    assert (await faux.attendre("pair_refuse"))["raison"] == "cle robot invalide"

    robot = await Client().connecter(serveur)
    await robot.sio.emit("pair", {"pseudo": "Robot", "code": code, "robot": True, "cle": "secret"})
    await pilote.attendre("user_joined", filtre=lambda d: d["pseudo"] == "Robot")
    assert all(d["pseudo"] != "Faux" for e, d in pilote.recus if e == "user_joined")
    recus = robot_qui_repond(robot, {"ok": True})
    assert (await pilote.sio.call("drive", {"cmd": "S", "ack": True}, timeout=3))["ok"] is True
    assert recus == [{"cmd": "S"}]

    # Avec une cle configuree, envoyer robot_status ne donne plus les droits du robot.
    spect = await spectateur(serveur, code, pilote)
    await spect.sio.emit("robot_status", {"code": code, "status": {"fix": False, "arduinoConnected": False}})
    await asyncio.sleep(0.1)
    await spect.sio.emit("robot_drive", {"code": code, "cmd": "F"})
    assert (await spect.attendre("acces_refuse_commande"))["commande"] == "robot_drive"
    await fermer(pilote, faux, robot, spect)


async def test_post_robot_drive_seulement_avec_jeton(serveur, monkeypatch):
    monkeypatch.setattr(config, "ROBOT_HTTP_TOKEN", "jeton")
    code = nouveau_code()
    pilote, robot = await salon(serveur, code)
    corps = {"code": code, "cmd": "f", "from": "test", "id": "h1"}
    async with httpx.AsyncClient(base_url=serveur) as http:
        for entetes in ({}, {"Authorization": "Bearer faux"}):
            r = await http.post("/robot-drive", json=corps, headers=entetes)
            assert r.status_code == 200 and r.json()["relaye"] is False
        r = await http.post("/robot-drive", json=corps, headers={"Authorization": "Bearer jeton"})
        assert r.json() == {"ok": True, "id": "h1", "cmd": "F", "relaye": True}
    recu = await robot.attendre("robot_drive")
    assert recu == {"id": "h1", "cmd": "F", "by": "test"}
    await asyncio.sleep(0.2)
    assert len([d for e, d in robot.recus if e == "robot_drive"]) == 1
    assert not pilote.a_recu("robot_drive")
    await fermer(pilote, robot)
