// camera.js - Capture d'une (ou deux) webcam USB (UVC) via ffmpeg.
// Deux sorties simultanees depuis UNE seule capture :
//  1. (si rtspUrl fourni) H.264 pousse en RTSP vers MediaMTX sur le VPS ;
//     l'app le lit ensuite en WebRTC (latence basse, vraie video fluide).
//     L'encodeur est choisi selon la machine (_encodeurH264) : circuit
//     MATERIEL sur Pi 3/4 (h264_v4l2m2m, CPU quasi nul), LOGICIEL sur Pi 5
//     qui n'a plus d'encodeur H.264 (libx264 ; mesure du 03/08 sur andypi2 :
//     640x360@15 encode a 9,7x le temps reel, ~10% d'un coeur).
//  2. MJPEG sur pipe:1, decoupe image par image vers onFrame(buffer) : sert
//     aux photos et de secours si le WebRTC ne passe pas. En mode 'single'
//     c'est une COPIE du MJPEG natif de la webcam (zero encodage) ; robot.js
//     choisit ensuite la cadence d'envoi (tri en JS, gratuit).
// En mode 'both' (double camera avant+arriere), ffmpeg decode les deux flux,
// les colle cote a cote (70% avant / 30% arriere) puis encode les deux
// sorties ; fps reduit pour menager le CPU du Pi 3.
'use strict';

const { spawn, spawnSync, exec } = require('child_process');
const fs = require('fs');

const SOI = Buffer.from([0xff, 0xd8]); // debut d'une image JPEG
const EOI = Buffer.from([0xff, 0xd9]); // fin d'une image JPEG

class Camera {
  constructor({
    device,
    deviceRear,
    width,
    height,
    fps,
    quality,
    log,
    onFrame,
    splitPct,
    compositeFps,
    rtspUrl,
    rtcFps,
    rtcBitrate,
    audioDevice,
    rtcAudio,
    audioBitrate,
  } = {}) {
    this.device = device || '/dev/video0';
    this.deviceRear = deviceRear || '/dev/video2';
    this.width = width || 640;
    this.height = height || 480;
    this.fps = fps || 6;
    this.quality = quality || 8; // 2 (meilleur, + lourd) .. 31 (pire, + leger)
    // En composite le Pi encode -> on limite le fps pour menager le CPU du Pi 3.
    this.compositeFps = compositeFps || 8;
    // Part de largeur de la camera AVANT dans l'image combinee (0.7 = 70%).
    this.splitPct = splitPct || 0.7;
    this.mode = 'single'; // 'single' (this.device) | 'both' (avant+arriere)
    // WebRTC : URL de publication RTSP vers MediaMTX (vide = MJPEG seul).
    this.rtspUrl = rtspUrl || '';
    this.rtcFps = rtcFps || 20;
    this.rtcBitrate = rtcBitrate || '1200k';
    // Micro du robot dans le meme flux (piste Opus ~32 kb/s, lue par l'app
    // dans la meme connexion WebRTC que la video). Si le micro fait planter
    // ffmpeg (absent/occupe), on retente automatiquement en video seule.
    this.audioDevice = audioDevice || '';
    this.rtcAudio = !!rtcAudio;
    this.audioBitrate = audioBitrate || '48k';
    this._audioGaveUp = false;
    // Si la publication H.264 echoue en boucle (4G en vrac, VPS injoignable),
    // on passe en MJPEG seul pendant 90s puis on RETENTE tout seul : la cle
    // 4G du robot a des absences passageres et se remet sans aide.
    this._rtcFails = 0;
    this._rtcGaveUpAt = 0;
    this._rtcRetryTimer = null;
    // Chien de garde de la publication : la 4G du robot avale parfois une
    // connexion en silence (rotation d'IP de la cle) et le muxer RTSP de
    // ffmpeg 7 reste alors bloque dans son thread SANS erreur, pendant que le
    // MJPEG continue. On verifie donc regulierement avec `ss` qu'une
    // connexion TCP ETABLIE existe bien vers MediaMTX ; sinon on relance.
    this._rtcHost = null;
    this._rtcPort = null;
    if (this.rtspUrl) {
      try {
        const u = new URL(this.rtspUrl);
        this._rtcHost = u.hostname;
        this._rtcPort = u.port || '554';
      } catch {}
    }
    this._rtcStalls = 0;
    this._watchTimer = null;
    this._watchGraceUntil = 0;
    this.log = log || console.log;
    this.onFrame = onFrame || (() => {});
    this.proc = null;
    this.streaming = false;
    this.buf = Buffer.alloc(0);
    this._sawFrame = false;
    this._startedAt = 0;
    this._relanceTimer = null; // une seule relance programmee a la fois
  }

