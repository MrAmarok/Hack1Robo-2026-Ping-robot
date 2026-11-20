#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tete de Solana - coque imprimable pour la camera sur pan-tilt.

Genere tete_solana.stl (binaire) + un apercu SVG rendu depuis le VRAI maillage.

Principe de construction : pas de CSG (pas de bibliotheque booleenne ici). La
coque est une GRILLE de sommets (anneaux verticaux x angles), dupliquee en une
surface exterieure et une surface interieure. On coud ensuite les deux le long
des bords ouverts : le bas de la coque et l'ouverture de la visiere. Le maillage
reste ainsi ferme (manifold), ce qu'exigent les trancheurs.

Tout est parametrable en tete de fichier : relance le script apres modification.
"""

import math
import struct

import numpy as np

# ---------------------------------------------------------------- parametres
H = 78.0          # hauteur totale (mm)
EPAISSEUR = 2.4   # epaisseur de paroi (mm) - 3 perimetres en buse 0.4
N_ANG = 18        # facettes par anneau : peu = panneaux plats, look anguleux
N_Z = 44          # anneaux (finesse verticale)

# Ouverture de la visiere : bande en hauteur + secteur angulaire a l'avant
VISIERE_Z0, VISIERE_Z1 = 0.44, 0.62   # fraction de H
VISIERE_ANGLE = math.radians(50)      # demi-angle : laisse des MONTANTS lateraux
                                      # qui tiennent le front. A 72 la tete ne
                                      # tenait plus que par l'arriere.

FICHIER_STL = "tete_solana.stl"
FICHIER_SVG = "tete_solana_apercu.svg"


def profil(t):
    """Demi-largeur, demi-profondeur, exposant et recul, pour t = z/H (0..1).

    Profil defini par POINTS CLES relies en droites : chaque cassure devient une
    arete franche sur la piece. C'est ce qui donne l'aspect anguleux, la ou des
    courbes lisses donnaient une silhouette d'abat-jour.

    Silhouette voulue : machoire etroite en bas, joues qui s'evasent, front large
    en surplomb au-dessus de la visiere, sommet incline vers l'arriere.
    """
    cles =    [0.00, 0.10, 0.22, 0.42, 0.62, 0.70, 0.84, 1.00]
    largeur = [23.0, 28.0, 31.0, 35.0, 37.5, 36.5, 32.0, 24.0]
    profond = [21.0, 25.0, 28.0, 30.0, 31.0, 30.0, 26.0, 19.0]
    # Recul : le bas avance (menton), le haut part en arriere.
    reculs =  [ 3.0,  2.0,  0.0, -2.0, -5.0, -7.0,-11.0,-16.0]

    a = float(np.interp(t, cles, largeur))
    b = float(np.interp(t, cles, profond))
    recul = float(np.interp(t, cles, reculs))
    n = 3.4 - 0.8 * t   # section : hexagone adouci en bas, plus rond en haut

    # Casquette : le front deborde juste au-dessus de la visiere et porte son
    # ombre sur l'objectif. C'est le detail qui fait "casque" et non "boite".
    if 0.62 <= t <= 0.72:
        u = (t - 0.62) / 0.10
        b += 4.5 * math.sin(math.pi * u)

    # Une seule rainure, sur la machoire : deux faisaient "colonne romaine".
    if abs(t - 0.16) < 0.02:
        a -= 1.2
        b -= 1.2
    return a, b, n, recul


def superellipse(theta, a, b, n):
    """Rayon d'une superellipse |x/a|^n + |y/b|^n = 1 dans la direction theta."""
    c, s = math.cos(theta), math.sin(theta)
    d = (abs(c / a) ** n + abs(s / b) ** n) ** (-1.0 / n)
    return d * c, d * s


