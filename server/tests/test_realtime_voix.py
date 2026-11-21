from __future__ import annotations

import asyncio
import base64
import json
import sys
import types

import pytest
import pytest_asyncio
from websockets.protocol import State

from app.core import sio as sio_mod
from app.services import realtime_voix as rv

ENV_NETTOYES = [
    "OPENAI_API_KEY",
    "REALTIME_MODEL",
    "REALTIME_VOICE",
    "REALTIME_IDLE_MS",
    "REALTIME_VAD",
    "REALTIME_VAD_SEUIL",
    "REALTIME_VAD_ARDEUR",
    "REALTIME_VEILLE",
    "REALTIME_MOT_REVEIL",
    "REALTIME_VEILLE_MS",
    "REALTIME_MOT_REVEIL_LISIBLE",
]


class FakeConn:
    def __init__(self) -> None:
        self.envoyes: list[dict] = []
        self._entrants: asyncio.Queue = asyncio.Queue()
        self.state = State.OPEN
        self.close_code: int | None = None
        self.close_reason = ""

    async def send(self, texte: str) -> None:
        assert isinstance(texte, str)
        self.envoyes.append(json.loads(texte))

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if self.state is State.CLOSED:
            return
        self.state = State.CLOSED
        self.close_code, self.close_reason = code, reason
        self._entrants.put_nowait(None)

    def fermer_par_pair(self, code: int, reason: str = "") -> None:
        self.state = State.CLOSED
        self.close_code, self.close_reason = code, reason
        self._entrants.put_nowait(None)

    def pousser(self, ev: dict) -> None:
        self._entrants.put_nowait(json.dumps(ev))

    def types(self) -> list[str]:
        return [m.get("type") for m in self.envoyes]

    def __aiter__(self):
        return self

    async def __anext__(self):
        m = await self._entrants.get()
        if m is None:
            raise StopAsyncIteration
        return m


async def attendre(cond, delai: float = 2.0) -> None:
    fin = asyncio.get_running_loop().time() + delai
    while not cond():
        if asyncio.get_running_loop().time() > fin:
            raise AssertionError("condition jamais remplie")
        await asyncio.sleep(0.005)


class Banc:
    def __init__(self) -> None:
        self.emis: list[tuple] = []
        self.emis_sid: list[tuple] = []
        self.conns: list[FakeConn] = []
        self.urls: list[str] = []
        self.cles: list[str] = []
        self.outils_appeles: list[tuple] = []
        self.echec_connexion: Exception | None = None
        self.retour_outil: list = [{"type": "text", "text": "ok"}]

    async def emit_room(self, room, event, data=None, skip_sid=None):
        self.emis.append((room, event, data))

    async def emit_to(self, sid, event, data=None):
        self.emis_sid.append((sid, event, data))

    async def connecter(self, url, cle):
        self.urls.append(url)
        self.cles.append(cle)
        if self.echec_connexion:
            raise self.echec_connexion
        c = FakeConn()
        self.conns.append(c)
        return c

    async def run_tool(self, name, input, ctx):
        self.outils_appeles.append((name, input, ctx))
        return self.retour_outil

    def evenements(self, nom: str) -> list:
        return [d for (_r, e, d) in self.emis if e == nom]