  // La sortie H.264/RTSP est active si configuree et pas en pause apres echecs.
  _rtcOn() {
    if (!this.rtspUrl) return false;
    return !(this._rtcGaveUpAt && Date.now() - this._rtcGaveUpAt < 90000);
  }

  // Pause H.264 (90s) + re-tentative automatique si la camera filme toujours.
  _rtcGiveUp() {
    this._rtcGaveUpAt = Date.now();
    this._rtcStalls = 0;
    this._rtcFails = 0;
    this.log('Camera: publication H.264 en echec -> MJPEG seul, nouvelle tentative dans 90s.');
    if (this._rtcRetryTimer) clearTimeout(this._rtcRetryTimer);
    this._rtcRetryTimer = setTimeout(() => {
      this._rtcRetryTimer = null;
      if (this.streaming && this.rtspUrl) {
        this.log('Camera: nouvelle tentative de publication H.264.');
        this._restart();
      }
    }, 92000);
  }

  _startWatchdog() {
    this._stopWatchdog();
    if (!this._rtcOn() || !this._rtcHost) return;
    // Laisse le temps a ffmpeg de demarrer et de se connecter avant le 1er controle.
    this._watchGraceUntil = Date.now() + 12000;
    this._watchTimer = setInterval(() => this._checkRtcLink(), 8000);
  }

  _stopWatchdog() {
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
  }

  _checkRtcLink() {
    if (!this.streaming || !this._rtcOn()) return;
    if (Date.now() < this._watchGraceUntil) return;
    exec(
      `ss -Htn state established "dst ${this._rtcHost} and dport = ${this._rtcPort}"`,
      { timeout: 5000 },
      (err, stdout) => {
        if (!this.streaming || !this._rtcOn()) return;
        if (err || (stdout && stdout.trim())) {
          // Connexion presente (ou `ss` indisponible : on ne juge pas).
          if (!err) this._rtcStalls = 0;
          return;
        }
        this._rtcStalls++;
        this.log(`Camera: publication H.264 muette (aucune connexion RTSP etablie, essai ${this._rtcStalls}/3) -> relance ffmpeg.`);
        if (this._rtcStalls >= 3) this._rtcGiveUp();
        this._restart();
      }
    );
  }

  // Le micro part-il dans le flux WebRTC ?
  _rtcAudioOn() {
    return this.rtcAudio && !!this.audioDevice && !this._audioGaveUp;
  }

  // Entree ALSA du micro (a placer AVANT les -map). 48 kHz mono = ce
  // qu'Opus attend ; plughw convertit si la carte ne sait pas faire.
  // use_wallclock : meme horloge que la video -> le muxer peut entrelacer
  // sans attendre (sinon ~2s de retard audio constate).
  _audioIn() {
    return [
      '-f', 'alsa', '-thread_queue_size', '1024',
      '-use_wallclock_as_timestamps', '1',
      '-ar', '48000', '-ac', '1', '-i', this.audioDevice,
    ];
  }

  // Arguments de la sortie H.264 : encodeur MATERIEL du Pi, reglages basse
  // latence (pas de B-frames, image cle toutes les ~1s pour un demarrage
  // rapide de la lecture WebRTC), pousse en RTSP/TCP (fiable en 4G).
  // ATTENTION : ne PAS mettre '-timeout' ici — sur le muxer RTSP cette
  // option fait passer ffmpeg en mode ECOUTE (il attend une connexion au
  // lieu de publier, sans erreur ni socket sortant). Les blocages
  // silencieux sont geres par le chien de garde `ss` (_checkRtcLink).
  // Encodeur H.264 disponible sur CETTE machine.
  // Le Pi 3/4 possede un encodeur MATERIEL (h264_v4l2m2m, CPU quasi nul).
  // Le Pi 5 ne l'a PLUS : Raspberry l'a supprime. Sans ce test, ffmpeg
  // echouait en boucle sur Pi 5 et l'emballement des relances faisait
  // redemarrer la machine (constate le 03/08).
  _encodeurH264() {
    if (this._encH264) return this._encH264;
    // NE PAS se fier a `ffmpeg -encoders` : h264_v4l2m2m n'est qu'un wrapper
    // V4L2 compile d'office dans le ffmpeg Debian. Il est LISTE sur Pi 5 alors
    // qu'aucun encodeur materiel n'existe -> ffmpeg echoue ensuite a chaque
    // demarrage de flux (verifie le 03/08 sur andypi2).
    // Seule preuve fiable : le peripherique d'encodage expose par le noyau.
    //   Pi 3/4 : bcm2835-codec-encode  (=> materiel, CPU quasi nul)
    //   Pi 5   : rpi-hevc-dec + pispbe-* seulement (decodage et ISP)
    this._encH264 = 'libx264';
    try {
      const base = '/sys/class/video4linux';
      for (const d of fs.readdirSync(base)) {
        const nom = fs.readFileSync(`${base}/${d}/name`, 'utf8');
        if (/codec-encode/i.test(nom)) {
          this._encH264 = 'h264_v4l2m2m';
          break;
        }
      }
    } catch {
      // Pas de /sys (machine non-Pi) : l'encodage logiciel marche partout.
    }
    if (this._encH264 === 'libx264') {
      this.log('Camera: pas d encodeur materiel -> encodage logiciel (libx264).');
    }
    return this._encH264;
  }

