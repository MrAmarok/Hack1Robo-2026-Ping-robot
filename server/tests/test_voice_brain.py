from __future__ import annotations

import asyncio
import base64
import os
from types import SimpleNamespace

import pytest

import app.services.voice_brain as vb
from app.core.sio import _handlers


@pytest.fixture(autouse=True)
def _etat_propre(monkeypatch):
    for nom in ("ANTHROPIC_API_KEY", "DEEPGRAM_API_KEY", "VOICE_FAST"):
        monkeypatch.delenv(nom, raising=False)
    monkeypatch.setattr(vb, "_client", None)
    monkeypatch.setattr(vb, "_client_partage", None)
    vb.suivis.clear()
    vb.servos.clear()
    vb.conversations.clear()
    yield
    for s in vb.suivis.values():
        s["actif"] = False
        if s.get("ticker"):
            s["ticker"].cancel()
    vb.suivis.clear()
    vb.servos.clear()
    vb.conversations.clear()


@pytest.fixture
def emis(monkeypatch):
    journal: list[tuple] = []

    async def faux_emit_room(room, event, data=None, skip_sid=None):
        journal.append((room, event, data))

    monkeypatch.setattr(vb, "emit_room", faux_emit_room)
    return journal


@pytest.fixture
def traces(monkeypatch):
    lignes: list[str] = []

    def faux_log(*args):
        lignes.append(" ".join(str(a) for a in args))

    monkeypatch.setattr(vb, "log", faux_log)
    return lignes


def drives(journal):
    return [d["cmd"] for (_r, ev, d) in journal if ev == "robot_drive"]


def ctx(**kw):
    base = {"code": "ABC", "frame": None, "log": lambda *a: None}
    base.update(kw)
    return base


class Bloc(SimpleNamespace):
    pass


def texte(t):
    return Bloc(type="text", text=t)


def reponse(*blocs, stop_reason="end_turn"):
    return SimpleNamespace(content=list(blocs), stop_reason=stop_reason)


class FauxMessages:
    def __init__(self, reponses):
        self.reponses = list(reponses)
        self.appels: list[dict] = []

    async def create(self, **params):
        instantane = dict(params)
        if "messages" in instantane:
            instantane["messages"] = list(instantane["messages"])
        self.appels.append(instantane)
        r = self.reponses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


class FauxClient:
    def __init__(self, reponses=(), beta=()):
        self.messages = FauxMessages(reponses)
        self.beta = SimpleNamespace(messages=FauxMessages(beta))


def test_gestionnaires_enregistres():
    assert vb._voice_ask in _handlers["voice_ask"]
    assert vb._vision_obstacle in _handlers["vision_obstacle"]


def test_api_publique():
    noms = [t["name"] for t in vb.TOOLS]
    assert noms == [
        "piloter", "regarder", "aller_a", "bouger_camera", "ronde", "suivre_personne",
        "arreter_suivi", "aller_vers_objet", "etat_robot", "mode_surveillance",
    ]
    for t in vb.TOOLS:
        assert set(t) == {"name", "description", "input_schema"}
    assert "Tu t'appelles Solana" in vb.SYSTEM_PROMPT
    assert "{" not in vb.SYSTEM_PROMPT
    assert vb.MODEL == os.environ.get("VOICE_MODEL", "claude-opus-5")
    assert vb.VISION_MODEL == os.environ.get("VISION_MODEL", "claude-haiku-4-5-20251001")


def test_attach_sans_cle(traces):
    vb.attach_voice_brain()
    assert vb._client is None
    assert any("mode COMMANDES LOCALES" in l and "whisper local (lent)" in l for l in traces)


def test_attach_avec_cle(monkeypatch, traces):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "dg-test")
    monkeypatch.setenv("VOICE_FAST", "true")
    vb.attach_voice_brain()
    assert vb._client is not None
    assert vb.client_vision() is vb._client
    ligne = next(l for l in traces if "Assistant vocal actif" in l)
    assert f"STT Deepgram {vb.DEEPGRAM_MODEL} (rapide)" in ligne
    assert f"Claude {vb.MODEL} (effort {vb.EFFORT}," in ligne