@pytest.fixture
def banc(monkeypatch):
    for n in ENV_NETTOYES:
        monkeypatch.delenv(n, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    b = Banc()
    vb = types.ModuleType("app.services.voice_brain")
    vb.TOOLS = [
        {
            "name": "piloter",
            "description": "Fait rouler.",
            "input_schema": {"type": "object", "properties": {}},
        }
    ]
    vb.SYSTEM_PROMPT = "PROMPT"
    vb.run_tool = b.run_tool
    monkeypatch.setitem(sys.modules, "app.services.voice_brain", vb)
    monkeypatch.setattr(rv, "emit_room", b.emit_room)
    monkeypatch.setattr(rv, "emit_to", b.emit_to)
    monkeypatch.setattr(rv, "_connecter", b.connecter)
    rv._sessions.clear()
    yield b
    rv._sessions.clear()


@pytest_asyncio.fixture
async def propre():
    yield
    for s in list(rv._sessions.values()):
        await s.fermer()
    await asyncio.sleep(0.01)
    boucle = asyncio.get_running_loop()
    for t in list(sio_mod._taches):
        if t.get_loop() is boucle and not t.done():
            t.cancel()
    await asyncio.sleep(0)


async def demarrer(
    banc: Banc, code: str = "C1", sid: str = "sid1"
) -> tuple[rv.SessionVocale, FakeConn]:
    avant = len(banc.conns)
    await rv._rt_start(sid, {"code": code})
    await attendre(lambda: len(banc.conns) > avant and banc.conns[-1].envoyes)
    return rv._sessions[code], banc.conns[-1]


def test_sans_accents_et_mot_de_reveil(monkeypatch):
    monkeypatch.delenv("REALTIME_MOT_REVEIL", raising=False)
    assert rv.sans_accents("Salut, Solâna !") == "salut solana"
    assert rv.sans_accents("  Été   à  l'École ") == "ete a l ecole"
    for dit in ["Salut Solana", "solène tu es la", "SOL ANA ?", "Hé Solenna."]:
        assert rv._mot_reveil().search(rv.sans_accents(dit)), dit
    for dit in ["solanaceae", "bonjour", "sol", "le solaire"]:
        assert not rv._mot_reveil().search(rv.sans_accents(dit)), dit
    monkeypatch.setenv("REALTIME_MOT_REVEIL", r"\brobot\b")
    assert rv._mot_reveil().search("salut robot")
    assert not rv._mot_reveil().search("salut solana")


def test_base64_aller_retour():
    for n in (0, 1, 2, 3, 4, 479, 480, 4800):
        octets = bytes((i * 37) & 0xFF for i in range(n))
        assert rv._b64(base64.b64encode(octets).decode()) == octets
    assert rv._b64("AQI") == b"\x01\x02"
    assert rv._b64("AQ\nID") == b"\x01\x02\x03"
    assert rv._b64("-_8") == base64.b64decode("+/8=")
    assert rv._b64("") == b""


def test_octets():
    assert rv._octets(b"\x00\x01") == b"\x00\x01"
    assert rv._octets(bytearray(b"ab")) == b"ab"
    assert rv._octets(memoryview(b"ab")) == b"ab"
    assert rv._octets([1, 2, 255]) == b"\x01\x02\xff"
    assert rv._octets({"type": "Buffer", "data": [7, 8]}) == b"\x07\x08"
    assert rv._octets("é") == "é".encode()
    assert rv._octets(12) is None
    assert rv._octets({"x": 1}) is None


def test_url_modele_et_detection(monkeypatch):
    for n in ENV_NETTOYES:
        monkeypatch.delenv(n, raising=False)
    assert rv._url() == "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1"
    monkeypatch.setenv("REALTIME_MODEL", "modele a/b")
    assert rv._url() == "wss://api.openai.com/v1/realtime?model=modele%20a%2Fb"
    assert rv._detection_tour() == {
        "type": "server_vad",
        "threshold": 0.7,
        "prefix_padding_ms": 300,
        "silence_duration_ms": 700,
    }
    monkeypatch.setenv("REALTIME_VAD_SEUIL", "0.9")
    assert rv._detection_tour()["threshold"] == 0.9
    monkeypatch.setenv("REALTIME_VAD", "semantic")
    assert rv._detection_tour() == {"type": "semantic_vad", "eagerness": "low"}
    monkeypatch.setenv("REALTIME_VAD_ARDEUR", "high")
    assert rv._detection_tour()["eagerness"] == "high"
    assert rv.TAUX == 24000


def test_constructeur_options(monkeypatch, capsys):
    monkeypatch.delenv("REALTIME_VEILLE", raising=False)
    s = rv.SessionVocale(code="C9")
    assert s.veille is True and s.eveille is False and s.annoncer is True
    assert s.format_audio == {"type": "audio/pcm", "rate": 24000}
    assert s.etiquette == "RT" and s.consignes == "" and s.outils_en_plus == []
    assert (
        'code=C9 en veille, dites "Salut Solana" pour parler.'
        in capsys.readouterr().out
    )
    s = rv.SessionVocale(
        code="C9",
        veille=False,
        annoncer=False,
        etiquette="TEL",
        format_audio={"type": "audio/pcmu"},
    )
    assert s.veille is False and s.eveille is True and s.annoncer is False
    assert s.format_audio == {"type": "audio/pcmu"}
    assert "en veille" not in capsys.readouterr().out
    monkeypatch.setenv("REALTIME_VEILLE", "FALSE")
    assert rv.SessionVocale(code="C9").veille is False
    assert rv.SessionVocale(code="C9").etat_veille() == {
        "eveille": True,
        "veille": False,
        "phrase": "Salut Solana",
    }


@pytest.mark.asyncio
async def test_session_robot_avec_veille(banc, propre, capsys):
    s, conn = await demarrer(banc)
    assert banc.urls == ["wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1"]
    assert banc.cles == ["sk-test"]

    upd = conn.envoyes[0]
    assert upd["type"] == "session.update"
    sess = upd["session"]
    assert sess["type"] == "realtime"
    assert sess["instructions"].startswith(
        "PROMPT\n\nTu es maintenant en conversation VOCALE DIRECTE."
    )
    assert sess["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 24000}
    assert sess["audio"]["input"]["turn_detection"] == {
        "type": "server_vad",
        "threshold": 0.7,
        "prefix_padding_ms": 300,
        "silence_duration_ms": 700,
        "create_response": False,
    }
    assert sess["audio"]["input"]["transcription"] == {
        "model": "gpt-4o-mini-transcribe",
        "language": "fr",
    }
    assert sess["audio"]["output"] == {
        "format": {"type": "audio/pcm", "rate": 24000},
        "voice": "marin",
    }
    assert sess["tools"] == [
        {
            "type": "function",
            "name": "piloter",
            "description": "Fait rouler.",
            "parameters": {"type": "object", "properties": {}},
        }
    ]
    assert sess["tool_choice"] == "auto"
    await attendre(lambda: banc.evenements("rt_veille"))
    assert ("C1", "rt_etat", {"actif": True}) in banc.emis
    assert banc.evenements("rt_veille") == [
        {"eveille": False, "veille": True, "phrase": "Salut Solana"}
    ]
    assert s.prete

    pcm = bytes(range(256)) * 8
    await rv._rt_audio("sid1", {"code": "C1", "pcm": pcm})
    await rv._rt_audio("sid1", {"code": "C1", "pcm": b""})
    await attendre(lambda: "input_audio_buffer.append" in conn.types())
    ajouts = [m for m in conn.envoyes if m["type"] == "input_audio_buffer.append"]
    assert len(ajouts) == 1 and base64.b64decode(ajouts[0]["audio"]) == pcm

    conn.pousser(
        {
            "type": "response.output_audio.delta",
            "delta": base64.b64encode(b"\x01\x02\x03").decode(),
        }
    )
    await attendre(lambda: banc.evenements("rt_audio_out"))
    assert banc.evenements("rt_audio_out") == [{"pcm": b"\x01\x02\x03"}]

    conn.pousser({"type": "input_audio_buffer.speech_started"})
    await attendre(lambda: banc.evenements("rt_couper"))
    assert banc.evenements("rt_couper") == [{}]

    conn.pousser({"type": "response.output_audio.done"})
    await attendre(lambda: {"finReponse": True} in banc.evenements("rt_etat"))
    assert s.reponses == 1

    conn.pousser(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "il pleut",
        }
    )
    await attendre(lambda: banc.evenements("rt_entendu"))
    await asyncio.sleep(0.02)
    assert banc.evenements("rt_entendu") == [{"texte": "il pleut"}]
    assert "response.create" not in conn.types()
    assert "code=C1 en veille, pas de reponse." in capsys.readouterr().out

    conn.pousser(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "Salut, Solâna !",
        }
    )
    await attendre(lambda: "response.create" in conn.types())
    assert s.eveille is True
    assert banc.evenements("rt_veille")[-1] == {
        "eveille": True,
        "veille": True,
        "phrase": "Salut Solana",
    }
    assert s.veille_timer is not None

    conn.pousser({"type": "response.created"})
    conn.pousser(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "et toi ?",
        }
    )
    await attendre(lambda: len(banc.evenements("rt_entendu")) == 3)
    await asyncio.sleep(0.02)
    assert conn.types().count("response.create") == 1
    assert s.reponse_en_cours is True

    await rv._rt_veille_etat("app1", {"code": "C1"})
    assert banc.emis_sid == [
        (
            "app1",
            "rt_veille",
            {"eveille": True, "veille": True, "phrase": "Salut Solana"},
        )
    ]

    await rv._rt_interrompre("sid1", {"code": "C1"})
    await attendre(lambda: "input_audio_buffer.clear" in conn.types())
    assert conn.types()[-2:] == ["response.cancel", "input_audio_buffer.clear"]
    assert s.reponse_en_cours is False
    await rv._rt_interrompre("sid1", {"code": "C1"})
    await attendre(lambda: conn.types().count("input_audio_buffer.clear") == 2)
    assert conn.types().count("response.cancel") == 1

    await rv._rt_frame("sid1", {"code": "C1", "frame": b"\xff\xd8jpeg"})
    assert s.image == b"\xff\xd8jpeg"
    banc.retour_outil = [
        {"type": "text", "text": "Image en direct"},
        {"type": "text", "text": "de la camera"},
        {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"},
        },
        {"type": "image", "source": {"type": "base64"}},
    ]
    avant = len(conn.envoyes)
    conn.pousser(
        {
            "type": "response.done",
            "response": {
                "output": [
                    {"type": "message"},
                    {
                        "type": "function_call",
                        "name": "regarder",
                        "call_id": "call_1",
                        "arguments": '{"zoom": 2}',
                    },
                ]
            },
        }
    )
    await attendre(lambda: conn.types()[avant:].count("response.create") == 1)
    nom, entree, ctx = banc.outils_appeles[-1]
    assert nom == "regarder" and entree == {"zoom": 2}
    assert set(ctx) == {"code", "frame", "log"}
    assert ctx["code"] == "C1" and ctx["frame"] == b"\xff\xd8jpeg"
    assert conn.envoyes[avant:] == [
        {
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": '{"resultat":"Image en direct de la camera"}',
            },
        },
        {
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_image", "image_url": "data:image/png;base64,QUJD"}
                ],
            },
        },
        {"type": "response.create"},
    ]
    assert (
        "code=C1 outil regarder -> Image en direct de la camera [+1 image]"
        in capsys.readouterr().out
    )

    avant = len(conn.envoyes)
    conn.pousser({"type": "response.done", "response": {"output": []}})
    conn.pousser({"type": "error", "error": {"message": "x" * 500}})
    await attendre(lambda: "erreur API" in capsys.readouterr().out)
    assert len(conn.envoyes) == avant

    await rv._rt_stop("sid1", {"code": "C1"})
    await attendre(lambda: conn.state is State.CLOSED)
    await attendre(lambda: banc.evenements("rt_etat").count({"actif": False}) >= 2)
    assert "C1" not in rv._sessions
    assert (
        s.ws is None
        and s.prete is False
        and s.veille_timer is None
        and s._minuteur is None
    )
    out = capsys.readouterr().out
    assert "[RT] code=C1 arret demande par le robot (rt_stop)." in out
    assert "[RT] code=C1 session fermee (code=1000" in out and "1 reponse(s))." in out


