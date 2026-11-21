from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import re
import tempfile
import unicodedata
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

import httpx

from app.core.config import ENV_FILE, env, env_float
from app.core.logs import log, now_ms
from app.core.sio import call, emit_room, on, payload, room_sids, tache, wait_for_event

WHISPER_BIN = env("WHISPER_BIN", "/root/whisper.cpp/build/bin/whisper-cli")
WHISPER_MODEL = env("WHISPER_MODEL", "/root/whisper.cpp/models/ggml-small-q5_1.bin")
WHISPER_PROMPT = env(
    "WHISPER_PROMPT",
    "Avance. Recule. Tourne a droite. Tourne a gauche. Stop. "
    "Regarde autour de toi et dis-moi ce que tu vois. Ou es-tu ? Prends une photo.",
)

MODEL = env("VOICE_MODEL", "claude-opus-5")
EFFORT = env("VOICE_EFFORT", "low")

HISTORY_TTL_MS = 15 * 60 * 1000
MAX_TURNS = 12
conversations: dict[str, dict] = {}

OWNER = env("OWNER_NAME", "Andy")

SYSTEM_PROMPT = f"""Tu es la voix d'un petit robot mobile a roues, en France. Tu t'appelles Solana.
Ton proprietaire s'appelle {OWNER} : c'est lui qui te parle et qui t'a construit. Tutoie-le et
appelle-le par son prenom de temps en temps, sans en abuser.
Ton texte est LU A VOIX HAUTE par une enceinte : reponds en francais, en une a deux phrases courtes,
sans listes, sans markdown, sans emoji, sans URL. Parle naturellement, comme un compagnon serviable.

Tu as de l'humour. De temps en temps — environ une fois sur cinq, jamais deux fois de suite —
glisse une petite blague pince-sans-rire, courte, dans le genre : "bon, aujourd'hui on pirate
la NASA", "je carbure au 11,1 volts et je me porte tres bien", "je suis a six roues motrices,
je crains personne dans le couloir". Invente les tiennes, ne repete pas toujours les memes.
Trois regles : ca reste TRES court, ca ne retarde jamais une action demandee, et tu laisses
tomber l'humour des que c'est serieux — obstacle, batterie faible, panne, ou si {OWNER} a
l'air presse ou agace. On plaisante avec lui, jamais a ses depens.

Tu peux agir sur le monde reel avec tes outils :
- piloter : bouger le robot. Il roule vraiment, dans une vraie piece ou une vraie rue.
- regarder : voir par ta camera quand on te demande ce que tu vois ou de decrire quelque chose.
- bouger_camera : tourner ta tete (la camera), sans deplacer le robot. Si tu ne vois pas ce qu'on
  te demande, tourne la tete et regarde a nouveau plutot que de repondre que tu ne vois rien.
- aller_vers_objet : rejoindre un objet que tu VOIS (poubelle, porte, personne). Tu avances par
  petits pas en le gardant au centre de ton image. C'est l'outil pour "va vers la poubelle".
- suivre_personne : mode "suis-moi". Tu emboites le pas a quelqu'un et tu gardes tes distances,
  en fond, jusqu'a ce qu'on te dise stop. arreter_suivi met fin a ce mode.
- aller_a : lancer la navigation GPS autonome vers une ADRESSE postale (pas un objet).
- ronde : surveillance en boucle. On t'APPREND un circuit en te pilotant une fois, puis tu le
  refais seul, avec une pause entre chaque tour. Pendant l'apprentissage tu n'enregistres que
  si on te conduit : dis-le clairement au lieu de laisser croire que c'est automatique.
- etat_robot : ta position GPS, tes capteurs, l'obstacle devant toi.

TU ES UN ROBOT DE SURVEILLANCE DE LA MAISON. C'est ta raison d'etre principale.
Tu fonctionnes selon DEUX MODES, que {OWNER} choisit depuis son telephone :
- MODE NORMAL : il est chez lui. Tu es un compagnon ordinaire, tu ne guettes rien
  et tu n'alertes personne. Ton micro de surveillance ne tourne meme pas.
- MODE ABSENT : il est parti et t'a laisse veiller. Tu surveilles vraiment :
  un radar de presence et l'analyse du bruit ambiant peuvent declencher une
  alerte sur son telephone, avec une photo de ce que tu vois.
Si on te demande dans quel mode tu es ou ce que tu surveilles, reponds
simplement et sans dramatiser.
C'est TOI qui changes de mode, avec l'outil mode_surveillance. Des qu'il
annonce qu'il s'en va, arme la surveillance sans qu'il ait a le demander : les
mains pleines sur le pas de la porte, personne ne pense a sortir son telephone.
Des qu'il annonce son retour, desarme-la. Mais une question n'est pas une
annonce, et le depart de quelqu'un d'autre ne te concerne pas : dans le doute,
demande plutot que de deviner.

SI TU DECOUVRES QUELQU'UN PENDANT UNE ABSENCE. Tu parles a un inconnu, pas a
{OWNER}. Reste calme, ferme et bref. Annonce ce qui est VRAI : que tu filmes,
que tu enregistres, et que le proprietaire vient d'etre prevenu. N'invente
jamais une intervention de police ou une alarme reliee a un centre de
surveillance — un mensonge te decredibiliserait au pire moment, et c'est le
genre d'affirmation qui se retourne contre {OWNER}. Pas d'humour dans ce
cas-la, jamais : c'est exactement la situation ou tu le laisses tomber.

A QUOI TU SERS. Si on te demande a quoi tu sers, ce que tu sais faire, ou comment tu
fonctionnes, explique-le simplement, avec tes mots, sans reciter de liste. En resume :
tu es un robot de TELESURVEILLANCE et de PRESENCE A DISTANCE. {OWNER} te pilote depuis
son telephone, d'ou qu'il soit, par la 4G ou le WiFi. Tu roules dans le logement, tu
montres ce que tu vois par ta camera, tu entends et tu parles — on peut donc prendre des
nouvelles de quelqu'un, ou verifier une piece, sans etre sur place. Tu sais aussi
apprendre un circuit qu'on te fait parcourir une fois, puis le refaire seul en boucle
pour surveiller les lieux a intervalles reguliers.
Reste HONNETE sur tes limites si on t'interroge dessus : tu n'es ni un dispositif
medical, ni une alarme reliee a un centre de surveillance, et tu ne remplaces personne.
Adapte la longueur : deux phrases si la question est posee en passant, un peu plus si on
veut vraiment comprendre. Jamais de liste enumeree a voix haute.

Regles de conduite : ne bouge que si on te le demande. Reste sous 3 secondes par mouvement sauf
demande explicite. Si un obstacle est proche ou si tu n'es pas sur d'avoir compris une commande de
mouvement, demande confirmation au lieu de rouler. Apres avoir agi, dis en quelques mots ce que tu
as fait.

Si la transcription semble incomprehensible ou vide, dis simplement que tu n'as pas compris."""

