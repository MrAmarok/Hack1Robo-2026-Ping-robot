// parole.js - Lecture d'une voix qui arrive EN FLUX depuis le VPS.
//
// Difference avec tts.js : celui-ci synthetise une phrase entiere en local
// (espeak/pico), ecrit un fichier, puis le joue. Il faut donc attendre que
// Claude ait fini d'ecrire, puis attendre la synthese, puis parler.
//
// Ici le VPS envoie des MORCEAUX de PCM au fil de l'eau (Deepgram Aura, voix
// francaise) et on les joue a mesure. Le robot commence a parler des la
// premiere phrase de Claude, pendant qu'il redige la suite.
//
// Un seul processus aplay reste ouvert pour toute la reponse : le relancer a
// chaque morceau reveillerait l'enceinte Bluetooth a chaque fois (~250 ms
// perdues) et hacherait la phrase.
'use strict';

const { spawn } = require('child_process');

class Parole {
  constructor({ playDevice, log, sampleRate, gain, filtreAudio, onCoupure } = {}) {
    // Chaine de filtres ffmpeg imposee (RT_FILTRE). Vide = chaine calculee a
    // partir de gain, voir _ouvrir().
    this.filtreAudio = String(filtreAudio || '').trim();
    this.playDevice = playDevice || 'default';
    this.log = log || console.log;
    // Appele quand le tuyau meurt en pleine conversation : c'est le signe que
    // l'enceinte a disparu (typiquement le firmware du dongle qui plante).
    this.onCoupure = onCoupure || (() => {});
    // Doit correspondre a ce que le VPS demande a Aura (linear16).
    this.sampleRate = sampleRate || 24000;
    // Amplification appliquee par ffmpeg quand elle est demandee. Sans elle on
    // envoie le PCM directement a aplay, ce qui evite un process de plus.
    this.gain = Number(gain || 0);

    this.play = null;   // aplay
    this.filtre = null; // ffmpeg optionnel (gain + limiteur)
    this.enCours = false;
    this._recus = 0;
    // Mode conversation : le tuyau audio reste ouvert entre les reponses.
    // Sans ca, le flux A2DP se ferme a chaque phrase et beaucoup d enceintes
    // Bluetooth raccrochent au bout de quelques secondes de silence. On y
    // ecrit donc du silence, ce qui maintient la liaison eveillee ET evite de
    // repayer les 150 ms d amorce a chaque reponse.
    this.enSession = false;
    this._silenceTimer = null;

    // Modele du temps de LECTURE, distinct du temps d'ecriture.
    //
    // aplay consomme le flux exactement au rythme de l'echantillonnage. Quand
    // on lui a ecrit N octets depuis l'ouverture, le dernier sortira donc du
    // haut-parleur a _t0 + N / (2 * sampleRate). Sans ce calcul, terminer()
    // rouvrait le micro des le dernier octet ECRIT, alors qu'il restait des
    // centaines de ms en tampon : le robot s'entendait finir sa phrase, la
    // detection de parole d'OpenAI y voyait une interruption, et le son se
    // coupait tout seul.
    this._t0 = 0;            // instant d'ouverture du tuyau
    this._octetsEcrits = 0;  // tout ce qui est parti dedans, silence compris
    this._finAudio = 0;      // fin prevue du dernier son AUDIBLE
    // Marge ajoutee a la fin de lecture calculee ci-dessus.
    //
    // Le modele "aplay consomme au rythme de l'echantillonnage" ignore deux
    // delais bien reels : le tampon ALSA, et surtout le chemin A2DP, qui
    // ajoute a lui seul 150 a 300 ms entre l'octet ecrit et le son emis. En
    // Bluetooth, 400 ms rouvraient donc le micro pendant que l'enceinte
    // finissait encore la phrase — et l'IA s'entendait. D'ou un defaut
    // nettement plus large des que la sortie est bluealsa.
    const margeDefaut = String(this.playDevice).startsWith('bluealsa') ? 900 : 400;
    this.margeMs = Number(process.env.RT_MARGE_MS || margeDefaut);
  }

  ouvrirSession() {
    this.enSession = true;
  }