def test_client_vision_sans_cle():
    assert vb.client_vision() is None


@pytest.mark.parametrize("brut,attendu", [
    ("Où es-tu ?", "ou es tu"),
    ("  Ça   VA!!  ", "ca va"),
    ("Tourne à droite, s'il te plaît", "tourne a droite s il te plait"),
    ("Arrête\tla\nsurveillance", "arrete la surveillance"),
    ("", ""),
])
def test_normalize(brut, attendu):
    assert vb.normalize(brut) == attendu


@pytest.mark.parametrize("txt,attendu", [
    ("avance pendant 3 secondes", 3),
    ("avance 10 secondes", 5),
    ("avance 0 secondes", 0.2),
    ("avance 2s", 2),
    ("avance deux secondes", 2),
    ("avance une seconde", 1),
    ("avance une demi seconde", 0.5),
    ("avance dix secondes", 5),
    ("avance un peu", 0.6),
    ("recule beaucoup", 3),
    ("avance", 1),
    (vb.normalize("avance 2,5 secondes"), 5),
])
def test_duree_de(txt, attendu):
    assert vb.duree_de(txt) == pytest.approx(attendu)


@pytest.mark.parametrize("phrase,tool,entree,reponse_dite", [
    ("Avance", "piloter", {"action": "avancer", "duree_secondes": 1}, "J avance."),
    ("avance pendant 3 secondes", "piloter", {"action": "avancer", "duree_secondes": 3}, "J avance."),
    ("Recule un peu", "piloter", {"action": "reculer", "duree_secondes": 0.6}, "Je recule."),
    ("Tourne à droite", "piloter", {"action": "droite", "duree_secondes": 1}, "Je tourne a droite."),
    ("tourne a gauche deux secondes", "piloter", {"action": "gauche", "duree_secondes": 2}, "Je tourne a gauche."),
    ("Fais demi-tour", "piloter", {"action": "droite", "duree_secondes": 3}, "Demi-tour."),
    ("Stop !", "piloter", {"action": "stop"}, "Stop."),
    ("bon allez arrête", "piloter", {"action": "stop"}, "Stop."),
    ("Arrête de me suivre", "piloter", {"action": "stop"}, "Stop."),
    ("Je m'en vais", "mode_surveillance", {"absent": True}, None),
    ("Active la surveillance", "mode_surveillance", {"absent": True}, None),
    ("Arrête la surveillance", "mode_surveillance", {"absent": False}, None),
    ("Me revoilà", "mode_surveillance", {"absent": False}, None),
    ("Suis-moi", "suivre_personne", {}, None),
    ("viens avec moi", "suivre_personne", {}, None),
    ("Reste là", "arreter_suivi", {}, None),
    ("Où es-tu ?", "etat_robot", {}, None),
    ("donne moi ta position", "etat_robot", {}, None),
])
def test_commande_locale_reconnue(phrase, tool, entree, reponse_dite):
    assert vb.commande_locale(phrase) == {"tool": tool, "input": entree, "reply": reponse_dite}


@pytest.mark.parametrize("phrase", [
    "",
    "   !!! ",
    "Bonjour Solana",
    "Qu'est-ce qu'il y a à ma droite ?",
    "Regarde a gauche",
    "Tu peux tourner à droite ?",
    "Comment tu avances",
    "la poubelle est a cote",
])
def test_commande_locale_non_reconnue(phrase):
    assert vb.commande_locale(phrase) is None


