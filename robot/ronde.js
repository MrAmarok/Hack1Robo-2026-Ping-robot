// ronde.js - Rondes autonomes : le robot rejoue en boucle un circuit qu'on lui
// a APPRIS en le pilotant une fois.
//
// Pourquoi l'apprentissage par demonstration plutot que des points poses sur
// une carte : un itineraire "pieton" d'OpenStreetMap n'est pas forcement
// franchissable par un chassis a six roues (marches, bordures, portails). Une
// trace enregistree pendant que le robot roulait vraiment est, elle, garantie
// praticable — il vient de la parcourir.
//
// La boucle vit ICI, dans le robot, et non dans l'app : une ronde doit
// continuer quand la 4G hoquette ou quand le telephone est range.
//
// Cycle de vie :
//   apprendreDebut() -> le robot roule, noterPosition() retient la trace
//   apprendreFin()   -> la trace est fermee (retour au depart) et enregistree
//   demarrer()       -> tour, pause, tour, pause... jusqu'a arreter()
'use strict';

const fs = require('fs');
const path = require('path');

const R_TERRE = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

function distanceMetres(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_TERRE * Math.asin(Math.sqrt(h));
}

class Ronde {
  constructor({
    getFix,
    lancerTrajet,
    arreterTrajet,
    log,
    fichier,
    pauseMs,
    pasM,
    dureeMaxMs,
    onEtat,
  } = {}) {
    this.getFix = getFix || (() => null);
    // Installe la trace comme itineraire courant et met le robot en route.
    this.lancerTrajet = lancerTrajet || (() => {});
    this.arreterTrajet = arreterTrajet || (() => {});
    this.log = log || console.log;
    this.onEtat = onEtat || (() => {});
    this.fichier = fichier || path.join(__dirname, 'ronde.json');

    // Pause ENTRE deux tours, et non periode fixe : si un tour dure plus
    // longtemps que la pause demandee, une periode fixe ferait se chevaucher
    // deux rondes. Ici le robot repart 5 min apres etre RENTRE.
    this.pauseMs = pauseMs || 5 * 60 * 1000;
    // Espacement minimal entre deux points retenus. Trop serre, le robot vise
    // des points a 1 m et zigzague ; trop large, il coupe les virages.
    this.pasM = pasM || 4;
    // Garde-fou : un tour qui ne finit pas (robot bloque, GPS perdu) doit
    // s'arreter tout seul plutot que de laisser le robot rouler indefiniment.
    this.dureeMaxMs = dureeMaxMs || 30 * 60 * 1000;

    this.trace = [];
    this.apprentissage = false;
    this.enCours = false;
    this.tourDebutAt = 0;
    this.toursFaits = 0;
    this.prochainDepartAt = 0;
    this._minuteur = null;
    this._limiteur = null;

    this._charger();
  }

  // --- Persistance ---------------------------------------------------------
  // La trace survit a un redemarrage du service : reapprendre une ronde
  // demande de ressortir le robot, ce n'est pas anodin.
  _charger() {
    try {
      const brut = JSON.parse(fs.readFileSync(this.fichier, 'utf8'));
      if (Array.isArray(brut?.points) && brut.points.length >= 2) {
        this.trace = brut.points;
        this.log(`Ronde: circuit connu, ${this.trace.length} points (${this._longueurM()} m).`);
      }
    } catch {
      // Pas de fichier au premier lancement : ce n'est pas une erreur.
    }
  }

  _enregistrer() {
    try {
      fs.writeFileSync(
        this.fichier,
        JSON.stringify({ points: this.trace, majAt: Date.now() }, null, 2)
      );
    } catch (e) {
      this.log('Ronde: enregistrement impossible :', e.message);
    }
  }

  _longueurM() {
    let d = 0;
    for (let i = 1; i < this.trace.length; i++) d += distanceMetres(this.trace[i - 1], this.trace[i]);
    return Math.round(d);
  }

  // --- Apprentissage -------------------------------------------------------
  apprendreDebut() {
    if (this.enCours) {
      this.log('Ronde: impossible d apprendre pendant une ronde.');
      return false;
    }
    this.apprentissage = true;
    this.trace = [];
    const fix = this.getFix();
    if (fix) this.trace.push({ latitude: fix.latitude, longitude: fix.longitude });
    this.log('Ronde: apprentissage demarre — pilote le robot sur le tour complet.');
    this._publier();
    return true;
  }

