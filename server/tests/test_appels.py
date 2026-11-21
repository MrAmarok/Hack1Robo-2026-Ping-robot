from __future__ import annotations

import asyncio
import base64
import json
import re
import sys
import types
from urllib.parse import parse_qs

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect, WebSocketState
from websockets.protocol import State

from app.core import sio as sio_mod
from app.services import appel_alerte as aa
from app.services import appel_direct as ad
from app.services import realtime_voix as rv

ENV_NETTOYES = [
    "OPENAI_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM",
    "ALERTE_APPEL_NUMERO",
    "ALERTE_APPEL_CADENCE_MS",
    "PUBLIC_URL",
    "APPEL_FLUX_URL",
    "APPEL_DUREE_MAX_MS",
    "APPEL_VAD_SEUIL",
    "PROCHE_NUMERO",
    "PROCHE_NOM",
    "OWNER_NAME",
    "ADRESSE_MAISON",
    "REALTIME_MODEL",
    "REALTIME_VOICE",
    "REALTIME_VEILLE",
]


@pytest.fixture(autouse=True)
def environnement(monkeypatch, tmp_path):
    for n in ENV_NETTOYES:
        monkeypatch.delenv(n, raising=False)
    monkeypatch.setattr(ad, "PUBLIC_URL", "https://api.ping-app.org")
    monkeypatch.setattr(aa, "FICHIER_REGLAGES", tmp_path / "appel-alerte.json")
    monkeypatch.setattr(aa, "_coupes", set())
    monkeypatch.setattr(aa, "_dernier_appel", 0)
    ad._attentes.clear()
    yield
    ad._attentes.clear()


def configurer_twilio(monkeypatch):
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC123")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "jeton-secret")
    monkeypatch.setenv("TWILIO_FROM", "+33100000000")
    monkeypatch.setenv("ALERTE_APPEL_NUMERO", "+33600000000")


class FauxTwilio:
    def __init__(self, ok: bool = True) -> None:
        self.appels: list[tuple] = []
        self.ok = ok

    async def __call__(self, to, twiml):
        self.appels.append((to, twiml))
        return (
            {"ok": True, "sid": f"CA{len(self.appels)}"} if self.ok else {"ok": False}
        )


def test_xml():
    assert aa.xml('a & b < c > d "e"') == "a &amp; b &lt; c &gt; d &quot;e&quot;"
    assert aa.xml("&lt;") == "&amp;lt;"
    assert aa.xml("l'apostrophe") == "l'apostrophe"
    assert aa.xml(12) == "12"
    assert ad.xml("<&>") == "&lt;&amp;&gt;"


def test_etat_et_reglage_persistant(monkeypatch):
    assert aa.etat_appel("R1") == {"actif": True, "configure": False}
    assert aa.regler_appel("R1", False) == {"actif": False, "configure": False}
    assert json.loads(aa.FICHIER_REGLAGES.read_text()) == {"coupes": ["R1"]}
    assert aa.FICHIER_REGLAGES.read_text() == '{"coupes":["R1"]}'
    monkeypatch.setattr(aa, "_coupes", set())
    aa._charger()
    assert aa.etat_appel("R1")["actif"] is False
    assert aa.etat_appel(1234)["actif"] is True
    configurer_twilio(monkeypatch)
    assert aa.regler_appel("R1", True) == {"actif": True, "configure": True}
    assert json.loads(aa.FICHIER_REGLAGES.read_text()) == {"coupes": []}
    aa.regler_appel(42, False)
    assert aa.etat_appel("42")["actif"] is False


def test_chargement_fichier_absent_ou_casse(monkeypatch):
    monkeypatch.setattr(aa, "_coupes", {"X"})
    aa.FICHIER_REGLAGES.write_text("{pas du json")
    aa._charger()
    assert aa._coupes == {"X"}
    aa.FICHIER_REGLAGES.write_text('{"coupes":[1,"B"]}')
    aa._charger()
    assert aa._coupes == {"1", "B"}