@pytest.mark.asyncio
async def test_outil_en_erreur_et_arguments_invalides(banc, propre, capsys):
    s, conn = await demarrer(banc)

    async def casse(name, input, ctx):
        raise RuntimeError("moteur bloque")

    sys.modules["app.services.voice_brain"].run_tool = casse
    conn.pousser(
        {
            "type": "response.done",
            "response": {
                "output": [
                    {
                        "type": "function_call",
                        "name": "piloter",
                        "call_id": "c2",
                        "arguments": "{pas du json",
                    },
                ]
            },
        }
    )
    await attendre(lambda: "response.create" in conn.types())
    sortie = [
        m
        for m in conn.envoyes
        if m.get("item", {}).get("type") == "function_call_output"
    ][0]
    assert json.loads(sortie["item"]["output"]) == {
        "resultat": "Erreur outil : moteur bloque"
    }


@pytest.mark.asyncio
async def test_session_sans_veille(banc, propre, monkeypatch, capsys):
    monkeypatch.setenv("REALTIME_VEILLE", "false")
    s, conn = await demarrer(banc)
    td = conn.envoyes[0]["session"]["audio"]["input"]["turn_detection"]
    assert "create_response" not in td
    await attendre(lambda: banc.evenements("rt_veille"))
    assert banc.evenements("rt_veille") == [
        {"eveille": True, "veille": False, "phrase": "Salut Solana"}
    ]
    conn.pousser(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "bonjour",
        }
    )
    conn.pousser(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "",
        }
    )
    await attendre(lambda: banc.evenements("rt_entendu"))
    await asyncio.sleep(0.02)
    assert "response.create" not in conn.types()
    assert "en veille" not in capsys.readouterr().out


