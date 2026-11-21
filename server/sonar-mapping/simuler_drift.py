from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
import time
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ICI = Path(__file__).resolve().parent
sys.path.insert(0, str(ICI.parent))
sys.path.insert(0, str(ICI))

import simuler_robot as sim  # noqa: E402
from app.services import sonar_mapper  # noqa: E402
from app.services.sonar_scans import RESOLUTION_M  # noqa: E402

SORTIES = ICI / ".simulation.ignore" / "drift"
TOLERANCE_MUR_M = 0.10
ZOOM = 8
BANDE = 78

sim.log = lambda *_args, **_kwargs: None


@dataclass(frozen=True)
class Derive:
    x_cm_min: float = 0.0
    y_cm_min: float = 0.0
    cap_deg_min: float = 0.0
    bruit_cap_deg: float = 0.0
    echelle_odo_pct: float = 0.0
    glissement_cm: float = 0.0
    biais_distance_cm_min: float = 0.0
    echelle_distance_pct_min: float = 0.0
    marche_distance_cm: float = 0.0

    def resume(self) -> str:
        morceaux = []
        if self.x_cm_min or self.y_cm_min:
            morceaux.append(f"x {self.x_cm_min:+g} / y {self.y_cm_min:+g} cm/min")
        if self.cap_deg_min:
            morceaux.append(f"cap {self.cap_deg_min:+g}°/min")
        if self.bruit_cap_deg:
            morceaux.append(f"bruit cap {self.bruit_cap_deg:g}°/√s")
        if self.echelle_odo_pct:
            morceaux.append(f"odométrie {self.echelle_odo_pct:+g} %")
        if self.glissement_cm:
            morceaux.append(f"glissement {self.glissement_cm:g} cm/√m")
        if self.biais_distance_cm_min:
            morceaux.append(f"distance {self.biais_distance_cm_min:+g} cm/min")
        if self.echelle_distance_pct_min:
            morceaux.append(f"distance {self.echelle_distance_pct_min:+g} %/min")
        if self.marche_distance_cm:
            morceaux.append(f"distance au hasard {self.marche_distance_cm:g} cm/√s")
        return ", ".join(morceaux) or "aucun"


@dataclass(frozen=True)
class Exemple:
    nom: str
    description: str
    derive: Derive = field(default_factory=Derive)
    tours: int = 1
    balayage: bool = False


ODOMETRIE = Derive(cap_deg_min=4, bruit_cap_deg=0.3, echelle_odo_pct=4, glissement_cm=2)

EXEMPLES = [
    Exemple("reference-balayage", "Algo d'origine (simuler_robot.py) : le capteur balaie de -45° à +45°, sans drift.",
            balayage=True),
    Exemple("reference-fixe", "Capteur fixe vers l'avant, sans drift. Base de comparaison des autres exemples."),
    Exemple("pose-cap-lent", "Le cap dérive de 3°/min, comme un gyro un peu biaisé.", Derive(cap_deg_min=3)),
    Exemple("pose-cap-rapide", "Le cap dérive de 12°/min.", Derive(cap_deg_min=12)),
    Exemple("pose-xy", "x et y dérivent de +12 et -8 cm/min, le cap reste juste.", Derive(x_cm_min=12, y_cm_min=-8)),
    Exemple("pose-odometrie", "Odométrie réaliste : roues comptées 4 % trop loin, gyro +4°/min, bruit sur le cap "
            "et glissement des roues.", ODOMETRIE),
    Exemple("pose-odometrie-3-tours", "Même odométrie, trois tours de suite : l'erreur s'accumule.", ODOMETRIE,
            tours=3),
    Exemple("distance-biais", "Les distances s'allongent de 10 cm par minute.", Derive(biais_distance_cm_min=10)),
    Exemple("distance-echelle", "Les distances grandissent de 3 % par minute (vitesse du son qui change avec la "
            "température).", Derive(echelle_distance_pct_min=3)),
    Exemple("distance-hasard", "Le biais des distances erre au hasard (1,5 cm/√s).", Derive(marche_distance_cm=1.5)),
    Exemple("distance-biais-3-tours", "Distances +10 cm/min sur trois tours.", Derive(biais_distance_cm_min=10),
            tours=3),
    Exemple("pose-et-distance", "Odométrie réaliste et distances +10 cm/min ensemble.",
            Derive(cap_deg_min=4, bruit_cap_deg=0.3, echelle_odo_pct=4, glissement_cm=2, biais_distance_cm_min=10)),
]


class RobotFixe(sim.Robot):
    def avancer_servo(self) -> None:
        self.servo = 0