def test_sauvegarde_impossible(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(aa, "FICHIER_REGLAGES", tmp_path / "absent" / "x.json")
    assert aa.regler_appel("R1", False)["actif"] is False
    assert "[APPEL] reglage non enregistre :" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_appel_coupe_ou_non_configure(monkeypatch, capsys):
    faux = FauxTwilio()
    monkeypatch.setattr(aa, "lancer_appel_twilio", faux)
    assert await aa.appeler_alerte("R1", "10:00", None) is False
    assert "[APPEL] non configure (TWILIO_ACCOUNT_SID" in capsys.readouterr().out
    configurer_twilio(monkeypatch)
    aa.regler_appel("R1", False)
    assert await aa.appeler_alerte("R1", "10:00", None) is False
    assert (
        "[APPEL] R1 : appels coupes par l'utilisateur, pas d'appel."
        in capsys.readouterr().out
    )
    assert faux.appels == []


@pytest.mark.asyncio
async def test_cadence_commune_a_tous_les_robots(monkeypatch, capsys):
    configurer_twilio(monkeypatch)
    faux = FauxTwilio()
    monkeypatch.setattr(aa, "lancer_appel_twilio", faux)
    assert await aa.appeler_alerte("R1", "10:00", "Un homme.") is True
    assert "[APPEL] R1 : appel lance (CA1)." in capsys.readouterr().out
    assert await aa.appeler_alerte("R1", "10:01", None) is False
    assert await aa.appeler_alerte("R2", "10:01", None) is False
    assert (
        "[APPEL] R2 : deja appele il y a 0 s, pas de nouvel appel."
        in capsys.readouterr().out
    )
    assert len(faux.appels) == 1
    monkeypatch.setattr(aa, "_dernier_appel", aa._dernier_appel - 600001)
    assert await aa.appeler_alerte("R2", "10:11", None) is True
    monkeypatch.setenv("ALERTE_APPEL_CADENCE_MS", "0")
    assert await aa.appeler_alerte("R2", "10:12", None) is True
    assert len(faux.appels) == 3


@pytest.mark.asyncio
async def test_echec_libere_la_cadence(monkeypatch):
    configurer_twilio(monkeypatch)
    faux = FauxTwilio(ok=False)
    monkeypatch.setattr(aa, "lancer_appel_twilio", faux)
    assert await aa.appeler_alerte("R1", "10:00", None) is False
    assert aa._dernier_appel == 0
    faux.ok = True
    assert await aa.appeler_alerte("R1", "10:00", None) is True
    assert aa._dernier_appel != 0


@pytest.mark.asyncio
async def test_repli_message_lu_sans_openai(monkeypatch, capsys):
    configurer_twilio(monkeypatch)
    faux = FauxTwilio()
    monkeypatch.setattr(aa, "lancer_appel_twilio", faux)
    assert (
        await aa.appeler_alerte("R1", "03:12", 'Un "homme" <cagoule> & gants.') is True
    )
    to, twiml = faux.appels[0]
    assert to == "+33600000000"
    msg = (
        "Alerte du robot. Quelqu'un a été vu dans la maison à 03:12. "
        "Un &quot;homme&quot; &lt;cagoule&gt; &amp; gants. La photo est dans l'application."
    )
    assert twiml == (
        "<Response>"
        f'<Say language="fr-FR" voice="Polly.Lea">{msg}</Say>'
        '<Pause length="1"/>'
        f'<Say language="fr-FR" voice="Polly.Lea">{msg}</Say>'
        "</Response>"
    )
    assert (
        "[TEL] OPENAI_API_KEY absente : appel en message lu, sans conversation."
        in capsys.readouterr().out
    )
    monkeypatch.setenv("ALERTE_APPEL_CADENCE_MS", "0")
    await aa.appeler_alerte("R1", "03:13", None)
    assert (
        "dans la maison à 03:13. La photo est dans l'application.</Say>"
        in faux.appels[1][1]
    )


@pytest.mark.asyncio
async def test_appel_branche_sur_l_assistant(monkeypatch):
    configurer_twilio(monkeypatch)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    faux = FauxTwilio()
    monkeypatch.setattr(aa, "lancer_appel_twilio", faux)
    assert await aa.appeler_alerte(77, "03:12", "Un homme.") is True
    twiml = faux.appels[0][1]
    m = re.fullmatch(
        r'<Response><Connect><Stream url="wss://api\.ping-app\.org/ping/twilio-flux">'
        r'<Parameter name="jeton" value="([0-9a-f]{32})"/></Stream></Connect></Response>',
        twiml,
    )
    assert m
    a = ad._attentes[m.group(1)]
    assert a["code"] == "77" and a["heure"] == "03:12" and a["phrase"] == "Un homme."


def brancher_transport(monkeypatch, gestionnaire):
    monkeypatch.setattr(
        aa,
        "_client",
        lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(gestionnaire), timeout=10
        ),
    )


