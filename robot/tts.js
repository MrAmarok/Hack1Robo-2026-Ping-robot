// tts.js - Synthese vocale : le robot "parle" via un haut-parleur Bluetooth.
// L'app envoie un texte (event robot_say) -> le Pi le synthetise en WAV puis
// le joue sur la JBL appairee, via aplay/BlueALSA.
//
// Moteur : pico2wave (voix FR plus naturelle) si installe, sinon espeak-ng.
//   sudo apt install espeak-ng            # repli, voix robotique
//   sudo apt install libttspico-utils     # meilleure voix FR (si dispo)
// Lecture Bluetooth : sudo apt install bluez-alsa-utils alsa-utils
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Lance une commande et resout {code, stderr, err} sans jamais throw.
// timeoutMs : au-dela, le process est tue (SIGKILL) pour ne JAMAIS bloquer la
// file de lecture (un aplay qui joue vers une enceinte endormie peut pendre).
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    let stdout = '';
    let stderr = '';
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, err: e.message, stdout, stderr });
      return;
    }
    let timer = null;
    const finish = (r) => {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(r); // resolve multiple = sans effet, pas grave
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish({ code: -2, err: `timeout ${timeoutMs}ms`, stdout, stderr });
      }, timeoutMs);
    }
    proc.stdout.on('data', (d) => { stdout += String(d); });
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('error', (e) => finish({ code: -1, err: e.message, stdout, stderr }));
    proc.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

