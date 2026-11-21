from __future__ import annotations

import asyncio
import base64
import importlib
import inspect
import json
import math
import re
import unicodedata
from functools import lru_cache
from typing import Any, Callable
from urllib.parse import quote

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed
from websockets.protocol import State

from app.core.config import ENV_FILE, env, env_float
from app.core.logs import log, now_ms
from app.core.sio import (
    emit_room,
    emit_to,
    on,
    on_disconnect,
    payload,
    room_sids,
    tache,
)

TAUX = 24000

_VERIF_INACTIVITE_S = 15.0


def _model() -> str:
    return env("REALTIME_MODEL", "gpt-realtime-2.1") or "gpt-realtime-2.1"


_SURS_URI = "-_.!~*'()"


def _url() -> str:
    return "wss://api.openai.com/v1/realtime?model=" + quote(_model(), safe=_SURS_URI)


def _voix() -> str:
    return env("REALTIME_VOICE", "marin") or "marin"


def _inactivite_ms() -> float:
    return env_float("REALTIME_IDLE_MS", 120000)


def _detection_tour() -> dict:
    if env("REALTIME_VAD", "server") == "semantic":
        return {"type": "semantic_vad", "eagerness": env("REALTIME_VAD_ARDEUR", "low")}
    return {
        "type": "server_vad",
        "threshold": env_float("REALTIME_VAD_SEUIL", 0.7),
        "prefix_padding_ms": 300,
        "silence_duration_ms": 700,
    }


def _veille_defaut() -> bool:
    return (env("REALTIME_VEILLE", "true") or "true").lower() == "true"


_MOT_REVEIL_DEFAUT = r"\b(solana|sol ana|solanna|solana|solene|solenna)\b"


@lru_cache(maxsize=8)
def _compiler(motif: str) -> re.Pattern:
    return re.compile(motif, re.IGNORECASE)


def _mot_reveil() -> re.Pattern:
    return _compiler(
        env("REALTIME_MOT_REVEIL", _MOT_REVEIL_DEFAUT) or _MOT_REVEIL_DEFAUT
    )


def _veille_delai_ms() -> float:
    return env_float("REALTIME_VEILLE_MS", 90000)


def _mot_reveil_lisible() -> str:
    return env("REALTIME_MOT_REVEIL_LISIBLE", "Salut Solana") or "Salut Solana"