@pytest.mark.asyncio
async def test_lancer_appel_twilio_succes(monkeypatch):
    configurer_twilio(monkeypatch)
    vues: list[httpx.Request] = []

    def gestionnaire(req: httpx.Request) -> httpx.Response:
        vues.append(req)
        return httpx.Response(201, json={"sid": "CA999", "status": "queued"})

    brancher_transport(monkeypatch, gestionnaire)
    r = await aa.lancer_appel_twilio(
        "+33611111111", "<Response><Say>é &amp;</Say></Response>"
    )
    assert r == {"ok": True, "sid": "CA999"}
    req = vues[0]
    assert req.method == "POST"
    assert str(req.url) == "https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json"
    assert (
        req.headers["authorization"]
        == "Basic " + base64.b64encode(b"AC123:jeton-secret").decode()
    )
    assert req.headers["content-type"] == "application/x-www-form-urlencoded"
    corps = parse_qs(req.content.decode())
    assert corps == {
        "To": ["+33611111111"],
        "From": ["+33100000000"],
        "Twiml": ["<Response><Say>é &amp;</Say></Response>"],
    }


@pytest.mark.asyncio
async def test_lancer_appel_twilio_refus(monkeypatch, capsys):
    configurer_twilio(monkeypatch)
    brancher_transport(
        monkeypatch,
        lambda req: httpx.Response(400, json={"message": "numero invalide"}),
    )
    assert await aa.lancer_appel_twilio("+1", "<Response/>") == {"ok": False}
    assert (
        "[APPEL] refus Twilio (HTTP 400) : numero invalide" in capsys.readouterr().out
    )
    brancher_transport(
        monkeypatch, lambda req: httpx.Response(500, text="<html>panne</html>")
    )
    assert await aa.lancer_appel_twilio("+1", "<Response/>") == {"ok": False}
    assert "[APPEL] refus Twilio (HTTP 500) : sans detail" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_lancer_appel_twilio_reseau(monkeypatch, capsys):
    configurer_twilio(monkeypatch)

    def gestionnaire(req):
        raise httpx.ConnectError("connexion refusee")

    brancher_transport(monkeypatch, gestionnaire)
    assert await aa.lancer_appel_twilio("+1", "<Response/>") == {"ok": False}
    assert "[APPEL] appel impossible : connexion refusee" in capsys.readouterr().out


def test_url_flux(monkeypatch):
    assert ad.url_flux() == "wss://api.ping-app.org/ping/twilio-flux"
    monkeypatch.setenv("PUBLIC_URL", "https://exemple.org/")
    assert ad.url_flux() == "wss://exemple.org/ping/twilio-flux"
    monkeypatch.setenv("PUBLIC_URL", "http://exemple.org")
    assert ad.url_flux() == "ws://exemple.org/ping/twilio-flux"
    monkeypatch.setenv("APPEL_FLUX_URL", "wss://autre/flux")
    assert ad.url_flux() == "wss://autre/flux"


def test_twiml_conversation(monkeypatch, capsys):
    assert ad.twiml_conversation("R1", "10:00", None) is None
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("PUBLIC_URL", "http://exemple.org")
    assert ad.twiml_conversation("R1", "10:00", None) is None
    assert (
        "[TEL] adresse de flux non chiffree (ws://exemple.org/ping/twilio-flux) : appel en message lu."
        in (capsys.readouterr().out)
    )
    monkeypatch.setenv("APPEL_FLUX_URL", 'wss://h/f?a=1&b="2"')
    twiml = ad.twiml_conversation("R1", "10:00", "phrase")
    assert '<Stream url="wss://h/f?a=1&amp;b=&quot;2&quot;">' in twiml
    jeton = re.search(r'value="([0-9a-f]{32})"', twiml).group(1)
    a = ad._attentes[jeton]
    assert a["code"] == "R1" and a["phrase"] == "phrase"
    assert a["expire"] - rv.now_ms() <= ad.VALIDITE_JETON_MS
    a["expire"] = 0
    ad.twiml_conversation("R2", "10:01", None)
    assert jeton not in ad._attentes and len(ad._attentes) == 1