  // Ouvre le tuyau audio. Appele au premier morceau, pas avant : inutile de
  // reveiller l'enceinte tant que Claude n'a rien produit.
  _ouvrir() {
    if (this.enCours) return;
    // En conversation, le tuyau est deja ouvert et alimente en silence entre
    // deux reponses : on le REPREND. Sans ce test on lancerait un second
    // aplay par-dessus le premier a chaque phrase.
    if (this.play) {
      this._arreterSilence();
      this.enCours = true;
      this._recus = 0;
      return;
    }
    const fmt =['-t', 'raw', '-f', 'S16_LE', '-r', String(this.sampleRate), '-c', '1'];
    try {
      this.play = spawn('aplay', ['-q', ...fmt, '-D', this.playDevice, '-'], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      // EPIPE si l'enceinte disparait en cours de phrase : on ne veut pas que
      // ca fasse tomber le processus du robot.
      this.play.stdin.on('error', () => {});
      this.play.on('error', (e) => this.log('Parole: aplay indisponible', e.message));
      // Si l'enceinte disparait pour de bon, aplay sort. On oublie le tuyau
      // mort : la reponse suivante en ouvrira un neuf, ce qui laisse aussi
      // au superviseur de tts.js le temps de refaire la liaison Bluetooth.
      const ceProcessus = this.play;
      this.play.on('close', () => {
        // Un tuyau neuf a pu etre ouvert entre-temps : ne pas l'annuler.
        if (this.play !== ceProcessus) return;
        this._arreterSilence();
        this.play = null;
        this.filtre = null;
        this.enCours = false;
        // En conversation, ne pas attendre la surveillance de fond (jusqu'a
        // une minute) : on rappelle l'enceinte tout de suite.
        if (this.enSession) {
          this.log('Parole: tuyau audio perdu — rappel immediat de l enceinte.');
          try { this.onCoupure(); } catch {}
        }
      });

      if (this.gain > 0) {
        // ATTENTION : ffmpeg et aplay n'ont PAS la meme syntaxe. On passait ici
        // les options d'aplay ('-t raw -f S16_LE -c 1'), or pour ffmpeg '-t'
        // est une duree, '-c' un codec, et le format s'ecrit 's16le'. ffmpeg
        // mourait donc aussitot, sa sortie fermait l'entree d'aplay, et toute
        // la lecture tombait — sans trace, stderr etant ignore.
        const fmtFfmpeg = ['-f', 's16le', '-ar', String(this.sampleRate), '-ac', '1'];

        // 'speechnorm' plutot qu'un simple 'volume'. Mesures du 01/09 sur un
        // signal de parole faible :
        //   volume=3 + limiteur -> RMS 0.123, crete 0.57
        //   volume=6 + limiteur -> RMS 0.238, crete 1.00  (ca sature)
        //   speechnorm          -> RMS 0.214, crete 0.95  (propre)
        // Multiplier le volume amplifie tout, y compris les silences, puis se
        // heurte au plafond. speechnorm remonte les passages FAIBLES et laisse
        // les forts tranquilles : a crete egale, la voix porte bien plus loin.
        //
        // RT_GAIN reste le bouton de reglage (3 = fort, 6 = tres fort) ; il
        // pilote maintenant l'expansion. RT_FILTRE permet d'imposer sa propre
        // chaine de filtres ffmpeg pour experimenter sans toucher au code.
        const expansion = Math.max(1, Math.min(50, this.gain * 4));
        const chaine =
          this.filtreAudio ||
          `speechnorm=e=${expansion}:r=0.0005:l=1,alimiter=limit=0.97`;

        this.filtre = spawn(
          'ffmpeg',
          ['-loglevel', 'error',
           ...fmtFfmpeg, '-i', 'pipe:0',
           '-af', chaine,
           ...fmtFfmpeg, 'pipe:1'],
          { stdio: ['pipe', 'pipe', 'pipe'] }
        );
        this.log(`Parole: filtre audio « ${chaine} ».`);
        this.filtre.stdin.on('error', () => {});
        this.filtre.stderr.on('data', (d) => {
          const t = String(d).trim().slice(0, 140);
          if (t) this.log('Parole ffmpeg: ' + t);
        });
        // end:false — si le filtre s'arrete, il ne doit PAS fermer l'entree
        // d'aplay au passage : on veut pouvoir continuer sans amplification
        // plutot que de perdre le son.
        this.filtre.stdout.pipe(this.play.stdin, { end: false });
        const ceFiltre = this.filtre;
        this.filtre.on('close', () => {
          if (this.filtre !== ceFiltre) return;
          this.filtre = null; // _ecrire() repasse directement sur aplay
          this.log('Parole: filtre de gain arrete, lecture sans amplification.');
        });
      }

      // Amorce de silence : l'enceinte Bluetooth met un instant a se reveiller
      // et avalerait les premieres syllabes. 150 ms suffisent ici, contre les
      // 250 ms de tts.js — le flux qui suit maintient la liaison eveillee.
      // Repere de temps du tuyau : tout le calcul de fin de lecture en decoule.
      this._t0 = Date.now();
      this._octetsEcrits = 0;

      const silence = Buffer.alloc(Math.round(this.sampleRate * 0.15) * 2);
      this._ecrire(silence);

      this.enCours = true;
      this._recus = 0;
    } catch (e) {
      this.log('Parole: impossible de demarrer la lecture', e.message);
      this.enCours = false;
    }
  }

  _ecrire(buf) {
    const cible = this.filtre ? this.filtre.stdin : this.play && this.play.stdin;
    if (cible && cible.writable) {
      cible.write(buf);
      // Le silence compte aussi : il occupe le tampon et retarde d'autant le
      // son qui sera ecrit apres lui.
      this._octetsEcrits += buf.length;
    }
  }

  // Instant ou le dernier octet ecrit sortira du haut-parleur.
  _finLecture() {
    return this._t0 + (this._octetsEcrits / 2 / this.sampleRate) * 1000;
  }

  // Un morceau de PCM arrive du VPS.
  ajouter(pcm) {
    if (!pcm || !pcm.length) return;
    this._ouvrir();
    if (!this.enCours) return;
    this._recus += pcm.length;
    this._ecrire(Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm));
  }

