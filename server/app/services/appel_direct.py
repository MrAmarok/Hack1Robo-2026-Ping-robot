from __future__ import annotations

import asyncio
import base64
import importlib
import json
import re
import secrets
from typing import Any

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketState

from app.core.config import DOSSIER_ALERTES, PUBLIC_URL, env, env_float
from app.core.logs import log, now_ms
from app.core.sio import emit_room, tache
from app.services.realtime_voix import SessionVocale, _b64

CHEMIN_FLUX = "/twilio-flux"


def _duree_max_ms() -> float:
    return env_float("APPEL_DUREE_MAX_MS", 600000)


_attentes: dict[str, dict] = {}
VALIDITE_JETON_MS = 10 * 60 * 1000


def xml(t: Any) -> str:
    return importlib.import_module("app.services.appel_alerte").xml(t)


def _json(objet: Any) -> str:
    return json.dumps(objet, ensure_ascii=False, separators=(",", ":"))


def url_flux() -> str:
    if env("APPEL_FLUX_URL"):
        return env("APPEL_FLUX_URL") or ""
    base = env("PUBLIC_URL", PUBLIC_URL) or "https://api.ping-app.org"
    return re.sub(r"/$", "", re.sub(r"^http", "ws", base)) + "/ping" + CHEMIN_FLUX


def twiml_conversation(code: Any, heure: Any, phrase: Any) -> str | None:
    if not env("OPENAI_API_KEY"):
        log("[TEL] OPENAI_API_KEY absente : appel en message lu, sans conversation.")
        return None
    url = url_flux()
    if not url.startswith("wss://"):
        log(f"[TEL] adresse de flux non chiffree ({url}) : appel en message lu.")
        return None
    t = now_ms()
    for j, a in list(_attentes.items()):
        if a["expire"] < t:
            del _attentes[j]
    jeton = secrets.token_hex(16)
    _attentes[jeton] = {
        "code": str(code),
        "heure": heure,
        "phrase": phrase,
        "expire": t + VALIDITE_JETON_MS,
    }
    return (
        "<Response><Connect>"
        f'<Stream url="{xml(url)}"><Parameter name="jeton" value="{jeton}"/></Stream>'
        "</Connect></Response>"
    )


def _outils_telephone(code: str) -> list[dict]:
    owner = env("OWNER_NAME", "Andy")
    adresse = env("ADRESSE_MAISON", "") or ""

    async def alarme(entree: dict) -> list[dict]:
        on = entree.get("on")
        await emit_room(code, "robot_alarme", {"on": bool(on)})
        log(
            f"[TEL] {code} : sirene {'declenchee' if on else 'arretee'} par l'assistant."
        )
        return [
            {"type": "text", "text": "Sirene declenchee." if on else "Sirene arretee."}
        ]

    async def dire_par_le_robot(entree: dict) -> list[dict]:
        t = str(entree.get("texte") or "").strip()[:300]
        if not t:
            return [{"type": "text", "text": "Rien a dire."}]
        await emit_room(code, "robot_say", {"text": t})
        log(f'[TEL] {code} : le robot dit "{t}"')
        return [{"type": "text", "text": "Phrase prononcee par le robot."}]

    outils: list[dict] = [
        {
            "declaration": {
                "type": "function",
                "name": "alarme",
                "description": "Declenche ou arrete la sirene du robot, dans la maison.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "on": {
                            "type": "boolean",
                            "description": "true pour declencher, false pour arreter",
                        }
                    },
                    "required": ["on"],
                },
            },
            "executer": alarme,
        },
        {
            "declaration": {
                "type": "function",
                "name": "dire_par_le_robot",
                "description": (
                    "Fait dire une phrase par le haut-parleur du robot, DANS la maison (par exemple a l'intrus). "
                    "Ce que dit l'utilisateur au telephone n'y est PAS diffuse sans cet outil."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "texte": {
                            "type": "string",
                            "description": "La phrase exacte a prononcer",
                        }
                    },
                    "required": ["texte"],
                },
            },
            "executer": dire_par_le_robot,
        },
    ]

    numero_proche = env("PROCHE_NUMERO")
    if numero_proche:
        nom = env("PROCHE_NOM", "le proche enregistre")
        deja_prevenu = False

        async def prevenir_proche(entree: dict) -> list[dict]:
            nonlocal deja_prevenu
            message = entree.get("message")
            if deja_prevenu:
                return [
                    {
                        "type": "text",
                        "text": f"{nom} a deja ete appele pendant cet appel.",
                    }
                ]
            deja_prevenu = True
            texte = (
                f"Message automatique du robot de surveillance de {owner}. "
                f"Une personne a été vue chez lui{f', au {adresse}' if adresse else ''}. "
                f"{str(message or '')[:300]} "
                f"{owner} vous demande de vérifier, et d'appeler le 17 si nécessaire."
            )
            twiml = (
                "<Response>"
                f'<Say language="fr-FR" voice="Polly.Lea">{xml(texte)}</Say>'
                '<Pause length="1"/>'
                f'<Say language="fr-FR" voice="Polly.Lea">{xml(texte)}</Say>'
                "</Response>"
            )
            appel_alerte = importlib.import_module("app.services.appel_alerte")
            r = await appel_alerte.lancer_appel_twilio(numero_proche, twiml)
            if not r.get("ok"):
                deja_prevenu = False
                return [{"type": "text", "text": f"L'appel a {nom} a echoue."}]
            log(f"[TEL] {code} : {nom} prevenu ({r.get('sid') or '?'}).")
            return [{"type": "text", "text": f"{nom} est en train d'etre appele."}]

        outils.append(
            {
                "declaration": {
                    "type": "function",
                    "name": "prevenir_proche",
                    "description": (
                        f"Appelle {nom} et lui lit un message d'alerte avec l'adresse. "
                        f"A utiliser seulement si {owner} le demande ou l'accepte."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "message": {
                                "type": "string",
                                "description": "Ce qui se passe, en une phrase",
                            }
                        },
                        "required": ["message"],
                    },
                },
                "executer": prevenir_proche,
            }
        )
    return outils