@pytest.mark.asyncio
async def test_transcription_vide_eveille_demande_reponse(banc, propre, capsys):
    s, conn = await demarrer(banc)
    s.eveille = True
    conn.pousser(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "",
        }
    )
    await attendre(lambda: "response.create" in conn.types())
    assert (
        "tour sans transcription -> reponse demandee quand meme."
        in capsys.readouterr().out
    )
    s.eveille = False
    conn.pousser({"type": "conversation.item.input_audio_transcription.completed"})
    await asyncio.sleep(0.03)
    assert conn.types().count("response.create") == 1


@pytest.mark.asyncio
async def test_retour_en_veille_apres_silence(banc, propre, monkeypatch, capsys):
    monkeypatch.setenv("REALTIME_VEILLE_MS", "40")
    s, conn = await demarrer(banc)
    conn.pousser(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "transcript": "solana",
        }
    )
    await attendre(lambda: s.eveille)
    await attendre(lambda: not s.eveille)
    assert banc.evenements("rt_veille")[-1]["eveille"] is False
    assert "code=C1 retour en veille." in capsys.readouterr().out


@pytest.mark.asyncio
async def test_sans_cle(banc, propre, monkeypatch, capsys):
    monkeypatch.delenv("OPENAI_API_KEY")
    await rv._rt_start("sid1", {"code": "C1"})
    assert banc.conns == []
    assert (
        "C1",
        "rt_etat",
        {"actif": False, "erreur": "cle OpenAI absente"},
    ) in banc.emis
    assert (
        "[RT] OPENAI_API_KEY absente -> mode temps reel indisponible."
        in capsys.readouterr().out
    )
    await rv._rt_start("sid1", {})
    await rv._rt_start("sid1", None)
    assert len(banc.emis) == 1