def sans_accents(t: Any) -> str:
    s = unicodedata.normalize("NFD", str(t).lower())
    s = re.sub(r"[̀-ͯ]", "", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _json(objet: Any) -> str:
    return json.dumps(objet, ensure_ascii=False, separators=(",", ":"))


def _b64(texte: Any) -> bytes:
    if isinstance(texte, (bytes, bytearray, memoryview)):
        texte = bytes(texte).decode("ascii", "ignore")
    s = str(texte).split("=", 1)[0]
    s = re.sub(r"[^A-Za-z0-9+/\-_]", "", s).replace("-", "+").replace("_", "/")
    if len(s) % 4 == 1:
        s = s[:-1]
    try:
        return base64.b64decode(s + "=" * (-len(s) % 4))
    except Exception:
        return b""


def _octets(x: Any) -> bytes | None:
    if isinstance(x, (bytes, bytearray, memoryview)):
        return bytes(x)
    if isinstance(x, str):
        return x.encode("utf-8")
    if (
        isinstance(x, dict)
        and x.get("type") == "Buffer"
        and isinstance(x.get("data"), list)
    ):
        x = x["data"]
    if isinstance(x, (list, tuple)):
        try:
            return bytes(int(v) & 0xFF for v in x)
        except (TypeError, ValueError):
            return None
    return None


def _arrondi(x: float) -> int:
    return int(math.floor(x + 0.5))


def _message(e: BaseException) -> str:
    return str(e) or e.__class__.__name__


async def _attendre(r: Any) -> Any:
    if inspect.isawaitable(r):
        return await r
    return r


def _voice_brain():
    return importlib.import_module("app.services.voice_brain")


def outils_openai() -> list[dict]:
    sortie = []
    for t in _voice_brain().TOOLS:
        o = {
            "type": "function",
            "name": t.get("name"),
            "description": t.get("description"),
            "parameters": t.get("input_schema"),
        }
        sortie.append({k: v for k, v in o.items() if v is not None})
    return sortie


async def _connecter(url: str, cle: str):
    return await connect(
        url,
        additional_headers={"Authorization": f"Bearer {cle}"},
        max_size=100 * 1024 * 1024,
        ping_interval=None,
        proxy=None,
    )


_FERMER = object()


class _Liaison:
    def __init__(self) -> None:
        self.conn: Any = None
        self.fermee = False
        self._file: asyncio.Queue = asyncio.Queue()
        self._ecrivain: asyncio.Task | None = None

    @property
    def ouverte(self) -> bool:
        return (
            self.conn is not None
            and not self.fermee
            and getattr(self.conn, "state", None) is State.OPEN
        )

    def demarrer(self, conn: Any) -> None:
        self.conn = conn
        self._ecrivain = tache(self._ecrire())

    def envoyer(self, texte: str) -> None:
        self._file.put_nowait(texte)

    def close(self) -> None:
        if self.fermee:
            return
        self.fermee = True
        self._file.put_nowait(_FERMER)

    def arreter(self) -> None:
        t = self._ecrivain
        self._ecrivain = None
        if t is not None and t is not asyncio.current_task():
            t.cancel()

    async def _ecrire(self) -> None:
        while True:
            t = await self._file.get()
            if t is _FERMER:
                try:
                    await self.conn.close()
                except Exception:
                    pass
                return
            try:
                await self.conn.send(t)
            except Exception:
                return


def _annuler(t: asyncio.Task | None) -> None:
    if t is None:
        return
    try:
        courante = asyncio.current_task()
    except RuntimeError:
        courante = None
    if t is not courante:
        t.cancel()


class SessionVocale:
    def __init__(
        self,
        *,
        code: Any,
        io: Any = None,
        log: Callable[..., None] | None = None,
        on_audio: Callable[[bytes], Any] | None = None,
        on_etat: Callable[[dict], Any] | None = None,
        veille: bool | None = None,
        annoncer: bool | None = None,
        format_audio: dict | None = None,
        detection: dict | None = None,
        consignes: str | None = None,
        outils: list[dict] | None = None,
        accueil: str | None = None,
        image: Callable[[], bytes | None] | None = None,
        etiquette: str | None = None,
    ) -> None:
        self.code = code
        self.veille = bool(veille) if veille is not None else _veille_defaut()
        self.annoncer = annoncer is not False
        self.format_audio = format_audio or {"type": "audio/pcm", "rate": TAUX}
        self.detection = detection or _detection_tour()
        self.consignes = consignes or ""
        self.outils_en_plus = outils or []
        self.accueil = accueil or None
        self.image_fournie = image or None
        self.etiquette = etiquette or "RT"
        self.io = io
        self.log = log or _journal
        self.on_audio = on_audio or (lambda _pcm: None)
        self.on_etat = on_etat or (lambda _etat: None)
        self.ws: _Liaison | None = None
        self.prete = False
        self.dernier_echange = now_ms()
        self._minuteur: asyncio.Task | None = None
        self.image: bytes | None = None
        self.ouverte_a = 0
        self.reponses = 0
        self.reponse_en_cours = False
        self.eveille = not self.veille
        self.veille_timer: asyncio.Task | None = None
        if self.veille:
            self.log(
                f'[{self.etiquette}] code={self.code} en veille, dites "{_mot_reveil_lisible()}" pour parler.'
            )

    async def _audio(self, pcm: bytes) -> None:
        await _attendre(self.on_audio(pcm))

    async def _etat(self, etat: dict) -> None:
        await _attendre(self.on_etat(etat))

    def ouvrir(self) -> bool:
        cle = env("OPENAI_API_KEY")
        if not cle:
            self.log("[RT] OPENAI_API_KEY absente -> mode temps reel indisponible.")
            return False
        if self.ws:
            return True

        liaison = _Liaison()
        self.ws = liaison
        tache(self._vivre(liaison, _url(), cle))
        return True

    async def _vivre(self, liaison: _Liaison, url: str, cle: str) -> None:
        try:
            conn = await _connecter(url, cle)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await self._sur_erreur(_message(e))
            await self._sur_fermeture(1006, "")
            return

        if liaison.fermee:
            tache(_fermer_sans_attendre(conn))
            await self._sur_erreur(
                "WebSocket was closed before the connection was established"
            )
            await self._sur_fermeture(1006, "")
            return

        liaison.demarrer(conn)
        erreur: BaseException | None = None
        try:
            await self._sur_ouverture(liaison)
            async for brut in conn:
                try:
                    await self._sur_evenement(brut)
                except Exception as e:
                    self.log(
                        f"[{self.etiquette}] code={self.code} erreur : {_message(e)}"
                    )
        except ConnectionClosed:
            pass
        except asyncio.CancelledError:
            liaison.arreter()
            raise
        except Exception as e:
            erreur = e
        liaison.arreter()
        if erreur is not None:
            await self._sur_erreur(_message(erreur))
        code = getattr(conn, "close_code", None)
        await self._sur_fermeture(
            code if code is not None else 1006, getattr(conn, "close_reason", "") or ""
        )

    async def _sur_ouverture(self, liaison: _Liaison) -> None:
        vb = _voice_brain()
        self.log(
            f"[{self.etiquette}] code={self.code} session ouverte ({_model()}, voix {_voix()})."
        )
        liaison.envoyer(
            _json(
                {
                    "type": "session.update",
                    "session": {
                        "type": "realtime",
                        "instructions": (
                            vb.SYSTEM_PROMPT
                            + "\n\nTu es maintenant en conversation VOCALE DIRECTE. Reponds en une ou deux "
                            + "phrases courtes, comme on parle. Si tu dois agir, agis d'abord et commente "
                            + "en une phrase. N'enumere jamais de listes a voix haute."
                            + ("\n\n" + self.consignes if self.consignes else "")
                        ),
                        "audio": {
                            "input": {
                                "format": self.format_audio,
                                "turn_detection": (
                                    {**self.detection, "create_response": False}
                                    if self.veille
                                    else self.detection
                                ),
                                "transcription": {
                                    "model": "gpt-4o-mini-transcribe",
                                    "language": "fr",
                                },
                            },
                            "output": {"format": self.format_audio, "voice": _voix()},
                        },
                        "tools": [
                            *outils_openai(),
                            *[o["declaration"] for o in self.outils_en_plus],
                        ],
                        "tool_choice": "auto",
                    },
                }
            )
        )
        self.prete = True
        self.ouverte_a = now_ms()
        self.reponses = 0
        await self._etat({"actif": True})
        await self._annoncer_veille()
        self._armer_inactivite()
        if self.accueil:
            self._envoyer(
                {
                    "type": "conversation.item.create",
                    "item": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": self.accueil}],
                    },
                }
            )
            self._envoyer({"type": "response.create"})

    async def _sur_erreur(self, message: str) -> None:
        self.log(f"[{self.etiquette}] code={self.code} erreur : {message}")
        await self._nettoyer()

    async def _sur_fermeture(self, code: Any, motif: str) -> None:
        txt = str(motif or "")[:200]
        self.log(
            f"[{self.etiquette}] code={self.code} session fermee"
            f" (code={code}{', motif=' + txt if txt else ''}"
            f", {_arrondi((now_ms() - self.ouverte_a) / 1000)}s, {self.reponses} reponse(s))."
        )
        await self._nettoyer()

    async def _sur_evenement(self, brut: Any) -> None:
        try:
            texte = (
                brut
                if isinstance(brut, str)
                else bytes(brut).decode("utf-8", "replace")
            )
            ev = json.loads(texte)
        except Exception:
            return
        if not isinstance(ev, dict):
            ev = {}
        await self._traiter(ev)
        self.dernier_echange = now_ms()

    async def _traiter(self, ev: dict) -> None:
        t = ev.get("type")

        if t == "input_audio_buffer.speech_started":
            await self._etat({"interrompre": True})

        elif t == "response.output_audio.delta":
            if ev.get("delta"):
                await self._audio(_b64(ev["delta"]))

        elif t == "response.created":
            self.reponse_en_cours = True

        elif t == "response.output_audio.done":
            self.reponses += 1
            await self._etat({"finReponse": True})

        elif t == "response.output_audio_transcript.done":
            if ev.get("transcript"):
                self.log(
                    f'[{self.etiquette}] code={self.code} robot: "{ev["transcript"]}"'
                )

        elif t == "conversation.item.input_audio_transcription.completed":
            await self._sur_transcription(ev.get("transcript"))

        elif t == "response.done":
            self.reponse_en_cours = False
            tache(self._traiter_outils(ev))

        elif t == "error":
            self.log(
                f"[{self.etiquette}] code={self.code} erreur API : {_json(ev.get('error') or ev)[:300]}"
            )

    async def _sur_transcription(self, transcript: Any) -> None:
        if transcript:
            self.log(f'[{self.etiquette}] code={self.code} entendu: "{transcript}"')
            await emit_room(self.code, "rt_entendu", {"texte": transcript})

            if self.veille:
                dit = sans_accents(transcript)
                if _mot_reveil().search(dit):
                    await self._reveiller("nom prononce")
                elif not self.eveille:
                    self.log(
                        f"[{self.etiquette}] code={self.code} en veille, pas de reponse."
                    )
                    return
                else:
                    self._programmer_veille()

            if self.veille and not self.reponse_en_cours:
                self._envoyer({"type": "response.create"})
        elif self.veille and self.eveille:
            self.log(
                f"[{self.etiquette}] code={self.code} tour sans transcription -> reponse demandee quand meme."
            )
            if not self.reponse_en_cours:
                self._envoyer({"type": "response.create"})

    def _programmer_veille(self) -> None:
        _annuler(self.veille_timer)
        self.veille_timer = tache(self._retour_veille(_veille_delai_ms() / 1000))

    async def _retour_veille(self, delai_s: float) -> None:
        await asyncio.sleep(delai_s)
        self.veille_timer = None
        if not self.eveille:
            return
        self.eveille = False
        self.log(f"[{self.etiquette}] code={self.code} retour en veille.")
        await self._annoncer_veille()

    async def _reveiller(self, raison: str) -> None:
        if not self.eveille:
            self.eveille = True
            self.log(f"[{self.etiquette}] code={self.code} reveil ({raison}).")
            await self._annoncer_veille()
        self._programmer_veille()

    def etat_veille(self) -> dict:
        return {
            "eveille": self.eveille,
            "veille": self.veille,
            "phrase": _mot_reveil_lisible(),
        }

    async def _annoncer_veille(self) -> None:
        if not self.annoncer:
            return
        await emit_room(self.code, "rt_veille", self.etat_veille())

    async def _traiter_outils(self, ev: dict) -> None:
        reponse = ev.get("response")
        sorties = (reponse.get("output") if isinstance(reponse, dict) else None) or []
        appels = [
            o
            for o in sorties
            if isinstance(o, dict) and o.get("type") == "function_call"
        ]
        if not appels:
            return

        for appel in appels:
            try:
                entree = json.loads(appel.get("arguments") or "{}")
            except Exception:
                entree = {}
            texte = ""
            images: list[str] = []
            try:
                propre = next(
                    (
                        o
                        for o in self.outils_en_plus
                        if o["declaration"].get("name") == appel.get("name")
                    ),
                    None,
                )
                if propre:
                    blocs = await _attendre(propre["executer"](entree))
                else:
                    blocs = await _voice_brain().run_tool(
                        appel.get("name"),
                        entree,
                        {
                            "code": self.code,
                            "frame": (
                                self.image_fournie()
                                if self.image_fournie
                                else self.image
                            ),
                            "log": self.log,
                        },
                    )
                blocs = [b for b in (blocs or []) if isinstance(b, dict)]
                texte = " ".join(
                    "" if b.get("text") is None else str(b.get("text"))
                    for b in blocs
                    if b.get("type") == "text"
                )
                images = [
                    f"data:{b['source'].get('media_type') or 'image/jpeg'};base64,{b['source']['data']}"
                    for b in blocs
                    if b.get("type") == "image"
                    and isinstance(b.get("source"), dict)
                    and b["source"].get("data")
                ]
            except Exception as e:
                texte = f"Erreur outil : {_message(e)}"
            self.log(
                f"[{self.etiquette}] code={self.code} outil {appel.get('name')} -> {texte[:80]}"
                + (f" [+{len(images)} image]" if images else "")
            )
            self._envoyer(
                {
                    "type": "conversation.item.create",
                    "item": {
                        "type": "function_call_output",
                        "call_id": appel.get("call_id"),
                        "output": _json({"resultat": texte}),
                    },
                }
            )
            for url in images:
                self._envoyer(
                    {
                        "type": "conversation.item.create",
                        "item": {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_image", "image_url": url}],
                        },
                    }
                )
        self._envoyer({"type": "response.create"})

    def _envoyer(self, objet: Any) -> None:
        if self.ws is not None and self.ws.ouverte:
            self.ws.envoyer(_json(objet))

    def pousser_audio(self, pcm: Any) -> None:
        if not self.prete or not pcm:
            return
        octets = _octets(pcm)
        if not octets:
            return
        self.dernier_echange = now_ms()
        self._envoyer(
            {
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(octets).decode("ascii"),
            }
        )

    def _armer_inactivite(self) -> None:
        _annuler(self._minuteur)
        self._minuteur = tache(self._surveiller_inactivite())

    async def _surveiller_inactivite(self) -> None:
        while True:
            await asyncio.sleep(_VERIF_INACTIVITE_S)
            if now_ms() - self.dernier_echange > _inactivite_ms():
                self.log(
                    f"[{self.etiquette}] code={self.code} inactive -> fermeture (economie)."
                )
                await self.fermer()
                return

    async def fermer(self) -> None:
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        await self._nettoyer()

    async def _nettoyer(self) -> None:
        _annuler(self._minuteur)
        self._minuteur = None
        _annuler(self.veille_timer)
        self.veille_timer = None
        self.ws = None
        self.prete = False
        await self._etat({"actif": False})