def test_consignes_telephone(monkeypatch):
    c = ad._consignes_telephone("03:12", None)
    assert c.startswith("APPEL TELEPHONIQUE. Tu parles a Andy AU TELEPHONE")
    assert "a 03:12. Tu ne parles PAS" in c
    assert "l'adresse de la maison, et la description" in c
    assert "prevenir_proche" not in c
    monkeypatch.setenv("OWNER_NAME", "Lea")
    monkeypatch.setenv("ADRESSE_MAISON", "3 rue Haute")
    monkeypatch.setenv("PROCHE_NUMERO", "+33622222222")
    c = ad._consignes_telephone("03:12", "un homme")
    assert "a 03:12 (sur la photo : un homme). " in c
    assert "l'adresse, 3 rue Haute, et la description" in c
    assert (
        "Tu peux aussi prevenir son proche avec prevenir_proche, si Lea le demande" in c
    )
    monkeypatch.setenv("PROCHE_NOM", "Paul")
    assert "prevenir Paul avec" in ad._consignes_telephone("x", None)


@pytest.mark.asyncio
async def test_outils_telephone(monkeypatch, capsys):
    emis: list[tuple] = []

    async def emit_room(room, event, data=None, skip_sid=None):
        emis.append((room, event, data))

    monkeypatch.setattr(ad, "emit_room", emit_room)
    outils = ad._outils_telephone("R1")
    assert [o["declaration"]["name"] for o in outils] == ["alarme", "dire_par_le_robot"]
    alarme, dire = (o["executer"] for o in outils)
    assert await alarme({"on": True}) == [
        {"type": "text", "text": "Sirene declenchee."}
    ]
    assert await alarme({"on": False}) == [{"type": "text", "text": "Sirene arretee."}]
    assert await dire({"texte": "  Sortez !  "}) == [
        {"type": "text", "text": "Phrase prononcee par le robot."}
    ]
    assert await dire({"texte": "   "}) == [{"type": "text", "text": "Rien a dire."}]
    await dire({"texte": "x" * 400})
    assert emis == [
        ("R1", "robot_alarme", {"on": True}),
        ("R1", "robot_alarme", {"on": False}),
        ("R1", "robot_say", {"text": "Sortez !"}),
        ("R1", "robot_say", {"text": "x" * 300}),
    ]
    out = capsys.readouterr().out
    assert "[TEL] R1 : sirene declenchee par l'assistant." in out
    assert '[TEL] R1 : le robot dit "Sortez !"' in out


@pytest.mark.asyncio
async def test_prevenir_proche(monkeypatch, capsys):
    monkeypatch.setenv("PROCHE_NUMERO", "+33622222222")
    monkeypatch.setenv("PROCHE_NOM", "Paul")
    monkeypatch.setenv("ADRESSE_MAISON", "3 rue <Haute>")
    faux = FauxTwilio(ok=False)
    monkeypatch.setattr(aa, "lancer_appel_twilio", faux)
    outils = ad._outils_telephone("R1")
    decl = outils[2]["declaration"]
    assert decl["name"] == "prevenir_proche"
    assert decl["description"] == (
        "Appelle Paul et lui lit un message d'alerte avec l'adresse. "
        "A utiliser seulement si Andy le demande ou l'accepte."
    )
    prevenir = outils[2]["executer"]
    assert await prevenir({"message": "Un intrus."}) == [
        {"type": "text", "text": "L'appel a Paul a echoue."}
    ]
    faux.ok = True
    assert await prevenir({"message": "Un intrus."}) == [
        {"type": "text", "text": "Paul est en train d'etre appele."}
    ]
    assert await prevenir({"message": "Encore."}) == [
        {"type": "text", "text": "Paul a deja ete appele pendant cet appel."}
    ]
    assert len(faux.appels) == 2
    to, twiml = faux.appels[1]
    texte = (
        "Message automatique du robot de surveillance de Andy. "
        "Une personne a été vue chez lui, au 3 rue &lt;Haute&gt;. Un intrus. "
        "Andy vous demande de vérifier, et d'appeler le 17 si nécessaire."
    )
    assert to == "+33622222222"
    assert twiml == (
        f'<Response><Say language="fr-FR" voice="Polly.Lea">{texte}</Say><Pause length="1"/>'
        f'<Say language="fr-FR" voice="Polly.Lea">{texte}</Say></Response>'
    )
    assert "[TEL] R1 : Paul prevenu (CA2)." in capsys.readouterr().out