  _h264Out(fps) {
    const enc = this._encodeurH264();
    if (enc === 'libx264') {
      // Encodage logiciel : reglages basse latence. Le processeur du Pi 5
      // avale ca sans effort a 640x360.
      return [
        '-c:v', 'libx264',
        '-preset', 'veryfast', '-tune', 'zerolatency',
        '-profile:v', 'baseline',
        '-b:v', this.rtcBitrate,
        '-maxrate', this.rtcBitrate, '-bufsize', this.rtcBitrate,
        '-g', String(fps), '-bf', '0', '-pix_fmt', 'yuv420p',
        '-f', 'rtsp', '-rtsp_transport', 'tcp', this.rtspUrl,
      ];
    }
    return [
      '-c:v', 'h264_v4l2m2m',
      '-b:v', this.rtcBitrate,
      // Profil H.264 "baseline" = le plus compatible (decodage telephone).
      // En NUMERIQUE (66) : ffmpeg 7 ne connait pas les noms de profils pour
      // h264_v4l2m2m ("Unable to parse option value 'baseline'").
      '-profile:v', '66',
      '-g', String(fps),
      '-bf', '0',
      '-pix_fmt', 'yuv420p',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', this.rtspUrl,
    ];
  }

  // Sortie micro : publication RTSP SEPAREE (chemin <path>-audio). Un tuyau
  // TCP a part : les paquets audio (20 ms) ne font plus la queue derriere
  // les rafales video (images cles) — c'est CA qui creait ~2s de retard.
  _opusOut(audioIdx) {
    return [
      '-map', `${audioIdx}:a`,
      // 'audio' et non 'voip' : le mode voip filtre agressivement pour ne
      // garder que la parole (bande passante reduite, son etouffe). 'audio'
      // restitue toute l'ambiance. Debit monte a 48k : la difference est
      // nette, et ca reste negligeable a cote de la video.
      '-c:a', 'libopus', '-b:a', this.audioBitrate, '-application', 'audio',
      '-vbr', 'on', '-frame_duration', '20',
      '-packet_loss', '10', '-fec', '1',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', `${this.rtspUrl}-audio`,
    ];
  }