async def _fermer_sans_attendre(conn: Any) -> None:
    try:
        await conn.close()
    except Exception:
        pass


def _journal(*args: Any) -> None:
    log(*args)


_sessions: dict[Any, SessionVocale] = {}


def _obtenir(code: Any) -> SessionVocale:
    s = _sessions.get(code)
    if s and s.ws:
        return s

    async def sur_audio(pcm: bytes) -> None:
        await emit_room(code, "rt_audio_out", {"pcm": pcm})

    async def sur_etat(etat: dict) -> None:
        if etat.get("actif") is False and _sessions.get(code) is s:
            _sessions.pop(code, None)
        if etat.get("interrompre"):
            await emit_room(code, "rt_couper", {})
        else:
            await emit_room(code, "rt_etat", etat)

    s = SessionVocale(code=code, log=log, on_audio=sur_audio, on_etat=sur_etat)
    _sessions[code] = s
    return s


def _code(data: Any) -> Any:
    return payload(data).get("code")


@on("rt_start")
async def _rt_start(sid: str, data: Any) -> None:
    code = _code(data)
    if not code:
        return
    s = _obtenir(code)
    if not s.ouvrir():
        await emit_room(
            code, "rt_etat", {"actif": False, "erreur": "cle OpenAI absente"}
        )