def test_aides_js():
    assert vb._js_str(1.0) == "1" and vb._js_str(0.6) == "0.6" and vb._js_str(True) == "true"
    assert vb._js_round(2.5) == 3 and vb._js_round(-2.5) == -2 and vb._js_round(2.4) == 2
    assert vb._ou(vb._js_number(None), 1) == 1
    assert vb._ou(vb._js_number("2"), 1) == 2
    assert vb._ou(vb._js_number(0), 1) == 1
    assert vb._ou(vb._js_number("abc"), 1) == 1
    assert vb._js_truthy(b"") is True
    assert vb._js_truthy("") is False and vb._js_truthy(0) is False
    assert vb._est_fini(3) and not vb._est_fini("3") and not vb._est_fini(True)


@pytest.mark.asyncio
async def test_mode_surveillance(emis):
    out = await vb.run_tool("mode_surveillance", {"absent": True}, ctx())
    assert emis == [("ABC", "robot_mode", {"absent": True})]
    assert out[0]["text"].startswith("Mode absence active.")
    out = await vb.run_tool("mode_surveillance", {"absent": False}, ctx())
    assert emis[-1] == ("ABC", "robot_mode", {"absent": False})
    assert out == [{"type": "text", "text": "Mode normal. La surveillance est desarmee, je ne guette plus."}]


@pytest.mark.asyncio
async def test_piloter_stop(emis):
    out = await vb.run_tool("piloter", {"action": "stop"}, ctx())
    assert out == [{"type": "text", "text": "Robot arrete."}]
    assert len(emis) == 1
    room, ev, d = emis[0]
    assert (room, ev, d["cmd"], d["by"]) == ("ABC", "robot_drive", "S", "solana")
    assert d["id"].startswith("voice-")


@pytest.mark.asyncio
async def test_piloter_mouvement_en_fond(emis):
    out = await vb.run_tool("piloter", {"action": "avancer", "duree_secondes": 0.2}, ctx())
    assert out == [{"type": "text", "text": 'Mouvement "avancer" effectue pendant 0.2s, robot arrete.'}]
    await asyncio.sleep(0.4)
    assert drives(emis) == ["F", "S"]
    assert emis[-1][2]["id"].startswith("voice-stop-")


@pytest.mark.asyncio
async def test_piloter_duree_par_defaut_et_bornes(emis):
    out = await vb.run_tool("piloter", {"action": "gauche"}, ctx())
    assert out[0]["text"] == 'Mouvement "gauche" effectue pendant 1s, robot arrete.'
    out = await vb.run_tool("piloter", {"action": "droite", "duree_secondes": 99}, ctx())
    assert out[0]["text"] == 'Mouvement "droite" effectue pendant 5s, robot arrete.'
    assert (await vb.run_tool("piloter", {"action": "voler"}, ctx())) == [{"type": "text", "text": "Action inconnue."}]


@pytest.mark.asyncio
async def test_regarder():
    out = await vb.run_tool("regarder", {}, ctx())
    assert out == [{"type": "text", "text": "Pas d'image : la camera du robot est eteinte."}]
    out = await vb.run_tool("regarder", {}, ctx(frame=b"\xff\xd8jpeg"))
    assert out[0] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(b"\xff\xd8jpeg").decode()},
    }
    assert out[1] == {"type": "text", "text": "Image en direct de la camera du robot."}


@pytest.mark.asyncio
async def test_bouger_camera(emis):
    out = await vb.run_tool("bouger_camera", {"direction": "centre"}, ctx())
    assert out[0]["text"] == "Camera recentree."
    assert emis[-1][1] == "robot_cam_move" and emis[-1][2]["center"] is True
    assert list(emis[-1][2]) == ["id", "center"]

    out = await vb.run_tool("bouger_camera", {"direction": "gauche", "amplitude": "beaucoup"}, ctx())
    assert out[0]["text"] == "Tete tournee vers gauche."
    assert emis[-1][2]["panDelta"] == 50 and emis[-1][2]["id"].startswith("voix-")

    await vb.run_tool("bouger_camera", {"direction": "bas"}, ctx())
    assert emis[-1][2]["tiltDelta"] == -28

    out = await vb.run_tool("bouger_camera", {"direction": "derriere"}, ctx())
    assert out[0]["text"] == "Direction inconnue : derriere."