  _buildArgs() {
    const common = [
      '-loglevel', 'error',
      // Basse latence : pas de mise en tampon ni d'analyse prealable du flux,
      // chaque image sort de ffmpeg des qu'elle est capturee.
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
    ];
    const rtc = this._rtcOn();

    if (this.mode === 'both') {
      const fps = this.compositeFps;
      // Largeur de l'avant (arrondie a un nombre pair, exige par le JPEG).
      let wl = Math.round((this.width * this.splitPct) / 2) * 2;
      wl = Math.max(2, Math.min(this.width - 2, wl));
      const wr = this.width - wl;
      const inputs = [
        '-f', 'v4l2', '-input_format', 'mjpeg', '-framerate', String(fps),
        '-use_wallclock_as_timestamps', '1',
        '-video_size', `${this.width}x${this.height}`, '-i', this.device,
        '-f', 'v4l2', '-input_format', 'mjpeg', '-framerate', String(fps),
        '-use_wallclock_as_timestamps', '1',
        '-video_size', `${this.width}x${this.height}`, '-i', this.deviceRear,
      ];
      // Avant a gauche (70%), arriere a droite (30%), meme hauteur -> hstack.
      const mosaic = `[0:v]scale=${wl}:${this.height}[l];[1:v]scale=${wr}:${this.height}[r];[l][r]hstack=inputs=2`;
      if (rtc) {
        const audio = this._rtcAudioOn();
        return [
          ...common, ...inputs,
          ...(audio ? this._audioIn() : []), // le micro = entree n°2
          // L'image combinee part vers les DEUX sorties (split).
          '-filter_complex', `${mosaic},format=yuv420p,split=2[va][vb]`,
          '-map', '[va]', ...this._h264Out(fps),
          ...(audio ? this._opusOut(2) : []),
          '-map', '[vb]',
          '-f', 'mjpeg', '-q:v', String(this.quality), '-flush_packets', '1', 'pipe:1',
        ];
      }
      return [
        ...common, ...inputs,
        '-filter_complex', `${mosaic}[v]`,
        '-map', '[v]',
        '-f', 'mjpeg', '-q:v', String(this.quality), '-flush_packets', '1', 'pipe:1',
      ];
    }

    if (rtc) {
      // Mode simple + WebRTC : capture au fps du H.264 ; le MJPEG natif est
      // COPIE tel quel sur le pipe (zero encodage), robot.js choisit ensuite
      // combien de ces images partent sur le socket.
      const audio = this._rtcAudioOn();
      return [
        ...common,
        '-f', 'v4l2', '-input_format', 'mjpeg', '-framerate', String(this.rtcFps),
        '-use_wallclock_as_timestamps', '1',
        '-video_size', `${this.width}x${this.height}`, '-i', this.device,
        ...(audio ? this._audioIn() : []), // le micro = entree n°1
        '-map', '0:v', ...this._h264Out(this.rtcFps),
        ...(audio ? this._opusOut(1) : []),
        '-map', '0:v', '-c:v', 'copy', '-f', 'mjpeg', '-flush_packets', '1', 'pipe:1',
      ];
    }

    // Mode simple : passthrough MJPEG natif (aucun encodage).
    return [
      ...common,
      '-f', 'v4l2', '-input_format', 'mjpeg', '-framerate', String(this.fps),
      '-video_size', `${this.width}x${this.height}`, '-i', this.device,
      '-f', 'mjpeg', '-q:v', String(this.quality), '-flush_packets', '1', 'pipe:1',
    ];
  }

  // UNE SEULE relance en vol. Le garde-fou "une par seconde" mesurait le temps
  // depuis le dernier lancement, mais n'empechait pas d'ARMER plusieurs
  // minuteurs : chaque ffmpeg qui mourait armait le sien, et un start() venu de
  // l'app pendant qu'un minuteur dormait ajoutait encore une chaine. Comme
  // ffmpeg meurt en quelques ms quand la webcam est absente, chaque chaine
  // repartait aussitot -> plusieurs cycles complets dans la meme seconde
  // (constate le 03/08 sur andypi2, webcam debranchee).
  _planifierRelance(ms) {
    if (this._relanceTimer) return;
    this._relanceTimer = setTimeout(() => {
      this._relanceTimer = null;
      this.start();
    }, ms);
  }