def construire():
    """Renvoie (sommets_ext, sommets_int) de forme (N_Z, N_ANG, 3)."""
    ext = np.zeros((N_Z, N_ANG, 3))
    inte = np.zeros((N_Z, N_ANG, 3))
    for i in range(N_Z):
        t = i / (N_Z - 1)
        a, b, n, recul = profil(t)
        z = t * H
        for j in range(N_ANG):
            th = 2 * math.pi * j / N_ANG
            x, y = superellipse(th, a, b, n)
            ext[i, j] = (x, y + recul, z)
            # Paroi interieure : meme forme, retreicie. Suffisant ici, la
            # section variant lentement.
            xi, yi = superellipse(th, a - EPAISSEUR, max(b - EPAISSEUR, 1.0), n)
            inte[i, j] = (xi, yi + recul, z)
    return ext, inte


def dans_visiere(i, j):
    """Cette case de la grille appartient-elle a l'ouverture de la visiere ?"""
    t = i / (N_Z - 1)
    if not (VISIERE_Z0 <= t <= VISIERE_Z1):
        return False
    th = 2 * math.pi * j / N_ANG
    # L'avant est +Y (theta = pi/2)
    ecart = abs(math.atan2(math.sin(th - math.pi / 2), math.cos(th - math.pi / 2)))
    return ecart <= VISIERE_ANGLE


def mailler(ext, inte):
    """Assemble les triangles. Renvoie un tableau (n, 3, 3)."""
    tris = []

    def quad(p0, p1, p2, p3):
        tris.append((p0, p1, p2))
        tris.append((p0, p2, p3))

    for i in range(N_Z - 1):
        for j in range(N_ANG):
            k = (j + 1) % N_ANG
            trou = dans_visiere(i, j)
            if not trou:
                # Surface exterieure (normale vers l'exterieur)
                quad(ext[i, j], ext[i, k], ext[i + 1, k], ext[i + 1, j])
                # Surface interieure (sens inverse)
                quad(inte[i, j], inte[i + 1, j], inte[i + 1, k], inte[i, k])

    # Bord de l'ouverture : on coud ext<->int tout autour du trou, sinon la
    # coque serait ouverte et le trancheur refuserait la piece.
    for i in range(N_Z - 1):
        for j in range(N_ANG):
            k = (j + 1) % N_ANG
            if not dans_visiere(i, j):
                continue
            if not dans_visiere(i - 1, j) and i > 0:          # bord bas
                quad(ext[i, j], ext[i, k], inte[i, k], inte[i, j])
            if not dans_visiere(i + 1, j):                    # bord haut
                quad(ext[i + 1, k], ext[i + 1, j], inte[i + 1, j], inte[i + 1, k])
            if not dans_visiere(i, (j - 1) % N_ANG):          # bord gauche
                quad(ext[i, j], inte[i, j], inte[i + 1, j], ext[i + 1, j])
            if not dans_visiere(i, k):                        # bord droit
                quad(ext[i, k], ext[i + 1, k], inte[i + 1, k], inte[i, k])

    # Couronne du bas : la tete est ouverte dessous (passage des cables et du
    # support pan-tilt), il faut refermer l'epaisseur de paroi.
    for j in range(N_ANG):
        k = (j + 1) % N_ANG
        quad(ext[0, j], inte[0, j], inte[0, k], ext[0, k])

    # Sommet plein, ferme par un eventail depuis le centre.
    centre = np.array([ext[-1, :, 0].mean(), ext[-1, :, 1].mean(), H])
    for j in range(N_ANG):
        k = (j + 1) % N_ANG
        tris.append((ext[-1, j], ext[-1, k], centre))
        tris.append((inte[-1, k], inte[-1, j], centre))

    return np.array(tris)