@pytest.mark.asyncio
async def test_ronde(emis):
    out = await vb.run_tool("ronde", {"action": "demarrer"}, ctx())
    assert out == [{"type": "text", "text": "Je commence ma ronde."}]
    assert emis == [("ABC", "robot_ronde", {"action": "demarrer"})]
    out = await vb.run_tool("ronde", {"action": "danser"}, ctx())
    assert out[0]["text"] == "Action de ronde inconnue : danser."


@pytest.mark.asyncio
async def test_outils_vision_sans_client(emis):
    out = await vb.run_tool("suivre_personne", {}, ctx())
    assert out[0]["text"] == "Je ne peux pas te suivre : ma vision n'est pas disponible."
    out = await vb.run_tool("aller_vers_objet", {"objet": "la poubelle"}, ctx())
    assert out[0]["text"] == "Je ne peux pas m'y rendre : ma vision n'est pas disponible."
    out = await vb.run_tool("aller_vers_objet", {"objet": "  "}, ctx())
    assert out[0]["text"] == "Cible non precisee."
    out = await vb.run_tool("arreter_suivi", {}, ctx())
    assert out[0]["text"] == "Je n'etais pas en train de suivre."
    assert emis == []


@pytest.mark.asyncio
async def test_outil_inconnu():
    assert (await vb.run_tool("voler", {}, ctx())) == [{"type": "text", "text": "Outil inconnu."}]


@pytest.mark.asyncio
async def test_aller_a(emis, monkeypatch):
    async def faux_geocode(adresse):
        return {"latitude": 48.8566, "longitude": 2.0, "label": "Paris, Ile-de-France, France"}

    monkeypatch.setattr(vb, "geocode", faux_geocode)
    out = await vb.run_tool("aller_a", {"adresse": "Paris"}, ctx())
    assert out[0]["text"] == "Navigation lancee vers Paris, Ile-de-France, France."
    assert emis == [("ABC", "robot_nav", {"target": {"latitude": 48.8566, "longitude": 2.0}, "on": True})]

    async def geocode_vide(adresse):
        return None

    monkeypatch.setattr(vb, "geocode", geocode_vide)
    out = await vb.run_tool("aller_a", {"adresse": "nulle part"}, ctx())
    assert out[0]["text"] == "Adresse introuvable : nulle part."
    assert (await vb.run_tool("aller_a", {}, ctx()))[0]["text"] == "Adresse manquante."


@pytest.mark.asyncio
@pytest.mark.parametrize("brut,attendu", [
    (
        {"code": "ABC", "status": {
            "coords": {"latitude": 48.1234567, "longitude": 2.5}, "gpsAgeMs": 2500,
            "obstacleCm": 30, "arduinoConnected": True, "navActive": True,
        }},
        "position 48.12346, 2.50000, relevee il y a 3 secondes, obstacle a 30 cm, "
        "moteurs connectes et prets, navigation en cours.",
    ),
    (
        {"coords": None, "obstacleCm": None, "arduinoConnected": False},
        "pas encore de position GPS (le recepteur cherche les satellites), moteurs deconnectes.",
    ),
    (None, "Le robot n a pas repondu."),
])
async def test_etat_robot(emis, monkeypatch, brut, attendu):
    async def faux_wait_for_event(event, room=None, timeout=5, filtre=None):
        assert (event, room, timeout) == ("robot_status", "ABC", 5)
        await asyncio.sleep(0)
        return brut

    monkeypatch.setattr(vb, "wait_for_event", faux_wait_for_event)
    out = await vb.run_tool("etat_robot", {}, ctx())
    assert out == [{"type": "text", "text": attendu}]
    assert emis == [("ABC", "robot_status_request", {"by": "solana"})]


@pytest.mark.asyncio
async def test_tout_arreter_rien_en_cours(emis):
    assert (await vb.tout_arreter("ABC")) == {"servo": False, "suivi": False}
    assert [(d["cmd"], d["by"]) for (_r, ev, d) in emis] == [("S", "arret-urgence"), ("V255", "arret-urgence")]


