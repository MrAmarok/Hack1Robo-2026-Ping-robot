// micro.js - Capture continue du micro pour la conversation temps reel.
//
// Le mode tour par tour (voice.js) enregistre un FICHIER : il attend le
// silence, ecrit le wav, l'envoie. Ici on pousse le son au fil de l'eau, par
// petits morceaux, pendant que la personne parle encore.
//
// Le format est impose par la Realtime d'OpenAI : PCM 16 bits signes,
// 24 kHz, mono. On demande donc exactement ca a arecord, sans conversion
// intermediaire — un reechantillonnage ajouterait de la latence pour rien.
//
// Taille de morceau : 40 ms. Plus court, on multiplie les paquets reseau sur
// une liaison 4G deja etroite ; plus long, on ajoute du retard a la detection
// de tour de parole, qui se fait a l'autre bout.
'use strict';

const { spawn } = require('child_process');

const TAUX = 24000;
const OCTETS_PAR_MS = (TAUX * 2) / 1000; // 16 bits mono
const MORCEAU_MS = 40;

// Niveau sonore d'un morceau, entre 0 et 1 (valeur efficace).
// Sert a decider LOCALEMENT si quelqu'un parle vraiment — indispensable tant
// qu'on n'a pas d'annulation d'echo : sans ca, le robot prend sa propre voix
// dans l'enceinte pour une interruption et se coupe la parole en boucle.
function niveau(buf) {
  const n = buf.length >> 1;
  if (!n) return 0;
  let somme = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    somme += v * v;
  }
  return Math.sqrt(somme / n) / 32768;
}

class Micro {
  constructor({ device, log, onChunk } = {}) {
    this.device = device || 'default';
    this.log = log || console.log;
    this.onChunk = onChunk || (() => {});
    this.proc = null;
    this.tampon = Buffer.alloc(0);
    this.taille = OCTETS_PAR_MS * MORCEAU_MS;
    this._relance = null;
  }

  demarrer() {
    if (this.proc) return;
    this.proc = spawn('arecord', [
      '-q', '-D', this.device,
      '-f', 'S16_LE', '-r', String(TAUX), '-c', '1', '-t', 'raw',
    ]);

    this.proc.stdout.on('data', (d) => {
      // arecord livre par blocs de taille variable : on decoupe nous-memes
      // en morceaux reguliers pour un debit reseau previsible.
      this.tampon = Buffer.concat([this.tampon, d]);
      while (this.tampon.length >= this.taille) {
        const morceau = this.tampon.subarray(0, this.taille);
        this.onChunk(morceau, niveau(morceau));
        this.tampon = this.tampon.subarray(this.taille);
      }
    });

    this.proc.on('error', (e) => this.log('Micro: arecord indisponible', e.message));

    // Micro debranche ou occupe : arecord sort aussitot. UNE seule relance en
    // vol, avec temporisation — c'est la lecon de la boucle d'emballement de
    // voice.js (03/08), on ne la refait pas ici.
    this.proc.on('close', (code) => {
      const tournait = !!this.proc;
      this.proc = null;
      if (!tournait || this._relance) return;
      this.log(`Micro: capture arretee (code=${code}), relance dans 2s.`);
      this._relance = setTimeout(() => {
        this._relance = null;
        if (this.voulu) this.demarrer();
      }, 2000);
    });

    this.voulu = true;
    this.log(`Micro: capture continue sur ${this.device} (${TAUX} Hz, morceaux de ${MORCEAU_MS} ms).`);
  }

  arreter() {
    this.voulu = false;
    if (this._relance) {
      clearTimeout(this._relance);
      this._relance = null;
    }
    const p = this.proc;
    this.proc = null;
    if (p) {
      try {
        p.kill('SIGKILL');
      } catch {}
      this.log('Micro: capture arretee.');
    }
    this.tampon = Buffer.alloc(0);
  }

  actif() {
    return !!this.proc;
  }
}

module.exports = { Micro, TAUX };