  // A appeler a chaque position GPS. Ne retient un point que s'il s'est
  // vraiment eloigne du precedent : sinon le bruit du GPS a l'arret
  // fabriquerait des centaines de points sur place.
  noterPosition(fix) {
    if (!this.apprentissage || !fix) return;
    const p = { latitude: fix.latitude, longitude: fix.longitude };
    const dernier = this.trace[this.trace.length - 1];
    if (dernier && distanceMetres(dernier, p) < this.pasM) return;
    this.trace.push(p);
  }

  apprendreFin() {
    this.apprentissage = false;
    if (this.trace.length < 3) {
      this.log(`Ronde: trace trop courte (${this.trace.length} points), circuit ignore.`);
      this.trace = [];
      this._publier();
      return 0;
    }
    // Ferme la boucle : le dernier point rejoint le premier, sinon le robot
    // finirait chaque tour a l'autre bout du circuit.
    const premier = this.trace[0];
    const dernier = this.trace[this.trace.length - 1];
    if (distanceMetres(premier, dernier) > this.pasM) {
      this.trace.push({ latitude: premier.latitude, longitude: premier.longitude });
    }
    this._enregistrer();
    this.log(`Ronde: circuit appris — ${this.trace.length} points, ${this._longueurM()} m.`);
    this._publier();
    return this.trace.length;
  }

  oublier() {
    this.arreter();
    this.trace = [];
    try {
      fs.unlinkSync(this.fichier);
    } catch {}
    this.log('Ronde: circuit efface.');
    this._publier();
  }

  // --- Execution -----------------------------------------------------------
  demarrer() {
    if (this.enCours) return false;
    if (this.trace.length < 3) {
      this.log('Ronde: aucun circuit appris.');
      return false;
    }
    this.enCours = true;
    this.toursFaits = 0;
    this.log(`Ronde: demarrage (${this._longueurM()} m, pause de ${Math.round(this.pauseMs / 60000)} min entre les tours).`);
    this._lancerUnTour();
    return true;
  }

  arreter() {
    const etait = this.enCours;
    this.enCours = false;
    this._annulerMinuteurs();
    if (etait) {
      this.arreterTrajet();
      this.log(`Ronde: arretee apres ${this.toursFaits} tour(s).`);
    }
    this._publier();
    return etait;
  }

  _annulerMinuteurs() {
    if (this._minuteur) {
      clearTimeout(this._minuteur);
      this._minuteur = null;
    }
    if (this._limiteur) {
      clearTimeout(this._limiteur);
      this._limiteur = null;
    }
    this.prochainDepartAt = 0;
  }

  _lancerUnTour() {
    if (!this.enCours) return;
    this.tourDebutAt = Date.now();
    this.prochainDepartAt = 0;
    // Copie defensive : le module de navigation consomme le tableau en
    // avancant un index, il ne doit pas entamer la trace de reference.
    this.lancerTrajet(this.trace.map((p) => ({ ...p })));
    this._limiteur = setTimeout(() => {
      if (!this.enCours) return;
      this.log('Ronde: tour trop long (robot bloque ou GPS perdu) -> abandon de ce tour.');
      this.arreterTrajet();
      this._programmerSuivant();
    }, this.dureeMaxMs);
    this._publier();
  }

  // Appele par robot.js quand le dernier point du circuit est atteint.
  onArrivee() {
    if (!this.enCours) return false;
    this.toursFaits++;
    const duree = Math.round((Date.now() - this.tourDebutAt) / 1000);
    this.log(`Ronde: tour ${this.toursFaits} termine en ${duree}s.`);
    this.arreterTrajet();
    this._programmerSuivant();
    return true;
  }

  _programmerSuivant() {
    if (this._limiteur) {
      clearTimeout(this._limiteur);
      this._limiteur = null;
    }
    if (!this.enCours) return;
    this.prochainDepartAt = Date.now() + this.pauseMs;
    this.log(`Ronde: prochain tour dans ${Math.round(this.pauseMs / 60000)} min.`);
    this._publier();
    this._minuteur = setTimeout(() => {
      this._minuteur = null;
      this._lancerUnTour();
    }, this.pauseMs);
  }

  etat() {
    return {
      apprentissage: this.apprentissage,
      enCours: this.enCours,
      points: this.trace.length,
      longueurM: this.trace.length >= 2 ? this._longueurM() : 0,
      toursFaits: this.toursFaits,
      // Secondes avant le prochain depart (0 = en train de rouler).
      prochainDansS: this.prochainDepartAt
        ? Math.max(0, Math.round((this.prochainDepartAt - Date.now()) / 1000))
        : 0,
    };
  }

  _publier() {
    try {
      this.onEtat(this.etat());
    } catch {}
  }
}

module.exports = { Ronde, distanceMetres };