TOOLS: list[dict] = [
    {
        "name": "piloter",
        "description": (
            "Fait rouler le robot. L'action dure le nombre de secondes demande puis le robot s'arrete tout seul. "
            "Utilise 'stop' pour un arret immediat."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["avancer", "reculer", "gauche", "droite", "stop"],
                    "description": "Le mouvement a effectuer.",
                },
                "duree_secondes": {
                    "type": "number",
                    "description": "Duree du mouvement (0.2 a 5). Ignore pour stop. Defaut 1.",
                },
            },
            "required": ["action"],
        },
    },
    {
        "name": "regarder",
        "description": (
            "Prend une image par la camera du robot et te la montre. Utilise-le des qu'on te demande ce que "
            "tu vois, de decrire les alentours, de lire quelque chose, ou de chercher un objet."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "aller_a",
        "description": (
            "Lance la navigation GPS autonome vers une adresse. Le robot s'y rend seul. "
            "Utilise-le pour 'va a...', 'rejoins-moi a...', 'rentre a la maison' (si l'adresse est connue)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "adresse": {
                    "type": "string",
                    "description": "L'adresse ou le lieu de destination, en clair. Ex: '12 rue de la Paix, Paris'.",
                },
            },
            "required": ["adresse"],
        },
    },
    {
        "name": "bouger_camera",
        "description": (
            "Oriente ta tete (la camera sur son support pan-tilt). Le robot ne bouge pas, seule la camera tourne. "
            "Appelle-le quand on te dit 'regarde a gauche', 'leve la tete', 'baisse les yeux', 'remets-toi droit', "
            "ET SURTOUT de ta propre initiative : si on te demande de decrire ou de trouver quelque chose que tu "
            "ne vois pas dans ton champ, tourne la tete et reprends une photo au lieu de repondre que tu ne vois rien. "
            "Enchaine librement bouger_camera puis regarder pour balayer les alentours."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "direction": {
                    "type": "string",
                    "enum": ["gauche", "droite", "haut", "bas", "centre"],
                    "description": "Ou tourner la tete. 'centre' remet la camera droit devant.",
                },
                "amplitude": {
                    "type": "string",
                    "enum": ["peu", "moyen", "beaucoup"],
                    "description": "De combien. Par defaut 'moyen'. Ignore avec 'centre'.",
                },
            },
            "required": ["direction"],
        },
    },
    {
        "name": "ronde",
        "description": (
            "Gere les rondes de surveillance : un circuit que le robot APPREND en se faisant piloter une "
            "fois, puis rejoue en boucle tout seul avec une pause entre chaque tour. "
            "Appelle-le pour 'apprends la ronde' / 'retiens ce trajet' (action apprendre_debut), "
            "'c'est bon, tu connais le tour' (apprendre_fin), 'fais ta ronde' / 'commence a patrouiller' "
            "(demarrer), 'arrete la ronde' (arreter), 'oublie la ronde' (oublier), "
            "'ou en est ta ronde' (etat). "
            "IMPORTANT : apprendre_debut n'enregistre que pendant qu'on pilote le robot ; previens "
            "l'utilisateur qu'il doit maintenant faire le tour en le conduisant, puis te dire quand c'est fini."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "apprendre_debut",
                        "apprendre_fin",
                        "demarrer",
                        "arreter",
                        "oublier",
                        "etat",
                    ],
                    "description": "L'operation a effectuer sur la ronde.",
                },
            },
            "required": ["action"],
        },
    },
    {
        "name": "suivre_personne",
        "description": (
            "Mode 'suis-moi' : le robot emboite le pas a la personne devant lui et la suit en gardant "
            "ses distances, jusqu'a ce qu'on lui dise stop. A utiliser pour 'suis-moi', 'viens avec moi', "
            "'accompagne-moi'. Rend la main tout de suite : le robot continue de suivre en arriere-plan."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "cible": {
                    "type": "string",
                    "description": (
                        "Qui suivre, decrit visuellement. Par defaut 'la personne devant le robot'. "
                        "Precise s'il y a un detail utile : 'la personne au pull rouge'."
                    ),
                },
            },
            "required": [],
        },
    },
    {
        "name": "arreter_suivi",
        "description": (
            "Arrete le mode 'suis-moi' en cours. A utiliser pour 'arrete de me suivre', 'stop', "
            "'reste la' quand le robot est en train de suivre quelqu'un."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "aller_vers_objet",
        "description": (
            "Se diriger vers un objet VISIBLE par la camera (une poubelle, une porte, une personne...). "
            "Le robot avance par petits pas en recentrant l'objet dans son image, jusqu'a l'atteindre. "
            "A utiliser pour 'va vers...', 'rejoins...', 'approche-toi de...' quand la cible est un objet "
            "et non une adresse postale."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "objet": {
                    "type": "string",
                    "description": "Description courte et visuelle de la cible. Ex: 'la poubelle noire a roulettes'.",
                },
            },
            "required": ["objet"],
        },
    },
    {
        "name": "etat_robot",
        "description": (
            "Renvoie la position GPS du robot, la distance a l obstacle devant lui et l etat de ses moteurs."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "mode_surveillance",
        "description": (
            "Arme ou desarme la surveillance de la maison. A utiliser quand la personne ANNONCE "
            'qu\'elle part ("je m\'en vais", "j\'y vais", "je pars", "a ce soir") ou qu\'elle rentre '
            '("je suis rentre", "me revoila"), et quand elle demande explicitement le mode absent '
            'ou le mode normal. N\'appelle PAS cet outil sur une simple question ("tu es en mode quoi ?") '
            "ni si la personne parle du depart de quelqu'un d'autre."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "absent": {
                    "type": "boolean",
                    "description": (
                        "true = mode ABSENT, la surveillance s arme. false = mode NORMAL, elle se desarme."
                    ),
                },
            },
            "required": ["absent"],
        },
    },
]


_RE_NOMBRE_JS = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[+-]?Infinity")


def _js_truthy(v: Any) -> bool:
    if v is None or v is False:
        return False
    if v is True:
        return True
    if isinstance(v, (int, float)):
        return v != 0 and not math.isnan(v)
    if isinstance(v, str):
        return v != ""
    return True


def _js_number(v: Any) -> float:
    if v is None:
        return math.nan
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0.0
        if _RE_NOMBRE_JS.fullmatch(s):
            return float(s.replace("Infinity", "inf"))
        return math.nan
    return math.nan


def _ou(n: float, defaut: float) -> float:
    return n if (n and not math.isnan(n)) else defaut