@pytest.mark.asyncio
async def test_connexion_impossible(banc, propre, capsys):
    banc.echec_connexion = OSError("reseau injoignable")
    await rv._rt_start("sid1", {"code": "C1"})
    await attendre(lambda: "C1" not in rv._sessions)
    await attendre(lambda: banc.evenements("rt_etat").count({"actif": False}) == 2)
    out = capsys.readouterr().out
    assert "[RT] code=C1 erreur : reseau injoignable" in out
    assert "[RT] code=C1 session fermee (code=1006" in out


@pytest.mark.asyncio
async def test_fermeture_cote_openai(banc, propre, capsys):
    s, conn = await demarrer(banc)
    conn.fermer_par_pair(1011, "panne interne")
    await attendre(lambda: "C1" not in rv._sessions)
    assert banc.evenements("rt_etat")[-1] == {"actif": False}
    assert "session fermee (code=1011, motif=panne interne" in capsys.readouterr().out
    s2, conn2 = await demarrer(banc)
    assert s2 is not s and conn2 is not conn


@pytest.mark.asyncio
async def test_inactivite(banc, propre, monkeypatch, capsys):
    monkeypatch.setattr(rv, "_VERIF_INACTIVITE_S", 0.02)
    monkeypatch.setenv("REALTIME_IDLE_MS", "10")
    s, conn = await demarrer(banc)
    await attendre(lambda: conn.state is State.CLOSED)
    await attendre(lambda: "C1" not in rv._sessions)
    assert "code=C1 inactive -> fermeture (economie)." in capsys.readouterr().out


@pytest.mark.asyncio
async def test_deconnexion_ferme_si_salon_vide(banc, propre, monkeypatch, capsys):
    s, conn = await demarrer(banc)
    monkeypatch.setattr(rv, "room_sids", lambda code: ["sid1", "app1"])
    await rv._deconnexion("sid1")
    assert s.ws is not None
    monkeypatch.setattr(rv, "room_sids", lambda code: ["sid1"])
    await rv._deconnexion("sid1")
    assert s.ws is None
    await attendre(lambda: conn.state is State.CLOSED)
    assert (
        "[RT] code=C1 plus personne dans la room -> fermeture."
        in capsys.readouterr().out
    )


@pytest.mark.asyncio
async def test_fermer_pendant_la_connexion(banc, propre, capsys):
    porte = asyncio.Event()
    conns: list[FakeConn] = []

    async def lent(url, cle):
        await porte.wait()
        c = FakeConn()
        conns.append(c)
        return c

    rv._connecter = lent
    await rv._rt_start("sid1", {"code": "C1"})
    s = rv._sessions["C1"]
    assert s.ws is not None
    await rv._rt_stop("sid1", {"code": "C1"})
    porte.set()
    await attendre(lambda: conns and conns[0].state is State.CLOSED)
    await attendre(
        lambda: "WebSocket was closed before the connection was established"
        in capsys.readouterr().out
    )
    assert conns[0].envoyes == []