@on("rt_veille_etat")
async def _rt_veille_etat(sid: str, data: Any) -> None:
    code = _code(data)
    s = _sessions.get(code) if code else None
    if s and s.ws:
        await emit_to(sid, "rt_veille", s.etat_veille())


@on("rt_audio")
async def _rt_audio(sid: str, data: Any) -> None:
    p = payload(data)
    code = p.get("code")
    if not code:
        return
    s = _sessions.get(code)
    if s:
        s.pousser_audio(p.get("pcm"))


@on("rt_frame")
async def _rt_frame(sid: str, data: Any) -> None:
    p = payload(data)
    code = p.get("code")
    s = _sessions.get(code) if code else None
    if s and p.get("frame"):
        octets = _octets(p.get("frame"))
        if octets is not None:
            s.image = octets


@on("rt_interrompre")
async def _rt_interrompre(sid: str, data: Any) -> None:
    code = _code(data)
    s = _sessions.get(code) if code else None
    if not s:
        return
    if s.reponse_en_cours:
        s._envoyer({"type": "response.cancel"})
        s.reponse_en_cours = False
    s._envoyer({"type": "input_audio_buffer.clear"})


@on("rt_stop")
async def _rt_stop(sid: str, data: Any) -> None:
    code = _code(data)
    s = _sessions.get(code) if code else None
    if s:
        log(f"[RT] code={code} arret demande par le robot (rt_stop).")
        await s.fermer()


@on_disconnect
async def _deconnexion(sid: str) -> None:
    for code, s in list(_sessions.items()):
        restants = [x for x in room_sids(code) if x != sid]
        if s.ws and not restants:
            log(f"[RT] code={code} plus personne dans la room -> fermeture.")
            await s.fermer()


def attach_realtime_voix() -> None:
    log(
        f"[RT] Mode conversation temps reel pret ({_model()}, voix {_voix()}, {TAUX} Hz)."
        if env("OPENAI_API_KEY")
        else f"[RT] Mode temps reel INACTIF : OPENAI_API_KEY absente de {ENV_FILE}"
    )