  // --- Reglages du capteur pour la vision de nuit ---
  //
  // Mesure du 24/09/2026 sur l'Innomaker : le gain etait a 64 sur 128 (la
  // moitie de sa sensibilite) et exposure_dynamic_framerate a 0, ce qui
  // interdit au capteur d'allonger sa pose quand il fait sombre. Autrement
  // dit la camera voyait mal la nuit surtout parce qu'on ne lui demandait
  // pas de faire mieux.
  //
  // Ces reglages vivent dans le pilote USB, PAS dans ffmpeg : ils sont perdus
  // a chaque redemarrage du Pi. D'ou leur application ici, juste avant chaque
  // lancement de capture.
  //
  // Tout est reglable par variable d'environnement, et CAM_TUNE=false rend
  // la main au pilote si un reglage se revele contre-productif.
  _appliquerReglages() {
    if (String(process.env.CAM_TUNE || 'true').toLowerCase() !== 'true') return;
    // Correction du 24/09/2026 : la premiere version poussait gain=128,
    // brightness=16 ET backlight_compensation=1 en meme temps. Resultat dans
    // une piece sombre, le centre de l'image virait au BLANC PUR — plus aucune
    // information, alors que l'ecran semblait "plus lumineux".
    //
    // La distinction qui compte : seul exposure_dynamic_framerate apporte de
    // la VRAIE lumiere (il autorise une pose plus longue). Le gain et la
    // luminosite ne font qu'amplifier ce que le capteur a deja capte — ils
    // amplifient donc aussi le bruit, et saturent les zones claires.
    //
    //   brightness  : decale toute l'image vers le haut -> ecrete le clair
    //   backlight   : surexpose DELIBEREMENT le centre -> pire ici
    //   gain        : a fond, il sature ce qui est deja trop clair
    const ctrls = [
      `gain=${Number(process.env.CAM_GAIN || 96)}`,
      `brightness=${Number(process.env.CAM_BRIGHTNESS || 0)}`,
      `exposure_dynamic_framerate=${Number(process.env.CAM_DYN_FPS || 1)}`,
      `backlight_compensation=${Number(process.env.CAM_BACKLIGHT || 0)}`,
    ];
    for (const dev of [this.device, this.mode === 'both' ? this.deviceRear : null]) {
      if (!dev) continue;
      // v4l2-ctl echoue sans bruit si un reglage n'existe pas sur ce capteur :
      // on ne veut surtout pas que ca empeche la camera de demarrer.
      const p = spawnSync('v4l2-ctl', ['-d', dev, ...ctrls.map((c) => `--set-ctrl=${c}`)], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      if (p.error) {
        this.log('Camera: v4l2-ctl indisponible, reglages du capteur ignores.');
        return;
      }
    }
    this.log(`Camera: capteur regle pour la faible lumiere (${ctrls.join(' ')}).`);
  }

  start() {
    if (this.streaming) return;
    // On demarre maintenant : une relance encore en attente ferait doublon.
    if (this._relanceTimer) {
      clearTimeout(this._relanceTimer);
      this._relanceTimer = null;
    }
    this.streaming = true;
    this._sawFrame = false;
    this._startedAt = Date.now();
    this._dernierLancement = Date.now();
    const args = this._buildArgs();
    const rtcTag = this._rtcOn()
      ? ` + H.264 ${this.rtcBitrate}${this._rtcAudioOn() ? ' + micro Opus' : ''} -> MediaMTX`
      : '';
    if (this.mode === 'both') {
      this.log(`Camera: composite AVANT(${this.device}) + ARRIERE(${this.deviceRear}) ${this.width}x${this.height}@${this.compositeFps} (q=${this.quality})${rtcTag}`);
    } else if (this._rtcOn()) {
      this.log(`Camera: ffmpeg ${this.device} ${this.width}x${this.height}@${this.rtcFps}${rtcTag}`);
    } else {
      this.log(`Camera: ffmpeg ${this.device} ${this.width}x${this.height}@${this.fps} (q=${this.quality})`);
    }
    // Avant ffmpeg : sinon le pilote reprend ses valeurs par defaut a
    // l'ouverture du peripherique et le reglage serait sans effet.
    this._appliquerReglages();

    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.streaming = false;
      this.log('Camera: impossible de lancer ffmpeg (installe-le: sudo apt install ffmpeg).', e.message);
      return;
    }
    this.proc = proc;
    proc.stdout.on('data', (chunk) => this._onData(chunk));
    proc.stderr.on('data', (d) => this.log('Camera ffmpeg:', String(d).trim()));
    proc.on('close', (code) => {
      this.log(`Camera: ffmpeg arrete (code=${code}).`);
      // Ne touche a l'etat que si c'est bien le process courant : lors d'un
      // redemarrage (reconfigure), l'ancien process se ferme APRES le nouveau.
      if (this.proc !== proc) return;
      this.proc = null;
      this.streaming = false;
      // Repli : si le composite meurt vite sans avoir sorti d'image (souvent la
      // camera arriere absente ou occupee), on revient a la seule camera avant
      // pour ne pas laisser l'ecran noir.
      if (this.mode === 'both' && !this._sawFrame && Date.now() - this._startedAt < 4000) {
        this.log('Camera: composite impossible (camera arriere absente ?) -> repli sur AVANT seule.');
        this.mode = 'single';
        this._planifierRelance(500);
        return;
      }
      // Repli WebRTC : si ffmpeg meurt vite en boucle avec la sortie RTSP
      // (MediaMTX injoignable, mauvais mot de passe...), on continue en MJPEG
      // seul pour ne pas priver l'app de toute image. Retente a la prochaine
      // session de visionnage (stop() remet le compteur a zero).
      // GARDE-FOU : jamais plus d'une relance par seconde. Sur Pi 5, ffmpeg
      // echouait instantanement (encodeur absent) et la boucle de reprise
      // enchainait les lancements jusqu'a faire redemarrer la machine.
      const depuisDernier = Date.now() - (this._dernierLancement || 0);
      if (depuisDernier < 1000) {
        this.log('Camera: relances trop rapprochees, pause de securite (3s).');
        this._planifierRelance(3000);
        return;
      }
      if (this._rtcOn() && Date.now() - this._startedAt < 8000) {
        // Premier reflexe : si le micro etait dans le flux, c'est peut-etre
        // lui qui plante (occupe/debranche) -> retente en video seule avant
        // de compter un echec H.264.
        if (this._rtcAudioOn()) {
          this._audioGaveUp = true;
          this.log('Camera: echec avec micro -> nouvelle tentative en video seule.');
          this._planifierRelance(700);
          return;
        }
        this._rtcFails++;
        if (this._rtcFails >= 3) this._rtcGiveUp();
        this._planifierRelance(700);
      }
    });
    proc.on('error', (e) => {
      this.log('Camera: erreur ffmpeg', e.message);
      if (this.proc === proc) this.streaming = false;
    });
    this._startWatchdog();
  }

