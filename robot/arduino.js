// arduino.js - Liaison serie Raspberry Pi <-> Arduino
// Envoie des commandes moteur (F/B/L/R/S) et recoit la distance "D:<cm>".
'use strict';

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// Ligne du capteur au format de map_sonar.py : x_m,y_m,heading_deg,sensor_angle_deg,distance_cm
// (distance vide = pas d'echo). Si le firmware en ecrit, elles partent telles quelles au serveur.
const NB = '\\s*-?\\d+(?:\\.\\d+)?\\s*';
const RE_LIGNE_CAPTEUR = new RegExp(`^${NB},${NB},${NB},${NB},\\s*(?:\\d+(?:\\.\\d+)?)?\\s*$`);

class Arduino {
  constructor({ port, baud, log, onSensor, onPresence, onConnect, onLigneCapteur }) {
    this.port = port;
    this.baud = baud;
    this.log = log || console.log;
    this.onSensor = onSensor || (() => {});
    this.onPresence = onPresence || (() => {});
    this.onLigneCapteur = onLigneCapteur || null;
    // Appele une fois la liaison serie ouverte : c'est le moment d'imposer
    // au firmware les reglages qu'on ne veut pas dependre de son demarrage.
    this.onConnect = onConnect || null;
    this.sp = null;
    this.connected = false;
    this.lastCmd = null;
    this.warnedGpsPort = false;
    this.pendingAcks = [];
  }

  connect() {
    try {
      this.sp = new SerialPort({ path: this.port, baudRate: this.baud });
    } catch (e) {
      this.log(`Arduino injoignable (${this.port}) :`, e.message);
      this.log('La navigation auto ne pourra pas piloter les moteurs.');
      return;
    }

    const parser = this.sp.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line) => {
      line = String(line).trim();
      if (line.startsWith('$GP') || line.startsWith('$GN') || line.startsWith('$GL')) {
        if (!this.warnedGpsPort) {
          this.warnedGpsPort = true;
          this.log(`Le port Arduino (${this.port}) recoit des trames GPS. Change ARDUINO_PORT: ce n'est pas l'Arduino moteur.`);
        }
        return;
      }
      if (line.startsWith('ACK:')) {
        this.log(`Arduino > ${line}`);
        const ackCmd = line.slice(4).trim().charAt(0).toUpperCase();
        this.resolveAck(ackCmd, line);
      } else if (line.startsWith('D:')) {
        const cm = parseInt(line.slice(2), 10);
        if (Number.isFinite(cm)) this.onSensor(cm);
      } else if (line.startsWith('PRES:')) {
        // Le radar n'envoie que ses CHANGEMENTS d'etat.
        this.onPresence(line.slice(5).trim() === '1');
      } else if (this.onLigneCapteur && RE_LIGNE_CAPTEUR.test(line)) {
        this.onLigneCapteur(line);
      } else if (line) {
        this.log(`Arduino > ${line}`);
      }
    });

    this.sp.on('open', () => {
      this.connected = true;
      if (typeof this.sp.set === 'function') {
        this.sp.set({ dtr: false, rts: false }, () => {});
      }
      this.log(`Arduino connecte sur ${this.port} @ ${this.baud} bauds.`);
      // Laisse le firmware finir son setup() avant de lui parler : un Arduino
      // qui vient d'etre alimente ignore les tout premiers octets recus.
      if (this.onConnect) {
        setTimeout(() => { try { this.onConnect(); } catch {} }, 1500);
      }
    });
    this.sp.on('error', (e) => this.log('Erreur Arduino :', e.message));
    this.sp.on('close', () => {
      this.connected = false;
      this.log('Arduino deconnecte.');
    });
  }

  resolveAck(cmd, line) {
    const i = this.pendingAcks.findIndex((p) => p.cmd === cmd);
    if (i < 0) return false;
    const pending = this.pendingAcks.splice(i, 1)[0];
    clearTimeout(pending.timer);
    pending.resolve({ ok: true, line });
    return true;
  }

  send(cmd) {
    if (!this.connected || !this.sp) return false;
    // Pas de dedoublonnage pour +/-, V<n> (vitesse), P/U/T/C (pan-tilt camera)
    // ni K (couvercle) : les renvoyer doit toujours agir
    // (ex. meme vitesse redemandee apres un redemarrage de l'Arduino).
    // 'T' manquait : depuis que le tilt s'envoie en T<angle> et non plus en
    // U<angle>, deux demandes identiques d'affilee etaient avalees ici.
    const noDedupe = cmd === '+' || cmd === '-' || 'VPUTCK'.includes(cmd[0]);
    if (cmd === this.lastCmd && !noDedupe) return true;
    this.lastCmd = cmd;
    try {
      this.sp.write(cmd + '\n');
      return true;
    } catch (e) {
      this.log('Ecriture Arduino echouee :', e.message);
      return false;
    }
  }

  sendWithAck(cmd, timeoutMs = 1200) {
    const c = String(cmd || '').trim().toUpperCase();
    if (!this.connected || !this.sp) {
      return Promise.resolve({ ok: false, line: '', message: `Arduino non connecte (${this.port})` });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.pendingAcks.findIndex((p) => p.cmd === c && p.resolve === resolve);
        if (i >= 0) this.pendingAcks.splice(i, 1);
        resolve({ ok: false, line: '', message: `ACK:${c} absent apres ${timeoutMs}ms` });
      }, timeoutMs);

      this.pendingAcks.push({ cmd: c, resolve, timer });
      this.lastCmd = c;
      this.sp.write(c + '\n', (err) => {
        if (!err) return;
        clearTimeout(timer);
        const i = this.pendingAcks.findIndex((p) => p.cmd === c && p.resolve === resolve);
        if (i >= 0) this.pendingAcks.splice(i, 1);
        this.log('Ecriture Arduino echouee :', err.message);
        resolve({ ok: false, line: '', message: err.message });
      });
      this.sp.drain(() => {});
    });
  }

  stop() {
    this.lastCmd = null;
    return this.send('S');
  }
}

module.exports = { Arduino };
