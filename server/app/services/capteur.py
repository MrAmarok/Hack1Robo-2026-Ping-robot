from __future__ import annotations

import math
import re
import time
from pathlib import Path

from app.core import config

ENTETE = "x_m,y_m,heading_deg,sensor_angle_deg,distance_cm"
RE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_comptes: dict[tuple[str, str], int] = {}


class TropVolumineux(Exception):
    pass


def id_valide(v) -> bool:
    return isinstance(v, str) and bool(RE_ID.match(v))


def dossier(code: str) -> Path:
    return Path(config.CAPTEUR_DIR) / code


def chemin(code: str, session: str) -> Path:
    return dossier(code) / f"{session}.csv"


def nouvelle_session(code: str) -> str:
    base = time.strftime("s-%Y%m%d-%H%M%S")
    candidat, n = base, 2
    while chemin(code, candidat).exists():
        candidat, n = f"{base}-{n}", n + 1
    return candidat


def _nombre(texte: str) -> bool:
    try:
        return math.isfinite(float(texte))
    except ValueError:
        return False


def lire_ligne(brut: str) -> tuple[str | None, str | None]:
    champs = [c.strip() for c in brut.split(",")]
    if len(champs) != 5:
        return None, f"5 champs attendus ({ENTETE}), {len(champs)} recus"
    for nom, valeur in zip(ENTETE.split(",")[:4], champs[:4]):
        if not _nombre(valeur):
            return None, f"{nom} doit etre un nombre"
    if champs[4] and not (_nombre(champs[4]) and float(champs[4]) >= 0):
        return None, "distance_cm doit etre un nombre positif ou vide (pas d'echo)"
    return ",".join(champs), None


def decouper(texte: str) -> tuple[list[str], list[dict]]:
    valides, erreurs = [], []
    for brut in texte.splitlines():
        ligne = brut.strip()
        if not ligne or ligne.replace(" ", "") == ENTETE:
            continue
        propre, erreur = lire_ligne(ligne)
        if erreur:
            erreurs.append({"ligne": ligne[:120], "raison": erreur})
        else:
            valides.append(propre)
    return valides, erreurs


def compter(code: str, session: str) -> int:
    cle = (code, session)
    if cle not in _comptes:
        f = chemin(code, session)
        n = 0
        if f.exists():
            with f.open(encoding="utf8") as source:
                n = sum(1 for ligne in source if ligne.strip()) - 1
        _comptes[cle] = max(0, n)
    return _comptes[cle]


def ajouter(code: str, session: str, lignes: list[str]) -> int:
    total = compter(code, session)
    ajouter_csv(chemin(code, session), lignes)
    _comptes[(code, session)] = total + len(lignes)
    return _comptes[(code, session)]


def ajouter_csv(f: Path, lignes: list[str]) -> None:
    if f.exists() and f.stat().st_size > config.CAPTEUR_MAX_MO * 1024 * 1024:
        raise TropVolumineux(f"session au-dela de {config.CAPTEUR_MAX_MO} Mo")
    f.parent.mkdir(parents=True, exist_ok=True)
    nouveau = not f.exists()
    with f.open("a", encoding="utf8") as sortie:
        if nouveau:
            sortie.write(ENTETE + "\n")
        sortie.write("".join(l + "\n" for l in lignes))


def lister(code: str) -> list[dict]:
    d = dossier(code)
    if not d.is_dir():
        return []
    sortie = []
    for f in sorted(d.glob("*.csv"), key=lambda x: x.stat().st_mtime, reverse=True):
        if not id_valide(f.stem):
            continue
        stat = f.stat()
        sortie.append({
            "session": f.stem,
            "lignes": compter(code, f.stem),
            "taille_ko": round(stat.st_size / 1024, 1),
            "modifie": int(stat.st_mtime * 1000),
        })
    return sortie