@pytest.mark.asyncio
async def test_tout_arreter_interrompt_aller_vers_objet(emis, monkeypatch):
    async def faux_grab(code, timeout_ms=8000):
        return b"jpeg"

    async def faux_localiser(client, frame, objet):
        return {"vu": True, "x": 0.0, "taille": 0.1}

    monkeypatch.setattr(vb, "grab_frame", faux_grab)
    monkeypatch.setattr(vb, "localiser_objet", faux_localiser)
    manoeuvre = asyncio.ensure_future(vb.aller_vers_objet(object(), "ABC", "la poubelle"))
    await asyncio.sleep(0.35)
    assert "ABC" in vb.servos
    etat = await vb.tout_arreter("ABC")
    assert etat == {"servo": True, "suivi": False}
    bilan = await asyncio.wait_for(manoeuvre, 3)
    assert bilan == "Arret demande, je me suis arrete en chemin."
    assert "ABC" not in vb.servos
    cmds = drives(emis)
    assert cmds[0] == "V150" and cmds[-1] == "V255"
    apres = cmds[cmds.index("V255"):]
    assert apres.count("F") <= 1


@pytest.mark.asyncio
async def test_aller_vers_objet_arrive(emis, monkeypatch):
    async def faux_grab(code, timeout_ms=8000):
        return b"jpeg"

    async def faux_localiser(client, frame, objet):
        return {"vu": True, "x": 0.0, "taille": 0.6}

    monkeypatch.setattr(vb, "grab_frame", faux_grab)
    monkeypatch.setattr(vb, "localiser_objet", faux_localiser)
    out = await vb.run_tool("aller_vers_objet", {"objet": "la porte"}, ctx(client=object()))
    assert out == [{"type": "text", "text": "J'y suis, la porte est juste devant moi (1 manoeuvres)."}]
    assert drives(emis) == ["V150", "V255"]


@pytest.mark.asyncio
async def test_aller_vers_objet_sans_image(emis, monkeypatch):
    async def faux_grab(code, timeout_ms=8000):
        return None

    monkeypatch.setattr(vb, "grab_frame", faux_grab)
    out = await vb.aller_vers_objet(object(), "ABC", "la porte")
    assert out == "Je n'arrive pas a prendre d'image, je ne peux pas m'y rendre."


@pytest.mark.asyncio
async def test_bouger_annule_en_cours(emis):
    appels = {"n": 0}

    def annule():
        appels["n"] += 1
        return appels["n"] > 1

    await vb.bouger("ABC", "F", 2, annule)
    assert drives(emis) == ["F", "S"]


@pytest.mark.asyncio
async def test_suivi_puis_stop(emis, monkeypatch):
    async def faux_grab(code, timeout_ms=8000):
        await asyncio.sleep(0.05)
        return b"jpeg"

    async def faux_localiser(client, frame, objet):
        await asyncio.sleep(0.05)
        return {"vu": True, "x": 0.0, "taille": 0.1}

    monkeypatch.setattr(vb, "grab_frame", faux_grab)
    monkeypatch.setattr(vb, "localiser_objet", faux_localiser)
    out = await vb.run_tool("suivre_personne", {}, ctx(client=object()))
    assert out[0]["text"] == "Je te suis. Dis stop quand tu veux que j arrete."
    await asyncio.sleep(1.0)
    assert drives(emis)[0] == "V170"
    assert "F" in drives(emis)

    out = await vb.run_tool("piloter", {"action": "stop"}, ctx())
    assert out[0]["text"] == "Robot arrete, je ne te suis plus."
    n = len(emis)
    await asyncio.sleep(0.9)
    assert "F" not in drives(emis[n:])
    assert not vb.suivis["ABC"]["actif"]
    assert (await vb.run_tool("arreter_suivi", {}, ctx()))[0]["text"] == "Je n'etais pas en train de suivre."