class FakeConn:
    def __init__(self) -> None:
        self.envoyes: list[dict] = []
        self._entrants: asyncio.Queue = asyncio.Queue()
        self.state = State.OPEN
        self.close_code = None
        self.close_reason = ""

    async def send(self, texte):
        self.envoyes.append(json.loads(texte))

    async def close(self, code=1000, reason=""):
        if self.state is State.CLOSED:
            return
        self.state = State.CLOSED
        self.close_code, self.close_reason = code, reason
        self._entrants.put_nowait(None)

    def fermer_par_pair(self, code=1000):
        self.state = State.CLOSED
        self.close_code = code
        self._entrants.put_nowait(None)

    def pousser(self, ev):
        self._entrants.put_nowait(json.dumps(ev))

    def types(self):
        return [m.get("type") for m in self.envoyes]

    def __aiter__(self):
        return self

    async def __anext__(self):
        m = await self._entrants.get()
        if m is None:
            raise StopAsyncIteration
        return m


class FauxFluxTwilio:
    def __init__(self) -> None:
        self.client_state = WebSocketState.CONNECTED
        self.application_state = WebSocketState.CONNECTED
        self._entrants: asyncio.Queue = asyncio.Queue()
        self.envoyes: list[dict] = []
        self.ferme = False

    async def receive(self):
        m = await self._entrants.get()
        if m["type"] == "websocket.disconnect":
            self.client_state = WebSocketState.DISCONNECTED
        return m

    async def send_text(self, t):
        assert self.application_state == WebSocketState.CONNECTED
        self.envoyes.append(json.loads(t))

    async def close(self, code=1000, reason=None):
        assert (
            self.application_state == WebSocketState.CONNECTED
        ), "close() appele deux fois"
        self.application_state = WebSocketState.DISCONNECTED
        self.ferme = True
        self._entrants.put_nowait({"type": "websocket.disconnect", "code": code})

    def pousser(self, m):
        self._entrants.put_nowait({"type": "websocket.receive", "text": json.dumps(m)})


async def attendre(cond, delai=2.0):
    fin = asyncio.get_running_loop().time() + delai
    while not cond():
        if asyncio.get_running_loop().time() > fin:
            raise AssertionError("condition jamais remplie")
        await asyncio.sleep(0.005)


class Banc:
    def __init__(self) -> None:
        self.emis: list[tuple] = []
        self.conns: list[FakeConn] = []
        self.outils: list[tuple] = []

    async def emit_room(self, room, event, data=None, skip_sid=None):
        self.emis.append((room, event, data))

    async def connecter(self, url, cle):
        c = FakeConn()
        self.conns.append(c)
        return c

    async def run_tool(self, name, input, ctx):
        self.outils.append((name, input, ctx))
        return [{"type": "text", "text": "Photo regardee."}]