def _consignes_telephone(heure: Any, phrase: Any) -> str:
    owner = env("OWNER_NAME", "Andy")
    adresse = env("ADRESSE_MAISON", "") or ""
    nom_proche = (env("PROCHE_NOM") or "son proche") if env("PROCHE_NUMERO") else None
    return (
        f"APPEL TELEPHONIQUE. Tu parles a {owner} AU TELEPHONE : c'est toi qui l'as appele, "
        f"parce qu'une personne a ete vue chez lui pendant son absence, a {heure}"
        + (f" (sur la photo : {phrase})" if phrase else "")
        + f". Tu ne parles PAS a quelqu'un dans la maison, et ce que dit {owner} n'y est pas diffuse. "
        + "Pour parler a la personne dans la maison, utilise dire_par_le_robot. Pour la sirene, alarme. "
        + "L'outil regarder montre la DERNIERE PHOTO D'ALERTE, pas forcement l'instant present : dis-le.\n\n"
        + "SECOURS. Tu ne peux PAS appeler la police, les pompiers, le 17 ou le 112, et tu ne dois "
        + f"jamais pretendre l'avoir fait ni qu'ils arrivent. Si {owner} demande les secours, ou si la "
        + "situation semble dangereuse, dis-lui clairement de raccrocher et d'appeler lui-meme le 17 "
        + "(police) ou le 112, et donne-lui en une phrase quoi leur dire : "
        + (f"l'adresse, {adresse}, " if adresse else "l'adresse de la maison, ")
        + "et la description de la personne."
        + (
            f" Tu peux aussi prevenir {nom_proche} avec prevenir_proche, si {owner} le demande ou l'accepte."
            if nom_proche
            else ""
        )
        + "\n\nN'agis pas seul sur ce qui est grave : sirene, message a l'intrus et appel d'un proche "
        + f"se font a la demande de {owner}, ou apres lui avoir propose. Reste calme et bref : il est "
        + "peut-etre inquiet, dans la rue, ou au travail."
    )


def _image_alerte(code: Any) -> bytes | None:
    try:
        with open(f"{DOSSIER_ALERTES}/{code}.jpg", "rb") as f:
            return f.read()
    except Exception:
        return None


def _message(e: BaseException) -> str:
    return str(e) or e.__class__.__name__


router = APIRouter()


@router.websocket(CHEMIN_FLUX)
async def flux_twilio(websocket: WebSocket) -> None:
    proposes = websocket.scope.get("subprotocols") or []
    await websocket.accept(subprotocol=proposes[0] if proposes else None)
    await _brancher(websocket)


async def _brancher(ws: Any) -> None:
    await _Appel(ws).ecouter()