@pytest.mark.asyncio
async def test_grab_frame(monkeypatch):
    monkeypatch.setattr(vb, "room_sids", lambda code: [])
    assert (await vb.grab_frame("ABC")) is None

    monkeypatch.setattr(vb, "room_sids", lambda code: ["app", "robot"])

    async def faux_call(sid, event, data=None, timeout=8):
        assert event == "robot_grab_frame" and data == {}
        if sid == "app":
            await asyncio.sleep(10)
        return b"image"

    monkeypatch.setattr(vb, "call", faux_call)
    assert (await asyncio.wait_for(vb.grab_frame("ABC"), 2)) == b"image"

    async def call_vide(sid, event, data=None, timeout=8):
        return None

    monkeypatch.setattr(vb, "call", call_vide)
    assert (await vb.grab_frame("ABC", timeout_ms=200)) is None


@pytest.mark.asyncio
async def test_decrire_scene(monkeypatch):
    assert (await vb.decrire_scene(b"jpeg")) is None

    client = FauxClient([
        reponse(texte('Voici : {"categorie":"animal","phrase":"Un chat sur le canape."}')),
        reponse(texte("Je vois une femme debout pres de la porte.")),
        reponse(texte('{"categorie":"bizarre","phrase":"Rien de visible."}')),
    ])
    monkeypatch.setattr(vb, "client_vision", lambda log=None: client)
    assert (await vb.decrire_scene(b"jpeg")) == {"categorie": "animal", "phrase": "Un chat sur le canape."}
    assert (await vb.decrire_scene(b"jpeg")) == {
        "categorie": "personne", "phrase": "Je vois une femme debout pres de la porte.",
    }
    assert (await vb.decrire_scene(b"jpeg")) == {"categorie": "rien", "phrase": "Rien de visible."}
    appel = client.messages.appels[0]
    assert appel["model"] == vb.VISION_MODEL and appel["max_tokens"] == 120
    assert appel["messages"][0]["content"][0]["source"]["data"] == base64.b64encode(b"jpeg").decode()
    assert (await vb.decrire_scene(b"")) is None


@pytest.mark.asyncio
async def test_localiser_objet():
    client = FauxClient([
        reponse(texte('{"vu": true, "x": 3, "taille": "0.4"}')),
        reponse(texte("pas de json")),
        reponse(texte("{casse}")),
    ])
    assert (await vb.localiser_objet(client, b"f", "la poubelle")) == {"vu": True, "x": 1, "taille": 0.4}
    assert (await vb.localiser_objet(client, b"f", "x")) == {"vu": False, "x": 0, "taille": 0}
    assert (await vb.localiser_objet(client, b"f", "x")) == {"vu": False, "x": 0, "taille": 0}
    assert client.messages.appels[0]["messages"][0]["content"][1]["text"] == "Ou se trouve : la poubelle ?"


@pytest.mark.asyncio
async def test_analyser_voie():
    client = FauxClient([
        reponse(texte('{"libre": false, "distance_m": 2.5, "cote_libre": "gauche"}')),
        reponse(texte('{"libre": true, "distance_m": 0, "cote_libre": "aucun"}')),
    ])
    vue = await vb.analyser_voie(client, b"f", {"distanceM": 42.4, "capRelatif": -35.5})
    assert vue == {"libre": False, "distance_m": 2.5, "cote_libre": "gauche"}
    situation = client.messages.appels[0]["messages"][0]["content"][1]["text"]
    assert situation.startswith("Je roule vers ma destination, situee a 42 metres, a 35 degres sur ma gauche.")
    vue = await vb.analyser_voie(client, b"f", None)
    assert vue == {"libre": True, "distance_m": 10, "cote_libre": None}
    assert client.messages.appels[1]["messages"][0]["content"][1]["text"] == "La voie est-elle libre devant moi ?"


