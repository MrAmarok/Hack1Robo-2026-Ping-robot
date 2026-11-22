// navigation.js — Pilotage automatique du robot vers le contact
// ---------------------------------------------------------------------------
// Mode "stop-and-sense" : pour avoir un cap boussole FIABLE malgré les moteurs
// (qui perturbent le magnétomètre), le robot lit la boussole MOTEURS COUPÉS.
//
// Cycle : STOP (moteurs off) -> attendre que le champ se stabilise -> lire le
// cap -> décider -> avancer (F) ou pivoter (L/R) un court instant -> recommencer.
'use strict';
const { performance } = require('perf_hooks');

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Cap (0-360°, 0 = Nord) du point `from` vers le point `to`
function bearing(from, to) {
  const dLon = toRad(to.longitude - from.longitude);
  const y = Math.sin(dLon) * Math.cos(toRad(to.latitude));
  const x =
    Math.cos(toRad(from.latitude)) * Math.sin(toRad(to.latitude)) -
    Math.sin(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Distance Haversine en mètres
function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

// Écart d'angle ramené à [-180, 180] (négatif = tourner à gauche)
function angleDiff(target, current) {
  return ((target - current + 540) % 360) - 180;
}

class Navigator {
  constructor({ getRobot, getTarget, send, log, opts, onArrived }) {
    this.getRobot = getRobot;
    this.getTarget = getTarget;
    this.send = send;
    this.log = log || console.log;
    this.onArrived = onArrived || (() => {});
    this.opts = Object.assign(
      {
        angleTol: 25,        // tolérance de cap avant d'avancer (°)
        arrivalRadius: 3,    // distance "arrivé" (m)
        obstacleStopCm: 25,  // évitement obstacle (cm)
        obstacleTtlMs: 3000, // validité d'une mesure d'obstacle (ms)
        settleMs: 300,       // pause moteurs coupés avant de lire la boussole
        driveMs: 1200,       // durée d'une avance
        turnMsPerDeg: 6,     // durée de pivot par degré d'écart
        turnMsMin: 200,
        turnMsMax: 700,
        oscillationForwardTol: 50,
      },
      opts || {}
    );
    this.running = false;
    this.obstacleCm = 999;
    this.obstacleExpireAt = 0;
    this.cameraCm = null;
    this.cameraExpireAt = 0;
    this.cameraAttenteJusqua = 0;
    this.preferredSide = null; // côté de contournement suggéré par la caméra
    this._sideTimer = null;
    this.arrived = false;
    this._lastLog = '';
    this._lastTurn = null;
    this._t = null;
  }

  // Côté par lequel contourner, indiqué par la caméra ('gauche' | 'droite').
  // Volontairement éphémère : on repart à gauche par défaut si l'info date.
  setPreferredSide(cote) {
    this.preferredSide = cote === 'droite' ? 'droite' : 'gauche';
    if (this._sideTimer) clearTimeout(this._sideTimer);
    this._sideTimer = setTimeout(() => { this.preferredSide = null; }, 8000);
  }

  // Une mesure périme : sans écho l'ultrason n'en donne pas de nouvelle, et le
  // robot tournerait sans fin sur le dernier obstacle vu.
  setObstacle(cm) {
    if (!Number.isFinite(cm)) return;
    this.obstacleCm = cm;
    this.obstacleExpireAt = performance.now() + this.opts.obstacleTtlMs;
  }

  setObstacleCamera(cm, ttlMs = 0, attenteMs = 0) {
    this.cameraCm = cm;
    this.cameraExpireAt = performance.now() + ttlMs;
    this.cameraAttenteJusqua = this.cameraExpireAt + attenteMs;
  }

  ultrasonRecent() {
    return performance.now() < this.obstacleExpireAt ? this.obstacleCm : null;
  }

  _estProche(cm) {
    return Number.isFinite(cm) && cm > 0 && cm < this.opts.obstacleStopCm;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.arrived = false;
    this._lastTurn = null;
    this.log('🧭 Navigation auto démarrée (stop-and-sense).');
    this._senseThenAct();
  }

  stop({ sendStop = true } = {}) {
    this.running = false;
    if (this._t) {
      clearTimeout(this._t);
      this._t = null;
    }
    if (sendStop) this.send('S');
    this._lastTurn = null;
    this.log('🧭 Navigation auto arrêtée — moteurs stop.');
  }

  _log(cmd, why) {
    const msg = `${cmd} — ${why}`;
    if (msg !== this._lastLog) {
      this._lastLog = msg;
      this.log(`🦾 ${msg}`);
    }
  }

  // Lit la boussole plusieurs fois (robot à l'arrêt) pour un cap stable
  _readSettled() {
    let r = this.getRobot();
    for (let i = 0; i < 4; i++) r = this.getRobot();
    return r;
  }

  // Étape 1 : couper les moteurs, laisser le champ magnétique se stabiliser
  _senseThenAct() {
    if (!this.running) return;
    this.send('S');
    this._t = setTimeout(() => this._act(), this.opts.settleMs);
  }

  // Étape 2 : lire le cap (propre) et agir
  _act() {
    if (!this.running) return;

    const robot = this._readSettled();
    if (!robot || !robot.fix) {
      this._log('S', 'pas de position GPS du robot');
      this._lastTurn = null;
      this._t = setTimeout(() => this._senseThenAct(), 500);
      return;
    }

    const target = this.getTarget();
    if (!target) {
      this._log('S', 'position du contact inconnue');
      this._lastTurn = null;
      this._t = setTimeout(() => this._senseThenAct(), 500);
      return;
    }

    const dist = distanceMeters(robot, target);

    // Arrivé ?
    if (dist <= this.opts.arrivalRadius) {
      this.send('S');
      this._lastTurn = null;
      this._log('S', `arrivé (${dist} m)`);
      if (!this.arrived) {
        this.arrived = true;
        this.onArrived(dist);
      }
      this._t = setTimeout(() => this._senseThenAct(), 1000);
      return;
    }
    this.arrived = false;

    // Obstacle droit devant -> on tourne pour l'éviter.
    // Le côté est celui que la caméra a jugé libre (setPreferredSide) ;
    // à défaut on tourne à gauche, comme avant.
    const maintenant = performance.now();
    const ultrason = this.ultrasonRecent();
    const ultrasonProche = this._estProche(ultrason);
    const cameraProche = this._estProche(this.cameraCm);
    if (ultrasonProche || (cameraProche && maintenant < this.cameraExpireAt)) {
      const obstacle = ultrasonProche ? ultrason : this.cameraCm;
      const cmd = this.preferredSide === 'droite' ? 'R' : 'L';
      const cote = cmd === 'R' ? 'droite' : 'gauche';
      this._log(cmd, `obstacle à ${obstacle} cm — contournement par la ${cote}`);
      this._lastTurn = null;
      this.send(cmd);
      this._t = setTimeout(() => this._senseThenAct(), 600);
      return;
    }
    if (cameraProche && maintenant < this.cameraAttenteJusqua) {
      this.send('S');
      this._log('S', 'obstacle caméra — attente de la prochaine image');
      this._lastTurn = null;
      this._t = setTimeout(() => this._senseThenAct(), 500);
      return;
    }

    const desired = bearing(robot, target);
    const heading = robot.heading;

    // Pas de cap dispo (boussole absente) -> on avance pour progresser
    if (!Number.isFinite(heading)) {
      this._log('F', `avance (cap indispo) (${dist} m)`);
      this._lastTurn = null;
      this.send('F');
      this._t = setTimeout(() => this._senseThenAct(), this.opts.driveMs);
      return;
    }

    const diff = angleDiff(desired, heading);
    if (Math.abs(diff) <= this.opts.angleTol) {
      // Bien orienté -> on avance
      this._log('F', `cap OK, en route (${dist} m, cap ${Math.round(heading)}->${Math.round(desired)})`);
      this._lastTurn = null;
      this.send('F');
      this._t = setTimeout(() => this._senseThenAct(), this.opts.driveMs);
    } else {
      // Pas aligné -> pivot court proportionnel à l'écart
      const cmd = diff > 0 ? 'R' : 'L';
      const absDiff = Math.abs(diff);
      if (
        this._lastTurn &&
        this._lastTurn.cmd !== cmd &&
        absDiff <= this.opts.oscillationForwardTol
      ) {
        this._log('F', `avance apres oscillation ${this._lastTurn.cmd}/${cmd} (${dist} m, ecart ${Math.round(absDiff)} deg)`);
        this._lastTurn = null;
        this.send('F');
        this._t = setTimeout(() => this._senseThenAct(), this.opts.driveMs);
        return;
      }
      this._lastTurn = { cmd, diff };
      const turnMs = Math.min(
        this.opts.turnMsMax,
        Math.max(this.opts.turnMsMin, absDiff * this.opts.turnMsPerDeg)
      );
      this._log(cmd, `pivote ${diff > 0 ? 'droite' : 'gauche'} ${Math.round(Math.abs(diff))}° (${dist} m)`);
      this.send(cmd);
      this._t = setTimeout(() => this._senseThenAct(), turnMs);
    }
  }
}

module.exports = { Navigator, bearing, distanceMeters, angleDiff };
