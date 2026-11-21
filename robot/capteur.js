// capteur.js - Tuyau WebSocket robot -> serveur pour les donnees du capteur.
//
// Une donnee = une ligne au format de map_sonar.py :
//   x_m,y_m,heading_deg,sensor_angle_deg,distance_cm      ex. "0,0,0,0,143"
// distance_cm vide ("0,0,0,0,") = pas d'echo.
//
// Utilisation (code de Pauline) :
//   capteur.envoyer('0,0,0,0,143');            // une ligne
//   capteur.envoyer([0.5, 0, 90, -30, 87.5]);  // ou un tableau de 5 valeurs (null = pas d'echo)
//   capteur.nouvelleSession();                 // nouveau fichier cote serveur
//
// Les lignes sont regroupees et envoyees toutes les 200 ms sur
// ws://<serveur>/ws/capteur. Une ligne n'est oubliee qu'une fois accusee par
// le serveur : pendant une coupure, elles s'accumulent et repartent dans
// l'ordre a la reconnexion.
'use strict';

const WS = globalThis.WebSocket || require('ws');

const RE_SESSION = /^[A-Za-z0-9_-]{1,64}$/;
const LOT_MAX = 500;

function horodatage() {
  const d = new Date();
  const deux = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${deux(d.getMonth() + 1)}${deux(d.getDate())}` +
    `-${deux(d.getHours())}${deux(d.getMinutes())}${deux(d.getSeconds())}`;
}

class CanalCapteur {
  constructor({ serverUrl, code, cle = '', session, log, intervalleMs = 200, maxEnAttente = 100000 }) {
    this.serverUrl = String(serverUrl || '').replace(/\/+$/, '');
    this.code = code;
    this.cle = cle;
    this.log = log || console.log;
    this.maxEnAttente = maxEnAttente;
    this.session = RE_SESSION.test(String(session || '')) ? String(session) : `s-${horodatage()}`;
    this.file = [];
    this.enVol = [];
    this.ws = null;
    this.ouvert = false;
    this.arrete = false;
    this.delai = 1000;
    this.acceptees = 0;
    this.perdues = 0;
    this.connecter();
    this.timer = setInterval(() => this.vider(), intervalleMs);
  }

  url() {
    const base = this.serverUrl.replace(/^http/i, 'ws');
    const q = new URLSearchParams({ code: this.code, session: this.session });
    if (this.cle) q.set('cle', this.cle);
    return `${base}/ws/capteur?${q}`;
  }

  connecter() {
    if (this.arrete) return;
    let ws;
    try {
      ws = new WS(this.url());
    } catch (e) {
      this.log(`Capteur: connexion impossible (${e.message}).`);
      this.relancer();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.ouvert = true;
      this.delai = 1000;
      this.vider();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let m;
      try {
        m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
      } catch {
        return;
      }
      if (m.type === 'bonjour') {
        this.log(`Capteur: connecte au serveur, session ${m.session} (${m.lignes} lignes deja recues).`);
      } else if (m.type === 'ack') {
        this.enVol.shift();
        this.acceptees += m.recues || 0;
        if (m.rejetees) {
          this.log(`Capteur: ${m.rejetees} ligne(s) refusee(s) par le serveur : ${JSON.stringify(m.erreurs || [])}`);
        }
      } else if (m.type === 'erreur') {
        this.log(`Capteur: le serveur refuse (${m.erreur}).`);
        if (/cle|session|code/.test(m.erreur || '')) this.arrete = true;
      }
    };
    // Le WebSocket natif de Node 22 n'emet que "error" (sans "close") quand la
    // connexion est refusee : les deux evenements menent donc a la reconnexion,
    // une seule fois grace au test this.ws === ws.
    ws.onerror = () => this.perdu(ws);
    ws.onclose = () => this.perdu(ws);
  }

  perdu(ws) {
    if (this.ws !== ws) return;
    this.ouvert = false;
    this.ws = null;
    try { ws.close(); } catch {}
    if (this.enVol.length) {
      this.file = [].concat(...this.enVol, this.file);
      this.enVol = [];
    }
    this.relancer();
  }

  relancer() {
    if (this.arrete) return;
    const d = this.delai;
    this.delai = Math.min(this.delai * 2, 10000);
    setTimeout(() => this.connecter(), d);
  }

  envoyer(donnee) {
    let lignes;
    if (Array.isArray(donnee)) {
      if (donnee.length !== 5) {
        this.log(`Capteur: 5 valeurs attendues (x_m,y_m,heading_deg,sensor_angle_deg,distance_cm), ${donnee.length} recues.`);
        return false;
      }
      lignes = [donnee.map((v, i) => (i === 4 && (v === null || v === undefined) ? '' : String(v))).join(',')];
    } else {
      lignes = String(donnee ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
    for (const l of lignes) this.file.push(l);
    if (this.file.length > this.maxEnAttente) {
      const trop = this.file.length - this.maxEnAttente;
      this.file.splice(0, trop);
      if (this.perdues === 0 || this.perdues % 1000 < trop) {
        this.log('Capteur: serveur injoignable trop longtemps, les lignes les plus anciennes sont perdues.');
      }
      this.perdues += trop;
    }
    return true;
  }

  vider() {
    if (!this.ouvert || !this.ws || !this.file.length) return;
    while (this.file.length) {
      const lot = this.file.splice(0, LOT_MAX);
      try {
        this.ws.send(lot.join('\n'));
        this.enVol.push(lot);
      } catch {
        this.file = lot.concat(this.file);
        return;
      }
    }
  }

  nouvelleSession(id) {
    this.vider();
    this.session = RE_SESSION.test(String(id || '')) ? String(id) : `s-${horodatage()}`;
    this.log(`Capteur: nouvelle session ${this.session}.`);
    if (this.ws) {
      const ancien = this.ws;
      this.ws = null;
      this.ouvert = false;
      try { ancien.close(); } catch {}
    }
    this.enVol = [];
    this.arrete = false;
    this.delai = 1000;
    this.connecter();
    return this.session;
  }

  etat() {
    return {
      session: this.session,
      connecte: this.ouvert,
      enAttente: this.file.length + this.enVol.reduce((n, l) => n + l.length, 0),
      acceptees: this.acceptees,
      perdues: this.perdues,
    };
  }

  fermer() {
    this.arrete = true;
    clearInterval(this.timer);
    if (this.ws) try { this.ws.close(); } catch {}
  }
}

module.exports = { CanalCapteur };