  // Change le fps/la qualite a chaud. Si la camera filme, on relance ffmpeg
  // avec les nouveaux reglages (bref gel ~0.5s) ; sinon on met juste a jour
  // les valeurs pour le prochain demarrage.
  reconfigure({ fps, quality } = {}) {
    let changed = false;
    if (fps != null && fps !== this.fps) { this.fps = fps; changed = true; }
    if (quality != null && quality !== this.quality) { this.quality = quality; changed = true; }
    if (!changed || !this.streaming) return;
    // Avec la sortie H.264/RTSP active, on ne relance PAS ffmpeg : ca gelerait
    // la video WebRTC. La cadence des images de secours est deja triee en JS
    // par robot.js ; les nouvelles valeurs serviront au prochain demarrage.
    if (this._rtcOn()) return;

    this.log(`Camera: reconfiguration -> ${this.width}x${this.height}@${this.fps} (q=${this.quality}).`);
    this._restart();
  }

  // Change la vue : { mode:'single', device:'/dev/videoX' } pour une seule
  // camera, ou { mode:'both' } pour l'image combinee avant+arriere.
  setView({ mode, device } = {}) {
    let changed = false;
    if (mode && mode !== this.mode) { this.mode = mode; changed = true; }
    if (device && device !== this.device) { this.device = device; changed = true; }
    if (!changed) return;
    if (this.mode === 'both') this.log('Camera: vue -> composite 70/30 (avant+arriere).');
    else this.log(`Camera: vue -> ${this.device}.`);
    if (this.streaming) this._restart();
  }

  _restart() {
    this._stopWatchdog();
    const old = this.proc;
    this.proc = null; // detache l'ancien process pour neutraliser son handler 'close'
    if (old) {
      try { old.kill('SIGKILL'); } catch {}
    }
    this.buf = Buffer.alloc(0);
    this.streaming = false;
    // Petit delai : laisse l'OS liberer le peripherique avant de relancer ffmpeg.
    setTimeout(() => this.start(), 400);
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let start = this.buf.indexOf(SOI);
    let end = start === -1 ? -1 : this.buf.indexOf(EOI, start + 2);
    while (start !== -1 && end !== -1) {
      this._sawFrame = true;
      this.onFrame(this.buf.slice(start, end + 2));
      this.buf = this.buf.slice(end + 2);
      start = this.buf.indexOf(SOI);
      end = start === -1 ? -1 : this.buf.indexOf(EOI, start + 2);
    }
    // Anti-fuite memoire si jamais le flux est invalide (pas de marqueur de fin).
    if (this.buf.length > 5 * 1024 * 1024) this.buf = Buffer.alloc(0);
  }

  stop() {
    this.streaming = false;
    this._stopWatchdog();
    if (this._relanceTimer) {
      clearTimeout(this._relanceTimer);
      this._relanceTimer = null;
    }
    // Nouvelle session de visionnage = nouvelle chance pour le H.264/RTSP
    // (et pour le micro).
    this._rtcFails = 0;
    this._rtcGaveUpAt = 0;
    this._rtcStalls = 0;
    this._audioGaveUp = false;
    if (this._rtcRetryTimer) {
      clearTimeout(this._rtcRetryTimer);
      this._rtcRetryTimer = null;
    }
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {}
      this.proc = null;
    }
    this.buf = Buffer.alloc(0);
  }
}

module.exports = { Camera };
