from __future__ import annotations

import asyncio
import json
from urllib.parse import urlencode

import httpx
import pytest
from websockets.asyncio.client import connect

from app.core import config
from app.services import capteur
from tests.test_integration import nouveau_code

pytestmark = pytest.mark.asyncio


class Robot:
    def __init__(self, serveur: str, **params):
        self.url = serveur.replace("http://", "ws://") + "/ws/capteur?" + urlencode(params)

    async def __aenter__(self):
        self.ws = await connect(self.url)
        return self

    async def __aexit__(self, *exc):
        await self.ws.close()

    async def recevoir(self) -> dict:
        return json.loads(await asyncio.wait_for(self.ws.recv(), 3))

    async def envoyer(self, texte: str) -> dict:
        await self.ws.send(texte)
        return await self.recevoir()


async def test_envoi_et_stockage_csv(serveur):
    code = nouveau_code()
    async with Robot(serveur, code=code, session="essai-1") as r:
        assert await r.recevoir() == {"type": "bonjour", "code": code, "session": "essai-1", "lignes": 0}
        assert await r.envoyer("0,0,0,0,") == {"type": "ack", "recues": 1, "rejetees": 0, "total": 1}
        a = await r.envoyer("x_m,y_m,heading_deg,sensor_angle_deg,distance_cm\n0, 0, 0, 10, 143\r\n0.5,0,90,-30,87.5\n\n")
        assert a == {"type": "ack", "recues": 2, "rejetees": 0, "total": 3}
    assert capteur.chemin(code, "essai-1").read_text() == (
        "x_m,y_m,heading_deg,sensor_angle_deg,distance_cm\n0,0,0,0,\n0,0,0,10,143\n0.5,0,90,-30,87.5\n")


async def test_lignes_invalides_refusees_une_par_une(serveur):
    code = nouveau_code()
    async with Robot(serveur, code=code, session="essai-2") as r:
        await r.recevoir()
        a = await r.envoyer("0,0,0,0,50\n0,0,0\na,0,0,0,1\n0,0,0,0,-3\n0,0,nan,0,1\n1,1,1,1,1")
        assert a["recues"] == 2 and a["rejetees"] == 4 and a["total"] == 2
        assert [e["ligne"] for e in a["erreurs"]] == ["0,0,0", "a,0,0,0,1", "0,0,0,0,-3", "0,0,nan,0,1"]
        assert "5 champs" in a["erreurs"][0]["raison"] and "x_m" in a["erreurs"][1]["raison"]
        await r.ws.send(b"2,2,2,2,2")
        assert (await r.recevoir())["total"] == 3


async def test_reprise_apres_coupure_meme_session(serveur):
    code = nouveau_code()
    async with Robot(serveur, code=code, session="reprise") as r:
        await r.recevoir()
        await r.envoyer("0,0,0,0,1\n0,0,0,0,2")
    capteur._comptes.clear()
    async with Robot(serveur, code=code, session="reprise") as r:
        assert (await r.recevoir())["lignes"] == 2
        assert (await r.envoyer("0,0,0,0,3"))["total"] == 3
    async with Robot(serveur, code=code) as r:
        bonjour = await r.recevoir()
        assert bonjour["session"].startswith("s-") and bonjour["lignes"] == 0


async def test_erreurs_de_connexion(serveur, monkeypatch):
    for params, erreur in [({}, "code"), ({"code": "c", "session": "../x"}, "session")]:
        async with Robot(serveur, **params) as r:
            m = await r.recevoir()
            assert m["type"] == "erreur" and erreur in m["erreur"]
    monkeypatch.setattr(config, "ROBOT_KEY", "secret")
    async with Robot(serveur, code="c", cle="faux") as r:
        assert (await r.recevoir())["erreur"] == "cle robot invalide"
    async with Robot(serveur, code=nouveau_code(), cle="secret") as r:
        assert (await r.recevoir())["type"] == "bonjour"


async def test_session_trop_volumineuse(serveur, monkeypatch):
    code = nouveau_code()
    monkeypatch.setattr(config, "CAPTEUR_MAX_MO", 0)
    async with Robot(serveur, code=code, session="gros") as r:
        await r.recevoir()
        assert (await r.envoyer("0,0,0,0,1"))["type"] == "ack"
        assert (await r.envoyer("0,0,0,0,2"))["type"] == "erreur"


async def test_routes_http(serveur):
    code = nouveau_code()
    async with Robot(serveur, code=code, session="dl") as r:
        await r.recevoir()
        await r.envoyer("0,0,0,0,143\n0,0,0,0,")
    async with httpx.AsyncClient(base_url=serveur) as http:
        sessions = (await http.get("/capteur", params={"code": code})).json()["sessions"]
        assert sessions[0]["session"] == "dl" and sessions[0]["lignes"] == 2
        r = await http.get("/capteur/dl", params={"code": code})
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
        assert r.text.splitlines() == ["x_m,y_m,heading_deg,sensor_angle_deg,distance_cm", "0,0,0,0,143", "0,0,0,0,"]
        assert (await http.get("/capteur/inconnue", params={"code": code})).status_code == 404
        assert (await http.get("/capteur/dl")).status_code == 400
        assert (await http.get("/capteur")).status_code == 400
        assert (await http.get("/ws/capteur", params={"code": code})).status_code == 426