function has(bin) {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

class Tts {
  constructor({ lang, speakerMac, playDevice, prerollMs, keepaliveMs, veilleuse, onPlaybackStart, onPlaybackEnd, log } = {}) {
    this.lang = lang || 'fr-FR';
    this.speakerMac = (speakerMac || '').trim();
    // Sortie aplay : la JBL via BlueALSA si on connait sa MAC, sinon la sortie
    // ALSA par defaut (utile pour tester avec un casque/HP filaire).
    this.playDevice = playDevice ||
      (this.speakerMac ? `bluealsa:DEV=${this.speakerMac},PROFILE=a2dp` : 'default');
    this.reconnectMac = this.speakerMac || this._macFromPlayDevice(this.playDevice);
    // Silence d'amorce (ms) colle devant chaque phrase : laisse le temps a une
    // enceinte Bluetooth de "se reveiller", sinon les phrases courtes sont
    // avalees. 0 = desactive (ex. HP filaire).
    this.prerollMs = prerollMs != null ? prerollMs : 1500;
    // Anti-veille optionnel. Desactive par defaut : sur la cle Realtek du
    // robot, chaque ouverture/fermeture A2DP peut provoquer un hw err du
    // firmware. Le silence periodique toutes les 90 s recreait donc la panne
    // meme sans message vocal. Une valeur > 0 permet de le reactiver.
    this.keepaliveMs = keepaliveMs != null ? keepaliveMs : 0;
    // Veilleuse : le filet de son permanent qui empeche l'enceinte de
    // s'eteindre toute seule (voir demarrerVeilleuse). Uniquement sur une
    // sortie Bluetooth : un haut-parleur filaire ne s'endort pas, et occuper
    // sa carte son en permanence bloquerait les autres lecteurs.
    // Vaut pour TOUTES les sorties. Premiere version limitee a bluealsa : sur
    // le montage reel, la sortie est plughw:CARD=Headphones (prise jack) et la
    // veilleuse ne demarrait donc jamais — elle ne servait a rien. Une enceinte
    // amplifiee sur jack s'endort sur le silence exactement comme une Bluetooth.
    this.veilleuseActive =
      veilleuse != null
        ? !!veilleuse
        : String(process.env.TTS_VEILLEUSE || 'true').toLowerCase() === 'true';
    // Temps laisse au pilote pour rendre le peripherique apres l'arret de la
    // veilleuse. Sur une sortie EXCLUSIVE (plughw), le peripherique reste pris
    // un court instant apres la mort du processus : jouer tout de suite echoue
    // sur "Device or resource busy", et le robot reste muet.
    this.veilleuseLibererMs = Number(process.env.TTS_VEILLEUSE_LIBERER_MS || 300);
    // Frequence de la veilleuse : le bon choix depend du TYPE de sortie,
    // parce que ce n'est pas le meme organe qui decide de s'endormir.
    //
    //   Bluetooth : c'est la presence du FLUX A2DP qui compte, le detecteur
    //     est numerique et en amont du haut-parleur. 30 Hz convient : un petit
    //     boomer ne descend pas si bas, on ne l'entend pas.
    //
    //   Jack : le detecteur est ANALOGIQUE et place apres l'etage d'entree de
    //     l'enceinte, qui coupe les basses (condensateur de liaison, filtre
    //     passe-haut). A 30 Hz le signal lui arrive attenue a presque rien :
    //     l'enceinte "voit" du silence et s'endort quand meme. Il faut donc
    //     une frequence DANS sa bande passante — mais hors de l'audition
    //     humaine : 18 kHz, que la plupart des adultes n'entendent plus et
    //     qu'un tweeter reproduit sans peine.
    const hzDefaut = this.playDevice.startsWith('bluealsa') ? 30 : 18000;
    this.veilleuseHz = Number(process.env.TTS_VEILLEUSE_HZ || hzDefaut);
    this.veilleuseVol = Number(process.env.TTS_VEILLEUSE_VOL || 0.02);
    this._veilleuse = null;        // process ffmpeg en cours
    this._veilleuseVoulue = false; // demarrerVeilleuse() a-t-elle ete appelee ?
    this._veilleusePauses = 0;     // > 0 : quelqu un d autre a besoin du HP
    this._veilleuseTimer = null;
    this._veilleuseAttente = 5000; // recul progressif entre deux essais
    this._veilleuseKo = false;     // pour ne pas repeter le meme echec
    this.log = log || console.log;
    this.onPlaybackStart = typeof onPlaybackStart === 'function' ? onPlaybackStart : null;
    this.onPlaybackEnd = typeof onPlaybackEnd === 'function' ? onPlaybackEnd : null;
    // aplay par defaut : son buffer ALSA de 0.7s (--buffer-time) encaisse bien
    // mieux les micro-coupures Bluetooth que la sortie alsa de ffmpeg.
    this.player = String(process.env.TTS_PLAYER || 'aplay').trim().toLowerCase();
    // Copie de diagnostic desactivee par defaut : deux ecritures disque de ~100 Ko
    // a chaque message, sur la carte SD d'un Pi 3, pour rien en usage normal.
    this.keepLastClip = String(process.env.TTS_KEEP_LAST_CLIP || 'false').toLowerCase() === 'true';
    // Tampon ALSA large (1.2s) : le Pi 3 partage son antenne entre WiFi/4G et
    // Bluetooth, et le CPU est charge (video + encodage). Un tampon court
    // provoquait des underruns BlueALSA = son hache. Periode 300ms = moins
    // de reveils du thread audio, donc moins sensible aux pics de charge.
    this.aplayBufferTimeUs = Number(process.env.TTS_APLAY_BUFFER_TIME_US || 1200000);
    this.aplayPeriodTimeUs = Number(process.env.TTS_APLAY_PERIOD_TIME_US || 300000);
    // Volume de la voix. amplitude = force du moteur espeak (100 defaut, 200
    // maxi) ; gain = amplification du wav avant lecture (limiteur anti-satu).
    this.amplitude = Number(process.env.TTS_AMPLITUDE || 200);
    this.gain = Number(process.env.TTS_GAIN || 2);
    this.queue = [];
    this.busy = false;
    // --- Alarme ---
    this.alarmeActive = false;
    this._alarmeProc = null;   // lecture en cours, pour pouvoir la tuer net
    this._sirene = null;       // fichier genere une fois puis reutilise
    this.alarmePhrase =
      process.env.TTS_ALARME_PHRASE ||
      "Attention. Vous etes filme et enregistre. Le proprietaire vient d'etre prevenu.";
    this._autoTimer = null; // surveillance de l'enceinte (startAutoReconnect)
    this.engine = null; // 'pico' | 'espeak' | 'none' (resolu au 1er usage)
    this._silence = null;

    // L'ancien anti-veille par salves ne sert plus a rien quand la veilleuse
    // tient le flux en continu, et les deux se disputeraient le PCM.
    if (this.keepaliveMs > 0 && !this.veilleuseActive && this.playDevice.startsWith('bluealsa')) {
      const t = setInterval(() => this._keepaliveTick(), this.keepaliveMs);
      if (t.unref) t.unref();
      // Premier tick rapide : reconnecte l'enceinte peu apres le demarrage.
      const t0 = setTimeout(() => this._keepaliveTick(), 8000);
      if (t0.unref) t0.unref();
    }
  }

  // 'fr-FR' -> 'fr' pour espeak-ng
  _langEspeak() {
    return (this.lang.split('-')[0] || 'fr').toLowerCase();
  }

  async _resolveEngine() {
    if (this.engine) return this.engine;
    if (await has('pico2wave')) this.engine = 'pico';
    else if (await has('espeak-ng')) this.engine = 'espeak';
    else this.engine = 'none';
    if (this.engine !== 'none') this.log(`TTS: moteur = ${this.engine}.`);
    return this.engine;
  }

  _macFromPlayDevice(device) {
    const m = String(device || '').match(/(?:^|,)DEV=([0-9A-Fa-f:]{17})(?:,|$)/);
    return m ? m[1].toUpperCase() : '';
  }

  // Reconnecte l'enceinte ET attend que son peripherique audio reapparaisse.
  // Se contenter de lancer la connexion ne suffisait pas : la lecture repartait
  // avant que BlueALSA ait publie le PCM, et echouait sur "PCM not found".
  async _reconnectSpeaker() {
    if (!this.reconnectMac) return false;
    this.log(`TTS: reconnexion Bluetooth ${this.reconnectMac}...`);
    await run('bluetoothctl', ['connect', this.reconnectMac], 15000);
    // Jusqu'a 12 s d'attente, le temps que le profil audio soit negocie.
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const info = await run('bluetoothctl', ['info', this.reconnectMac], 5000);
      if (/Connected:\s*yes/i.test(info.stdout || '')) {
        await new Promise((r) => setTimeout(r, 1500)); // laisse publier le PCM
        this.log('TTS: enceinte de nouveau disponible.');
        return true;
      }
    }
    this.log('TTS: enceinte toujours injoignable.');
    return false;
  }

  // Reconnexion IMMEDIATE, pour la conversation en direct.
  //
  // Le firmware du dongle Realtek plante de temps en temps ("RTL: hw err,
  // trigger devcoredump", constate le 08/08 a 228 s et 947 s d'uptime) et
  // reinitialise hci0 : l'enceinte tombe en pleine phrase. La surveillance de
  // fond finit par la rattraper, mais elle attend au minimum une minute — bien
  // trop long quand on est en train de parler avec le robot.
  //
  // Un seul essai a la fois : sans ce verrou, un plantage declencherait une
  // rafale d'appels a bluetoothctl (la lecon de la boucle d'emballement).
  async reconnecterMaintenant() {
    if (!this.reconnectMac || this._reconnexionEnCours) return false;
    this._reconnexionEnCours = true;
    try {
      return await this._reconnectSpeaker();
    } finally {
      this._reconnexionEnCours = false;
    }
  }

  // Au demarrage du Pi, l'enceinte n'est PAS reconnectee toute seule : en
  // Bluetooth c'est la source (le Pi) qui doit rappeler le haut-parleur, et
  // BlueZ ne le fait pas de lui-meme. On s'en charge ici, avec plusieurs
  // essais espaces (l'enceinte peut etre encore en train de s'allumer, ou
  // hors de portee au moment ou le robot demarre).
  async ensureConnectedAtStartup(tries = 6, delayMs = 20000) {
    if (!this.reconnectMac) return;
    let connectee = false;
    for (let i = 1; i <= tries && !connectee; i++) {
      const info = await run('bluetoothctl', ['info', this.reconnectMac], 8000);
      if (/Connected:\s*yes/i.test(info.stdout || '')) {
        if (i > 1) this.log('TTS: enceinte reconnectee.');
        connectee = true;
        this._veilleuseMaintenant();
        break;
      }
      this.log(`TTS: enceinte absente, tentative de connexion ${i}/${tries}...`);
      await run('bluetoothctl', ['connect', this.reconnectMac], 15000);
      await new Promise((r) => setTimeout(r, 3000));
      const after = await run('bluetoothctl', ['info', this.reconnectMac], 8000);
      if (/Connected:\s*yes/i.test(after.stdout || '')) {
        this.log('TTS: enceinte connectee.');
        connectee = true;
        this._veilleuseMaintenant();
        break;
      }
      if (i < tries) await new Promise((r) => setTimeout(r, delayMs));
    }
    if (!connectee) this.log('TTS: enceinte injoignable (eteinte ?). Surveillance en fond.');
    // Armee dans TOUS les cas, meme si l'enceinte a repondu : elle peut etre
    // eteinte ou sortir de portee plus tard dans la journee.
    this.startAutoReconnect();
  }

  // Surveillance continue de l'enceinte, APRES l'abandon du demarrage.
  //
  // Pourquoi elle est necessaire : ensureConnectedAtStartup ne couvre que ~2
  // minutes, alors qu'on allume presque toujours le robot AVANT l'enceinte.
  // Passe ce delai, plus rien ne la rappelait et la premiere phrase arrivait
  // avec ~15 s de retard, le temps de la reconnexion a chaud.
  //
  // Pourquoi elle est PRUDENTE (lecon du 01/08) : une surveillance trop zelee
  // provoque elle-meme les coupures. Donc ici, jamais de relance de
  // bluetoothd ni de la cle USB — c'est le travail de bt-adapter-up. On se
  // contente de rappeler l'enceinte, et seulement si :
  //   - elle est reellement deconnectee (on verifie avant d'agir),
  //   - aucun son n'est en cours (ne jamais couper une phrase en vol),
  // avec un espacement croissant : une enceinte eteinte pour la nuit ne doit
  // pas etre appelee toutes les minutes jusqu'au matin.
  startAutoReconnect({ minMs = 60000, maxMs = 600000 } = {}) {
    if (!this.reconnectMac || this._autoTimer) return;
    let attente = minMs;
    const tick = async () => {
      this._autoTimer = null;
      try {
        if (!this.busy && !this.queue.length) {
          const info = await run('bluetoothctl', ['info', this.reconnectMac], 8000);
          if (/Connected:\s*yes/i.test(info.stdout || '')) {
            attente = minMs; // enceinte revenue : on redevient reactif
            this._veilleuseMaintenant();
          } else {
            await run('bluetoothctl', ['connect', this.reconnectMac], 15000);
            const apres = await run('bluetoothctl', ['info', this.reconnectMac], 8000);
            if (/Connected:\s*yes/i.test(apres.stdout || '')) {
              this.log('TTS: enceinte reconnectee (surveillance).');
              attente = minMs;
              this._veilleuseMaintenant();
            } else {
              attente = Math.min(attente * 2, maxMs);
            }
          }
        }
      } catch {
        attente = Math.min(attente * 2, maxMs);
      }
      this._autoTimer = setTimeout(tick, attente);
      if (this._autoTimer.unref) this._autoTimer.unref();
    };
    this._autoTimer = setTimeout(tick, attente);
    if (this._autoTimer.unref) this._autoTimer.unref();
  }

  stopAutoReconnect() {
    if (this._autoTimer) {
      clearTimeout(this._autoTimer);
      this._autoTimer = null;
    }
  }

  // Empile un texte a dire. Les phrases sont jouees une par une (pas de
  // chevauchement) pour rester comprehensibles.
  say(text) {
    let t = String(text || '').trim();
    if (!t) return;
    if (t.length > 300) t = t.slice(0, 300); // securite : pas de roman
    this.queue.push({ type: 'text', text: t });
    this._drain();
  }

  playTestTone() {
    this.queue.push({ type: 'test' });
    this._drain();
  }

  // Talkie-walkie : empile un clip audio encode (m4a/aac...) recu de l'app.
  playClip(b64, ext) {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (!buf.length || buf.length > 2 * 1024 * 1024) return;
    const e = String(ext || 'm4a').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'm4a';
    this.queue.push({ type: 'clip', buf, ext: e });
    this._drain();
  }

  async _drain() {
    if (this.busy) return;
    this.busy = true;
    // La veilleuse tient le peripherique audio, qui n'accepte qu'un client a
    // la fois : elle s'efface le temps qu'on parle vraiment.
    const veilleuseTournait = !!this._veilleuse;
    this.pauseVeilleuse();
    try { if (this.onPlaybackStart) this.onPlaybackStart(); } catch {}
    try {
      // Seulement si elle jouait reellement : sinon on ajouterait ce delai
      // devant CHAQUE phrase pour rien.
      if (veilleuseTournait && this.veilleuseLibererMs > 0) {
        await new Promise((r) => setTimeout(r, this.veilleuseLibererMs));
      }
      while (this.queue.length) {
        const item = this.queue.shift();
        if (item.type === 'clip') await this._playClipOne(item);
        else if (item.type === 'keepalive') await this._keepaliveOne();
        else if (item.type === 'test') await this._testToneOne();
        else await this._speakOne(item.text);
      }
    } finally {
      this.busy = false;
      try { if (this.onPlaybackEnd) this.onPlaybackEnd(); } catch {}
      this.reprendreVeilleuse();
    }
  }

  // Joue un fichier sur l'enceinte. Si elle a decroche (PCM not found), on
  // tente une reconnexion Bluetooth puis on rejoue une fois.
  async _playFile(file, timeoutMs) {
    if (this.player !== 'aplay') {
      const playedByFfmpeg = await this._playFileWithFfmpeg(file, timeoutMs);
      if (playedByFfmpeg.code === 0) return playedByFfmpeg;
      const errText = `${playedByFfmpeg.err || ''} ${playedByFfmpeg.stderr || ''}`.trim();
      this.log(`TTS: lecture ffmpeg echouee, essai aplay (${errText}).`);
    }

    const bufferedArgs = this._aplayArgs(file, true);
    const plainArgs = this._aplayArgs(file, false);
    let played = await run('aplay', bufferedArgs, timeoutMs);
    let errText = `${played.err || ''} ${played.stderr || ''}`;
    if (played.code !== 0 && /unrecognized option|invalid option|unknown option/i.test(errText)) {
      played = await run('aplay', plainArgs, timeoutMs);
      errText = `${played.err || ''} ${played.stderr || ''}`;
    }
    // Peripherique occupe : c'est presque toujours la veilleuse qui ne l'a pas
    // encore rendu. On lui laisse une seconde chance, puis on la sacrifie —
    // tenir l'enceinte eveillee est un confort, PARLER est la fonction.
    if (played.code !== 0 && /Device or resource busy/i.test(errText)) {
      this.log('TTS: peripherique occupe, nouvel essai dans 400 ms.');
      this._tuerVeilleuse();
      await new Promise((r) => setTimeout(r, 400));
      played = await run('aplay', bufferedArgs, timeoutMs);
      errText = `${played.err || ''} ${played.stderr || ''}`;
      if (played.code !== 0 && /Device or resource busy/i.test(errText) && this.veilleuseActive) {
        this.veilleuseActive = false;
        this.arreterVeilleuse();
        this.log('TTS: la veilleuse bloque la sortie audio -> desactivee pour cette session.');
        played = await run('aplay', bufferedArgs, timeoutMs);
        errText = `${played.err || ''} ${played.stderr || ''}`;
      }
    }
    if (played.code !== 0 && /PCM not found|No such device/i.test(errText) && await this._reconnectSpeaker()) {
      played = await run('aplay', bufferedArgs, timeoutMs);
      const retryErr = `${played.err || ''} ${played.stderr || ''}`;
      if (played.code !== 0 && /unrecognized option|invalid option|unknown option/i.test(retryErr)) {
        played = await run('aplay', plainArgs, timeoutMs);
      }
    }
    // Si aplay etait le lecteur principal et qu'il a echoue (absent, device
    // refuse...), on retente via ffmpeg pour ne pas rester muet.
    if (played.code !== 0 && this.player === 'aplay') {
      const lastErr = `${played.err || ''} ${played.stderr || ''}`.trim();
      this.log(`TTS: lecture aplay echouee, essai ffmpeg (${lastErr}).`);
      const viaFfmpeg = await this._playFileWithFfmpeg(file, timeoutMs);
      if (viaFfmpeg.code === 0) return viaFfmpeg;
    }
    return played;
  }

  async _playFileWithFfmpeg(file, timeoutMs) {
    let played = await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-vn',
      '-ac', '2',
      '-ar', '44100',
      '-f', 'alsa',
      this.playDevice,
    ], timeoutMs);

    const errText = `${played.err || ''} ${played.stderr || ''}`;
    if (played.code !== 0 && /PCM not found|No such device|Device or resource busy/i.test(errText) && await this._reconnectSpeaker()) {
      played = await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', file,
        '-vn',
        '-ac', '2',
        '-ar', '44100',
        '-f', 'alsa',
        this.playDevice,
      ], timeoutMs);
    }
    return played;
  }

  _aplayArgs(file, buffered) {
    const args = ['-q'];
    if (buffered && this.aplayBufferTimeUs > 0) {
      args.push(`--buffer-time=${this.aplayBufferTimeUs}`);
      if (this.aplayPeriodTimeUs > 0) args.push(`--period-time=${this.aplayPeriodTimeUs}`);
    }
    args.push('-D', this.playDevice, file);
    return args;
  }

  async _renderPlayableWav(input, output, padMs, timeoutMs) {
    const filters = ['aresample=async=1000:first_pts=0'];
    // Gain final + limiteur : monte le volume sans faire saturer l'enceinte
    // (alimiter ecrete proprement au lieu de distordre).
    if (this.gain && this.gain !== 1) {
      filters.push(`volume=${this.gain}`, 'alimiter=limit=0.95');
    }
    if (padMs > 0) filters.unshift(`adelay=${padMs}:all=1`);
    return run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', input,
      '-vn',
      '-af', filters.join(','),
      '-ac', '2',
      '-ar', '44100',
      '-c:a', 'pcm_s16le',
      output,
    ], timeoutMs);
  }

  // --- Sirene ---
  //
  // Un sifflement module, pas un bip. Deux choix delibérés :
  //
  //   la FREQUENCE tourne autour de 1800 Hz, parce que le conduit auditif
  //   resonne vers 3 kHz : c'est la zone ou l'oreille humaine est la plus
  //   sensible, et donc ou un son devient reellement penible ;
  //
  //   elle BALAIE 1100-2500 Hz deux fois par seconde. Un son fixe se laisse
  //   ignorer au bout de quelques secondes, l'oreille s'y habitue ; un son
  //   qui bouge sans cesse rend l'accoutumance impossible.
  //
  // L'expression ci-dessous est une vraie modulation de frequence : la phase
  // integre la frequence, sinon on obtiendrait un glissando faux et mou.
  //   phase = 2.PI.(f0.t + (df / 2.PI.fm).sin(2.PI.fm.t))
  async _sireneFile() {
    if (this._sirene) return this._sirene;
    const f = path.join(os.tmpdir(), `ping-alarme-${process.pid}.wav`);
    const gen = await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'aevalsrc=0.9*sin(2*PI*(1800*t+55.7*sin(2*PI*2*t))):s=44100:d=6',
      '-ac', '2', '-c:a', 'pcm_s16le', f,
    ], 15000);
    if (gen.code !== 0) {
      this.log(`ALARME: generation de la sirene impossible ${(gen.err || gen.stderr || '').trim()}`);
      return null;
    }
    this._sirene = f;
    return f;
  }

  // Lecture d'un passage de sirene, interruptible : on garde le process sous
  // la main pour que l'arret soit IMMEDIAT. Une alarme qu'on ne peut pas
  // couper tout de suite est pire qu'une alarme absente.
  _jouerSirene(file) {
    return new Promise((resolve) => {
      let p;
      try {
        p = spawn('aplay', this._aplayArgs(file, true), { stdio: 'ignore' });
      } catch {
        resolve();
        return;
      }
      this._alarmeProc = p;
      p.on('error', () => { if (this._alarmeProc === p) this._alarmeProc = null; resolve(); });
      p.on('close', () => { if (this._alarmeProc === p) this._alarmeProc = null; resolve(); });
    });
  }

  // Alterne sirene et annonce parlee. La voix seule ne fait pas peur, la
  // sirene seule n'informe pas : c'est l'alternance qui dissuade.
  async demarrerAlarme(phrase) {
    if (this.alarmeActive) return false;
    this.alarmeActive = true;
    // L'alarme passe avant tout le reste : on vide ce qui attendait.
    this.queue.length = 0;
    this.pauseVeilleuse();
    this.log('ALARME: declenchee.');
    const texte = String(phrase || this.alarmePhrase || '').trim();
    try {
      while (this.alarmeActive) {
        const s = await this._sireneFile();
        if (!s) break;
        await this._jouerSirene(s);
        if (!this.alarmeActive) break;
        if (texte) await this._speakOne(texte);
      }
    } finally {
      this.alarmeActive = false;
      this.reprendreVeilleuse();
      this.log('ALARME: arretee.');
    }
    return true;
  }

  arreterAlarme() {
    if (!this.alarmeActive) return false;
    this.alarmeActive = false;
    const p = this._alarmeProc;
    this._alarmeProc = null;
    if (p) { try { p.kill('SIGKILL'); } catch {} }
    return true;
  }

  // Genere (une fois) un petit wav de silence pour l'anti-veille.
  // Signal d'anti-veille. PAS du silence numerique : beaucoup d'enceintes
  // Bluetooth (dont la G200) se mettent en veille en l'absence d'energie
  // audio reelle, meme si le flux est actif. On joue donc une tonalite tres
  // grave (30 Hz, inaudible sur un petit haut-parleur) a volume tres bas :
  // assez pour la tenir eveillee, sans qu'on l'entende.
  async _silenceFile() {
    if (this._silence) return this._silence;
    const f = path.join(os.tmpdir(), `ping-tts-keepalive-${process.pid}.wav`);
    const gen = await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=30:sample_rate=44100:duration=0.8',
      '-af', 'volume=0.02',
      '-ac', '2', '-c:a', 'pcm_s16le', f,
    ], 10000);
    if (gen.code !== 0) return null;
    this._silence = f;
    return f;
  }

  // --- Veilleuse : l'enceinte ne doit JAMAIS s'eteindre ---
  //
  // Elle s'eteignait pour deux raisons, et il faut traiter les deux :
  //   1. plus aucune liaison A2DP -> l'enceinte se croit seule et se coupe ;
  //   2. liaison ouverte mais SILENCIEUSE -> beaucoup de modeles (dont la
  //      G200) s'endorment quand meme, faute d'energie audio reelle.
  // On tient donc un flux permanent qui porte une vraie tonalite, mais a
  // 30 Hz et 2 % de volume : un petit haut-parleur ne la restitue pas.
  //
  // Pourquoi un flux CONTINU et non les salves de l'ancien anti-veille :
  // chaque salve ouvrait puis refermait la liaison A2DP, et c'est exactement
  // ce cycle qui faisait planter le firmware Bluetooth (lecon du 08/08).
  // Ici la liaison est ouverte une fois puis tenue : au repos, plus un seul
  // cycle. C'est pour ca que l'anti-veille par salves reste desactive.
  //
  // BlueALSA n'accepte qu'un client a la fois : la veilleuse doit rendre le
  // haut-parleur des que le robot parle (_drain) ou passe en conversation
  // directe (parole.js, via pauseVeilleuse appele depuis robot.js).
  demarrerVeilleuse() {
    if (!this.veilleuseActive || this._veilleuseVoulue) return;
    this._veilleuseVoulue = true;
    this.log(
      `TTS: veilleuse active (${this.veilleuseHz} Hz a ${Math.round(this.veilleuseVol * 100)} %) : ` +
      "l'enceinte ne se coupera plus toute seule."
    );
    this._planifierVeilleuse(3000);
  }

  arreterVeilleuse() {
    this._veilleuseVoulue = false;
    if (this._veilleuseTimer) { clearTimeout(this._veilleuseTimer); this._veilleuseTimer = null; }
    this._tuerVeilleuse();
  }

  // Rend le haut-parleur a quelqu'un d'autre. Imbricable : chaque pause doit
  // etre suivie d'une reprise (un compteur, pas un booleen — sinon la fin
  // d'une phrase relancerait la veilleuse en pleine conversation directe).
  pauseVeilleuse() {
    this._veilleusePauses++;
    if (this._veilleusePauses > 1) return;
    if (this._veilleuseTimer) { clearTimeout(this._veilleuseTimer); this._veilleuseTimer = null; }
    this._tuerVeilleuse();
  }

  reprendreVeilleuse() {
    if (this._veilleusePauses > 0) this._veilleusePauses--;
    if (this._veilleusePauses > 0) return;
    // Petit delai : BlueALSA doit avoir rendu le PCM du lecteur precedent,
    // sinon la veilleuse repart aussitot sur "Device or resource busy".
    this._planifierVeilleuse(800);
  }

  // L'enceinte vient de repondre : inutile d'attendre la fin du recul.
  _veilleuseMaintenant() {
    if (!this._veilleuseVoulue) return;
    this._veilleuseAttente = 5000;
    this._planifierVeilleuse(1000);
  }

  _tuerVeilleuse() {
    if (!this._veilleuse) return;
    const p = this._veilleuse;
    this._veilleuse = null;
    // Marque l'arret comme VOULU : sans ca, le gestionnaire 'close' ci-dessous
    // prenait notre propre SIGKILL pour une panne et ecrivait "veilleuse
    // impossible, enceinte absente" a chaque phrase prononcee. Un journal qui
    // ment sur la cause coute plus cher qu'il n'y parait.
    p._arretVoulu = true;
    try { p.kill('SIGKILL'); } catch {}
  }

  _planifierVeilleuse(delaiMs) {
    if (!this.veilleuseActive || !this._veilleuseVoulue) return;
    if (this._veilleusePauses > 0 || this._veilleuse || this._veilleuseTimer) return;
    this._veilleuseTimer = setTimeout(() => {
      this._veilleuseTimer = null;
      this._lancerVeilleuse();
    }, Math.max(0, delaiMs));
    if (this._veilleuseTimer.unref) this._veilleuseTimer.unref();
  }

  _lancerVeilleuse() {
    if (!this._veilleuseVoulue || this._veilleusePauses > 0 || this._veilleuse) return;
    let p;
    try {
      p = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi',
        // Sans "duration", le generateur tourne tant qu'on le laisse vivre.
        '-i', `sine=frequency=${this.veilleuseHz}:sample_rate=44100`,
        '-af', `volume=${this.veilleuseVol}`,
        '-ac', '2',
        '-f', 'alsa',
        this.playDevice,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      this._veilleuseKo = true;
      this._veilleuseAttente = Math.min(this._veilleuseAttente * 2, 60000);
      this._planifierVeilleuse(this._veilleuseAttente);
      return;
    }
    this._veilleuse = p;
    const debut = Date.now();
    let err = '';
    p.stderr.on('data', (d) => { err += String(d); });
    // Tenir 5 s = le flux est reellement etabli. C'est le seul signal de
    // succes disponible : ffmpeg ne dit rien quand tout va bien.
    const okTimer = setTimeout(() => {
      if (this._veilleuse !== p) return;
      if (this._veilleuseKo) this.log('TTS: veilleuse en place.');
      this._veilleuseKo = false;
      this._veilleuseAttente = 5000;
    }, 5000);
    if (okTimer.unref) okTimer.unref();
    p.on('error', () => {}); // traite dans 'close'
    p.on('close', () => {
      clearTimeout(okTimer);
      if (this._veilleuse === p) this._veilleuse = null;
      if (Date.now() - debut > 30000) {
        // Elle avait pris : la coupure vient de l'enceinte (eteinte a la main,
        // sortie de portee). On repart vite.
        this._veilleuseAttente = 5000;
      } else if (p._arretVoulu) {
        // On l'a arretee nous-memes pour laisser parler le robot : rien a
        // signaler, et surtout pas de recul progressif a appliquer.
        this._veilleuseAttente = 5000;
      } else {
        // Echec immediat : enceinte absente. On espace jusqu'a une minute pour
        // ne pas harceler BlueALSA, et on ne le dit qu'une fois.
        if (!this._veilleuseKo) {
          this._veilleuseKo = true;
          this.log(`TTS: veilleuse impossible pour l'instant (${err.trim().slice(0, 120) || 'enceinte absente'}).`);
        }
        this._veilleuseAttente = Math.min(this._veilleuseAttente * 2, 60000);
      }
      this._planifierVeilleuse(this._veilleuseAttente);
    });
  }

  _keepaliveTick() {
    if (this.busy || this.queue.length) return; // deja du son en cours
    this.queue.push({ type: 'keepalive' });
    this._drain();
  }

  async _keepaliveOne() {
    const f = await this._silenceFile();
    if (!f) return;
    await this._playFile(f, 15000); // silencieux : pas de log si tout va bien
  }

  async _testToneOne() {
    const f = path.join(os.tmpdir(), `ping-test-tone-${process.pid}-${Date.now()}.wav`);
    const gen = await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=3',
      '-af', 'volume=0.25',
      '-ac', '2',
      '-c:a', 'pcm_s16le',
      f,
    ], 10000);
    if (gen.code !== 0) {
      this.log(`TTS: generation test audio echouee ${(gen.err || gen.stderr || '').trim()}`);
      return;
    }
    const played = await this._playFile(f, 15000);
    if (played.code !== 0) {
      this.log(`TTS: test audio echoue dev=${this.playDevice} ${(played.err || played.stderr || '').trim()}`);
    } else {
      this.log('TTS: test audio ok.');
    }
    fs.unlink(f, () => {});
  }

  // Decode le clip (ffmpeg) en wav avec le silence d'amorce, puis le joue.
  // Lecture ENCHAINEE : ffmpeg decode et envoie directement dans aplay, sans
  // passer par un fichier wav intermediaire. Le son demarre des les premiers
  // octets decodes au lieu d'attendre la fin de la conversion (~4 s de gagne
  // sur un clip de 5 s, mesure sur le Pi 3).
  _playClipPiped(src, timeoutMs = 60000) {
    return new Promise((resolve) => {
      const filtres = [`adelay=${this.prerollMs}:all=1`, 'aresample=async=1000:first_pts=0'];
      if (this.gain && this.gain !== 1) filtres.push(`volume=${this.gain}`, 'alimiter=limit=0.95');
      const dec = spawn('ffmpeg', [
        '-loglevel', 'error', '-i', src, '-vn',
        '-af', filtres.join(','),
        '-ac', '2', '-ar', '44100', '-f', 'wav', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const play = spawn('aplay', this._aplayArgs('-', true), {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let err = '';
      let termine = false;
      let timer = null;
      const finir = (code, message = '') => {
        if (termine) return;
        termine = true;
        if (timer) clearTimeout(timer);
        if (message) err += `${err ? ' ' : ''}${message}`;
        try { dec.stdout.unpipe(play.stdin); } catch {}
        try { if (!dec.killed) dec.kill('SIGKILL'); } catch {}
        try { if (!play.killed) play.kill('SIGKILL'); } catch {}
        resolve({ code, stderr: err });
      };
      dec.stderr.on('data', (d) => (err += d));
      play.stderr.on('data', (d) => (err += d));
      // Si la cle Bluetooth tombe pendant la lecture, aplay ferme son entree.
      // Sans gestionnaire, Node recoit EPIPE sur ce tube et tue tout le robot,
      // y compris le micro WebRTC. Ici la lecture seule echoue proprement.
      dec.stdout.on('error', (e) => finir(1, `ffmpeg stdout: ${e.message}`));
      play.stdin.on('error', (e) => finir(1, `aplay stdin: ${e.message}`));
      dec.on('error', (e) => finir(1, `ffmpeg: ${e.message}`));
      play.on('error', (e) => finir(1, `aplay: ${e.message}`));
      play.on('close', (code) => {
        finir(code === null ? 1 : code);
      });
      timer = setTimeout(() => finir(1, `timeout ${timeoutMs}ms`), timeoutMs);
      dec.stdout.pipe(play.stdin);
    });
  }

  async _playClipOne({ buf, ext }) {
    await this._ensureVolume();
    const base = path.join(os.tmpdir(), `ping-voice-${process.pid}-${Date.now()}`);
    const src = `${base}.${ext}`;
    const wav = `${base}.wav`;
    try {
      fs.writeFileSync(src, buf);
    } catch (e) {
      this.log('Talkie: ecriture du clip echouee', e.message);
      return;
    }

    // Chemin rapide : decodage et lecture en meme temps.
    const t0Rapide = Date.now();
    const direct = await this._playClipPiped(src);
    if (direct.code === 0) {
      this.log(`Talkie: lecture directe ok (${Date.now() - t0Rapide} ms).`);
      fs.unlink(src, () => {});
      return;
    }
    // Repli sur l'ancienne methode (fichier intermediaire) si le tube echoue,
    // notamment quand l'enceinte a decroche et qu'il faut la reconnecter.
    this.log('Talkie: lecture directe impossible, methode classique.');
    const dec = await this._renderPlayableWav(src, wav, this.prerollMs, 15000);
    if (dec.code !== 0) {
      this.log(`Talkie: decodage echoue ${(dec.err || dec.stderr || '').trim()}`);
      fs.unlink(src, () => {});
      fs.unlink(wav, () => {});
      return;
    }
    if (this.keepLastClip) {
      try {
        fs.copyFileSync(src, path.join(os.tmpdir(), `ping-last-voice.${ext}`));
        fs.copyFileSync(wav, path.join(os.tmpdir(), 'ping-last-voice.wav'));
        this.log(`Talkie: diagnostic garde dans ${path.join(os.tmpdir(), `ping-last-voice.${ext}`)} et ${path.join(os.tmpdir(), 'ping-last-voice.wav')}`);
      } catch (e) {
        this.log('Talkie: diagnostic fichier non garde', e.message);
      }
    }
    const t0 = Date.now();
    const played = await this._playFile(wav, 60000);
    if (played.code !== 0) {
      this.log(`Talkie: lecture echouee dev=${this.playDevice} ${(played.err || played.stderr || '').trim()}`);
    } else {
      this.log(`Talkie: lecture ok (${Date.now() - t0} ms).`);
    }
    fs.unlink(src, () => {});
    fs.unlink(wav, () => {});
  }

  // La JBL remet parfois son volume A2DP a 0 quand elle se rendort ou se
  // reconnecte -> aplay "joue" mais en silence. On force donc le volume
  // BlueALSA a 100% avant chaque phrase.
  async _ensureVolume() {
    if (!this.playDevice.startsWith('bluealsa')) return;
    const list = await run('amixer', ['-D', 'bluealsa', 'scontrols'], 5000);
    if (list.code !== 0) {
      this.log(`TTS: mixer bluealsa indisponible (${(list.err || list.stderr || '').trim()})`);
      return;
    }
    const line = list.stdout.split('\n').find((l) => l.includes('A2DP')) ||
      list.stdout.split('\n')[0] || '';
    const m = line.match(/'([^']+)'/);
    if (!m) return;
    const set = await run('amixer', ['-D', 'bluealsa', 'sset', m[1], '100%', 'unmute'], 5000);
    if (set.code !== 0) {
      this.log(`TTS: volume non applique sur '${m[1]}' (${(set.err || set.stderr || '').trim()})`);
    } else if (!this._volLogged) {
      this._volLogged = true;
      this.log(`TTS: volume A2DP force a 100% ('${m[1]}').`);
    }
  }

  async _speakOne(text) {
    const engine = await this._resolveEngine();
    if (engine === 'none') {
      this.log('TTS: aucun moteur installe (sudo apt install espeak-ng).');
      return;
    }

    await this._ensureVolume();

    const base = path.join(os.tmpdir(), `ping-tts-${process.pid}-${Date.now()}`);
    const wav = `${base}.wav`;

    const synth = engine === 'pico'
      ? await run('pico2wave', ['-l', this.lang, '-w', wav, text], 10000)
      // -a : amplitude de la voix (100 = defaut, 200 = maximum d'espeak-ng).
      : await run('espeak-ng', ['-v', this._langEspeak(), '-a', String(this.amplitude), '-w', wav, text], 10000);

    if (synth.code !== 0) {
      this.log(`TTS: synthese echouee (${engine}) ${(synth.err || synth.stderr || '').trim()}`);
      fs.unlink(wav, () => {});
      return;
    }

    // Colle un silence devant la phrase (reveil de l'enceinte Bluetooth) via
    // ffmpeg. Si ffmpeg echoue/absent, on joue le wav brut sans bloquer.
    let toPlay = wav;
    let padded = null;
    if (this.prerollMs > 0) {
      padded = `${base}-pad.wav`;
      const pad = await this._renderPlayableWav(wav, padded, this.prerollMs, 10000);
      if (pad.code === 0) {
        toPlay = padded;
      } else {
        this.log(`TTS: silence d'amorce ignore (ffmpeg ${pad.code}).`);
        padded = null;
      }
    }

    const t0 = Date.now();
    const played = await this._playFile(toPlay, 30000);
    if (played.code !== 0) {
      this.log(`TTS: lecture echouee dev=${this.playDevice} ${(played.err || played.stderr || '').trim()}`);
    } else {
      this.log(`TTS: lecture ok (${Date.now() - t0} ms).`);
    }
    fs.unlink(wav, () => {});
    if (padded) fs.unlink(padded, () => {});
  }
}

module.exports = { Tts };