def _est_fini(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


def _js_str(v: Any) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if math.isnan(v):
            return "NaN"
        if math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        if v.is_integer() and abs(v) < 1e21:
            return str(int(v))
        return repr(v)
    if isinstance(v, (list, tuple)):
        return ",".join("" if x is None else _js_str(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


def _texte(v: Any, defaut: str = "") -> str:
    return _js_str(v) if _js_truthy(v) else defaut


def _champ(o: Any, cle: str) -> Any:
    return o.get(cle) if isinstance(o, dict) else None


def _octets(x: Any) -> bytes:
    if isinstance(x, (bytes, bytearray, memoryview)):
        return bytes(x)
    if isinstance(x, str):
        return x.encode("utf-8")
    if isinstance(x, list):
        return bytes(int(b) & 0xFF for b in x)
    if (
        isinstance(x, dict)
        and x.get("type") == "Buffer"
        and isinstance(x.get("data"), list)
    ):
        return bytes(int(b) & 0xFF for b in x["data"])
    raise TypeError("donnee binaire attendue")


def _b64(frame: Any) -> str:
    if isinstance(frame, str):
        return frame
    return base64.b64encode(bytes(frame)).decode("ascii")


def _encode_uri_component(s: str) -> str:
    return quote(s, safe="-_.!~*'()")


def _msg(e: BaseException) -> str:
    m = getattr(e, "message", None)
    if isinstance(m, str) and m:
        return m
    return str(e) or type(e).__name__


def _type_bloc(b: Any) -> Any:
    return b.get("type") if isinstance(b, dict) else getattr(b, "type", None)


def _textes(blocs: Any) -> list[str]:
    out = []
    for b in blocs or []:
        if _type_bloc(b) == "text":
            out.append(
                b.get("text", "") if isinstance(b, dict) else getattr(b, "text", "")
            )
    return out


async def _attendre_ms(ms: float) -> None:
    await asyncio.sleep(max(0.0, ms) / 1000)


def normalize(s: Any) -> str:
    t = unicodedata.normalize("NFD", str(s).lower())
    t = re.sub(r"[\u0300-\u036f]", "", t)
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


NOMBRES = {
    "un": 1,
    "une": 1,
    "deux": 2,
    "trois": 3,
    "quatre": 4,
    "cinq": 5,
    "six": 6,
    "sept": 7,
    "huit": 8,
    "neuf": 9,
    "dix": 10,
    "demi": 0.5,
}


def duree_de(txt: str) -> float:
    chiffre = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:secondes?|s\b)", txt)
    if chiffre:
        return max(0.2, min(5, float(chiffre.group(1).replace(",", ".", 1))))
    for mot, val in NOMBRES.items():
        if re.search(rf"\b{mot}\b\s*(?:secondes?)", txt):
            return min(5, val)
    if re.search(
        r"\b(un peu|un petit peu|legerement|doucement|un chouia|un tout petit peu)\b",
        txt,
    ):
        return 0.6
    if re.search(r"\b(beaucoup|longtemps|bien|a fond|loin|tout droit)\b", txt):
        return 3
    return 1


_MOUVEMENTS = [
    (
        re.compile(
            r"\b(avance|avancer|avances|avancez|tout droit|en avant|va devant|vas y|roule|demarre)\b"
        ),
        "avancer",
        "J avance",
    ),
    (
        re.compile(
            r"\b(recule|reculer|recules|reculez|en arriere|va derriere|recul)\b"
        ),
        "reculer",
        "Je recule",
    ),
    (
        re.compile(
            r"\b(a droite|vers la droite|tourne droite|sur la droite|tourne a droite|pivote a droite)\b"
        ),
        "droite",
        "Je tourne a droite",
    ),
    (
        re.compile(
            r"\b(a gauche|vers la gauche|tourne gauche|sur la gauche|tourne a gauche|pivote a gauche)\b"
        ),
        "gauche",
        "Je tourne a gauche",
    ),
]


def commande_locale(texte: str) -> dict | None:
    t = normalize(texte)
    if not t:
        return None

    if re.search(
        r"\b(mode absent|active la surveillance|arme la surveillance|surveille la maison)\b",
        t,
    ) or re.search(
        r"\b(je m en vais|je men vais|je pars|j y vais|je quitte la maison)\b", t
    ):
        return {"tool": "mode_surveillance", "input": {"absent": True}, "reply": None}
    if re.search(
        r"\b(mode normal|(arrete|coupe|desactive|desarme) la surveillance)\b", t
    ) or re.search(
        r"\b(je suis rentre|je suis rentree|je suis revenu|je suis revenue|me revoila)\b",
        t,
    ):
        return {"tool": "mode_surveillance", "input": {"absent": False}, "reply": None}

    if re.search(r"\b(stop|stoppe|arrete|arretes|arreter|halte|stoppez)\b", t):
        return {"tool": "piloter", "input": {"action": "stop"}, "reply": "Stop."}

    if re.search(
        r"\b(suis moi|suit moi|suis moi stp|viens avec moi|accompagne moi|suis moi steuplait)\b",
        t,
    ):
        return {"tool": "suivre_personne", "input": {}, "reply": None}
    if re.search(r"\b(arrete de me suivre|ne me suis plus|reste la|reste ici)\b", t):
        return {"tool": "arreter_suivi", "input": {}, "reply": None}

    if re.search(
        r"\b(ou es tu|ou est tu|ou tu es|ta position|ton etat|ta batterie)\b", t
    ):
        return {"tool": "etat_robot", "input": {}, "reply": None}

    est_question = "?" in str(texte) or bool(
        re.search(
            r"^(qu|que|quoi|qui|quel|quelle|quels|quelles|ou|comment|pourquoi|combien|est ce que|peux tu"
            r"|sais tu|vois tu|y a t il|dis moi|decris|raconte|explique|cherche|trouve|regarde)\b",
            t,
        )
    )
    if est_question:
        return None

    if re.search(
        r"\b(demi tour|fais demi tour|retourne toi|fais un demi tour|volte face)\b", t
    ):
        return {
            "tool": "piloter",
            "input": {"action": "droite", "duree_secondes": 3},
            "reply": "Demi-tour.",
        }

    for regle, action, mot in _MOUVEMENTS:
        if regle.search(t):
            secs = duree_de(t)
            return {
                "tool": "piloter",
                "input": {"action": action, "duree_secondes": secs},
                "reply": f"{mot}.",
            }

    return None


def get_conversation(code: str) -> dict:
    now = now_ms()
    existing = conversations.get(code)
    if existing and now - existing["last_at"] < HISTORY_TTL_MS:
        existing["last_at"] = now
        return existing
    fresh = {"messages": [], "last_at": now}
    conversations[code] = fresh
    return fresh


DEEPGRAM_MODEL = env("DEEPGRAM_MODEL", "nova-3")


async def transcribe_deepgram(wav_path: str, key: str) -> str:
    audio = Path(wav_path).read_bytes()
    url = (
        f"https://api.deepgram.com/v1/listen?model={_encode_uri_component(DEEPGRAM_MODEL)}"
        "&language=fr&smart_format=true&punctuate=true"
    )

    async def _requete():
        async with httpx.AsyncClient() as c:
            res = await c.post(
                url,
                headers={"Authorization": f"Token {key}", "Content-Type": "audio/wav"},
                content=audio,
                timeout=15,
            )
            if not res.is_success:
                raise RuntimeError(f"deepgram {res.status_code} {res.text[:120]}")
            return res.json()

    data = await asyncio.wait_for(_requete(), 15)
    channels = _champ(_champ(data, "results"), "channels")
    canal = channels[0] if isinstance(channels, list) and channels else None
    alts = _champ(canal, "alternatives")
    alt = alts[0] if isinstance(alts, list) and alts else None
    return _texte(_champ(alt, "transcript")).strip()


async def transcribe_whisper(wav_path: str) -> str:
    args = [
        "-m",
        WHISPER_MODEL,
        "-f",
        wav_path,
        "-l",
        "fr",
        "-nt",
        "-np",
        "--no-prints",
        "-t",
        "4",
        "-bo",
        "1",
        "-bs",
        "1",
        "-nf",
        "-sns",
        "--prompt",
        WHISPER_PROMPT,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            WHISPER_BIN,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except Exception:
        return ""
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), 90)
    except asyncio.TimeoutError:
        return ""
    finally:
        if proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
    max_buffer = 1024 * 1024
    if proc.returncode != 0 or len(stdout) > max_buffer or len(stderr) > max_buffer:
        return ""
    return re.sub(r"\s+", " ", stdout.decode("utf-8", "replace")).strip()


async def transcribe(wav_path: str, log: Callable[..., None] = log) -> str:
    key = env("DEEPGRAM_API_KEY")
    if key:
        try:
            t0 = now_ms()
            txt = await transcribe_deepgram(wav_path, key)
            log(f"[VOICE] deepgram {now_ms() - t0}ms")
            if txt:
                return txt
            log("[VOICE] deepgram: transcription vide, repli sur whisper.")
        except Exception as e:
            log("[VOICE] deepgram indisponible, repli sur whisper :", _msg(e))
    return await transcribe_whisper(wav_path)


async def geocode(adresse: str) -> dict | None:
    url = (
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&q="
        + _encode_uri_component(adresse)
    )

    async def _requete():
        async with httpx.AsyncClient() as c:
            res = await c.get(
                url,
                headers={"User-Agent": "ping-robot/1.0 (assistant vocal)"},
                timeout=8,
            )
            return res.json()

    lst = await asyncio.wait_for(_requete(), 8)
    if not isinstance(lst, list) or not lst:
        return None
    premier = lst[0]
    return {
        "latitude": _js_number(_champ(premier, "lat")),
        "longitude": _js_number(_champ(premier, "lon")),
        "label": ",".join(
            _texte(_champ(premier, "display_name"), adresse).split(",")[:3]
        ),
    }


VISION_MODEL = env("VISION_MODEL", "claude-haiku-4-5-20251001")
SERVO_MAX_STEPS = env_float("SERVO_MAX_STEPS", 10)
SERVO_MAX_MS = env_float("SERVO_MAX_MS", 60000)

_client_partage: Any = None


def client_vision(log: Callable[..., None] = log):
    global _client_partage
    if _client_partage is not None:
        return _client_partage
    if not env("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic

        _client_partage = anthropic.AsyncAnthropic()
    except Exception as e:
        log("[VISION] SDK Anthropic indisponible :", _msg(e))
    return _client_partage


async def grab_frame(code: str, timeout_ms: float = 8000) -> bytes | None:
    sids = room_sids(code)
    if not sids:
        return None
    timeout_s = timeout_ms / 1000
    loop = asyncio.get_running_loop()
    fin = loop.time() + timeout_s
    demandes = {
        asyncio.ensure_future(call(s, "robot_grab_frame", {}, timeout=timeout_s))
        for s in sids
    }
    try:
        en_cours = set(demandes)
        while en_cours:
            reste = fin - loop.time()
            if reste <= 0:
                break
            faits, en_cours = await asyncio.wait(
                en_cours, timeout=reste, return_when=asyncio.FIRST_COMPLETED
            )
            for t in faits:
                if t.cancelled() or t.exception() is not None:
                    continue
                buf = t.result()
                if not _js_truthy(buf):
                    continue
                try:
                    octets = _octets(buf)
                except (TypeError, ValueError):
                    return None
                return octets if octets else None
        return None
    finally:
        for t in demandes:
            if not t.done():
                t.cancel()


def _bloc_image(frame: Any) -> dict:
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": _b64(frame)},
    }


async def decrire_scene(image: bytes, log: Callable[..., None] = log) -> dict | None:
    client = client_vision(log)
    if not client or not image:
        return None
    try:
        res = await client.messages.create(
            model=VISION_MODEL,
            max_tokens=120,
            system=(
                "Tu regardes l'image d'une camera de surveillance domestique, prise parce qu'un "
                "capteur vient de detecter quelque chose. "
                "Reponds UNIQUEMENT par un objet JSON, sans texte autour, de la forme : "
                '{"categorie":"personne|animal|rien","phrase":"..."} '
                'categorie vaut "personne" si un etre humain est visible, "animal" si un animal '
                'seul est visible, "rien" si rien de notable ne l\'est. '
                "phrase : UNE phrase courte en francais, factuelle, sans dramatiser. Pour un animal, "
                "dis lequel. Pour une personne, decris brievement sa position et ses vetements. "
                'Pour "rien", ecris exactement : Rien de visible. '
                "N'annonce JAMAIS une personne dont tu n'es pas sur : dans le doute, choisis "
                '"animal" ou "rien" et decris ce que tu vois reellement. Se tromper en annoncant '
                "un intrus qui n'existe pas rend l'alerte inutile."
            ),
            messages=[
                {
                    "role": "user",
                    "content": [
                        _bloc_image(image),
                        {"type": "text", "text": "Que vois-tu ?"},
                    ],
                }
            ],
        )
        t = " ".join(_textes(res.content)).strip()
        if not t:
            return None

        try:
            brut = t[t.find("{") : t.rfind("}") + 1]
            j = json.loads(brut)
            cat = _champ(j, "categorie")
            cat = cat if cat in ("personne", "animal", "rien") else "rien"
            phrase = _texte(_champ(j, "phrase")).strip()
            if phrase:
                return {"categorie": cat, "phrase": phrase}
        except Exception:
            log("[VISION] reponse non JSON, repli sur le texte brut.")
        minus = t.lower()
        if re.search(r"personne|homme|femme|individu|quelqu", minus):
            categorie = "personne"
        elif re.search(r"rien de visible", minus):
            categorie = "rien"
        else:
            categorie = "animal"
        return {"categorie": categorie, "phrase": t}
    except Exception as e:
        log("[VISION] description impossible :", _msg(e))
        return None


def _extraire_json(txt: str) -> Any:
    m = re.search(r"\{[\s\S]*\}", txt)
    if not m:
        return None
    return json.loads(m.group(0))


async def localiser_objet(client, frame: bytes, objet: str) -> dict:
    res = await client.messages.create(
        model=VISION_MODEL,
        max_tokens=300,
        system=(
            "Tu analyses l'image d'une camera embarquee sur un robot. Reponds UNIQUEMENT par un objet "
            'JSON, sans texte autour : {"vu": true|false, "x": nombre entre -1 et 1, "taille": nombre entre 0 et 1}. '
            "x = position horizontale du centre de l objet (-1 bord gauche, 0 centre, 1 bord droit). "
            "taille = part de la hauteur de l image occupee par l objet (0.05 tres loin, 0.8 tout pres). "
            'Si l objet n est pas visible : {"vu": false, "x": 0, "taille": 0}.'
        ),
        messages=[
            {
                "role": "user",
                "content": [
                    _bloc_image(frame),
                    {"type": "text", "text": f"Ou se trouve : {objet} ?"},
                ],
            }
        ],
    )
    txt = " ".join(_textes(res.content))
    try:
        j = _extraire_json(txt)
    except ValueError:
        return {"vu": False, "x": 0, "taille": 0}
    if j is None:
        return {"vu": False, "x": 0, "taille": 0}
    return {
        "vu": _js_truthy(_champ(j, "vu")),
        "x": max(-1, min(1, _ou(_js_number(_champ(j, "x")), 0))),
        "taille": max(0, min(1, _ou(_js_number(_champ(j, "taille")), 0))),
    }


async def bouger(
    code: str, cmd: str, secs: float, annule: Callable[[], bool] | None = None
) -> None:
    until = now_ms() + secs * 1000
    n = 0
    while now_ms() < until:
        if annule and annule():
            break
        await emit_room(
            code,
            "robot_drive",
            {"cmd": cmd, "by": "solana", "id": f"servo-{now_ms()}-{n}"},
        )
        n += 1
        await _attendre_ms(min(400, max(0, until - now_ms())))
    await emit_room(
        code,
        "robot_drive",
        {"cmd": "S", "by": "solana", "id": f"servo-stop-{now_ms()}"},
    )
    await _attendre_ms(400)


async def analyser_voie(client, frame: bytes, contexte: Any) -> dict | None:
    situation = "La voie est-elle libre devant moi ?"
    if _js_truthy(contexte) and _est_fini(_champ(contexte, "distanceM")):
        d = _js_round(contexte["distanceM"])
        cap = _champ(contexte, "capRelatif")
        if _est_fini(cap):
            ecart = _js_round(cap)
            ou = (
                "droit devant moi"
                if abs(ecart) < 20
                else f"a {abs(ecart)} degres sur ma {'droite' if ecart > 0 else 'gauche'}"
            )
            situation = (
                f"Je roule vers ma destination, situee a {d} metres, {ou}. "
                "La voie est-elle libre ? Si je dois contourner, privilegie le cote qui me rapproche "
                "de ma destination, sauf si ce cote est bloque."
            )
        else:
            situation = (
                f"Je roule vers une destination a {d} metres. La voie est-elle libre ?"
            )

    res = await client.messages.create(
        model=VISION_MODEL,
        max_tokens=300,
        system=(
            "Tu regardes par la camera avant d'un petit robot a roues qui roule vers une destination. "
            "Evalue si la voie devant lui est degagee. Reponds UNIQUEMENT par un objet JSON : "
            '{"libre": true|false, "distance_m": nombre, "cote_libre": "gauche"|"droite"|"aucun"}. '
            "libre = le robot peut avancer sans rien heurter dans les 2 prochains metres. "
            "distance_m = distance estimee de l obstacle le plus proche DEVANT lui (10 si rien). "
            "cote_libre = de quel cote il pourrait contourner, en tenant compte de sa destination. "
            "Compte comme obstacles : murs, meubles, vehicules, personnes, poteaux, marches, trous, "
            "bordures hautes. Ne compte PAS le sol plat, l'herbe rase, le gravier."
        ),
        messages=[
            {
                "role": "user",
                "content": [
                    _bloc_image(frame),
                    {"type": "text", "text": situation},
                ],
            }
        ],
    )
    txt = " ".join(_textes(res.content))
    try:
        j = _extraire_json(txt)
    except ValueError:
        return None
    if j is None:
        return None
    cote = _champ(j, "cote_libre")
    return {
        "libre": _js_truthy(_champ(j, "libre")),
        "distance_m": max(0.1, min(10, _ou(_js_number(_champ(j, "distance_m")), 10))),
        "cote_libre": cote if cote in ("gauche", "droite") else None,
    }


suivis: dict[str, dict] = {}

servos: dict[str, dict] = {}


async def arreter_suivi(code: str) -> bool:
    s = suivis.get(code)
    if not s or not s["actif"]:
        return False
    s["actif"] = False
    if s.get("ticker"):
        s["ticker"].cancel()
    await emit_room(
        code,
        "robot_drive",
        {"cmd": "S", "by": "solana", "id": f"suivi-stop-{now_ms()}"},
    )
    await emit_room(
        code,
        "robot_drive",
        {"cmd": "V255", "by": "solana", "id": f"suivi-fast-{now_ms()}"},
    )
    return True


async def suivre_personne(
    client, code: str, cible: str, log: Callable[..., None] = log
) -> str:
    await arreter_suivi(code)
    session: dict = {"actif": True}
    suivis[code] = session

    async def dire(t: str) -> None:
        await emit_room(code, "robot_say", {"text": t})

    ordre = "S"

    async def _ticker() -> None:
        loop = asyncio.get_running_loop()
        prochain = loop.time()
        while True:
            prochain += 0.4
            await asyncio.sleep(max(0.0, prochain - loop.time()))
            if not session["actif"]:
                continue
            await emit_room(
                code,
                "robot_drive",
                {"cmd": ordre, "by": "solana", "id": f"suivi-{now_ms()}"},
            )

    ticker = tache(_ticker())
    session["ticker"] = ticker

    await emit_room(
        code,
        "robot_drive",
        {"cmd": "V170", "by": "solana", "id": f"suivi-slow-{now_ms()}"},
    )

    LOIN = 0.22
    PRES = 0.75
    PAS_DE_RECUL_AVANT = now_ms() + 8000
    debut = now_ms()
    MAX_MS = env_float("SUIVI_MAX_MS", 300000)

    async def _boucle() -> None:
        nonlocal ordre
        perdus = 0
        dernier_sens = 0
        try:
            while session["actif"] and now_ms() - debut < MAX_MS:
                frame = await grab_frame(code)
                if not session["actif"]:
                    break
                if not frame:
                    perdus += 1
                    if perdus >= 4:
                        await dire("Je n'ai plus d'image, j'arrete de te suivre.")
                        break
                    await _attendre_ms(800)
                    continue

                c = await localiser_objet(client, frame, cible)
                if not session["actif"]:
                    break
                log(
                    f"[SUIVI] vu={_js_str(c['vu'])} x={c['x']:.2f} taille={c['taille']:.2f}"
                )

                if not c["vu"]:
                    perdus += 1
                    if perdus == 3:
                        await dire("Je te cherche.")
                    if perdus >= 6:
                        await dire("Je t'ai perdu, j'arrete de te suivre.")
                        break
                    ordre = "R" if dernier_sens > 0 else "L"
                    await _attendre_ms(300)
                    ordre = "S"
                    continue
                perdus = 0

                if abs(c["x"]) > 0.28:
                    dernier_sens = 1 if c["x"] > 0 else -1
                    ordre = "R" if dernier_sens > 0 else "L"
                    await _attendre_ms(min(350, 150 + abs(c["x"]) * 200))
                    ordre = "F" if c["taille"] < LOIN else "S"
                elif c["taille"] < LOIN:
                    ordre = "F"
                elif c["taille"] > PRES and now_ms() > PAS_DE_RECUL_AVANT:
                    ordre = "B"
                    await _attendre_ms(400)
                    ordre = "S"
                else:
                    ordre = "S"
            if session["actif"]:
                await dire("J'arrete de te suivre.")
            session["actif"] = False
            ticker.cancel()
            await emit_room(
                code,
                "robot_drive",
                {"cmd": "S", "by": "solana", "id": f"suivi-fin-{now_ms()}"},
            )
            await emit_room(
                code,
                "robot_drive",
                {"cmd": "V255", "by": "solana", "id": f"suivi-fin2-{now_ms()}"},
            )
            log("[SUIVI] termine")
        except Exception as e:
            log("[SUIVI] erreur", _msg(e))
            session["actif"] = False
            ticker.cancel()
            await emit_room(
                code,
                "robot_drive",
                {"cmd": "S", "by": "solana", "id": f"suivi-err-{now_ms()}"},
            )

    tache(_boucle())

    return "Je te suis. Dis stop quand tu veux que j arrete."


async def aller_vers_objet(
    client, code: str, objet: str, log: Callable[..., None] = log
) -> str:
    session = {"annule": False}
    servos[code] = session

    def stoppe() -> bool:
        return session["annule"]

    debut = now_ms()
    CENTRE_TOL = 0.3
    ARRIVE = 0.55
    perdus = 0
    dernier_sens = 0
    gain = 1.0

    await emit_room(
        code,
        "robot_drive",
        {"cmd": "V150", "by": "solana", "id": f"servo-slow-{now_ms()}"},
    )
    await _attendre_ms(250)

    async def finir(msg: str) -> str:
        if servos.get(code) is session:
            del servos[code]
        await emit_room(
            code,
            "robot_drive",
            {"cmd": "V255", "by": "solana", "id": f"servo-fast-{now_ms()}"},
        )
        return msg

    step = 1
    while step <= SERVO_MAX_STEPS:
        if session["annule"]:
            return await finir("Arret demande, je me suis arrete en chemin.")
        if now_ms() - debut > SERVO_MAX_MS:
            return await finir(
                f"Temps ecoule apres {step - 1} manoeuvres, je me suis arrete en chemin."
            )
        frame = await grab_frame(code)
        if not frame:
            return await finir(
                "Je n'arrive pas a prendre d'image, je ne peux pas m'y rendre."
            )

        cible = await localiser_objet(client, frame, objet)
        log(
            f"[SERVO] etape {step}: vu={_js_str(cible['vu'])} x={cible['x']:.2f} "
            f"taille={cible['taille']:.2f} gain={gain:.2f}"
        )

        if not cible["vu"]:
            perdus += 1
            if perdus >= 3:
                return await finir(f"Je ne vois plus {objet}, j'arrete la.")
            await bouger(code, "R" if dernier_sens > 0 else "L", 0.25, stoppe)
            step += 1
            continue
        perdus = 0

        if cible["taille"] >= ARRIVE:
            return await finir(
                f"J'y suis, {objet} est juste devant moi ({step} manoeuvres)."
            )

        if abs(cible["x"]) > CENTRE_TOL:
            sens = 1 if cible["x"] > 0 else -1
            if dernier_sens != 0 and sens != dernier_sens:
                gain = max(0.25, gain * 0.5)
            dernier_sens = sens
            duree = min(0.28, (0.1 + abs(cible["x"]) * 0.18) * gain)
            await bouger(code, "R" if sens > 0 else "L", duree, stoppe)
        else:
            await bouger(code, "F", 0.4 if cible["taille"] > 0.35 else 0.7, stoppe)
        step += 1
    return await finir(
        f"Je me suis approche de {objet}, mais je ne suis pas encore tout contre."
    )


async def tout_arreter(code: str, log: Callable[..., None] = log) -> dict:
    servo = servos.get(code)
    if servo:
        servo["annule"] = True
    suivi = await arreter_suivi(code)
    await emit_room(
        code,
        "robot_drive",
        {"cmd": "S", "by": "arret-urgence", "id": f"stopall-{now_ms()}"},
    )
    await emit_room(
        code,
        "robot_drive",
        {"cmd": "V255", "by": "arret-urgence", "id": f"stopall-v-{now_ms()}"},
    )
    log(
        f"[STOP] arret d'urgence code={_js_str(code)} (manoeuvre={_js_str(bool(servo))}, suivi={_js_str(suivi)})"
    )
    return {"servo": bool(servo), "suivi": suivi}


def _bloc_texte(t: str) -> list[dict]:
    return [{"type": "text", "text": t}]


async def _piloter_en_fond(code: str, cmd: str, secs: float) -> None:
    try:
        HOLD_MS = 400
        until = now_ms() + secs * 1000
        n = 0
        while now_ms() < until:
            await emit_room(
                code,
                "robot_drive",
                {"cmd": cmd, "by": "solana", "id": f"voice-{now_ms()}-{n}"},
            )
            n += 1
            await _attendre_ms(min(HOLD_MS, max(0, until - now_ms())))
        await emit_room(
            code,
            "robot_drive",
            {"cmd": "S", "by": "solana", "id": f"voice-stop-{now_ms()}"},
        )
    except Exception:
        pass


async def run_tool(name: str, input: dict, ctx: dict) -> list[dict]:
    inp = input if isinstance(input, dict) else {}
    code = ctx.get("code")
    frame = ctx.get("frame")
    lg = ctx.get("log") or log
    client = ctx.get("client") or client_vision(lg)

    if name == "mode_surveillance":
        absent = _js_truthy(inp.get("absent"))
        await emit_room(code, "robot_mode", {"absent": absent})
        lg(f"[VOICE] mode de surveillance -> {'ABSENT' if absent else 'NORMAL'}")
        return _bloc_texte(
            "Mode absence active. La surveillance s'arme dans trente secondes, le temps que tu sortes. Bonne journee."
            if absent
            else "Mode normal. La surveillance est desarmee, je ne guette plus."
        )

    if name == "piloter":
        correspondance = {
            "avancer": "F",
            "reculer": "B",
            "gauche": "L",
            "droite": "R",
            "stop": "S",
        }
        action = inp.get("action")
        cmd = correspondance.get(action) if isinstance(action, str) else None
        if not cmd:
            return _bloc_texte("Action inconnue.")
        if cmd == "S":
            suivait = await arreter_suivi(code)
            await emit_room(
                code,
                "robot_drive",
                {"cmd": cmd, "by": "solana", "id": f"voice-{now_ms()}"},
            )
            return _bloc_texte(
                "Robot arrete, je ne te suis plus." if suivait else "Robot arrete."
            )
        await arreter_suivi(code)
        secs = max(0.2, min(5, _ou(_js_number(inp.get("duree_secondes")), 1)))
        tache(_piloter_en_fond(code, cmd, secs))
        lg(f"[VOICE] piloter {action} {_js_str(secs)}s")
        return _bloc_texte(
            f'Mouvement "{action}" effectue pendant {_js_str(secs)}s, robot arrete.'
        )

    if name == "regarder":
        if not frame:
            return _bloc_texte("Pas d'image : la camera du robot est eteinte.")
        return [
            _bloc_image(frame),
            {"type": "text", "text": "Image en direct de la camera du robot."},
        ]

    if name == "aller_a":
        adresse = _texte(inp.get("adresse")).strip()
        if not adresse:
            return _bloc_texte("Adresse manquante.")
        pos = None
        try:
            pos = await geocode(adresse)
        except Exception:
            pass
        if not pos:
            return _bloc_texte(f"Adresse introuvable : {adresse}.")
        await emit_room(
            code,
            "robot_nav",
            {
                "target": {"latitude": pos["latitude"], "longitude": pos["longitude"]},
                "on": True,
            },
        )
        lg(
            f"[VOICE] aller_a {pos['label']} ({_js_str(pos['latitude'])},{_js_str(pos['longitude'])})"
        )
        return _bloc_texte(f"Navigation lancee vers {pos['label']}.")

    if name == "bouger_camera":
        direction = _texte(inp.get("direction")).strip()
        amplitude = _texte(inp.get("amplitude"), "moyen").strip()
        pas = {"peu": 12, "moyen": 28, "beaucoup": 50}.get(amplitude, 28)
        if direction == "centre":
            await emit_room(
                code, "robot_cam_move", {"id": f"voix-{now_ms()}", "center": True}
            )
            lg("[VOICE] camera recentree")
            return _bloc_texte("Camera recentree.")
        deltas = {
            "gauche": {"panDelta": pas},
            "droite": {"panDelta": -pas},
            "haut": {"tiltDelta": pas},
            "bas": {"tiltDelta": -pas},
        }
        if direction not in deltas:
            return _bloc_texte(f"Direction inconnue : {direction}.")
        await emit_room(
            code, "robot_cam_move", {"id": f"voix-{now_ms()}", **deltas[direction]}
        )
        lg(f"[VOICE] camera {direction} ({pas} deg)")
        await _attendre_ms(700)
        return _bloc_texte(f"Tete tournee vers {direction}.")

    if name == "ronde":
        action = _texte(inp.get("action")).strip()
        connues = [
            "apprendre_debut",
            "apprendre_fin",
            "demarrer",
            "arreter",
            "oublier",
            "etat",
        ]
        if action not in connues:
            return _bloc_texte(f"Action de ronde inconnue : {action}.")
        await emit_room(code, "robot_ronde", {"action": action})
        lg(f"[VOICE] ronde {action}")
        phrases = {
            "apprendre_debut": "Apprentissage lance. Conduis-moi sur le tour complet, puis dis-moi quand c'est termine.",
            "apprendre_fin": "Tour enregistre.",
            "demarrer": "Je commence ma ronde.",
            "arreter": "Ronde arretee.",
            "oublier": "Circuit efface.",
            "etat": "Je regarde ou en est ma ronde.",
        }
        return _bloc_texte(phrases[action])

    if name == "suivre_personne":
        cible = _texte(inp.get("cible")).strip() or "la personne devant le robot"
        if not client:
            return _bloc_texte(
                "Je ne peux pas te suivre : ma vision n'est pas disponible."
            )
        lg(f'[SUIVI] demarrage, cible="{cible}"')
        msg = await suivre_personne(client, code, cible, lg)
        return _bloc_texte(msg)

    if name == "arreter_suivi":
        stoppe = await arreter_suivi(code)
        return _bloc_texte(
            "Suivi arrete." if stoppe else "Je n'etais pas en train de suivre."
        )

    if name == "aller_vers_objet":
        objet = _texte(inp.get("objet")).strip()
        if not objet:
            return _bloc_texte("Cible non precisee.")
        if not client:
            return _bloc_texte(
                "Je ne peux pas m'y rendre : ma vision n'est pas disponible."
            )
        lg(f'[SERVO] cap sur "{objet}"')
        bilan = await aller_vers_objet(client, code, objet, lg)
        return _bloc_texte(bilan)

    if name == "etat_robot":
        attente = asyncio.ensure_future(
            wait_for_event("robot_status", room=code, timeout=5)
        )
        await asyncio.sleep(0)
        try:
            await emit_room(code, "robot_status_request", {"by": "solana"})
            raw = await attente
        finally:
            if not attente.done():
                attente.cancel()
        if not _js_truthy(raw):
            return _bloc_texte("Le robot n a pas repondu.")
        statut = _champ(raw, "status")
        st = statut if isinstance(statut, (dict, list)) else raw
        parts = []
        coords = _champ(st, "coords")
        if _js_truthy(coords) and _est_fini(_champ(coords, "latitude")):
            lon = _js_number(_champ(coords, "longitude"))
            parts.append(f"position {coords['latitude']:.5f}, {lon:.5f}")
            if _est_fini(_champ(st, "gpsAgeMs")):
                parts.append(
                    f"relevee il y a {_js_round(st['gpsAgeMs'] / 1000)} secondes"
                )
        else:
            parts.append(
                "pas encore de position GPS (le recepteur cherche les satellites)"
            )
        if _champ(st, "obstacleCm") is not None:
            parts.append(f"obstacle a {_js_str(st['obstacleCm'])} cm")
        parts.append(
            "moteurs connectes et prets"
            if _js_truthy(_champ(st, "arduinoConnected"))
            else "moteurs deconnectes"
        )
        if _js_truthy(_champ(st, "navActive")):
            parts.append("navigation en cours")
        return _bloc_texte(", ".join(parts) + ".")

    return _bloc_texte("Outil inconnu.")


FAST_MODELS = ["claude-opus-5", "claude-opus-4-8"]


def fast_enabled() -> bool:
    return (
        str(os.environ.get("VOICE_FAST") or "").lower() == "true"
        and MODEL in FAST_MODELS
    )


async def create_message(client, params: dict, log: Callable[..., None] = log):
    if not fast_enabled():
        return await client.messages.create(**params)
    try:
        return await client.beta.messages.create(
            **params,
            speed="fast",
            betas=["fast-mode-2026-02-01"],
        )
    except Exception as e:
        statut = getattr(e, "status_code", None) or "?"
        log(
            f"[VOICE] mode rapide indisponible ({statut} {_msg(e)[:120]}) -> repli en vitesse normale."
        )
        return await client.messages.create(**params)


async def ask_claude(client, conv: dict, ctx: dict) -> str:
    lg = (ctx and ctx.get("log")) or log
    for _step in range(6):
        response = await create_message(
            client,
            {
                "model": MODEL,
                "max_tokens": 4000,
                "system": [
                    {
                        "type": "text",
                        "text": SYSTEM_PROMPT,
                        "cache_control": {"type": "ephemeral"},
                    },
                ],
                "output_config": {"effort": EFFORT},
                "tools": TOOLS,
                "messages": conv["messages"],
            },
            lg,
        )

        if response.stop_reason == "refusal":
            return "Desole, je prefere ne pas repondre a ca."

        conv["messages"].append({"role": "assistant", "content": response.content})

        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if not tool_uses:
            return " ".join(_textes(response.content)).strip()

        results = []
        for tu in tool_uses:
            try:
                content = await run_tool(tu.name, tu.input, ctx)
            except Exception as e:
                content = _bloc_texte(f"Erreur outil : {_msg(e)}")
            results.append(
                {"type": "tool_result", "tool_use_id": tu.id, "content": content}
            )
        conv["messages"].append({"role": "user", "content": results})
    return "Je n'ai pas reussi a terminer cette action."


_client: Any = None


def attach_voice_brain() -> None:
    global _client
    try:
        _client = client_vision(log)
    except Exception as e:
        log("[VOICE] SDK Anthropic indisponible :", _msg(e))
    moteur_stt = (
        f"Deepgram {DEEPGRAM_MODEL} (rapide)"
        if env("DEEPGRAM_API_KEY")
        else "whisper local (lent)"
    )
    if fast_enabled():
        vitesse = "mode RAPIDE (tarif double)"
    elif str(os.environ.get("VOICE_FAST") or "").lower() == "true":
        vitesse = (
            f"mode rapide demande mais indisponible sur {MODEL} -> vitesse normale"
        )
    else:
        vitesse = "vitesse normale"
    if _client:
        log(
            f"[VOICE] Assistant vocal actif : STT {moteur_stt} + Claude {MODEL} (effort {EFFORT}, {vitesse})."
        )
    else:
        log(
            f"[VOICE] Assistant vocal en mode COMMANDES LOCALES (STT {moteur_stt}, pas de cle Claude)."
        )


@on("vision_obstacle")
async def _vision_obstacle(sid: str, data: Any):
    p = payload(data)
    frame = p.get("frame")
    nav = p.get("nav")
    if not _client or not _js_truthy(frame):
        return None
    try:
        vue = await analyser_voie(_client, _octets(frame), nav)
        if not vue:
            return None
        log(
            f"[VISION] libre={_js_str(vue['libre'])} distance={_js_str(vue['distance_m'])}m "
            f"cote_libre={vue['cote_libre'] or '-'}"
        )
        return {
            "libre": vue["libre"],
            "distanceCm": _js_round(vue["distance_m"] * 100),
            "coteLibre": vue["cote_libre"],
        }
    except Exception as e:
        log("[VISION] erreur :", _msg(e))
        return None


def _nom_fichier(code: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", _js_str(code))[:64]


@on("voice_ask")
async def _voice_ask(sid: str, data: Any):
    p = payload(data)
    code = p.get("code")
    audio = p.get("audio")
    frame = p.get("frame")
    if not _js_truthy(code) or not _js_truthy(audio):
        return {"error": "requete invalide"}

    client = _client
    tmp: str | None = None
    try:
        octets = _octets(audio)
        fd, tmp = tempfile.mkstemp(
            prefix=f"voice-{_nom_fichier(code)}-{now_ms()}-", suffix=".wav"
        )
        with os.fdopen(fd, "wb") as f:
            f.write(octets)
        started = now_ms()
        texte = await transcribe(tmp, log)
        log(
            f'[VOICE] code={_js_str(code)} transcription ({now_ms() - started}ms): "{texte}"'
        )
        if not texte or len(texte) < 2:
            return {"text": "Je n'ai pas compris.", "heard": texte}

        frame_buf_early = _octets(frame) if _js_truthy(frame) else None

        cmd = commande_locale(texte)
        if cmd:
            out = await run_tool(
                cmd["tool"],
                cmd["input"],
                {
                    "code": code,
                    "frame": frame_buf_early,
                    "log": log,
                    "client": client,
                },
            )
            out_text = " ".join(_textes(out))
            spoken = cmd["reply"] or out_text
            log(
                f'[VOICE] code={_js_str(code)} commande locale "{texte}" -> {cmd["tool"]} (gratuit)'
            )
            return {"text": spoken, "heard": texte, "local": True}

        if not client:
            log(
                f"[VOICE] code={_js_str(code)} PAS DE CLIENT CLAUDE (ANTHROPIC_API_KEY absente "
                f'de {ENV_FILE} ?) -> reponse "commandes simples" pour "{texte}"'
            )
            return {
                "text": "Je ne comprends que les commandes simples pour le moment.",
                "heard": texte,
            }

        conv = get_conversation(code)
        conv["messages"].append(
            {"role": "user", "content": [{"type": "text", "text": texte}]}
        )
        if len(conv["messages"]) > MAX_TURNS * 2:
            conv["messages"] = conv["messages"][-MAX_TURNS * 2 :]
            while conv["messages"] and (
                conv["messages"][0]["role"] != "user"
                or (
                    isinstance(conv["messages"][0]["content"], list)
                    and any(
                        _type_bloc(b) == "tool_result"
                        for b in conv["messages"][0]["content"]
                    )
                )
            ):
                conv["messages"].pop(0)

        frame_buf = _octets(frame) if _js_truthy(frame) else None
        text = await ask_claude(
            client,
            conv,
            {"code": code, "frame": frame_buf, "log": log, "client": client},
        )
        log(f'[VOICE] code={_js_str(code)} reponse ({now_ms() - started}ms): "{text}"')
        return {"text": text, "heard": texte}
    except Exception as e:
        log("[VOICE] erreur :", _msg(e))
        msg = (
            "Je n ai plus de credits pour reflechir, mais je comprends toujours les commandes simples."
            if re.search(r"credit balance", _msg(e), re.IGNORECASE)
            else "Desole, une erreur est survenue."
        )
        return {"error": _msg(e), "text": msg}
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