@pytest_asyncio.fixture
async def banc(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    b = Banc()
    vb = types.ModuleType("app.services.voice_brain")
    vb.TOOLS = [
        {
            "name": "regarder",
            "description": "Regarde.",
            "input_schema": {"type": "object"},
        }
    ]
    vb.SYSTEM_PROMPT = "PROMPT"
    vb.run_tool = b.run_tool
    monkeypatch.setitem(sys.modules, "app.services.voice_brain", vb)
    monkeypatch.setattr(rv, "emit_room", b.emit_room)
    monkeypatch.setattr(ad, "emit_room", b.emit_room)
    monkeypatch.setattr(rv, "_connecter", b.connecter)
    monkeypatch.setattr(ad, "DOSSIER_ALERTES", str(tmp_path))
    yield b
    await asyncio.sleep(0.01)
    boucle = asyncio.get_running_loop()
    for t in list(sio_mod._taches):
        if t.get_loop() is boucle and not t.done():
            t.cancel()
    await asyncio.sleep(0)


def jeton_de(twiml: str) -> str:
    return re.search(r'value="([0-9a-f]{32})"', twiml).group(1)


async def decrocher(banc: Banc, code="R7", heure="03:12", phrase="un homme en noir"):
    jeton = jeton_de(ad.twiml_conversation(code, heure, phrase))
    ws = FauxFluxTwilio()
    tache = asyncio.ensure_future(ad._brancher(ws))
    ws.pousser({"event": "connected", "protocol": "Call", "version": "1.0.0"})
    ws.pousser(
        {
            "event": "start",
            "start": {
                "streamSid": "MZ1",
                "callSid": "CA1",
                "customParameters": {"jeton": jeton},
            },
        }
    )
    await attendre(lambda: banc.conns and len(banc.conns[-1].envoyes) >= 3)
    return ws, banc.conns[-1], tache, jeton


@pytest.mark.asyncio
async def test_conversation_telephonique(banc, tmp_path, capsys):
    (tmp_path / "R7.jpg").write_bytes(b"\xff\xd8photo")
    ws, conn, tache, jeton = await decrocher(banc)
    assert jeton not in ad._attentes

    upd = conn.envoyes[0]["session"]
    assert upd["audio"]["input"]["format"] == {"type": "audio/pcmu"}
    assert upd["audio"]["output"] == {
        "format": {"type": "audio/pcmu"},
        "voice": "marin",
    }
    assert upd["audio"]["input"]["turn_detection"] == {
        "type": "server_vad",
        "threshold": 0.5,
        "prefix_padding_ms": 300,
        "silence_duration_ms": 600,
    }
    assert upd["instructions"].startswith(
        "PROMPT\n\nTu es maintenant en conversation VOCALE DIRECTE."
    )
    assert "\n\nAPPEL TELEPHONIQUE. Tu parles a Andy" in upd["instructions"]
    assert "a 03:12 (sur la photo : un homme en noir)." in upd["instructions"]
    assert [t["name"] for t in upd["tools"]] == [
        "regarder",
        "alarme",
        "dire_par_le_robot",
    ]
    assert conn.envoyes[1] == {
        "type": "conversation.item.create",
        "item": {
            "type": "message",
            "role": "user",
            "content": [
                {
                    "type": "input_text",
                    "text": (
                        "[L'appel vient d'etre decroche.] Annonce en une ou deux phrases pourquoi tu appelles "
                        "et ce que montre la photo, puis demande ce qu'il veut faire."
                    ),
                }
            ],
        },
    }
    assert conn.envoyes[2] == {"type": "response.create"}

    ulaw = bytes([0xFF, 0x7F, 0x00, 0x80, 0x55]) * 32
    ws.pousser(
        {
            "event": "media",
            "media": {"track": "inbound", "payload": base64.b64encode(ulaw).decode()},
        }
    )
    await attendre(lambda: "input_audio_buffer.append" in conn.types())
    ajout = [m for m in conn.envoyes if m["type"] == "input_audio_buffer.append"][0]
    assert base64.b64decode(ajout["audio"]) == ulaw

    conn.pousser(
        {
            "type": "response.output_audio.delta",
            "delta": base64.b64encode(b"\x01\x02").decode(),
        }
    )
    await attendre(lambda: ws.envoyes)
    assert ws.envoyes[0] == {
        "event": "media",
        "streamSid": "MZ1",
        "media": {"payload": "AQI="},
    }

    conn.pousser({"type": "input_audio_buffer.speech_started"})
    await attendre(lambda: len(ws.envoyes) == 2)
    assert ws.envoyes[1] == {"event": "clear", "streamSid": "MZ1"}

    conn.pousser(
        {
            "type": "response.done",
            "response": {
                "output": [
                    {
                        "type": "function_call",
                        "name": "alarme",
                        "call_id": "c1",
                        "arguments": '{"on": true}',
                    },
                    {
                        "type": "function_call",
                        "name": "regarder",
                        "call_id": "c2",
                        "arguments": "{}",
                    },
                ]
            },
        }
    )
    await attendre(lambda: conn.types().count("response.create") == 2)
    assert ("R7", "robot_alarme", {"on": True}) in banc.emis
    nom, _entree, ctx = banc.outils[0]
    assert (
        nom == "regarder" and ctx["frame"] == b"\xff\xd8photo" and ctx["code"] == "R7"
    )
    sorties = [
        m["item"]
        for m in conn.envoyes
        if m.get("item", {}).get("type") == "function_call_output"
    ]
    assert sorties == [
        {
            "type": "function_call_output",
            "call_id": "c1",
            "output": '{"resultat":"Sirene declenchee."}',
        },
        {
            "type": "function_call_output",
            "call_id": "c2",
            "output": '{"resultat":"Photo regardee."}',
        },
    ]

    conn.pousser(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "allo",
        }
    )
    await attendre(lambda: ("R7", "rt_entendu", {"texte": "allo"}) in banc.emis)
    assert not [e for e in banc.emis if e[1] == "rt_veille"]

    ws.pousser({"event": "stop", "stop": {"callSid": "CA1"}})
    await asyncio.wait_for(tache, 2)
    assert ws.ferme and conn.state is State.CLOSED
    out = capsys.readouterr().out
    assert "[TEL] R7 : appel decroche, conversation avec l'assistant." in out
    assert "[TEL] code=R7 session ouverte" in out
    assert "[TEL] R7 : fin de l'appel (raccroche)." in out