  // Le VPS annonce la fin de la reponse : on ferme l'entree et on laisse aplay
  // vider son tampon. Surtout PAS de kill ici, sinon la fin de phrase saute.
  terminer() {
    if (!this.enCours) return;
    if (this.enSession) {
      // On rend la main au micro (parle() redevient faux) mais on GARDE le
      // tuyau ouvert, alimente en silence.
      const s = (this._recus / 2 / this.sampleRate).toFixed(1);
      // Photographie de la fin de lecture AVANT de remettre du silence :
      // le silence qui suit ne doit pas repousser cette echeance.
      this._finAudio = this._finLecture();
      const reste = Math.max(0, this._finAudio + this.margeMs - Date.now());
      this.log(
        `Parole: fin de la reponse (${s}s d audio), liaison maintenue` +
        (reste > 50 ? `, micro rouvert dans ${reste}ms.` : '.')
      );
      this.enCours = false;
      this._recus = 0;
      this._maintenirEveille();
      return;
    }
    const secondes = (this._recus / 2 / this.sampleRate).toFixed(1);
    this.log(`Parole: fin de la reponse (${secondes}s d audio).`);
    try {
      if (this.filtre) this.filtre.stdin.end();
      else if (this.play) this.play.stdin.end();
    } catch {}
    this.enCours = false;
    this.filtre = null;
    this.play = null;
  }

  // Coupure IMMEDIATE — c'est ce qui permettra de lui couper la parole.
  // On tue les process au lieu de fermer proprement : le tampon d'aplay
  // contient deja plusieurs centaines de millisecondes de son a jeter.
  couper(raison = '') {
    if (!this.enCours && !this.play) return false;
    this._arreterSilence();
    try { if (this.filtre) this.filtre.kill('SIGKILL'); } catch {}
    try { if (this.play) this.play.kill('SIGKILL'); } catch {}
    this.filtre = null;
    this.play = null;
    this.enCours = false;
    // Le tampon part avec le processus : plus rien ne sortira, le micro peut
    // rouvrir tout de suite.
    this._finAudio = 0;
    this.log(`Parole: coupee${raison ? ' (' + raison + ')' : ''}.`);
    return true;
  }

  // Entre deux reponses, on continue d'ecrire du silence dans le tuyau. Le
  // flux A2DP reste donc ouvert et l'enceinte ne raccroche pas — c'est ce qui
  // la faisait decrocher en pleine conversation, chaque fin de phrase fermant
  // le flux. Bonus : la reponse suivante part sans amorce, donc plus vite.
  _maintenirEveille() {
    this._arreterSilence();
    const paquet = Buffer.alloc(Math.round(this.sampleRate * 0.2) * 2); // 200 ms
    this._silenceTimer = setInterval(() => {
      if (this.enCours) return; // une reponse a repris, elle alimente le tuyau
      if (!this.play) return this._arreterSilence();
      // N'ecrire QUE si le tuyau est reellement vide.
      //
      // Le VPS envoie l'audio plus vite que le temps reel : a la fin d'une
      // reponse, il reste souvent plusieurs secondes en attente de lecture.
      // Sans ce test, on empilait du silence par-dessus, et le retard grossissait
      // d'une reponse a l'autre — mesure du 12/08 : 3s, 6s, 16s puis 21s. Le
      // robot finissait par parler avec vingt secondes de decalage.
      if (Date.now() < this._finLecture()) return;
      this._ecrire(paquet);
    }, 200);
    if (this._silenceTimer.unref) this._silenceTimer.unref();
  }

  _arreterSilence() {
    if (this._silenceTimer) {
      clearInterval(this._silenceTimer);
      this._silenceTimer = null;
    }
  }

  // Fin de la conversation : la, on ferme vraiment.
  fermerSession() {
    this.enSession = false;
    this._arreterSilence();
    try {
      if (this.filtre) this.filtre.stdin.end();
      else if (this.play) this.play.stdin.end();
    } catch {}
    this.enCours = false;
    this._finAudio = 0;
    this.filtre = null;
    this.play = null;
    this.log('Parole: tuyau audio ferme.');
  }

  // Vrai tant que du son sort ou va sortir du haut-parleur. Le micro reste
  // ferme pendant tout ce temps : c'est ce qui empeche le robot de prendre sa
  // propre fin de phrase pour une interruption.
  parle() {
    return this.enCours || Date.now() < this._finAudio + this.margeMs;
  }
}

module.exports = { Parole };