def ecrire_stl(tris, chemin):
    with open(chemin, "wb") as f:
        f.write(b"Tete Solana - genere par tete_solana.py".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for tri in tris:
            n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
            norme = np.linalg.norm(n)
            n = n / norme if norme > 1e-9 else np.zeros(3)
            f.write(struct.pack("<3f", *n))
            for s in tri:
                f.write(struct.pack("<3f", *s))
            f.write(struct.pack("<H", 0))


def rendu_svg(tris, chemin):
    """Trois vues rendues depuis le maillage reel : 3/4, face, profil."""
    lumiere = np.array([-0.45, -0.6, 0.66])
    lumiere /= np.linalg.norm(lumiere)

    def vue(angle_y, angle_x, largeur, hauteur, decalage_x):
        cy, sy = math.cos(angle_y), math.sin(angle_y)
        cx, sx = math.cos(angle_x), math.sin(angle_x)
        centre = tris.reshape(-1, 3).mean(axis=0)
        p = tris - centre
        # rotation autour de Z (lacet) puis autour de X (tangage)
        x = p[..., 0] * cy - p[..., 1] * sy
        y = p[..., 0] * sy + p[..., 1] * cy
        z = p[..., 2]
        y2 = y * cx - z * sx
        z2 = y * sx + z * cx

        ecran = np.stack([x, -z2], axis=-1)
        profondeur = y2.mean(axis=1)

        n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
        n /= (np.linalg.norm(n, axis=1, keepdims=True) + 1e-9)
        nx = n[:, 0] * cy - n[:, 1] * sy
        ny = n[:, 0] * sy + n[:, 1] * cy
        nz = n[:, 2]
        ny2 = ny * cx - nz * sx
        nz2 = ny * sx + nz * cx
        nrot = np.stack([nx, ny2, nz2], axis=-1)

        visible = nrot[:, 1] < 0            # elimination des faces arriere
        idx = np.where(visible)[0]
        idx = idx[np.argsort(-profondeur[idx])]   # peintre : du fond vers l'avant

        pts = ecran[idx]
        mini, maxi = ecran.reshape(-1, 2).min(axis=0), ecran.reshape(-1, 2).max(axis=0)
        ech = min(largeur / (maxi[0] - mini[0]), hauteur / (maxi[1] - mini[1])) * 0.88
        cx_e = (mini[0] + maxi[0]) / 2
        cy_e = (mini[1] + maxi[1]) / 2
        pts = (pts - [cx_e, cy_e]) * ech + [decalage_x + largeur / 2, hauteur / 2 + 20]

        eclair = np.clip((nrot[idx] @ lumiere) * 0.5 + 0.5, 0, 1)
        out = []
        for tri, e in zip(pts, eclair):
            # Palette cyan/ardoise, dans l'esprit du theme HUD de l'app
            r = int(18 + 60 * e)
            g = int(32 + 150 * e)
            b = int(40 + 165 * e)
            d = f"M{tri[0,0]:.1f},{tri[0,1]:.1f}L{tri[1,0]:.1f},{tri[1,1]:.1f}L{tri[2,0]:.1f},{tri[2,1]:.1f}Z"
            out.append(f'<path d="{d}" fill="rgb({r},{g},{b})"/>')
        return "".join(out)

    L, Ht = 300, 380
    corps = (
        vue(math.radians(145), math.radians(14), L, Ht, 0)
        + vue(math.radians(180), math.radians(6), L, Ht, L)
        + vue(math.radians(270), math.radians(6), L, Ht, 2 * L)
    )
    etiquettes = "".join(
        f'<text x="{L*i + L/2}" y="{Ht-8}" fill="#5eead4" font-family="monospace" '
        f'font-size="13" text-anchor="middle">{nom}</text>'
        for i, nom in enumerate(("trois quarts", "face", "profil"))
    )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{3*L}" height="{Ht}" '
        f'viewBox="0 0 {3*L} {Ht}"><rect width="{3*L}" height="{Ht}" fill="#05080b"/>'
        f"{corps}{etiquettes}</svg>"
    )
    with open(chemin, "w", encoding="utf-8") as f:
        f.write(svg)


if __name__ == "__main__":
    ext, inte = construire()
    tris = mailler(ext, inte)
    ecrire_stl(tris, FICHIER_STL)
    rendu_svg(tris, FICHIER_SVG)

    sommets = tris.reshape(-1, 3)
    mini, maxi = sommets.min(axis=0), sommets.max(axis=0)
    dim = maxi - mini
    print(f"triangles      : {len(tris)}")
    print(f"encombrement   : {dim[0]:.1f} x {dim[1]:.1f} x {dim[2]:.1f} mm")
    print(f"paroi          : {EPAISSEUR} mm")
    print(f"fichiers       : {FICHIER_STL}, {FICHIER_SVG}")