@pytest.mark.asyncio
async def test_vision_obstacle(monkeypatch):
    assert (await vb._vision_obstacle("sid", {"frame": b"f", "nav": None})) is None
    client = FauxClient([reponse(texte('{"libre": false, "distance_m": 1.234, "cote_libre": "droite"}'))])
    monkeypatch.setattr(vb, "_client", client)
    ack = await vb._vision_obstacle("sid", {"code": "ABC", "frame": b"f", "nav": {"distanceM": 10, "capRelatif": 5}})
    assert ack == {"libre": False, "distanceCm": 123, "coteLibre": "droite"}
    assert (await vb._vision_obstacle("sid", None)) is None


@pytest.mark.asyncio
async def test_ask_claude_avec_outil(emis):
    tool_use = Bloc(type="tool_use", id="tu_1", name="ronde", input={"action": "etat"})
    client = FauxClient([
        reponse(texte("Je regarde."), tool_use, stop_reason="tool_use"),
        reponse(Bloc(type="thinking", thinking=""), texte(" Ta ronde tourne. "), stop_reason="end_turn"),
    ])
    conv = {"messages": [{"role": "user", "content": [{"type": "text", "text": "ou en est ta ronde"}]}], "last_at": 0}
    out = await vb.ask_claude(client, conv, ctx(client=client))
    assert out == "Ta ronde tourne."
    assert emis == [("ABC", "robot_ronde", {"action": "etat"})]

    premier = client.messages.appels[0]
    assert premier["model"] == vb.MODEL and premier["max_tokens"] == 4000
    assert premier["system"] == [{"type": "text", "text": vb.SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]
    assert premier["output_config"] == {"effort": vb.EFFORT}
    assert premier["tools"] is vb.TOOLS
    assert "thinking" not in premier and "speed" not in premier

    roles = [m["role"] for m in conv["messages"]]
    assert roles == ["user", "assistant", "user", "assistant"]
    assert conv["messages"][2]["content"] == [{
        "type": "tool_result", "tool_use_id": "tu_1",
        "content": [{"type": "text", "text": "Je regarde ou en est ma ronde."}],
    }]


@pytest.mark.asyncio
async def test_ask_claude_refus_et_limite():
    client = FauxClient([reponse(texte("..."), stop_reason="refusal")])
    conv = {"messages": [{"role": "user", "content": [{"type": "text", "text": "x"}]}]}
    assert (await vb.ask_claude(client, conv, ctx())) == "Desole, je prefere ne pas repondre a ca."

    boucle = [reponse(Bloc(type="tool_use", id=f"t{i}", name="voler", input={}), stop_reason="tool_use") for i in range(6)]
    client = FauxClient(boucle)
    conv = {"messages": [{"role": "user", "content": [{"type": "text", "text": "x"}]}]}
    assert (await vb.ask_claude(client, conv, ctx())) == "Je n'ai pas reussi a terminer cette action."
    assert len(client.messages.appels) == 6


@pytest.mark.asyncio
async def test_mode_rapide_et_repli(monkeypatch):
    monkeypatch.setenv("VOICE_FAST", "true")
    monkeypatch.setattr(vb, "MODEL", "claude-opus-5")
    erreur = RuntimeError("fast mode not enabled")
    erreur.status_code = 403
    client = FauxClient([reponse(texte("normal"))], beta=[erreur])
    lignes = []
    r = await vb.create_message(client, {"model": "claude-opus-5", "max_tokens": 10, "messages": []}, lambda *a: lignes.append(" ".join(a)))
    assert r.content[0].text == "normal"
    beta = client.beta.messages.appels[0]
    assert beta["speed"] == "fast" and beta["betas"] == ["fast-mode-2026-02-01"]
    assert "speed" not in client.messages.appels[0]
    assert lignes == ["[VOICE] mode rapide indisponible (403 fast mode not enabled) -> repli en vitesse normale."]

    monkeypatch.setattr(vb, "MODEL", "claude-sonnet-5")
    assert vb.fast_enabled() is False


@pytest.fixture
def transcription(monkeypatch):
    etat = {"texte": "", "chemins": []}

    async def faux_transcribe(wav_path, log=None):
        etat["chemins"].append(wav_path)
        with open(wav_path, "rb") as f:
            etat["audio"] = f.read()
        return etat["texte"]

    monkeypatch.setattr(vb, "transcribe", faux_transcribe)
    return etat


@pytest.mark.asyncio
async def test_voice_ask_requete_invalide():
    assert (await vb._voice_ask("sid", {"code": "ABC"})) == {"error": "requete invalide"}
    assert (await vb._voice_ask("sid", None)) == {"error": "requete invalide"}


@pytest.mark.asyncio
async def test_voice_ask_pas_compris(transcription):
    transcription["texte"] = ""
    r = await vb._voice_ask("sid", {"code": "ABC", "audio": b"RIFF"})
    assert r == {"text": "Je n'ai pas compris.", "heard": ""}
    assert transcription["audio"] == b"RIFF"
    assert not os.path.exists(transcription["chemins"][0])


@pytest.mark.asyncio
async def test_voice_ask_commande_locale(transcription, emis):
    transcription["texte"] = "Stop."
    r = await vb._voice_ask("sid", {"code": "ABC", "audio": b"RIFF", "frame": None})
    assert r == {"text": "Stop.", "heard": "Stop.", "local": True}
    assert drives(emis) == ["S"]

    transcription["texte"] = "je suis rentré"
    r = await vb._voice_ask("sid", {"code": "ABC", "audio": b"RIFF"})
    assert r["text"] == "Mode normal. La surveillance est desarmee, je ne guette plus." and r["local"] is True


@pytest.mark.asyncio
async def test_voice_ask_sans_client(transcription, emis, traces):
    transcription["texte"] = "raconte-moi une blague"
    r = await vb._voice_ask("sid", {"code": "ABC", "audio": b"RIFF"})
    assert r == {"text": "Je ne comprends que les commandes simples pour le moment.", "heard": "raconte-moi une blague"}
    assert any("PAS DE CLIENT CLAUDE" in l for l in traces)


@pytest.mark.asyncio
async def test_voice_ask_claude(transcription, emis, monkeypatch):
    client = FauxClient([reponse(texte("Bonjour Andy."))])
    monkeypatch.setattr(vb, "_client", client)
    transcription["texte"] = "comment vas-tu"
    r = await vb._voice_ask("sid", {"code": "ABC", "audio": b"RIFF", "frame": b"jpeg"})
    assert r == {"text": "Bonjour Andy.", "heard": "comment vas-tu"}
    assert [m["role"] for m in vb.conversations["ABC"]["messages"]] == ["user", "assistant"]


@pytest.mark.asyncio
async def test_voice_ask_erreur_credits(transcription, monkeypatch):
    client = FauxClient([RuntimeError("Your credit balance is too low")])
    monkeypatch.setattr(vb, "_client", client)
    transcription["texte"] = "comment vas-tu"
    r = await vb._voice_ask("sid", {"code": "ABC", "audio": b"RIFF"})
    assert r == {
        "error": "Your credit balance is too low",
        "text": "Je n ai plus de credits pour reflechir, mais je comprends toujours les commandes simples.",
    }


@pytest.mark.asyncio
async def test_voice_ask_fenetre_glissante(transcription, monkeypatch):
    vieux = []
    for i in range(12):
        vieux.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": []}]})
        vieux.append({"role": "assistant", "content": [texte(f"r{i}")]})
    vb.conversations["ABC"] = {"messages": vieux, "last_at": vb.now_ms()}
    client = FauxClient([reponse(texte("ok"))])
    monkeypatch.setattr(vb, "_client", client)
    transcription["texte"] = "comment vas-tu"
    await vb._voice_ask("sid", {"code": "ABC", "audio": b"RIFF"})
    envoyes = client.messages.appels[0]["messages"]
    assert envoyes[0]["role"] == "user"
    assert envoyes[0]["content"] == [{"type": "text", "text": "comment vas-tu"}]