@pytest.mark.asyncio
async def test_jeton_refuse(banc, capsys):
    for params in [{}, {"jeton": "inconnu"}, {"jeton": ["x"]}]:
        ws = FauxFluxTwilio()
        tache = asyncio.ensure_future(ad._brancher(ws))
        ws.pousser(
            {
                "event": "start",
                "start": {"streamSid": "MZ1", "customParameters": params},
            }
        )
        await asyncio.wait_for(tache, 2)
        assert ws.ferme
    assert (
        capsys.readouterr().out.count(
            "[TEL] flux refuse : jeton absent, inconnu ou expire."
        )
        == 3
    )
    jeton = jeton_de(ad.twiml_conversation("R7", "03:12", None))
    ad._attentes[jeton]["expire"] = 0
    ws = FauxFluxTwilio()
    tache = asyncio.ensure_future(ad._brancher(ws))
    ws.pousser({"event": "start", "start": {"customParameters": {"jeton": jeton}}})
    await asyncio.wait_for(tache, 2)
    assert ws.ferme and jeton not in ad._attentes
    assert banc.conns == []


@pytest.mark.asyncio
async def test_openai_ferme_on_raccroche(banc, capsys):
    ws, conn, tache, _ = await decrocher(banc)
    conn.fermer_par_pair(1000)
    await asyncio.wait_for(tache, 2)
    assert ws.ferme
    assert (
        "[TEL] R7 : fin de l'appel (session OpenAI fermee)." in capsys.readouterr().out
    )


@pytest.mark.asyncio
async def test_twilio_coupe_le_flux(banc, capsys):
    ws, conn, tache, _ = await decrocher(banc)
    ws._entrants.put_nowait({"type": "websocket.disconnect", "code": 1006})
    await asyncio.wait_for(tache, 2)
    await attendre(lambda: conn.state is State.CLOSED)
    assert "[TEL] R7 : fin de l'appel (flux ferme)." in capsys.readouterr().out


@pytest.mark.asyncio
async def test_duree_maximale(banc, monkeypatch, capsys):
    monkeypatch.setenv("APPEL_DUREE_MAX_MS", "50")
    ws, conn, tache, _ = await decrocher(banc)
    await asyncio.wait_for(tache, 2)
    assert ws.ferme and conn.state is State.CLOSED
    assert (
        "[TEL] R7 : fin de l'appel (duree maximale atteinte)."
        in capsys.readouterr().out
    )


@pytest.mark.asyncio
async def test_openai_indisponible_au_decroche(banc, monkeypatch, capsys):
    jeton = jeton_de(ad.twiml_conversation("R7", "03:12", None))
    monkeypatch.delenv("OPENAI_API_KEY")
    ws = FauxFluxTwilio()
    tache = asyncio.ensure_future(ad._brancher(ws))
    ws.pousser(
        {
            "event": "start",
            "start": {"streamSid": "MZ1", "customParameters": {"jeton": jeton}},
        }
    )
    await asyncio.wait_for(tache, 2)
    assert ws.ferme and banc.conns == []
    assert "[TEL] R7 : fin de l'appel (OpenAI indisponible)." in capsys.readouterr().out


def test_route_websocket():
    app = FastAPI()
    app.include_router(ad.router)
    with TestClient(app) as client:
        with client.websocket_connect("/twilio-flux", subprotocols=["audio"]) as w:
            assert w.accepted_subprotocol == "audio"
            w.send_text(
                json.dumps(
                    {"event": "start", "start": {"customParameters": {"jeton": "faux"}}}
                )
            )
            with pytest.raises(WebSocketDisconnect):
                w.receive_text()
        with client.websocket_connect("/twilio-flux?x=1") as w:
            w.send_text("pas du json")
            w.send_text(json.dumps({"event": "stop"}))
            with pytest.raises(WebSocketDisconnect):
                w.receive_text()