class _Appel:
    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self.session: SessionVocale | None = None
        self.stream_sid: Any = None
        self.code: Any = "?"
        self.fin_forcee: asyncio.TimerHandle | None = None

    def _ouvert(self) -> bool:
        return (
            self.ws.client_state == WebSocketState.CONNECTED
            and self.ws.application_state == WebSocketState.CONNECTED
        )

    async def _fermer_flux(self) -> None:
        if self._ouvert():
            try:
                await self.ws.close()
            except Exception:
                pass

    async def vers_twilio(self, objet: dict) -> None:
        if self._ouvert():
            try:
                await self.ws.send_text(_json(objet))
            except Exception:
                pass

    def _avec_stream(self, objet: dict) -> dict:
        if self.stream_sid is not None:
            objet["streamSid"] = self.stream_sid
        return objet

    async def terminer(self, raison: str) -> None:
        if self.fin_forcee is not None:
            self.fin_forcee.cancel()
        self.fin_forcee = None
        if self.session:
            s = self.session
            self.session = None
            log(f"[TEL] {self.code} : fin de l'appel ({raison}).")
            await s.fermer()
        await self._fermer_flux()

    async def _sur_audio(self, octets: bytes) -> None:
        await self.vers_twilio(
            {
                "event": "media",
                **self._avec_stream({}),
                "media": {"payload": base64.b64encode(bytes(octets)).decode("ascii")},
            }
        )

    async def _sur_etat(self, e: dict) -> None:
        if e.get("interrompre"):
            await self.vers_twilio(self._avec_stream({"event": "clear"}))
        if e.get("actif") is False:
            await self.terminer("session OpenAI fermee")

    async def ecouter(self) -> None:
        try:
            while True:
                msg = await self.ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                brut = msg.get("text")
                if brut is None and msg.get("bytes") is not None:
                    brut = bytes(msg["bytes"]).decode("utf-8", "replace")
                if brut is not None:
                    await self._sur_message(brut)
        except asyncio.CancelledError:
            tache(self.terminer("flux ferme"))
            raise
        except Exception as e:
            log(f"[TEL] {self.code} : erreur du flux : {_message(e)}")
            await self.terminer("erreur du flux")
        await self.terminer("flux ferme")

    async def _sur_message(self, brut: str) -> None:
        try:
            m = json.loads(brut)
        except Exception:
            return
        if not isinstance(m, dict):
            return
        evenement = m.get("event")

        if evenement == "start":
            start = m.get("start") if isinstance(m.get("start"), dict) else None
            self.stream_sid = start.get("streamSid") if start else None
            params = start.get("customParameters") if start else None
            jeton = params.get("jeton") if isinstance(params, dict) else None
            a = _attentes.get(jeton) if isinstance(jeton, str) and jeton else None
            if isinstance(jeton, str) and jeton:
                _attentes.pop(jeton, None)
            if not a or a["expire"] < now_ms():
                log("[TEL] flux refuse : jeton absent, inconnu ou expire.")
                await self._fermer_flux()
                return
            self.code = code = a["code"]
            log(f"[TEL] {code} : appel decroche, conversation avec l'assistant.")
            self.session = SessionVocale(
                code=code,
                log=log,
                veille=False,
                annoncer=False,
                etiquette="TEL",
                format_audio={"type": "audio/pcmu"},
                detection={
                    "type": "server_vad",
                    "threshold": env_float("APPEL_VAD_SEUIL", 0.5),
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 600,
                },
                consignes=_consignes_telephone(a.get("heure"), a.get("phrase")),
                outils=_outils_telephone(code),
                image=lambda: _image_alerte(code),
                accueil=(
                    "[L'appel vient d'etre decroche.] Annonce en une ou deux phrases pourquoi tu appelles "
                    "et ce que montre la photo, puis demande ce qu'il veut faire."
                ),
                on_audio=self._sur_audio,
                on_etat=self._sur_etat,
            )
            if not self.session.ouvrir():
                await self.terminer("OpenAI indisponible")
                return
            self.fin_forcee = asyncio.get_running_loop().call_later(
                _duree_max_ms() / 1000,
                lambda: tache(self.terminer("duree maximale atteinte")),
            )
            return

        media = m.get("media")
        if (
            evenement == "media"
            and self.session
            and isinstance(media, dict)
            and media.get("payload")
        ):
            self.session.pousser_audio(_b64(media["payload"]))
            return

        if evenement == "stop":
            await self.terminer("raccroche")


def attach_appel_direct() -> None:
    log(f"[TEL] conversation telephonique prete ({url_flux()}).")