@dataclass
class Pas:
    t: float
    vrai: tuple[float, float, float]
    envoye: tuple[float, float, float]
    capteur: int
    distance_vraie: float | None
    distance_envoyee: float | None


def simuler(exemple: Exemple, graine: int, bruit: bool) -> list[Pas]:
    sonar = sim.Sonar(random.Random(graine), bruit)
    rng = random.Random(graine + 1)
    robot = (sim.Robot if exemple.balayage else RobotFixe)(sonar)
    d = exemple.derive
    xe, ye, ce = robot.x, robot.y, robot.cap
    biais_hasard = 0.0
    t = 0.0
    pas: list[Pas] = []
    racine_dt = math.sqrt(sim.DT)
    precedent = (robot.x, robot.y, robot.cap)
    for _ in range(exemple.tours):
        for _ in sim.parcours_auto(robot, sim.DT, sim.VITESSE_MAX * 0.85):
            t += sim.DT
            px, py, pc = precedent
            dx, dy = robot.x - px, robot.y - py
            ds = math.hypot(dx, dy)
            if dx * math.cos(math.radians(pc)) + dy * math.sin(math.radians(pc)) < 0:
                ds = -ds
            dcap = (robot.cap - pc + 180) % 360 - 180
            precedent = (robot.x, robot.y, robot.cap)

            dcap_m = dcap + d.cap_deg_min / 60 * sim.DT + rng.gauss(0, d.bruit_cap_deg * racine_dt)
            ds_m = ds * (1 + d.echelle_odo_pct / 100)
            lateral = 0.0
            if ds and d.glissement_cm:
                sigma = d.glissement_cm / 100 * math.sqrt(abs(ds))
                ds_m += rng.gauss(0, sigma)
                lateral = rng.gauss(0, sigma)
            milieu = math.radians(ce + dcap_m / 2)
            xe += ds_m * math.cos(milieu) - lateral * math.sin(milieu) + d.x_cm_min / 6000 * sim.DT
            ye += ds_m * math.sin(milieu) + lateral * math.cos(milieu) + d.y_cm_min / 6000 * sim.DT
            ce += dcap_m

            angle = robot.cap + robot.servo
            impact = sim.lancer_rayon(robot.x, robot.y, math.radians(angle))
            distance_vraie = impact[0] * 100 if impact else None
            mesure = sonar.mesurer(robot.x, robot.y, angle)
            biais_hasard += rng.gauss(0, d.marche_distance_cm * racine_dt)
            if mesure is not None:
                minutes = t / 60
                mesure = (mesure * (1 + d.echelle_distance_pct_min / 100 * minutes)
                          + d.biais_distance_cm_min * minutes + biais_hasard)
                mesure = None if mesure > sim.PORTEE_MAX_CM else max(sim.PORTEE_MIN_CM, mesure)
            pas.append(Pas(t, (robot.x, robot.y, robot.cap), (xe, ye, ce), robot.servo, distance_vraie, mesure))
    return pas


def cm(valeur: float | None) -> str:
    return "" if valeur is None else f"{valeur:.1f}"


def ecrire_csv(pas: list[Pas], dossier: Path) -> Path:
    donnees = dossier / "donnees.csv"
    lignes = [",".join(sonar_mapper.FIELDS)]
    lignes += [f"{p.envoye[0]:.3f},{p.envoye[1]:.3f},{p.envoye[2] % 360:.1f},{p.capteur},{cm(p.distance_envoyee)}"
               for p in pas]
    donnees.write_text("\n".join(lignes) + "\n", encoding="utf-8")
    verite = ["t_s,x_vrai_m,y_vrai_m,cap_vrai_deg,x_envoye_m,y_envoye_m,cap_envoye_deg,capteur_deg,"
              "distance_vraie_cm,distance_envoyee_cm"]
    verite += [f"{p.t:.1f},{p.vrai[0]:.3f},{p.vrai[1]:.3f},{p.vrai[2] % 360:.1f},"
               f"{p.envoye[0]:.3f},{p.envoye[1]:.3f},{p.envoye[2] % 360:.1f},{p.capteur},"
               f"{cm(p.distance_vraie)},{cm(p.distance_envoyee)}" for p in pas]
    (dossier / "verite.csv").write_text("\n".join(verite) + "\n", encoding="utf-8")
    return donnees


def distance_segment(x: float, y: float, segment: tuple[float, float, float, float]) -> float:
    ax, ay, bx, by = segment
    ex, ey = bx - ax, by - ay
    u = max(0.0, min(1.0, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)))
    return math.hypot(x - ax - u * ex, y - ay - u * ey)


def points_murs(pas: float = 0.05) -> list[tuple[float, float]]:
    points = []
    for ax, ay, bx, by in sim.SEGMENTS:
        n = max(1, round(math.hypot(bx - ax, by - ay) / pas))
        points += [(ax + (bx - ax) * i / n, ay + (by - ay) * i / n) for i in range(n)]
    return points


def cellules_occupees(image: Image.Image, origine: tuple[float, float]) -> list[tuple[float, float]]:
    gauche, bas = origine
    largeur, hauteur = image.size
    pixels = image.tobytes()
    return [(gauche + (i % largeur + 0.5) * RESOLUTION_M, bas + (hauteur - i // largeur - 0.5) * RESOLUTION_M)
            for i, valeur in enumerate(pixels) if valeur == sonar_mapper.OCCUPIED]


def qualite_carte(image: Image.Image, origine: tuple[float, float]) -> tuple[float, float]:
    occupees = cellules_occupees(image, origine)
    if not occupees:
        return 0.0, 0.0
    bien_placees = sum(1 for x, y in occupees
                       if min(distance_segment(x, y, s) for s in sim.SEGMENTS) <= TOLERANCE_MUR_M)
    murs = points_murs()
    limite = TOLERANCE_MUR_M ** 2
    retrouves = sum(1 for mx, my in murs
                    if any((x - mx) ** 2 + (y - my) ** 2 <= limite for x, y in occupees))
    return 100 * bien_placees / len(occupees), 100 * retrouves / len(murs)


def dessiner(image: Image.Image, origine: tuple[float, float], pas: list[Pas], titre: list[str],
             chemin: Path) -> None:
    gauche, bas = origine
    largeur, hauteur = image.size
    echelle = ZOOM / RESOLUTION_M
    x0 = min(gauche, sim.PIECE.x0 - 0.3)
    y1 = max(bas + hauteur * RESOLUTION_M, sim.PIECE.y1 + 0.3)
    x1 = max(gauche + largeur * RESOLUTION_M, sim.PIECE.x1 + 0.3)
    y0 = min(bas, sim.PIECE.y0 - 0.3)
    toile = Image.new("RGB", (math.ceil((x1 - x0) * echelle), BANDE + math.ceil((y1 - y0) * echelle)),
                      (225, 225, 225))
    carte = image.convert("RGB").resize((largeur * ZOOM, hauteur * ZOOM), Image.NEAREST)
    toile.paste(carte, (round((gauche - x0) * echelle),
                        BANDE + round((y1 - (bas + hauteur * RESOLUTION_M)) * echelle)))

    def point(x: float, y: float) -> tuple[float, float]:
        return (x - x0) * echelle, BANDE + (y1 - y) * echelle

    dessin = ImageDraw.Draw(toile)
    dessin.rectangle((0, 0, toile.width, BANDE - 1), fill=(255, 255, 255))
    for ax, ay, bx, by in sim.SEGMENTS:
        dessin.line([point(ax, ay), point(bx, by)], fill=(220, 40, 40), width=2)
    dessin.line([point(p.vrai[0], p.vrai[1]) for p in pas], fill=(30, 160, 60), width=2)
    dessin.line([point(p.envoye[0], p.envoye[1]) for p in pas], fill=(40, 90, 230), width=2)
    police, texte_ok = police_texte()
    for i, ligne in enumerate(titre):
        dessin.text((8, 6 + 22 * i), texte_ok(ligne), fill=(0, 0, 0), font=police)
    legende = [((220, 40, 40), "vraie pièce"), ((30, 160, 60), "vrai trajet"),
               ((40, 90, 230), "trajet envoyé au serveur")]
    x = 8
    for couleur, texte in legende:
        texte = texte_ok(texte)
        dessin.rectangle((x, 55, x + 14, 67), fill=couleur)
        dessin.text((x + 20, 52), texte, fill=(0, 0, 0), font=police)
        x += 30 + round(dessin.textlength(texte, font=police))
    toile.save(chemin)


def police_texte():
    for nom in ("DejaVuSans.ttf", "LiberationSans-Regular.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(nom, 14), str
        except OSError:
            continue

    def sans_accents(texte: str) -> str:
        texte = texte.replace("√", "racine ")
        return unicodedata.normalize("NFKD", texte).encode("latin-1", "ignore").decode("latin-1")

    try:
        return ImageFont.load_default(size=15), sans_accents
    except TypeError:
        return ImageFont.load_default(), sans_accents


def lancer(exemple: Exemple, graine: int, bruit: bool, racine: Path) -> dict:
    dossier = racine / exemple.nom
    dossier.mkdir(parents=True, exist_ok=True)
    pas = simuler(exemple, graine, bruit)
    donnees = ecrire_csv(pas, dossier)
    lectures = sonar_mapper.load_readings(donnees)
    image, origine = sonar_mapper.build_map(lectures, RESOLUTION_M)
    image.save(dossier / "carte.png")

    dernier = pas[-1]
    erreurs = [math.hypot(p.envoye[0] - p.vrai[0], p.envoye[1] - p.vrai[1]) * 100 for p in pas]
    ecarts = [p.distance_envoyee - p.distance_vraie for p in pas
              if p.distance_envoyee is not None and p.distance_vraie is not None]
    bien_places, retrouves = qualite_carte(image, origine)
    mesures = {
        "nom": exemple.nom,
        "description": exemple.description,
        "derive": asdict(exemple.derive),
        "derive_resume": exemple.derive.resume(),
        "tours": exemple.tours,
        "capteur": "balayage" if exemple.balayage else "fixe",
        "graine": graine,
        "bruit_capteur": bruit,
        "lignes": len(pas),
        "echos": len(lectures),
        "duree_s": round(dernier.t, 1),
        "erreur_position_finale_cm": round(erreurs[-1], 1),
        "erreur_position_max_cm": round(max(erreurs), 1),
        "erreur_cap_finale_deg": round((dernier.envoye[2] - dernier.vrai[2] + 180) % 360 - 180, 1),
        "ecart_distance_moyen_cm": round(sum(ecarts) / len(ecarts), 1) if ecarts else None,
        "murs_bien_places_pct": round(bien_places, 1),
        "murs_retrouves_pct": round(retrouves, 1),
    }
    (dossier / "mesures.json").write_text(json.dumps(mesures, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    titre = [f"{exemple.nom} : drift {exemple.derive.resume()}",
             f"A la fin : position fausse de {erreurs[-1]:.0f} cm, cap {mesures['erreur_cap_finale_deg']:+.1f}°. "
             f"Murs bien placés {bien_places:.0f} %, retrouvés {retrouves:.0f} %."]
    dessiner(image, origine, pas, titre, dossier / "comparaison.png")
    return mesures


def ecrire_resultats(racine: Path) -> Path:
    tous = []
    for fichier in sorted(racine.glob("*/mesures.json")):
        try:
            tous.append(json.loads(fichier.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    ordre = {e.nom: i for i, e in enumerate(EXEMPLES)}
    tous.sort(key=lambda m: (ordre.get(m["nom"], len(ordre)), m["nom"]))
    lignes = [
        "# Simulations avec drift",
        "",
        f"Généré par `sonar-mapping/simuler_drift.py` le {time.strftime('%Y-%m-%d %H:%M')}. Les cartes sortent de "
        f"l'algo de Tom (`sonar_mapper.build_map`, {RESOLUTION_M * 100:g} cm/pixel), exactement comme **Save scan** "
        "côté back.",
        "",
        f"- **Murs bien placés** : part des cellules noires de la carte à moins de {TOLERANCE_MUR_M * 100:g} cm "
        "d'un vrai mur ou meuble.",
        f"- **Murs retrouvés** : part des vrais murs et meubles qui ont une cellule noire à moins de "
        f"{TOLERANCE_MUR_M * 100:g} cm. 100 % est impossible : le dos du canapé, collé au mur, ne se voit jamais.",
        "- **Écart distance** : moyenne de (distance envoyée - vraie distance), en cm.",
        "",
        "| Exemple | Capteur | Drift | Tours | Lignes | Position fin / max (cm) | Cap fin | Écart distance "
        "| Murs bien placés | Murs retrouvés |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for m in tous:
        ecart = "-" if m["ecart_distance_moyen_cm"] is None else f"{m['ecart_distance_moyen_cm']:+.1f} cm"
        lignes.append(
            f"| [{m['nom']}]({m['nom']}/comparaison.png) | {m['capteur']} | {m['derive_resume']} | {m['tours']} "
            f"| {m['lignes']} | {m['erreur_position_finale_cm']:g} / {m['erreur_position_max_cm']:g} "
            f"| {m['erreur_cap_finale_deg']:+g}° | {ecart} | {m['murs_bien_places_pct']:g} % "
            f"| {m['murs_retrouves_pct']:g} % |")
    lignes += [
        "",
        "Dans chaque dossier :",
        "",
        "- `donnees.csv` : ce que le robot envoie au serveur (pose avec drift, distance avec drift).",
        "- `verite.csv` : la vraie pose et la vraie distance à chaque ligne, à côté des valeurs envoyées.",
        "- `carte.png` : la carte brute de l'algo de Tom (1 pixel = 5 cm).",
        "- `comparaison.png` : la carte agrandie, avec la vraie pièce et les deux trajets par-dessus.",
        "- `mesures.json` : les chiffres du tableau et les réglages du drift.",
        "",
        "Pour faire calculer la carte d'un exemple par le back (depuis `server/`) :",
        "",
        "```sh",
        "uv run python sonar-mapping/simuler_robot.py --code 1234 --scan --frequence 50 \\",
        "  --csv sonar-mapping/.simulation.ignore/drift/pose-odometrie/donnees.csv",
        "```",
        "",
    ]
    resultats = racine / "resultats.md"
    resultats.write_text("\n".join(lignes), encoding="utf-8")
    return resultats


def main() -> int:
    p = argparse.ArgumentParser(description="Simule le robot avec un capteur fixe et du drift sur la pose ou sur "
                                            "les distances, puis calcule la carte avec l'algo de Tom.")
    p.add_argument("--exemple", action="append", choices=[e.nom for e in EXEMPLES],
                   help="ne lancer que cet exemple (option repetable, defaut : tous)")
    p.add_argument("--liste", action="store_true", help="afficher les exemples et quitter")
    p.add_argument("--nom", help="lancer un exemple perso avec les reglages ci-dessous")
    p.add_argument("--derive-x", type=float, default=0.0, help="drift de x en cm/min")
    p.add_argument("--derive-y", type=float, default=0.0, help="drift de y en cm/min")
    p.add_argument("--derive-cap", type=float, default=0.0, help="drift du cap en deg/min")
    p.add_argument("--bruit-cap", type=float, default=0.0, help="bruit du cap en deg/racine(s)")
    p.add_argument("--echelle-odo", type=float, default=0.0, help="erreur d'echelle de l'odometrie en %%")
    p.add_argument("--glissement", type=float, default=0.0, help="glissement des roues en cm/racine(m)")
    p.add_argument("--biais-distance", type=float, default=0.0, help="drift des distances en cm/min")
    p.add_argument("--echelle-distance", type=float, default=0.0, help="drift des distances en %%/min")
    p.add_argument("--hasard-distance", type=float, default=0.0, help="biais des distances au hasard en cm/racine(s)")
    p.add_argument("--tours", type=int, default=1, help="nombre de tours de la piece (exemple perso)")
    p.add_argument("--balayage", action="store_true", help="capteur qui balaie au lieu d'etre fixe (exemple perso)")
    p.add_argument("--graine", type=int, default=1, help="graine aleatoire (defaut : 1)")
    p.add_argument("--sans-bruit", action="store_true", help="capteur parfait, seul le drift reste")
    p.add_argument("--sortie", type=Path, default=SORTIES, help=f"dossier des resultats (defaut : {SORTIES})")
    args = p.parse_args()

    if args.liste:
        for e in EXEMPLES:
            print(f"{e.nom:24} {e.description}")
        return 0
    if args.tours < 1:
        p.error("--tours doit valoir au moins 1")
    if args.nom:
        if args.exemple:
            p.error("--nom et --exemple ne vont pas ensemble")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.nom):
            p.error("--nom : lettres, chiffres, - et _ seulement")
        derive = Derive(args.derive_x, args.derive_y, args.derive_cap, args.bruit_cap, args.echelle_odo,
                        args.glissement, args.biais_distance, args.echelle_distance, args.hasard_distance)
        exemples = [Exemple(args.nom, "Exemple perso.", derive, args.tours, args.balayage)]
    else:
        exemples = [e for e in EXEMPLES if not args.exemple or e.nom in args.exemple]

    args.sortie.mkdir(parents=True, exist_ok=True)
    for exemple in exemples:
        debut = time.monotonic()
        m = lancer(exemple, args.graine, not args.sans_bruit, args.sortie)
        print(f"{m['nom']:24} {m['lignes']:5} lignes | position fin {m['erreur_position_finale_cm']:6.1f} cm, "
              f"cap {m['erreur_cap_finale_deg']:+6.1f}° | murs bien places {m['murs_bien_places_pct']:5.1f} %, "
              f"retrouves {m['murs_retrouves_pct']:5.1f} % ({time.monotonic() - debut:.1f} s)", flush=True)
    resultats = ecrire_resultats(args.sortie)
    print(f"\nResultats : {resultats}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
