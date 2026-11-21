// robot.js - Client robot Ping pour Raspberry Pi
// Compatible avec le sketch Arduino V3/L298N:
//   robot/arduino/robot_motors/robot_motors.ino
//   robot/arduino/elegoo_final_robot_motors/elegoo_final_robot_motors.ino
// Mapping Elegoo V3: ENA D5, IN1 D7, IN2 D8, ENB D6, IN3 D9, IN4 D11.
//
// Lancement conseille:
//   CODE=toncode node robot.js
//
// Ports par defaut:
//   GPS      -> /dev/ttyACM1
//   Arduino  -> /dev/ttyACM0

'use strict';

const readline = require('readline');
const { io } = require('socket.io-client');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { Arduino } = require('./arduino');
const { Navigator, bearing } = require('./navigation');
const { Ronde } = require('./ronde');
// TAUX vient de micro.js pour qu'il n'existe qu'UNE definition de la frequence
// attendue par la Realtime : le micro embarque et le flux du telephone doivent
// arriver au meme format, sinon la voix part trop vite ou trop lentement.
const { Micro, TAUX: RT_TAUX } = require('./micro');
const { Parole } = require('./parole');
const { Camera } = require('./camera');
const { Audio } = require('./audio');
const { Voice } = require('./voice');
const { Tts } = require('./tts');
const { CanalCapteur } = require('./capteur');

// Les numeros ALSA (card 0, card 1...) changent selon l'ordre de detection des
// peripheriques USB ; on vise donc la carte par son NOM, stable au rebranchement.
//
// 19/08 : passage a un micro USB dedie (C-Media USB PnP Sound Device), qui se
// presente sous le nom ALSA "Device". Auparavant on utilisait le micro integre
// de la camera Innomaker ("InnomakerU20CAM"), d'ou l'ancien defaut.
//
// AUDIO_CARD dans le service reste prioritaire : c'est lui qu'il faut changer
// le jour ou le micro change encore, pas cette ligne.
const ROBOT_MIC_CARD = /^[A-Za-z0-9_-]+$/.test(process.env.AUDIO_CARD || '')
  ? process.env.AUDIO_CARD
  : 'Device';

function sharedRobotMicDevice() {
  const configured = String(process.env.AUDIO_DEVICE || process.env.VOICE_DEVICE || '').trim();
  // Anciennes installations : micplug et plughw:0,0 pouvaient viser
  // l'Innomaker apres un rebranchement. On les remplace par le nom stable.
  const unstable =
    !configured ||
    configured.toLowerCase() === 'micplug' ||
    /^(?:plug)?hw:\d+(?:,\d+)?$/i.test(configured);
  if (unstable) return `plug:'dsnoop:CARD=${ROBOT_MIC_CARD},DEV=0'`;
  return configured;
}

const ROBOT_MIC_DEVICE = sharedRobotMicDevice();

const CONFIG = {
  SERVER_URL: process.env.SERVER_URL || 'http://<ip-serveur>:3000',
  // Nom affiche dans l'app et dans les messages d'appairage. C'est aussi le
  // nom que l'assistant vocal se donne (voir SYSTEM_PROMPT cote serveur).
  PSEUDO: process.env.PSEUDO || 'Solana',
  CODE: process.env.CODE || process.argv[2] || '',

  GPS_PORT: process.env.GPS_PORT || '/dev/ttyACM1',
  GPS_BAUD: Number(process.env.GPS_BAUD || 9600),
  GPS_ENABLE: String(process.env.GPS_ENABLE || '').toLowerCase() === 'true',

  ARDUINO_PORT: process.env.ARDUINO_PORT || '/dev/ttyACM0',
  ARDUINO_BAUD: Number(process.env.ARDUINO_BAUD || 9600),

  AUTO_ACCEPT: String(process.env.AUTO_ACCEPT || '').toLowerCase() === 'true',
  NAV_ENABLE: String(process.env.NAV_ENABLE || '').toLowerCase() === 'true',
  // Boussole désactivée par défaut. Active avec COMPASS_ENABLE=true.
  COMPASS_ENABLE: String(process.env.COMPASS_ENABLE || '').toLowerCase() === 'true',

  SHARE_INTERVAL_MS: Number(process.env.SHARE_INTERVAL_MS || 5000),
  ROBOT_STATUS_INTERVAL_MS: Number(process.env.ROBOT_STATUS_INTERVAL_MS || 10000),
  ROBOT_HEARTBEAT_MS: Number(process.env.ROBOT_HEARTBEAT_MS || 30000),
  ROBOT_DEBUG_LOGS: String(process.env.ROBOT_DEBUG_LOGS || '').toLowerCase() === 'true',
  ARRIVAL_RADIUS_M: Number(process.env.ARRIVAL_RADIUS_M || 3),
  // Réglages adaptés aux pivots rapides de l'Elegoo (recale souvent, tolérance large = part droit plus tôt)
  NAV_TICK_MS: Number(process.env.NAV_TICK_MS || 350),
  NAV_ANGLE_TOL: Number(process.env.NAV_ANGLE_TOL || 25),
  NAV_OSCILLATION_TOL: Number(process.env.NAV_OSCILLATION_TOL || 50),
  NAV_GPS_MEASURE_TICKS: Number(process.env.NAV_GPS_MEASURE_TICKS || 3),
  NAV_MIN_SPEED_KNOTS: Number(process.env.NAV_MIN_SPEED_KNOTS || 0.5),
  OBSTACLE_STOP_CM: Number(process.env.OBSTACLE_STOP_CM || 25),

  // Camera (webcam USB). Le robot ne filme que quand l'app le demande.
  CAMERA_ENABLE: String(process.env.CAMERA_ENABLE || 'true').toLowerCase() === 'true',
  // Chemins STABLES (/dev/v4l/by-id/...) : ils portent le modele de la camera
  // et ne bougent pas. Les /dev/videoN, eux, changent selon l'ordre de
  // branchement — un simple debranchement a inverse video0 et video2 le
  // 02/08, et l'IA s'est mise a regarder par la mauvaise camera.
  // AVANT = l'Innomaker (c'est aussi elle qui porte le micro de l'assistant).
  CAMERA_DEVICE:
    process.env.CAMERA_DEVICE ||
    '/dev/v4l/by-id/usb-InnoMaker_Innomaker-U20CAM-1080PD_N-S1_20010101-video-index0',
  // ARRIERE = la Webcam ML. Chaque webcam USB cree 2 entrees /dev/videoX ;
  // les chemins by-id ci-dessus visent toujours la premiere (index0).
  CAMERA_DEVICE_REAR:
    process.env.CAMERA_DEVICE_REAR ||
    '/dev/v4l/by-id/usb-BC-251020-CX_Webcam_ML._01.00.00-video-index0',
  // Vue "both" (plein ecran paysage) : le Pi combine avant+arriere en 1 image.
  // Il RE-ENCODE (contrairement au mode simple) : decodage des DEUX webcams,
  // mise a l'echelle, collage, puis encodage. 8 fps etait une contrainte du
  // Pi 3 ; le Pi 5 (A76 2,4 GHz) avale ca sans peine, d'ou 15.
  CAMERA_FPS_BOTH: Number(process.env.CAMERA_FPS_BOTH || 15),
  // Part de largeur de la camera AVANT dans l'image combinee (0.7 = 70%).
  CAMERA_SPLIT_PCT: Number(process.env.CAMERA_SPLIT_PCT || 0.7),
  // Resolution de SECOURS. En temps normal c'est rtcLinkProfile() qui decide :
  // 1280x720 sur WiFi/Ethernet, 640x360 sur 4G (voir plus bas). On garde 640x360
  // ici, la valeur prudente, pour le cas ou la liaison est inconnue.
  // Tailles MJPEG dispo sur la webcam: 320x240, 640x480, 1280x720, 1280x960, 1920x1080.
  CAMERA_WIDTH: Number(process.env.CAMERA_WIDTH || 640),
  CAMERA_HEIGHT: Number(process.env.CAMERA_HEIGHT || 360),
  // 12 img/s + compression plus forte (q12) : chaque image traverse plus vite
  // le reseau qu'en 6 fps / q8 -> rendu "direct" au lieu de trainer derriere.
  CAMERA_FPS: Number(process.env.CAMERA_FPS || 12),
  CAMERA_QUALITY: Number(process.env.CAMERA_QUALITY || 12),
  // NB: fps/quality ci-dessus = reglages "reseau parfait" (niveau 0). En 4G
  // faible, l'echelle automatique (NET_LADDER plus bas) descend toute seule.

  // Video WebRTC : le robot pousse un flux H.264 (encodeur MATERIEL du Pi,
  // CPU quasi nul) vers MediaMTX sur le VPS ; l'app le lit en WebRTC (fluide,
  // latence basse). Les images MJPEG du socket deviennent alors juste le
  // secours + la source des photos (~1 img/s).
  RTC_ENABLE: String(process.env.RTC_ENABLE || 'true').toLowerCase() === 'true',
  // URL de publication complete (prioritaire si definie), sinon construite
  // avec les champs ci-dessous. Port 3002 = un des rares ports TCP ouverts
  // par le firewall du fournisseur VPS (tout l'UDP entrant y est bloque).
  RTC_PUSH_URL: process.env.RTC_PUSH_URL || '',
  RTC_HOST: process.env.RTC_HOST || '<ip-serveur>',
  RTC_PORT: Number(process.env.RTC_PORT || 3002),
  RTC_USER: process.env.RTC_USER || 'robot',
  // Mot de passe de publication MediaMTX (VPS: /opt/mediamtx/publish-pass.txt).
  RTC_PASS: process.env.RTC_PASS || 'REDACTED',
  // Reglages 4G de SECOURS (si le signal de la cle est illisible) : prudents.
  // Mesure du 29/07 : SINR -1 dB en interieur => ~150-200 kb/s d'upload reel.
  // Le debit effectif est choisi par rtcLinkProfile() selon le SINR de la cle.
  RTC_FPS: Number(process.env.RTC_FPS || 10),
  RTC_BITRATE: process.env.RTC_BITRATE || '250k',
  // Interface HiLink de la cle 4G Huawei/Brovi E3372 (vide = pas de lecture
  // du signal, on garde les reglages de secours ci-dessus).
  RTC_MODEM_API: process.env.RTC_MODEM_API || 'http://192.168.8.1',
  // Micro du robot en Opus/WebRTC (32 kb/s), ecoute en mode appel sur le
  // telephone. Le flux MP3/HTTPS reste produit en parallele comme secours.
  RTC_AUDIO: String(process.env.RTC_AUDIO || 'true').toLowerCase() === 'true',
  // Debit de la piste micro. 48k en mode 'audio' donne un son bien plus
  // riche que les 24-32k en mode 'voip' d'origine, pour ~2 Ko/s de plus.
  RTC_AUDIO_BITRATE: process.env.RTC_AUDIO_BITRATE || '48k',

  // Assistant vocal (le robot s'appelle Solana) : il ecoute le mot-cle, envoie
  // la question au VPS (transcription + Claude) et dit la reponse a voix haute.
  // Le mot-cle reel reste "alexa", faute de modele openWakeWord francais — voir
  // VOICE_WAKE_MODEL plus bas.
  VOICE_ENABLE: String(process.env.VOICE_ENABLE || 'true').toLowerCase() === 'true',
  // Le meme peripherique partage alimente l'assistant et le flux WebRTC. Le
  // plugin dsnoop permet aux deux processus de lire le micro en meme temps.
  VOICE_DEVICE: ROBOT_MIC_DEVICE,
  VOICE_CARD: ROBOT_MIC_CARD,
  // "alexa" plutot que "hey_jarvis" : les modeles openWakeWord sont entraines
  // sur la prononciation ANGLAISE. Mesure du 30/07 avec une voix francaise :
  // alexa 0.844, hey_marvin 0.263, hey_jarvis 0.005 (indetectable en francais).
  VOICE_WAKE_MODEL: process.env.VOICE_WAKE_MODEL || 'alexa',
  // Ecoute permanente du mot-cle. VOICE_WAKE=false garde l'assistant complet
  // mais declenchable uniquement par le bouton de l'app : plus de python ni
  // d'onnxruntime en memoire, plus de micro ouvert en continu. C'est ce qui
  // rend l'assistant tenable sur un Pi 3 (1 Go de RAM, bus USB partage).
  VOICE_WAKE: String(process.env.VOICE_WAKE || 'true').toLowerCase() === 'true',
  // 0 = tres sensible (faux declenchements), 1 = tres strict. 0.2 : le micro
  // de webcam capte faiblement, mieux vaut un peu trop sensible que sourd.
  VOICE_THRESHOLD: Number(process.env.VOICE_THRESHOLD || 0.2),
  // 60% capte mieux une voix eloignee que l'ancien reglage a 25%. L'AGC de
  // la webcam ajuste ensuite automatiquement les sons proches/lointains.
  VOICE_MIC_GAIN: process.env.VOICE_MIC_GAIN || '60%',
  VOICE_AUTO_GAIN: String(process.env.VOICE_AUTO_GAIN || 'true').toLowerCase() === 'true',
  VOICE_PYTHON: process.env.VOICE_PYTHON || `${require('os').homedir()}/voice-venv/bin/python`,
  // Camera utilisee par l'outil "regarder" de l'assistant vocal : l'Innomaker,
  // c'est-a-dire la camera AVANT, quelle que soit la vue affichee dans l'app.
  // Le repli suit donc CAMERA_DEVICE (et non CAMERA_DEVICE_REAR, qui pointait
  // sur l'Innomaker avant que l'avant et l'arriere ne soient echanges).
  VOICE_CAMERA_DEVICE:
    process.env.VOICE_CAMERA_DEVICE ||
    process.env.CAMERA_DEVICE ||
    '/dev/v4l/by-id/usb-InnoMaker_Innomaker-U20CAM-1080PD_N-S1_20010101-video-index0',

  // Evitement par la CAMERA pendant la navigation GPS. Le capteur a ultrasons
  // ne voit qu'a 25 cm droit devant ; la camera voit un mur a plusieurs
  // metres et sait de quel cote le contourner.
  NAV_VISION_ENABLE: String(process.env.NAV_VISION_ENABLE || 'true').toLowerCase() === 'true',
  // Periode entre deux analyses (ms). Chaque analyse = 1 appel au modele.
  NAV_VISION_MS: Number(process.env.NAV_VISION_MS || 4000),

  // Micro (audio "webradio"). Le robot ne diffuse que quand l'app ecoute.
  AUDIO_ENABLE: String(process.env.AUDIO_ENABLE || 'true').toLowerCase() === 'true',
  AUDIO_DEVICE: ROBOT_MIC_DEVICE,
  AUDIO_CARD: ROBOT_MIC_CARD,
  AUDIO_BITRATE: process.env.AUDIO_BITRATE || '40k',
  AUDIO_SAMPLE_RATE: Number(process.env.AUDIO_SAMPLE_RATE || 22050),

  // Synthese vocale ("le robot parle") via haut-parleur Bluetooth.
  TTS_ENABLE: String(process.env.TTS_ENABLE || 'true').toLowerCase() === 'true',
  TTS_LANG: process.env.TTS_LANG || 'fr-FR',
  // MAC de la JBL appairee (bluetoothctl). Si vide -> sortie ALSA par defaut.
  SPEAKER_MAC: process.env.SPEAKER_MAC || '',
  // Forcer un device aplay precis (sinon deduit de SPEAKER_MAC). Ex: "default".
  TTS_PLAY_DEVICE: process.env.TTS_PLAY_DEVICE || '',
  // Silence (ms) avant chaque phrase, pour le reveil de l'enceinte Bluetooth.
  // Mets 0 si tu utilises un haut-parleur filaire (pas de reveil necessaire).
  // 250 ms suffisent depuis que le Bluetooth est passe sur la cle USB (la
  // liaison ne dort plus). 1500 ms rallongeaient CHAQUE phrase de 1,25 s.
  TTS_PREROLL_MS: Number(process.env.TTS_PREROLL_MS || 250),
  // Anti-veille desactive par defaut. La cle Realtek plante parfois au moment
  // precis ou un nouveau flux A2DP est ouvert ; l'ancien silence toutes les
  // 90 s provoquait donc lui-meme des deconnexions au repos.
  TTS_KEEPALIVE_MS: Number(process.env.TTS_KEEPALIVE_MS || 0),
  // Veilleuse : filet de son permanent sur l'enceinte Bluetooth pour qu'elle
  // ne se mette jamais en veille toute seule. Remplace l'anti-veille par
  // salves ci-dessus (voir tts.js). Mets "false" pour rendre la radio
  // Bluetooth libre au repos.
  TTS_VEILLEUSE: String(process.env.TTS_VEILLEUSE || 'true').toLowerCase() === 'true',
  // Vitesse moteur imposee des que l'Arduino repond (commande V<n>, 0..255).
  //
  // Pourquoi ne pas se fier au firmware : le sketch demarre a 160/255, soit
  // 63 %, et rien ne le remontait jamais — le curseur de l'app n'envoie un V
  // que si on y touche, et les journaux montrent qu'aucun V n'a JAMAIS ete
  // emis. Le robot a donc roule bride en permanence, sans le couple
  // necessaire pour tourner sur un sol accrocheur.
  // Ici le Pi impose la valeur lui-meme : plus rien a se rappeler cote app,
  // et plus besoin de reflasher l'Arduino pour en changer.
  // 0 = ne rien imposer (garder la valeur du firmware).
  MOTOR_SPEED_BOOT: Number(process.env.MOTOR_SPEED_BOOT || 255),
  // PWM de depart du demarrage progressif (commande J<n>, 0..255).
  //
  // A pleine puissance d'emblee, le moteur qui repond le premier fait pivoter
  // le chassis avant que les autres n'aient pris : le robot part de travers a
  // chaque depart et les roues patinent. La rampe ne concerne QUE la marche
  // avant et arriere — les virages gardent tout leur couple immediatement.
  // Plus la valeur est basse, plus le depart est doux et long.
  // 0 = pas de rampe (depart sec, comme avant).
  MOTOR_SOFT_START: Number(process.env.MOTOR_SOFT_START || 120),
  // Duree de chauffe avant de garder la photo, en secondes. Monte-la si les
  // images d'alerte sont encore sombres la nuit.
  PHOTO_CHAUFFE_S: Number(process.env.PHOTO_CHAUFFE_S || 1.5),
  // Ce que le robot dit a voix haute quand il decouvre quelqu'un pendant une
  // absence. A garder VRAI : annoncer une intervention de police qui n'arrive
  // pas se retourne contre le proprietaire.
  PRESENCE_PHRASE: process.env.PRESENCE_PHRASE ||
    "Vous etes filme et enregistre. Le proprietaire vient d'etre prevenu.",
  // --- Maintien de cap ---
  //
  // Un equilibrage fixe (MOTOR_TRIM_*) corrige un ecart CONSTANT. Or l'ecart
  // reel varie avec la tension de la batterie, la charge, le sol et l'usure :
  // regle sur du carrelage, il derive sur la moquette. C'est pour ca qu'on ne
  // trouvait jamais "le bon reglage" — il n'existe pas.
  //
  // Ici le robot MESURE son cap et se corrige en continu. Plus rien a regler.
  CAP_HOLD: String(process.env.CAP_HOLD || 'true').toLowerCase() === 'true',
  // Correction appliquee, en % de vitesse, par degre d'ecart.
  CAP_GAIN: Number(process.env.CAP_GAIN || 2),
  // Plafond de la correction : au-dela le robot vire au lieu de se recaler.
  CAP_CORR_MAX: Number(process.env.CAP_CORR_MAX || 40),
  // Periode du regulateur. Plus court = plus reactif mais plus de trafic
  // serie ; l'Arduino coupe les moteurs apres 1,5 s sans ordre, il faut donc
  // rester tres en dessous.
  CAP_TICK_MS: Number(process.env.CAP_TICK_MS || 120),
  // Equilibrage gauche/droite, en % (100 = pleine puissance sur ce cote).
  //
  // Deux moteurs identiques ne tournent jamais a la meme vitesse : le robot
  // part en crabe. On RALENTIT le cote rapide — impossible d'accelerer
  // l'autre, il est deja a 255.
  //
  // Regle : le robot devie du cote LENT. S'il tire a droite, c'est le cote
  // GAUCHE qui va trop vite -> baisser MOTOR_TRIM_LEFT.
  // Ajuster par pas de 2 a 3 %, batterie bien chargee, sol plat.
  MOTOR_TRIM_LEFT: Number(process.env.MOTOR_TRIM_LEFT || 100),
  MOTOR_TRIM_RIGHT: Number(process.env.MOTOR_TRIM_RIGHT || 100),

  // Envoi des donnees du capteur au serveur (capteur.js, WebSocket /ws/capteur).
  CAPTEUR_ENABLE: String(process.env.CAPTEUR_ENABLE || 'true').toLowerCase() === 'true',
  // Session (fichier cote serveur). Vide = une nouvelle a chaque demarrage.
  CAPTEUR_SESSION: process.env.CAPTEUR_SESSION || '',
  // Meme valeur que ROBOT_KEY sur le serveur, si elle y est configuree.
  ROBOT_KEY: process.env.ROBOT_KEY || '',
};

if (!CONFIG.CODE) {
  console.error('CODE manquant. Lance avec: CODE=123456 node robot.js');
  process.exit(1);
}

const now = () => new Date().toLocaleTimeString();
const log = (...args) => console.log(`[${now()}]`, ...args);
const debugLog = (...args) => {
  if (CONFIG.ROBOT_DEBUG_LOGS) log(...args);
};
const ROBOT_CLIENT_VERSION = 'robot-drive-debug-v3-2026-06-28';
const ROBOT_DRIVE_BUZZ_PREFIX = 'PING_ROBOT_DRIVE:';
const ROBOT_ACK_BUZZ_PREFIX = 'PING_ROBOT_ACK:';
const ROBOT_ONLINE_BUZZ_PREFIX = 'PING_ROBOT_ONLINE:';
const ROBOT_CAM_BUZZ_PREFIX = 'PING_ROBOT_CAM:';

let lastFix = null;
let peerCoord = null;
let sharing = false;
let shareTimer = null;
let meetActive = false;
let compass = null;

// ========================
// Mode de surveillance — NORMAL ou ABSENT
// ========================
//
// En mode ABSENT, tout ce qui releve de la surveillance s'arme : detection de
// presence, photo, analyse par Claude, alerte. En mode NORMAL le robot reste
// un robot, il ne guette rien et n'alerte personne.
//
// L'etat est ECRIT SUR LE DISQUE, et c'est le point important : si le robot
// redemarre pendant ton absence — coupure de courant, plantage, batterie — il
// doit revenir en surveillance tout seul. Un mode qui s'oublie au reboot est
// exactement celui qui te laisse sans rien le jour ou ca compte.
const MODE_FICHIER = require('path').join(__dirname, 'mode.json');
let modeAbsent = false;

function chargerMode() {
  try {
    const j = JSON.parse(require('fs').readFileSync(MODE_FICHIER, 'utf8'));
    modeAbsent = !!j.absent;
    log(`Mode: ${modeAbsent ? 'ABSENT (surveillance armee)' : 'NORMAL'} (restaure).`);
  } catch {
    modeAbsent = false;
  }
}

function enregistrerMode() {
  try {
    require('fs').writeFileSync(MODE_FICHIER, JSON.stringify({ absent: modeAbsent, ts: Date.now() }));
  } catch (e) {
    log('Mode: enregistrement impossible :', e.message);
  }
}

// Point d'entree unique pour tout ce qui sera declenche par la surveillance.
// La detection de presence, demain, n'aura qu'a appeler ceci avant d'agir.
// Point d'entree unique : vrai seulement en mode ABSENT ET une fois le delai
// de sortie ecoule.
function surveillanceArmee() {
  return modeAbsent && Date.now() >= survArmeeA;
}

function definirMode(absent, source) {
  const nouveau = !!absent;
  if (nouveau === modeAbsent) return false;
  modeAbsent = nouveau;
  enregistrerMode();
  log(`Mode: ${modeAbsent ? 'ABSENT — surveillance armee' : 'NORMAL — surveillance desarmee'}${source ? ` (${source})` : ''}.`);
  // PAS d'annonce vocale ici. Elle paraissait utile ("j'entends que c'est
  // arme en partant") mais elle etait catastrophique : le micro de
  // surveillance entendait le haut-parleur du robot et declenchait une alerte
  // "bruit detecte" cinq secondes apres chaque armement, a tous les coups
  // (niveau mesure 0,27 contre un seuil de 0,02).
  // L'ecoute ne demarre qu'en mode ABSENT : en mode normal le robot ne doit
  // ni ecouter ni alerter, c'est le sens meme des deux modes.
  if (modeAbsent) {
    survArmeeA = Date.now() + SURV_DELAI_MS;
    log(`Mode: surveillance effective dans ${Math.round(SURV_DELAI_MS / 1000)} s (le temps de sortir).`);
    setTimeout(() => {
      if (!modeAbsent) return;
      surveillanceSonDemarrer();
      log('Mode: surveillance maintenant active.');
    }, SURV_DELAI_MS);
  } else {
    survArmeeA = 0;
    surveillanceSonArreter();
  }
  return true;
}

// Restaure le mode des le chargement : si le robot a redemarre pendant une
// absence, il doit etre arme avant meme d'etre joignable.
// ========================
// Surveillance sonore — n'ecoute qu'en mode ABSENT
// ========================
//
// Le micro mesure deja son niveau sonore morceau par morceau (c'est ce qui
// sert au squelch de la conversation). On reutilise exactement la meme idee :
// on apprend le bruit de fond de la piece, et on n'alerte que sur ce qui le
// depasse FRANCHEMENT et DURABLEMENT.
//
// Deux pieges evites, appris en reglant le squelch :
//   - un seuil absolu ne veut rien dire, le gain du micro et l'ambiance de la
//     piece changent d'un jour a l'autre -> seuil relatif au bruit de fond ;
//   - un pic isole (craquement de meuble, voiture qui passe) ne doit pas
//     declencher -> il faut plusieurs morceaux forts dans une meme fenetre.
const SURV_FACTEUR = Number(process.env.SURV_FACTEUR || 5);
// Abaisse de 0.02 a 0.012 le 25/09 : avec un bruit de fond mesure a 0.003,
// c'etait le PLANCHER qui fixait le seuil, pas la mesure — et des coups
// frappes a la porte passaient tout juste (0.027). Le plancher ne doit mordre
// que dans le silence complet.
const SURV_PLANCHER = Number(process.env.SURV_PLANCHER || 0.012);
const SURV_PLAFOND = Number(process.env.SURV_PLAFOND || 0.05);
// 3 morceaux forts sur 10, au lieu de 4 : des coups frappes a une porte sont
// des impacts secs separes par du silence, ils remplissent mal une fenetre.
const SURV_MORCEAUX = Number(process.env.SURV_MORCEAUX || 3);
const SURV_FENETRE = Number(process.env.SURV_FENETRE || 10);
// Delai de sortie, exactement comme une alarme de maison : entre le moment ou
// on arme depuis l'app et celui ou le robot commence vraiment a guetter, on
// laisse le temps de sortir. Sans ca, c'est TOI que le robot detecte, et le
// bruit de tes propres pas qui declenche la premiere alerte.
// Il fixe aussi la reference du radar : la piece doit etre vide quand il
// commence, sinon une presence deja etablie ne produit aucun changement
// d'etat, donc aucune alerte.
const SURV_DELAI_MS = Number(process.env.SURV_DELAI_MS || 30000);
let survArmeeA = 0;   // instant a partir duquel les alertes comptent

let survMicro = null;
let survBruitFond = 0.01;
let survFenetre = [];
let survMaxRecent = 0;
let survProchainLog = 0;
// Meme temporisation que pour le son : une alerte par minute au maximum.

// Envoi d'une alerte, avec accuse dans le journal et report si la liaison
// est coupee.
//
// Les deux alertes partaient d'un socket.emit() nu, alors que sept autres
// emissions de ce fichier verifient socket.connected. Sur un robot en 4G la
// liaison tombe, et socket.emit() sur une socket fermee ne fait RIEN, sans
// erreur. Le journal affichait pourtant "-> alerte", ecrit avant l'envoi :
// une alerte perdue et une alerte transmise s'y ressemblaient exactement.
// C'est le pire mode de panne pour un robot de surveillance, et c'est ce qui
// a fait croire le 28/09 que le micro n'etait pas assez sensible.
let alerteEnAttente = null;

// ========================
// Un incident, pas trois capteurs
// ========================
//
// Chaque capteur avait sa propre pause de 60 s. Une seule personne qui entre
// reveille le radar, le micro ET la camera : trois notifications, trois photos,
// trois analyses payantes, pour un seul evenement. Et l'inverse etait vrai
// aussi — un chat qui consommait la pause du radar rendait ce capteur sourd
// pendant une minute, y compris pour quelqu'un arrivant juste apres.
//
// Desormais les trois capteurs alimentent le MEME incident. Le premier qui
// voit quelque chose declenche ; les autres sont enregistres comme temoins.
// Tant que l'incident dure, les envois s'espacent (30 s, 2 min, puis 5 min) :
// une personne qui reste dix minutes ne produit pas dix notifications.
const ALERTE_PALIERS_MS = (process.env.ALERTE_PALIERS_MS || '0,30000,120000,300000')
  .split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
// Apres ce calme, on considere que l'incident est clos : le prochain
// declenchement repart du premier palier, donc immediat.
const ALERTE_FIN_MS = Number(process.env.ALERTE_FIN_MS || 180000);

let alerteDernier = 0;
let alerteRang = 0;
let alerteTemoins = new Set();

// Renvoie la liste des capteurs a joindre a l'alerte, ou null s'il ne faut
// rien envoyer maintenant.
function alerteAutorisee(capteur) {
  const t = Date.now();
  alerteTemoins.add(capteur);

  // Assez de calme : nouvel incident, on repart a zero.
  if (alerteDernier && t - alerteDernier > ALERTE_FIN_MS) alerteRang = 0;

  const attente = ALERTE_PALIERS_MS[Math.min(alerteRang, ALERTE_PALIERS_MS.length - 1)];
  if (alerteDernier && t - alerteDernier < attente) {
    // Rien n'est perdu : le capteur reste inscrit comme temoin et partira
    // avec le prochain envoi de l'incident.
    return null;
  }

  alerteDernier = t;
  alerteRang += 1;
  const capteurs = Array.from(alerteTemoins);
  alerteTemoins = new Set();
  return capteurs;
}

function envoyerAlerte(charge) {
  if (socket.connected) {
    socket.emit('robot_alerte', charge);
    log(`Alerte ${charge.type} TRANSMISE au serveur${charge.photo ? ' (avec photo)' : ' (sans photo)'}.`);
    return;
  }
  // Liaison coupee : on garde l'alerte pour la reconnexion. Une intrusion ne
  // doit pas passer inapercue parce que le reseau a cligne des yeux.
  alerteEnAttente = { charge, ts: Date.now() };
  log(`Alerte ${charge.type} NON TRANSMISE : liaison au serveur coupee. Gardee pour la reconnexion.`);
}

// Au retour du reseau. Passe 5 minutes l'alerte n'informe plus de rien : on
// prefere le silence a une notification qui ferait croire a un fait present.
function rejouerAlerteEnAttente() {
  if (!alerteEnAttente) return;
  const { charge, ts } = alerteEnAttente;
  alerteEnAttente = null;
  const age = Math.round((Date.now() - ts) / 1000);
  if (age > 300) {
    log(`Alerte ${charge.type} en attente abandonnee : ${age} s, trop ancienne.`);
    return;
  }
  socket.emit('robot_alerte', charge);
  log(`Alerte ${charge.type} transmise avec ${age} s de retard (liaison retablie).`);
}

// ========================
// Surveillance visuelle — la camera devient le troisieme capteur
// ========================
//
// Le radar dit qu'il y a QUELQUE CHOSE, le micro qu'il y a du BRUIT. Ni l'un
// ni l'autre ne sait faire la difference entre un chat et quelqu'un : c'est ce
// qui a produit des dizaines de fausses alertes. L'image, elle, tranche.
//
// On n'envoie surtout PAS toutes les images a l'IA : chaque analyse coute et
// prend une a deux secondes. Le declencheur est donc LOCAL et gratuit — on
// compare chaque image a la precedente. Tant que rien ne bouge, ca ne coute
// rien ; des que ca bouge, on photographie en pleine resolution et on analyse.
//
// Le flux de veille est minuscule (64x36 en niveaux de gris, 2 images par
// seconde) : assez pour voir une silhouette traverser, negligeable pour le Pi.
const MOUV_L = Number(process.env.MOUV_L || 64);
const MOUV_H = Number(process.env.MOUV_H || 36);
const MOUV_TAILLE = MOUV_L * MOUV_H;
// 5 images/s, et pas 4 : mesure le 28/09, la meme scene immobile monte a
// 0.0234 a 4 images/s (le battement du secteur a 50 Hz repasse au-dessus du
// seuil) contre 0.0056 a 5. Plus rapide ET plus propre.
const MOUV_FPS = Number(process.env.MOUV_FPS || 5);
// Ecart de luminosite au-dela duquel un pixel compte comme ayant change. Trop
// bas, le grain de l'image infrarouge declencherait tout seul.
const MOUV_DELTA = Number(process.env.MOUV_DELTA || 20);
// Meme principe que pour le son : un seuil RELATIF a ce que la camera voit
// d'habitude, jamais une valeur absolue.
const MOUV_FACTEUR = Number(process.env.MOUV_FACTEUR || 4);
const MOUV_PLANCHER = Number(process.env.MOUV_PLANCHER || 0.02);
const MOUV_PLAFOND = Number(process.env.MOUV_PLAFOND || 0.15);
const MOUV_MORCEAUX = Number(process.env.MOUV_MORCEAUX || 2);
const MOUV_FENETRE = Number(process.env.MOUV_FENETRE || 6);
// Images jetees au demarrage : le capteur regle son exposition, et pendant ce
// temps l'image change du tout au tout sans que rien n'ait bouge.
const MOUV_CHAUFFE = Number(process.env.MOUV_CHAUFFE || 8);
// Qualite de l'image pleine resolution produite par la veille. 4 = tres bonne.
const MOUV_QUALITE = Number(process.env.MOUV_QUALITE || 4);
// Resolution de CAPTURE de la veille, volontairement plus basse que le direct.
// Mesure le 28/09 sur le Pi 5 : 640x480 coute 68 % d'un coeur et donne des
// photos de 27 ko, contre 130 % et 69 ko en 1280x720. Le 720p n'apporte rien
// pour distinguer un chat d'une personne, et la photo legere part bien plus
// vite en 4G — ce qui est justement le but.
const MOUV_CAPTURE_L = Number(process.env.MOUV_CAPTURE_L || 640);
const MOUV_CAPTURE_H = Number(process.env.MOUV_CAPTURE_H || 480);
const DEBUT_JPEG = Buffer.from([0xFF, 0xD8]);
const FIN_JPEG = Buffer.from([0xFF, 0xD9]);

let mouvProc = null;
let mouvReste = Buffer.alloc(0);
let mouvPrec = null;
let mouvIgnore = 0;
let mouvFond = 0.01;
let mouvFenetre = [];
let mouvMaxRecent = 0;
let mouvProchainLog = 0;
// Un compteur, et non un booleen : deux captures peuvent se chevaucher, et la
// premiere qui se termine ne doit pas relancer la veille pendant la seconde.
let mouvSuspensions = 0;
// Derniere image PLEINE RESOLUTION produite par la veille elle-meme.
//
// C'est tout l'interet : la camera est deja ouverte et son exposition deja
// faite. Rouvrir le peripherique pour photographier coutait plus de trois
// secondes — fermeture de la veille, ouverture, 1,5 s de chauffe — et la
// personne avait le temps de sortir du champ. Ici l'image est deja la.
let mouvJpeg = null;
let mouvJpegAt = 0;
let mouvJpegBuf = Buffer.alloc(0);

function mouvSeuil() {
  return Math.max(MOUV_PLANCHER, mouvFond * MOUV_FACTEUR);
}

function mouvCameraOccupee() {
  try { return !!(camera && camera.streaming); } catch { return false; }
}

function mouvDemarrer() {
  if (mouvProc || mouvSuspensions > 0) return;
  if (!CONFIG.CAMERA_ENABLE || !surveillanceArmee() || mouvCameraOccupee()) return;
  const { spawn } = require('child_process');
  mouvReste = Buffer.alloc(0);
  mouvPrec = null;
  mouvIgnore = MOUV_CHAUFFE;
  mouvFond = 0.01;
  mouvFenetre = [];
  mouvMaxRecent = 0;
  mouvProchainLog = 0;
  // UNE lecture de la camera, DEUX sorties :
  //   pipe:1 — 64x36 en gris, pour detecter le mouvement ;
  //   pipe:3 — l'image pleine resolution, gardee en memoire pour la photo.
  // Le peripherique n'est ouvert qu'une fois, ce qui evite le conflit d'acces
  // et, surtout, rend la photo immediate.
  mouvJpeg = null;
  mouvJpegAt = 0;
  mouvJpegBuf = Buffer.alloc(0);
  mouvProc = spawn('ffmpeg', [
    '-loglevel', 'error', '-f', 'v4l2', '-input_format', 'mjpeg',
    '-video_size', `${MOUV_CAPTURE_L}x${MOUV_CAPTURE_H}`,
    '-i', CONFIG.VOICE_CAMERA_DEVICE,
    '-vf', `scale=${MOUV_L}:${MOUV_H},format=gray`,
    '-r', String(MOUV_FPS), '-f', 'rawvideo', 'pipe:1',
    '-vf', `fps=${MOUV_FPS}`,
    '-c:v', 'mjpeg', '-q:v', String(MOUV_QUALITE), '-f', 'image2pipe', 'pipe:3',
  ], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  mouvProc.stdout.on('data', mouvMorceau);
  if (mouvProc.stdio[3]) mouvProc.stdio[3].on('data', mouvJpegMorceau);
  mouvProc.stderr.on('data', () => {});
  mouvProc.on('error', (e) => { log('Surveillance visuelle: ffmpeg indisponible :', e.message); mouvProc = null; });
  mouvProc.on('exit', () => { mouvProc = null; });
  log('Surveillance visuelle armee.');
}

function mouvArreter() {
  if (!mouvProc) return;
  try { mouvProc.kill('SIGKILL'); } catch {}
  mouvProc = null;
}

// Un seul processus peut ouvrir /dev/video : toute capture pleine resolution
// doit rendre le peripherique a la veille, puis le lui reprendre.
function mouvSuspendre() {
  mouvSuspensions += 1;
  mouvArreter();
}

function mouvReprendre() {
  mouvSuspensions = Math.max(0, mouvSuspensions - 1);
  if (mouvSuspensions === 0) setTimeout(mouvDemarrer, 400);
}

// Decoupe le flux JPEG image par image. Une image commence par FFD8 et se
// termine par FFD9 ; le tube, lui, arrive en morceaux quelconques.
function mouvJpegMorceau(chunk) {
  mouvJpegBuf = mouvJpegBuf.length ? Buffer.concat([mouvJpegBuf, chunk]) : chunk;
  for (;;) {
    const fin = mouvJpegBuf.indexOf(FIN_JPEG);
    if (fin === -1) break;
    const debut = mouvJpegBuf.indexOf(DEBUT_JPEG);
    if (debut !== -1 && debut < fin) {
      mouvJpeg = Buffer.from(mouvJpegBuf.subarray(debut, fin + 2));
      mouvJpegAt = Date.now();
    }
    mouvJpegBuf = mouvJpegBuf.subarray(fin + 2);
  }
  // Garde-fou : si on ne retrouve jamais de fin d'image, le tampon ne doit pas
  // grossir indefiniment.
  if (mouvJpegBuf.length > 8 * 1024 * 1024) mouvJpegBuf = Buffer.alloc(0);
}

function mouvMorceau(chunk) {
  mouvReste = mouvReste.length ? Buffer.concat([mouvReste, chunk]) : chunk;
  while (mouvReste.length >= MOUV_TAILLE) {
    const img = mouvReste.subarray(0, MOUV_TAILLE);
    mouvReste = mouvReste.subarray(MOUV_TAILLE);
    mouvImage(img);
  }
}

function mouvImage(img) {
  if (mouvIgnore > 0) { mouvIgnore -= 1; mouvPrec = Buffer.from(img); return; }
  if (!mouvPrec) { mouvPrec = Buffer.from(img); return; }

  let changes = 0;
  for (let i = 0; i < MOUV_TAILLE; i += 1) {
    if (Math.abs(img[i] - mouvPrec[i]) > MOUV_DELTA) changes += 1;
  }
  mouvPrec = Buffer.from(img);
  const part = changes / MOUV_TAILLE;

  // Le fond colle au MINIMUM et remonte lentement : il absorbe le grain de
  // l'infrarouge ou un rideau qui bouge, sans se laisser tirer vers le haut
  // par ce qu'on cherche justement a detecter.
  mouvFond = part < mouvFond ? part : Math.min(mouvFond * 1.002, MOUV_PLAFOND);

  const seuil = mouvSeuil();
  mouvMaxRecent = Math.max(mouvMaxRecent, part);
  if (Date.now() > mouvProchainLog) {
    if (mouvProchainLog) {
      log(
        'Surveillance visuelle: calme (fond ' + mouvFond.toFixed(4) +
        ', seuil ' + seuil.toFixed(4) + ', pic recent ' + mouvMaxRecent.toFixed(4) + ').'
      );
    }
    mouvProchainLog = Date.now() + 300000;
    mouvMaxRecent = 0;
  }

  mouvFenetre.push(part >= seuil ? 1 : 0);
  if (mouvFenetre.length > MOUV_FENETRE) mouvFenetre.shift();
  let forts = 0;
  for (const c of mouvFenetre) forts += c;
  if (forts < MOUV_MORCEAUX) return;

  mouvFenetre = [];
  const temoinsMouv = alerteAutorisee('camera');
  if (!temoinsMouv) return;
  log('Surveillance visuelle: MOUVEMENT (part=' + part.toFixed(4) + ', seuil=' + seuil.toFixed(4) + ') -> alerte.');

  // L'image est deja la : on part SANS RIEN ATTENDRE.
  const age = Date.now() - mouvJpegAt;
  if (mouvJpeg && age < 3000) {
    log(`Surveillance visuelle: photo immediate (${age} ms, ${Math.round(mouvJpeg.length / 1024)} ko).`);
    envoyerAlerte({ code: CONFIG.CODE, type: 'mouvement', capteurs: temoinsMouv, photo: mouvJpeg.toString('base64') });
    return;
  }

  // Repli, si la veille vient de demarrer et n'a pas encore d'image.
  (async () => {
    let photo = null;
    try {
      const shot = await grabSingleFrame(CONFIG.VOICE_CAMERA_DEVICE);
      if (shot) photo = Buffer.from(shot).toString('base64');
    } catch (e) {
      log('Surveillance visuelle: photo impossible :', e.message);
    }
    envoyerAlerte({ code: CONFIG.CODE, type: 'mouvement', capteurs: temoinsMouv, photo });
  })();
}

// Chien de garde : rearme la veille si ffmpeg meurt, la coupe pendant le
// direct — un seul processus peut tenir la camera — et la relance apres.
setInterval(() => {
  if (!surveillanceArmee() || mouvCameraOccupee()) { mouvArreter(); return; }
  mouvDemarrer();
}, 5000);

function survSeuil() {
  return Math.max(SURV_PLANCHER, survBruitFond * SURV_FACTEUR);
}

function surveillanceSonDemarrer() {
  if (survMicro || !CONFIG.VOICE_DEVICE) return;
  survBruitFond = 0.01;
  survFenetre = [];
  survMaxRecent = 0;
  survProchainLog = 0;
  survMicro = new Micro({
    device: CONFIG.VOICE_DEVICE,
    log,
    onChunk: (pcm, niv) => {
      // Le robot parle (annonce de dissuasion, alarme, reponse vocale) : son
      // propre haut-parleur sature son micro. Sans ce garde-fou, chaque
      // phrase prononcee declenchait une alerte "bruit detecte" — y compris
      // celle qu'il prononce JUSTEMENT parce qu'il vient de detecter
      // quelqu'un. Le robot s'alertait lui-meme en boucle.
      if (ttsOccupeHautParleur()) return;

      // Le bruit de fond colle au MINIMUM et remonte lentement : il suit un
      // ventilateur qui demarre, sans se laisser tirer vers le haut par le
      // bruit qu'on cherche justement a detecter.
      survBruitFond = niv < survBruitFond
        ? niv
        : Math.min(survBruitFond * 1.0008, SURV_PLAFOND);

      const seuil = survSeuil();
      survMaxRecent = Math.max(survMaxRecent, niv);

      // Point de situation toutes les 5 min, pour regler sans deviner.
      if (Date.now() > survProchainLog) {
        if (survProchainLog) {
          log(
            'Surveillance: calme (bruit de fond ' + survBruitFond.toFixed(4) +
            ', seuil ' + seuil.toFixed(4) + ', pic recent ' + survMaxRecent.toFixed(4) + ').'
          );
        }
        survProchainLog = Date.now() + 300000;
        survMaxRecent = 0;
      }

      survFenetre.push(niv >= seuil ? 1 : 0);
      if (survFenetre.length > SURV_FENETRE) survFenetre.shift();
      let forts = 0;
      for (const c of survFenetre) forts += c;
      if (forts < SURV_MORCEAUX) return;

      survFenetre = [];
      const temoinsSon = alerteAutorisee('son');
      if (!temoinsSon) return;
      log('Surveillance: BRUIT DETECTE (niv=' + niv.toFixed(4) + ', seuil=' + seuil.toFixed(4) + ') -> alerte.');

      // Photo jointe, comme pour la presence : un bruit seul ne dit pas si
      // c'est un chat ou quelqu'un, une image le dit. C'est aussi elle que le
      // serveur fait analyser pour rediger le texte de la notification.
      (async () => {
        let photo = null;
        try {
          const shot = await grabSingleFrame(CONFIG.VOICE_CAMERA_DEVICE);
          if (shot) photo = Buffer.from(shot).toString('base64');
        } catch (e) {
          log('Surveillance: photo impossible :', e.message);
        }
        envoyerAlerte({
          code: CONFIG.CODE,
          type: 'bruit',
          capteurs: temoinsSon,
          niveau: Number(niv.toFixed(4)),
          seuil: Number(seuil.toFixed(4)),
          photo,
        });
      })();
    },
  });
  survMicro.demarrer();
  log('Surveillance sonore armee.');
}

// Etat du radar, rappele toutes les 5 minutes.
//
// Le sketch n'envoie que les CHANGEMENTS d'etat. Un radar bloque en detection
// permanente — parce qu'il traverse une cloison et voit la piece d'a cote, ou
// qu'il regarde une piece mobile du robot — ne produit donc plus aucune ligne.
// Vu des logs, "capteur muet" et "capteur sature" se ressemblent exactement.
// C'est ce qui nous a fait chercher au mauvais endroit.
let presenceEtat = null;
setInterval(() => {
  // "Aucune donnee" est l'information la PLUS utile ici : c'est le cas ou le
  // capteur est mal cable ou le firmware pas a jour. Se taire dans ce cas
  // revenait a cacher le seul defaut qu'on cherchait.
  log(
    presenceEtat === null
      ? 'Presence: AUCUNE donnee du radar (cablage D13 ou firmware a verifier).'
      : `Presence: etat du radar = ${presenceEtat ? 'OCCUPE' : 'vide'}.`
  );
}, 300000);

function surveillanceSonArreter() {
  if (!survMicro) return;
  survMicro.arreter();
  survMicro = null;
  log('Surveillance sonore desarmee.');
}

chargerMode();
// Le mode a pu etre restaure depuis le disque : on arme alors l'ecoute des le
// demarrage, sans attendre la moindre action de l'app.
if (modeAbsent) setTimeout(() => surveillanceSonDemarrer(), 4000);

const remoteDriveResults = new Map();

const gpsStats = {
  nmea: 0,
  noFix: 0,
  checksumBad: 0,
  lastLineAt: 0,
  lastFixAt: 0,
  lastType: null,
};

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function distanceMeters(a, b) {
  if (!a || !b) return null;
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

function nmeaToDecimal(value, hemisphere, degDigits) {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const deg = parseInt(value.slice(0, degDigits), 10);
  const min = parseFloat(value.slice(degDigits));
  if (Number.isNaN(deg) || Number.isNaN(min)) return null;
  let dec = deg + min / 60;
  if (hemisphere === 'S' || hemisphere === 'W') dec = -dec;
  return dec;
}

function nmeaChecksumOk(line) {
  const star = line.indexOf('*');
  if (star < 0) return true;
  let checksum = 0;
  for (let i = 1; i < star; i++) checksum ^= line.charCodeAt(i);
  const given = parseInt(line.slice(star + 1, star + 3), 16);
  return checksum === given;
}

let lastFixLog = 0;
let lastAcceptedPos = null;
const GPS_MAX_JUMP_M = Number(process.env.GPS_MAX_JUMP_M || 50);
function setFix(latitude, longitude, course, speedKnots) {
  const pos = { latitude, longitude };
  // Filtre anti-glitch : un robot lent ne peut pas sauter de dizaines de mètres
  // d'un coup. On rejette les fix aberrants (ex. saut de 200 m).
  if (lastAcceptedPos) {
    const jump = distanceMeters(lastAcceptedPos, pos);
    if (jump > GPS_MAX_JUMP_M) {
      log(`GPS: saut suspect ignoré (${jump} m)`);
      return;
    }
  }
  lastAcceptedPos = pos;

  gpsStats.lastFixAt = Date.now();
  const headingValid =
    Number.isFinite(course) &&
    Number.isFinite(speedKnots) &&
    speedKnots >= CONFIG.NAV_MIN_SPEED_KNOTS;

  lastFix = {
    latitude,
    longitude,
    ts: Date.now(),
    heading: Number.isFinite(course) ? course : null,
    speedKnots: Number.isFinite(speedKnots) ? speedKnots : 0,
    headingValid,
  };

  // Apprentissage d'une ronde : retient la trace pendant qu'on pilote.
  // Sans effet le reste du temps (le module ignore les positions hors
  // apprentissage), donc pas de condition a maintenir ici.
  if (ronde) ronde.noterPosition(lastFix);

  if (Date.now() - lastFixLog > 10000) {
    lastFixLog = Date.now();
    log(`GPS fix: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
  }
}

function handleNmeaLine(line) {
  line = String(line).trim();
  if (!line.startsWith('$')) return;

  gpsStats.nmea++;
  gpsStats.lastLineAt = Date.now();
  gpsStats.lastType = line.slice(3, 6);

  if (!nmeaChecksumOk(line)) {
    gpsStats.checksumBad++;
    return;
  }

  const type = line.slice(3, 6);
  const fields = line.split('*')[0].split(',');

  if (type === 'RMC') {
    if (fields[2] !== 'A') {
      gpsStats.noFix++;
      return;
    }
    const lat = nmeaToDecimal(fields[3], fields[4], 2);
    const lon = nmeaToDecimal(fields[5], fields[6], 3);
    const speedKnots = parseFloat(fields[7]);
    const course = parseFloat(fields[8]);
    if (lat != null && lon != null) setFix(lat, lon, course, speedKnots);
  } else if (type === 'GGA') {
    const quality = parseInt(fields[6], 10);
    if (!quality) {
      gpsStats.noFix++;
      return;
    }
    const lat = nmeaToDecimal(fields[2], fields[3], 2);
    const lon = nmeaToDecimal(fields[4], fields[5], 3);
    if (lat != null && lon != null) setFix(lat, lon);
  }
}

function startGps() {
  if (!CONFIG.GPS_ENABLE) {
    log('GPS desactive par defaut. Active avec GPS_ENABLE=true.');
    return;
  }

  if (CONFIG.GPS_PORT === CONFIG.ARDUINO_PORT) {
    log(`GPS desactive: GPS_PORT et ARDUINO_PORT utilisent le meme port (${CONFIG.GPS_PORT}).`);
    return;
  }

  let port;
  try {
    port = new SerialPort({ path: CONFIG.GPS_PORT, baudRate: CONFIG.GPS_BAUD });
  } catch (e) {
    log(`GPS impossible a ouvrir (${CONFIG.GPS_PORT}):`, e.message);
    return;
  }

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
  parser.on('data', (line) => {
    try {
      handleNmeaLine(line);
    } catch (e) {
      log('Erreur lecture GPS:', e.message);
    }
  });

  port.on('open', () => log(`GPS ouvert sur ${CONFIG.GPS_PORT} @ ${CONFIG.GPS_BAUD}`));
  port.on('error', (e) => log('Erreur port GPS:', e.message));

  setInterval(() => {
    const age = Date.now() - gpsStats.lastFixAt;
    if (gpsStats.lastFixAt && age < 15000) return;

    if (!gpsStats.lastLineAt) {
      log(`GPS: aucune trame recue sur ${CONFIG.GPS_PORT}`);
    } else {
      log(
        `GPS: trames recues mais pas de fix recent (type=${gpsStats.lastType || '?'}, noFix=${gpsStats.noFix}, checksumBad=${gpsStats.checksumBad})`
      );
    }
  }, 15000);
}

const socket = io(CONFIG.SERVER_URL, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 10000,
});

function pair() {
  // robot: true — le serveur ecarte le robot de l'election du pilote. Sans ce
  // marqueur il deviendrait pilote de son propre salon des qu'il se connecte
  // en premier, et plus personne ne pourrait lui donner d'ordre.
  socket.emit('pair', { pseudo: CONFIG.PSEUDO, code: CONFIG.CODE, robot: true });
  log(`Appairage envoye (pseudo="${CONFIG.PSEUDO}", code="${CONFIG.CODE}")`);
}

function shareLocationOnce() {
  if (!lastFix) {
    log('Position robot non disponible: pas encore de fix GPS.');
    return false;
  }
  socket.emit('share_location', {
    code: CONFIG.CODE,
    coords: { latitude: lastFix.latitude, longitude: lastFix.longitude },
  });
  return true;
}

function startSharing() {
  if (sharing) return;
  sharing = true;
  if (CONFIG.NAV_ENABLE) navigator.start();
  shareLocationOnce();

  shareTimer = setInterval(() => {
    shareLocationOnce();
    if (lastFix && peerCoord) {
      const d = distanceMeters(lastFix, peerCoord);
      if (d != null) log(`Distance robot/contact: ${d} m`);
      if (d != null && d <= CONFIG.ARRIVAL_RADIUS_M) {
        log('Robot arrive dans le rayon defini.');
      }
    }
  }, CONFIG.SHARE_INTERVAL_MS);

  log(`Partage de position demarre (${CONFIG.SHARE_INTERVAL_MS / 1000}s).`);
}

function stopSharing() {
  sharing = false;
  if (CONFIG.NAV_ENABLE) navigator.stop();
  if (shareTimer) {
    clearInterval(shareTimer);
    shareTimer = null;
  }
}

function requestMeet() {
  meetActive = true;
  shareLocationOnce();
  socket.emit('request_meet', { code: CONFIG.CODE, from: CONFIG.PSEUDO });
  startSharing();
  log('Demande "Se rejoindre" envoyee.');
}

function acceptMeet() {
  meetActive = true;
  socket.emit('accept_meet', { code: CONFIG.CODE });
  startSharing();
  log('Demande "Se rejoindre" acceptee.');
}

function cancelMeet() {
  socket.emit('cancel_meet', { code: CONFIG.CODE });
  meetActive = false;
  stopSharing();
  log('"Se rejoindre" annule.');
}

function sendMessage(text) {
  if (!text) return;
  socket.emit('buzz', { code: CONFIG.CODE, message: text });
  log(`Message envoye: "${text}"`);
}

// ========================
// Maintien de cap — le robot tient une direction au lieu d'etre "bien regle"
// ========================
//
// Quand l'app demande AVANCER, on ne relaie pas un simple 'F' : on retient le
// cap du moment, puis on envoie dix fois par seconde un pilotage differentiel
// corrige de l'ecart mesure. Le robot ne va pas droit parce qu'on a trouve le
// bon equilibrage : il se RATTRAPE en permanence.
//
// La rampe de demarrage est reprise ici, cote Pi : la commande M est
// volontairement directe cote Arduino (un regulateur qui subit une rampe
// oscille), c'est donc a l'appelant de monter en puissance.
let capCible = null;      // cap a tenir, en degres
let capTimer = null;
let capNiveau = 0;        // % de vitesse, monte progressivement
let capDernierF = 0;      // derniere demande d'avancer recue de l'app

function capActif() {
  return capTimer !== null;
}

function capArreter(raison) {
  if (!capTimer) return;
  clearInterval(capTimer);
  capTimer = null;
  capCible = null;
  if (raison) debugLog(`[CAP] arret (${raison})`);
}

// Ecart angulaire le plus court entre deux caps, dans [-180, +180].
// Sans ce repliement, passer de 359 a 1 degre donnerait -358 et le robot
// partirait en tete-a-queue pour "corriger".
function capEcart(actuel, cible) {
  let d = actuel - cible;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function capTick() {
  // L'app repete AVANCER tant que le doigt appuie. Plus rien depuis 900 ms :
  // le doigt est leve, on rend la main (et on coupe, sans attendre la
  // securite de 1,5 s de l'Arduino).
  if (Date.now() - capDernierF > 900) {
    capArreter('bouton relache');
    arduino.send('S');
    return;
  }

  // Rampe : meme forme que celle du firmware, exprimee en pourcentage.
  // Le niveau de depart est pose par capDemarrer(), ici on ne fait que monter.
  if (capNiveau < 100) capNiveau = Math.min(100, capNiveau + 3);

  const h = compass ? compass.getHeading() : null;
  if (!Number.isFinite(h)) {
    // Boussole muette en cours de route : on continue tout droit plutot que
    // de corriger au hasard. Mieux vaut derive connue que correction fausse.
    arduino.send(`M${capNiveau},${capNiveau}`);
    return;
  }

  const err = capEcart(h, capCible);
  let corr = Math.round(err * CONFIG.CAP_GAIN);
  corr = Math.max(-CONFIG.CAP_CORR_MAX, Math.min(CONFIG.CAP_CORR_MAX, corr));

  // On ne peut que RALENTIR un cote : a 100 % il n'y a pas de marge au-dessus.
  // Ecart positif = le robot a derive a droite -> on ralentit la gauche pour
  // le faire revenir vers la gauche.
  let g = capNiveau;
  let d = capNiveau;
  if (corr > 0) g = Math.max(0, capNiveau - corr);
  else if (corr < 0) d = Math.max(0, capNiveau + corr);

  arduino.send(`M${g},${d}`);
}

// Retourne true si le maintien de cap a pris la main sur cette commande.
function capDemarrer() {
  if (!CONFIG.CAP_HOLD || !compass) return false;
  capDernierF = Date.now();
  if (capActif()) return true;        // deja en cours : on prolonge, c'est tout
  const h = compass.getHeading();
  if (!Number.isFinite(h)) return false;   // pas de cap fiable -> 'F' classique
  capCible = h;
  capNiveau = Math.round((CONFIG.MOTOR_SOFT_START / 255) * 100);
  log(`Cap: maintien engage sur ${Math.round(h)}°.`);
  capTimer = setInterval(capTick, CONFIG.CAP_TICK_MS);
  capTick();
  return true;
}

async function handleRemoteDrive(cmd, source, id) {
  const c = String(cmd || '').trim().toUpperCase();
  const cmdId = String(id || `${c}-${Date.now()}`);
  const isSpeed = /^V\d{2,3}$/.test(c); // V<n> = reglage de vitesse absolue
  // M<g>,<d> = pilotage differentiel (virage en arc, joystick proportionnel).
  const isMix = /^M-?\d{1,3},-?\d{1,3}$/.test(c);
  debugLog(`[ROBOT_DRIVE][IN] id=${cmdId} source=${source || '?'} cmd=${c}`);

  // Un melange "tout droit" (les deux cotes a la meme vitesse vers l'avant)
  // doit passer par le maintien de cap, sinon pousser le joystick droit
  // devant contournerait le regulateur et le robot repartirait en crabe.
  // Tolerance de 3 % : le joystick ne produit jamais deux valeurs exactement
  // egales, le pouce n'est pas au pixel pres.
  let droitDevant = c === 'F';
  if (isMix) {
    const [pg, pd] = c.slice(1).split(',').map(Number);
    droitDevant = pg > 0 && pd > 0 && Math.abs(pg - pd) <= 3;
  }

  // Toute commande autre qu'un AVANCER reprend la main sur le regulateur :
  // sans ca, un stop serait aussitot recouvert par le prochain tick de cap.
  if (!droitDevant) capArreter(`commande ${c}`);

  // AVANCER : on laisse le maintien de cap piloter, s'il le peut.
  if (droitDevant && capDemarrer()) return true;

  if (!isSpeed && !isMix && (!'FBLRS+-'.includes(c) || c.length !== 1)) {
    debugLog(`[ROBOT_DRIVE][DROP] id=${cmdId} cmd invalide="${cmd}"`);
    return false;
  }
  if (remoteDriveResults.has(cmdId)) {
    debugLog(`[ROBOT_DRIVE][DEDUP] id=${cmdId} cmd=${c}`);
    return remoteDriveResults.get(cmdId);
  }
  // Le changement de vitesse (comme +/-) n'interrompt pas la navigation auto.
  if (CONFIG.NAV_ENABLE && navigator && c !== '+' && c !== '-' && !isSpeed) navigator.stop({ sendStop: false });
  debugLog(`[ROBOT_DRIVE][ARDUINO_SEND] id=${cmdId} cmd=${c} arduinoConnected=${arduino.connected}`);
  const sentPromise = sendDrive(c);
  remoteDriveResults.set(cmdId, sentPromise);
  setTimeout(() => remoteDriveResults.delete(cmdId), 5000);
  const sent = await sentPromise;
  debugLog(`[ROBOT_DRIVE][ARDUINO_RESULT] id=${cmdId} cmd=${c} sent=${sent}`);
  return sent;
}

function robotStatusPayload() {
  const gpsAgeMs = lastFix?.ts ? Date.now() - lastFix.ts : null;
  return {
    fix: !!lastFix,
    coords: lastFix
      ? { latitude: lastFix.latitude, longitude: lastFix.longitude }
      : null,
    gpsAgeMs,
    heading: lastFix?.heading ?? null,
    speedKnots: lastFix?.speedKnots ?? null,
    obstacleCm: lastObstacleCm,
    modeAbsent,
    arduinoConnected: arduino.connected,
    navActive: !!navigator?.running,
    sharing,
  };
}

function sendRobotStatus() {
  socket.emit('robot_status', {
    code: CONFIG.CODE,
    status: robotStatusPayload(),
  });
}

function announceRobotOnline() {
  const msg = `${ROBOT_ONLINE_BUZZ_PREFIX}${ROBOT_CLIENT_VERSION}:code=${CONFIG.CODE}:arduino=${arduino.connected ? '1' : '0'}`;
  debugLog(`[ROBOT_ONLINE][SEND] ${msg}`);
  socket.emit('buzz', { code: CONFIG.CODE, message: msg });
}

socket.on('connect', () => {
  log(`Connecte au serveur ${CONFIG.SERVER_URL} id=${socket.id}`);
  pair();
  setTimeout(rejouerAlerteEnAttente, 1500);
  setTimeout(() => {
    sendRobotStatus();
    announceRobotOnline();
  }, 1000);
});
socket.on('disconnect', (reason) => {
  log(`Deconnecte (${reason}).`);
  stopSharing();
});
socket.on('connect_error', (err) => log('Erreur connexion:', err.message));
socket.on('user_joined', (p) => log(`${p?.pseudo || 'Un contact'} a rejoint la room.`));
socket.on('user_left', () => {
  log('Le contact a quitte la room.');
  peerCoord = null;
});
socket.on('meet_request', (p) => {
  const from = p?.from || 'Ton contact';
  log(`"${from}" demande a se rejoindre.`);
  if (CONFIG.AUTO_ACCEPT) acceptMeet();
});
socket.on('meet_accepted', (p) => {
  log(`${p?.by || 'Le contact'} a accepte.`);
  meetActive = true;
  startSharing();
});
socket.on('meet_declined', (p) => {
  log(`${p?.by || 'Le contact'} a refuse.`);
  meetActive = false;
  stopSharing();
});
socket.on('meet_canceled', () => {
  log('"Se rejoindre" annule par le contact.');
  meetActive = false;
  stopSharing();
});
socket.on('peer_location', (p) => {
  const c = p?.coords;
  if (c && typeof c.latitude === 'number' && typeof c.longitude === 'number') {
    peerCoord = { latitude: c.latitude, longitude: c.longitude };
    log(`Position du contact: ${c.latitude.toFixed(6)}, ${c.longitude.toFixed(6)}`);
  }
});
// ========================
// Pan-tilt camera (2 servos branches sur l'Arduino)
// ========================
// L'app envoie des angles ABSOLUS (0..180) : rejouer un message en double est
// sans danger, mais on dedoublonne quand meme par id car chaque commande
// arrive par 2 canaux (socket 'robot_cam_move' + buzz de secours).
const camMoveSeen = new Map(); // id -> ts

// Sens des servos sur CE montage. true = retourne l'angle (180 - x).
// (Meme reglage possible dans le sketch Arduino via PAN_INVERT/TILT_INVERT,
// mais ici pas besoin de re-flasher : scp + restart suffisent.
// Si un jour tu actives TILT_INVERT dans le sketch, remets false ici,
// sinon la double inversion annule tout.)
const CAM_PAN_FLIP = true;  // gauche/droite inverse (constate le 14/11/2026)
const CAM_TILT_FLIP = true; // haut/bas inverse sans ce flip (reverifie le 18/11/2026 depuis l app)

// Position COURANTE des servos, en angles logiques (avant inversion).
// Mise a jour dans handleCamMove, qui est le point de passage UNIQUE de toute
// commande camera — app, canal de secours buzz, assistant vocal. Elle ne peut
// donc pas deriver : rien ne bouge les servos sans passer par ici.
// Utile pour les deplacements RELATIFS ("un peu plus a gauche"), que
// l'assistant vocal ne pourrait pas exprimer autrement : il ignore ou pointe
// la camera.
let camPan = 90;
let camTilt = 90;

// Bornes de securite. Les servos acceptent 0..180, mais un montage donne
// n'exploite pas toute la course : trop bas la camera filme ses propres roues,
// trop haut le ciel, et en butee mecanique le servo force et chauffe.
// Le pan est laisse libre par defaut (rotation generalement degagee) ; le tilt
// est restreint. A resserrer selon TON montage apres essai.
const CAM_PAN_MIN = Number(process.env.CAM_PAN_MIN || 0);
const CAM_PAN_MAX = Number(process.env.CAM_PAN_MAX || 180);
const CAM_TILT_MIN = Number(process.env.CAM_TILT_MIN || 50);
const CAM_TILT_MAX = Number(process.env.CAM_TILT_MAX || 150);

function handleCamMove(p) {
  const cmdId = String(p?.id || `cam-${Date.now()}`);
  if (camMoveSeen.has(cmdId)) {
    debugLog(`[CAM_MOVE][DEDUP] id=${cmdId}`);
    return true;
  }
  camMoveSeen.set(cmdId, Date.now());
  // Bascule de vue avant / arriere / double (2e webcam) — rien pour l'Arduino.
  if (p?.view === 'front' || p?.view === 'rear' || p?.view === 'both') {
    switchCameraView(p.view);
    debugLog(`[CAM_MOVE] id=${cmdId} view=${p.view}`);
    return true;
  }
  setTimeout(() => camMoveSeen.delete(cmdId), 5000);

  if (p?.center) {
    // Surtout PAS 'C' : sur le sketch flashe (rover_uart), 'C' ferme le
    // COUVERCLE de la boite. Le bouton "recentrer la camera" de l'app
    // refermait donc le couvercle sans prevenir. On envoie les deux angles
    // explicitement, ce qui recentre correctement quel que soit le sketch.
    // 90 est le centre : inverse ou non, 180 - 90 vaut 90. Les reglages
    // CAM_*_FLIP n'ont donc rien a corriger ici.
    const okPan = arduino.send('P90');
    const okTilt = arduino.send('T90');
    const ok = okPan || okTilt;
    camPan = 90;
    camTilt = 90;
    debugLog(`[CAM_MOVE] id=${cmdId} center ok=${ok}`);
    return ok;
  }
  const borne = (v, min, max) => Math.max(min, Math.min(max, Math.round(Number(v))));
  // Deplacement RELATIF (assistant vocal) : on part de la position memorisee.
  // Absolu (app) : la valeur envoyee fait foi. Les deux finissent bornes.
  const cible = (abs, delta, courant, min, max) => {
    if (Number.isFinite(Number(abs))) return borne(abs, min, max);
    if (Number.isFinite(Number(delta))) return borne(courant + Number(delta), min, max);
    return null;
  };

  let ok = false;
  const envoyes = [];
  const pan = cible(p?.pan, p?.panDelta, camPan, CAM_PAN_MIN, CAM_PAN_MAX);
  if (pan != null) {
    camPan = pan;
    const c = `P${CAM_PAN_FLIP ? 180 - pan : pan}`;
    envoyes.push(c);
    ok = arduino.send(c) || ok;
  }
  const tilt = cible(p?.tilt, p?.tiltDelta, camTilt, CAM_TILT_MIN, CAM_TILT_MAX);
  if (tilt != null) {
    camTilt = tilt;
    // 'T' et non 'U'. Le sketch reellement flashe (rover_uart) nomme
    // l'inclinaison 'T' et ignore 'U' — il accusait quand meme reception
    // ('ACK:U'), donc rien ne signalait la panne : le haut/bas de la camera
    // ne repondait tout simplement pas. Le pan ('P'), lui, marchait.
    // rover_uart.ino accepte desormais les deux, 'T' reste donc valable
    // apres reflashage.
    const c = `T${CAM_TILT_FLIP ? 180 - tilt : tilt}`;
    envoyes.push(c);
    ok = arduino.send(c) || ok;
  }
  // Journalise l'ANGLE REELLEMENT ENVOYE, pas seulement l'intention.
  // Sans ca, impossible de distinguer "l'app n'envoie rien", "elle envoie
  // toujours le meme angle" et "le servo ne bouge pas" : les trois donnent
  // exactement le meme symptome vu de l'exterieur.
  log(`Camera: pan=${camPan} tilt=${camTilt} -> Arduino ${envoyes.join(' ') || '(rien)'} ok=${ok}`);
  debugLog(`[CAM_MOVE] id=${cmdId} pan=${camPan} tilt=${camTilt} ok=${ok}`);
  return ok;
}

socket.on('robot_cam_move', (p) => {
  if (!p) return;
  handleCamMove(p);
});

socket.on('buzz', async (p) => {
  const message = String(p?.message || '');
  debugLog(`[BUZZ][IN] raw="${message}"`);
  if (message.startsWith(ROBOT_CAM_BUZZ_PREFIX)) {
    // Format: PING_ROBOT_CAM:<id>:P<pan>:U<tilt>  ou  PING_ROBOT_CAM:<id>:C
    const parts = message.slice(ROBOT_CAM_BUZZ_PREFIX.length).split(':');
    const id = parts.shift() || 'legacy';
    const payload = { id };
    for (const part of parts) {
      if (part === 'C') payload.center = true;
      else if (part[0] === 'P') payload.pan = Number(part.slice(1));
      else if (part[0] === 'U') payload.tilt = Number(part.slice(1));
      else if (part[0] === 'V') payload.view = part === 'V2' ? 'both' : part === 'V1' ? 'rear' : 'front';
    }
    handleCamMove(payload);
    return;
  }
  if (message.startsWith(ROBOT_DRIVE_BUZZ_PREFIX)) {
    const rest = message.slice(ROBOT_DRIVE_BUZZ_PREFIX.length);
    const parts = rest.split(':');
    const id = parts.length >= 2 ? parts[0] : 'legacy';
    const cmd = parts.length >= 2 ? parts[1] : parts[0];
    debugLog(`[BUZZ_DRIVE][IN] raw=${message} id=${id} cmd=${cmd}`);
    const sent = await handleRemoteDrive(cmd, 'buzz', id);
    const ack = `${ROBOT_ACK_BUZZ_PREFIX}${id}:${String(cmd || '').trim().toUpperCase()}:${sent ? 'OK' : 'ERR'}`;
    socket.emit('buzz', {
      code: CONFIG.CODE,
      message: ack,
    });
    debugLog(`[BUZZ_DRIVE][ACK_SENT] ${ack}`);
    sendRobotStatus();
    return;
  }
  if (message) log(`Message du contact: "${message}"`);
});
socket.on('robot_drive', async (p) => {
  const cmd = String(p?.cmd || '').trim().toUpperCase();
  const id = String(p?.id || `${cmd}-${Date.now()}`);
  debugLog(`[SOCKET_DRIVE][IN] id=${id} by=${p?.by || '?'} cmd=${cmd}`);
  // V<n> = vitesse absolue (ex "V180"). Elle etait rejetee ici alors que
  // handleRemoteDrive la gere : le curseur de vitesse de l'app et le reglage
  // fin de l'assistant vocal restaient donc sans effet.
  const isSpeedCmd = /^V\d{2,3}$/.test(cmd);
  if (!isSpeedCmd && (!'FBLRS+-'.includes(cmd) || cmd.length !== 1)) return;
  const sent = await handleRemoteDrive(cmd, p?.by || 'robot_drive', id);
  socket.emit('robot_drive_status', {
    code: CONFIG.CODE,
    id,
    cmd,
    ok: sent,
    message: sent ? 'Commande recue par le robot' : `Arduino non connecte (${CONFIG.ARDUINO_PORT})`,
  });
  debugLog(`[SOCKET_DRIVE][STATUS_SENT] id=${id} cmd=${cmd} ok=${sent}`);
  sendRobotStatus();
});
socket.on('robot_status_request', (p) => {
  debugLog(`[ROBOT_STATUS_REQUEST][IN] by=${p?.by || '?'} arduinoConnected=${arduino.connected} fix=${!!lastFix}`);
  sendRobotStatus();
});
socket.on('sync_batch', () => {});

let navigator;
let ronde; // rondes autonomes (voir ronde.js)
let navTarget = null; // destination finale envoyee par l'app

// --- Itineraire (carte OpenStreetMap) ---
// Sans itineraire, le robot fonce en ligne droite vers la destination : il
// traverse les murs, les haies et les proprietes. Avec, il suit le trace
// pieton d'OSM point par point, comme un GPS. Chaque point intermediaire
// devient une cible pour le Navigator, qui ne change pas d'un iota.
let navRoute = null; // [{latitude, longitude}, ...] ou null (ligne droite)
let navRouteIdx = 0;

// Distance a laquelle on considere un point de passage atteint. Plus large
// que le rayon d'arrivee final : inutile de viser juste au milieu d'une rue.
const WAYPOINT_RADIUS_M = Number(process.env.NAV_WAYPOINT_RADIUS_M || 6);

// Demande l'itineraire pieton a OSRM (le meme service que la carte de l'app).
async function chargerItineraire(depart, arrivee) {
  const url =
    `https://router.project-osrm.org/route/v1/foot/${depart.longitude},${depart.latitude};` +
    `${arrivee.longitude},${arrivee.latitude}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const data = await res.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    // OSM donne [longitude, latitude] ; on convertit et on allege le trace
    // (un point tous les ~8 m suffit, sinon le robot vise des points a 1 m).
    const pts = coords.map((c) => ({ latitude: c[1], longitude: c[0] }));
    const filtres = [pts[0]];
    for (const p of pts.slice(1)) {
      if (distanceMeters(filtres[filtres.length - 1], p) >= 8) filtres.push(p);
    }
    const dernier = pts[pts.length - 1];
    if (distanceMeters(filtres[filtres.length - 1], dernier) > 1) filtres.push(dernier);
    return filtres;
  } catch (e) {
    log(`Itineraire indisponible (${e.message}) -> navigation en ligne droite.`);
    return null;
  }
}
let lastObstacleCm = null;
let sensorSeen = false;

// Donnees du capteur pour la carte (capteur.js) : lignes
// x_m,y_m,heading_deg,sensor_angle_deg,distance_cm envoyees au serveur par
// WebSocket. Le code de Pauline appelle capteur.envoyer('0,0,0,0,143') ;
// les lignes de ce format ecrites par l'Arduino partent aussi toutes seules.
const capteur = CONFIG.CAPTEUR_ENABLE
  ? new CanalCapteur({
      serverUrl: CONFIG.SERVER_URL,
      code: CONFIG.CODE,
      cle: CONFIG.ROBOT_KEY,
      session: CONFIG.CAPTEUR_SESSION,
      log,
    })
  : null;

const arduino = new Arduino({
  port: CONFIG.ARDUINO_PORT,
  baud: CONFIG.ARDUINO_BAUD,
  log,
  onLigneCapteur: (ligne) => {
    if (capteur) capteur.envoyer(ligne);
  },
  onSensor: (cm) => {
    lastObstacleCm = cm;
    if (!sensorSeen) {
      sensorSeen = true;
      log(`Capteur ultrason detecte (lecture: ${cm} cm).`);
    }
    if (navigator) navigator.setObstacle(cm);
  },
  // Radar de presence (LD2410). Il ne parle qu'aux changements d'etat.
  onPresence: (present) => {
    presenceEtat = present;
    log(`Presence: ${present ? 'DETECTEE' : 'plus personne'}.`);
    // Le mode fait foi : en mode NORMAL le robot voit mais ne dit rien. C'est
    // le sens des deux modes, et ca evite d'etre alerte quand on est chez soi.
    if (!present || !surveillanceArmee()) return;
    const temoinsRadar = alerteAutorisee('radar');
    if (!temoinsRadar) return;

    // On PARLE d'abord, sans attendre la photo : la capture prend une seconde
    // ou deux, et pendant ce temps l'intrus est encore la. Le dissuader tout
    // de suite compte plus que l'ordre des operations.
    // Le robot reste MUET. Se signaler previent l'intrus qu'il est filme :
    // il se cache ou s'en va, et la photo ne vaut plus rien. C'est depuis
    // l'app, une fois l'image vue, que tu decides de parler ou de declencher
    // l'alarme.

    // Puis la photo, envoyee avec l'alerte : une notification qui montre ce
    // que le robot a vu vaut dix notifications qui l'affirment.
    // Si la veille visuelle tourne, son image est deja prete : le radar en
    // profite aussi, et son alerte part instantanement.
    const ageVeille = Date.now() - mouvJpegAt;
    if (mouvJpeg && ageVeille < 3000) {
      log(`Presence: photo immediate (${ageVeille} ms).`);
      envoyerAlerte({ code: CONFIG.CODE, type: 'presence', capteurs: temoinsRadar, photo: mouvJpeg.toString('base64') });
      return;
    }
    (async () => {
      let photo = null;
      try {
        const shot = await grabSingleFrame(CONFIG.VOICE_CAMERA_DEVICE);
        if (shot) photo = Buffer.from(shot).toString('base64');
      } catch (e) {
        log('Presence: photo impossible :', e.message);
      }
      envoyerAlerte({ code: CONFIG.CODE, type: 'presence', capteurs: temoinsRadar, photo });
    })();
  },
  onConnect: () => {
    // Demande au firmware de se nommer. Avec une dizaine de sketches dans le
    // dossier, savoir lequel tourne reellement a coute deux erreurs de
    // diagnostic : on ne devine plus, on demande a chaque connexion.
    // L'ancien firmware ne connait pas 'I' et se contente d'un ACK — c'est
    // justement ce silence qui nous dira qu'il n'a pas ete reflashe.
    arduino.send('I');
    if (CONFIG.MOTOR_SPEED_BOOT > 0) {
      const v = Math.max(0, Math.min(255, Math.round(CONFIG.MOTOR_SPEED_BOOT)));
      const ok = arduino.send(`V${v}`);
      log(`Moteurs: vitesse imposee a ${v}/255${ok ? '' : " (echec d'envoi)"}.`);
    }
    // Equilibrage : envoye et journalise TOUJOURS, meme a 100/100.
    //
    // Premiere version : on ne disait rien quand il n'y avait rien a
    // corriger. Mauvaise idee — l'absence de ligne ne permettait pas de
    // distinguer "reglage neutre applique" de "fichier pas recharge", et
    // c'est exactement la question qu'on se pose en reglant. Une ligne de
    // journal de plus coute moins cher qu'un doute.
    const g = Math.max(0, Math.min(100, Math.round(CONFIG.MOTOR_TRIM_LEFT)));
    const d = Math.max(0, Math.min(100, Math.round(CONFIG.MOTOR_TRIM_RIGHT)));
    arduino.send(`G${g}`);
    arduino.send(`H${d}`);
    log(
      `Moteurs: equilibrage gauche ${g} % / droite ${d} %` +
      (g === 100 && d === 100 ? ' (neutre, aucune correction).' : '.')
    );
    // Demarrage progressif. Envoye meme a 0 : c'est ainsi qu'on peut le
    // DESACTIVER depuis le service sans reflasher l'Arduino.
    if (Number.isFinite(CONFIG.MOTOR_SOFT_START)) {
      const j = Math.max(0, Math.min(255, Math.round(CONFIG.MOTOR_SOFT_START)));
      arduino.send(`J${j}`);
      log(`Moteurs: demarrage progressif a partir de ${j}/255 (avant/arriere seulement).`);
    }
  },
});

navigator = new Navigator({
  getRobot: () => {
    if (!lastFix) return { fix: false };
    const h = compass && typeof compass.getHeading === 'function' ? compass.getHeading() : null;
    if (h != null) return { fix: true, ...lastFix, heading: h, headingValid: true, headingSource: 'compass' };
    return { fix: true, ...lastFix, headingSource: lastFix.headingValid ? 'gps' : null };
  },
  // Cible du moment : le prochain point de l'itineraire s'il y en a un,
  // sinon la destination finale (ou le contact a rejoindre).
  getTarget: () => {
    if (navRoute && navRouteIdx < navRoute.length) return navRoute[navRouteIdx];
    return navTarget || peerCoord;
  },
  send: (cmd) => arduino.send(cmd),
  log,
  opts: {
    tickMs: CONFIG.NAV_TICK_MS,
    angleTol: CONFIG.NAV_ANGLE_TOL,
    oscillationForwardTol: CONFIG.NAV_OSCILLATION_TOL,
    arrivalRadius: CONFIG.ARRIVAL_RADIUS_M,
    obstacleStopCm: CONFIG.OBSTACLE_STOP_CM,
    gpsMeasureForwardTicks: CONFIG.NAV_GPS_MEASURE_TICKS,
  },
  onArrived: (d) => {
    // Point de passage atteint : on enchaine sur le suivant sans s'arreter.
    if (navRoute && navRouteIdx < navRoute.length - 1) {
      navRouteIdx++;
      const reste = navRoute.length - 1 - navRouteIdx;
      log(`Point de passage atteint (${d} m). Suivant : ${navRouteIdx}/${navRoute.length - 1} (${reste} restants).`);
      // Dernier point = la vraie destination : on repasse en visee precise.
      if (navRouteIdx === navRoute.length - 1 && navigator) {
        navigator.opts.arrivalRadius = CONFIG.ARRIVAL_RADIUS_M;
      }
      return; // le Navigator continue, avec la nouvelle cible
    }
    log(`Robot arrive a destination (${d} m).`);
    navTarget = null;
    navRoute = null;
    navRouteIdx = 0;
    setImmediate(() => {
      if (navigator) navigator.stop({ sendStop: true });
    });
    // Ronde en cours : c'est elle qui decide de la suite (pause puis tour
    // suivant). On ne signale donc pas une fin de navigation a l'app.
    if (ronde && ronde.onArrivee()) return;
    socket.emit('robot_nav_status', { code: CONFIG.CODE, arrived: true, on: false });
  },
});

// --- Rondes autonomes ------------------------------------------------------
// Rejoue en boucle un circuit appris en pilotant le robot une fois. La boucle
// vit dans le robot pour survivre aux coupures de 4G.
ronde = new Ronde({
  getFix: () => lastFix,
  log,
  pauseMs: Number(process.env.RONDE_PAUSE_MIN || 5) * 60000,
  pasM: Number(process.env.RONDE_PAS_M || 4),
  dureeMaxMs: Number(process.env.RONDE_DUREE_MAX_MIN || 30) * 60000,
  // Installe la trace comme itineraire et met le robot en route. On reutilise
  // exactement le mecanisme de "aller_a" : navRoute + Navigator, avec la
  // gestion d'obstacle et l'avancement des points de passage deja en place.
  lancerTrajet: (points) => {
    navRoute = points;
    navRouteIdx = 0;
    navTarget = points[points.length - 1];
    if (navigator) {
      navigator.opts.arrivalRadius = WAYPOINT_RADIUS_M;
      navigator.start();
    }
  },
  arreterTrajet: () => {
    navRoute = null;
    navRouteIdx = 0;
    navTarget = null;
    if (navigator) navigator.stop({ sendStop: true });
  },
  onEtat: (etat) => socket.emit('robot_ronde_status', { code: CONFIG.CODE, ...etat }),
});

function printHelp() {
  console.log(`
Commandes:
  F / B / L / R / S  commande moteur directe
  + / -              accelerer / ralentir
  cam <pan> <tilt>   oriente la camera (angles 0..180, ex: cam 45 120)
  cam c              recentre la camera (90/90)
  cam av / cam ar    bascule camera AVANT / ARRIERE
  cam both           image combinee avant+arriere (70/30)
  T                  avance 1.5s puis stop (test Arduino)
  1                  test cote gauche
  2                  test cote droit
  join               envoyer une demande "Se rejoindre"
  accept             accepter une demande
  stop / cancel      annuler "Se rejoindre"
  pos                afficher la position GPS
  capteur            etat de l'envoi des donnees du capteur
  capteur <ligne>    envoyer une ligne x_m,y_m,heading_deg,sensor_angle_deg,distance_cm
  capteur session    commencer une nouvelle session (nouveau fichier sur le serveur)
  ports              afficher les ports serie
  msg <texte>        envoyer un message
  help               aide
  quit               quitter
`);
}

async function listSerialPorts() {
  try {
    const ports = await SerialPort.list();
    if (!ports.length) {
      log('Aucun port serie detecte.');
      return;
    }
    ports.forEach((p) => log(`Port serie: ${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ''}`));
  } catch (e) {
    log('Impossible de lister les ports serie:', e.message);
  }
}

async function sendDrive(cmd) {
  const c = String(cmd || '').trim().toUpperCase();
  const isSpeed = /^V\d{2,3}$/.test(c);
  const isMix = /^M-?\d{1,3},-?\d{1,3}$/.test(c);
  if (!isSpeed && !isMix && (!'FBLRST12+-'.includes(c) || c.length !== 1)) {
    log(`Commande moteur invalide: "${cmd}"`);
    return false;
  }
  if (isMix) {
    // Pilotage differentiel : pas d'attente d'ACK, comme la vitesse. Ces
    // ordres partent en rafale, les attendre un par un ajouterait du retard
    // la ou il faut au contraire etre reactif.
    return arduino.send(c);
  }
  if (isSpeed) {
    // Vitesse absolue : envoi direct sans attendre d'ACK (liaison souvent a
    // sens unique), l'Arduino borne lui-meme la valeur MIN..MAX.
    const ok = arduino.send(c);
    log(ok ? `Arduino <- ${c} (vitesse)` : `Vitesse non envoyee (Arduino deconnecte ?)`);
    return ok;
  }
  const result = await arduino.sendWithAck(c, 1200);
  if (result.ok) debugLog(`Arduino <- ${c} confirme par ${result.line}`);
  else log(`Arduino ACK absent pour ${c}: ${result.message || 'aucun retour'}. Verifie ARDUINO_PORT=${CONFIG.ARDUINO_PORT} et le sketch.`);
  return result.ok;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt('robot> ');
rl.on('line', (input) => {
  const line = input.trim();
  if (line) log(`Commande recue: "${line}"`);

  // "direct &&" obligatoire : includes('') renvoie true, et sans ce garde
  // TOUTES les commandes a plusieurs mots (cam, msg, pos...) partaient dans
  // sendDrive('') au lieu d'atteindre le switch ci-dessous.
  const direct = line.length === 1 ? line.toUpperCase() : '';
  if (direct && 'FBLRST12+-'.includes(direct)) {
    sendDrive(direct);
    rl.prompt();
    return;
  }

  const [cmdRaw, ...rest] = line.split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase();

  switch (cmd) {
    case 'capteur': {
      if (!capteur) {
        log('Capteur desactive (CAPTEUR_ENABLE=false).');
        break;
      }
      if (!rest.length) log(`Capteur: ${JSON.stringify(capteur.etat())}`);
      else if (rest[0].toLowerCase() === 'session') capteur.nouvelleSession(rest[1]);
      else if (capteur.envoyer(rest.join(''))) log(`Capteur: ligne "${rest.join('')}" mise en file.`);
      break;
    }
    case 'drive':
      sendDrive(rest[0]);
      break;
    case 'cam': {
      const sub = (rest[0] || '').toLowerCase();
      if (sub === 'c') {
        handleCamMove({ id: `cli-${Date.now()}`, center: true });
        break;
      }
      if (sub === 'av' || sub === 'ar' || sub === 'both' || sub === '2') {
        const view = sub === 'ar' ? 'rear' : sub === 'av' ? 'front' : 'both';
        handleCamMove({ id: `cli-${Date.now()}`, view });
        break;
      }
      const pan = Number(rest[0]);
      const tilt = Number(rest[1]);
      if (!Number.isFinite(pan) && !Number.isFinite(tilt)) {
        log('Usage: cam <pan 0..180> <tilt 0..180>  ou  cam c');
        break;
      }
      handleCamMove({ id: `cli-${Date.now()}`, pan, tilt });
      break;
    }
    case 'join':
      requestMeet();
      break;
    case 'accept':
      acceptMeet();
      break;
    case 'stop':
    case 'cancel':
      cancelMeet();
      break;
    case 'pos':
      log(lastFix ? `${lastFix.latitude}, ${lastFix.longitude}` : 'Pas encore de fix GPS.');
      break;
    case 'capteur':
    case 'mur':
      log(
        lastObstacleCm == null
          ? 'Capteur: AUCUNE lecture (non branche, ou mauvais cablage Echo=A4 / Trig=A5).'
          : `Capteur: ${lastObstacleCm} cm`
      );
      break;
    case 'cap': {
      const h =
        compass && typeof compass.getHeading === 'function' ? compass.getHeading() : null;
      if (h == null) {
        log('Cap: boussole indisponible (lance avec la boussole activee).');
        break;
      }
      let msg = `Cap boussole: ${Math.round(h)}°`;
      if (lastFix && peerCoord) {
        const b = bearing(lastFix, peerCoord);
        const off = Math.round(((b - h + 540) % 360) - 180);
        msg += ` | cap vers contact: ${Math.round(b)}° | ecart: ${off}°`;
        msg += ` | si le robot VISE le contact -> relance avec DECLINATION=${off}`;
      } else {
        msg += ' | (lance un "Se rejoindre" pour comparer au cap du contact)';
      }
      log(msg);
      break;
    }
    case 'ports':
      listSerialPorts();
      break;
    case 'msg':
      sendMessage(rest.join(' '));
      break;
    case 'help':
    case '?':
      printHelp();
      break;
    case 'quit':
    case 'exit':
      arduino.stop();
      process.exit(0);
      break;
    case '':
      break;
    default:
      log(`Commande inconnue: "${cmd}". Tape help.`);
  }

  rl.prompt();
});

log('Demarrage robot Ping');
log(`VERSION ROBOT: ${ROBOT_CLIENT_VERSION}`);
log(`Serveur: ${CONFIG.SERVER_URL}`);
log(`Pseudo: ${CONFIG.PSEUDO}  Code: ${CONFIG.CODE}`);
log(`Heartbeat robot: ${CONFIG.ROBOT_HEARTBEAT_MS} ms`);
log(`GPS: ${CONFIG.GPS_ENABLE ? `${CONFIG.GPS_PORT} @ ${CONFIG.GPS_BAUD}` : 'desactive'}`);
log(`Arduino moteurs: ${CONFIG.ARDUINO_PORT} @ ${CONFIG.ARDUINO_BAUD}`);
printHelp();

startGps();

if (CONFIG.COMPASS_ENABLE) {
  try {
    const { Compass } = require('./compass');
    compass = new Compass({ log, declination: Number(process.env.DECLINATION || 0) });
    compass.start();
  } catch (e) {
    log('Boussole indisponible:', e.message);
  }
} else {
  log('Boussole desactivee: navigation au cap GPS.');
}

// L'Arduino doit toujours etre connecte: il sert au pilotage manuel
// (F/B/L/R/S) ET a la navigation auto. Avant, il n'etait ouvert que si
// NAV_ENABLE=true, donc desactiver la nav coupait aussi les commandes manuelles.
arduino.connect();
log(`Arduino attendu sur ${CONFIG.ARDUINO_PORT}.`);
if (CONFIG.NAV_ENABLE) {
  log('Navigation auto activee.');
}

// ========================
// Camera (webcam) — flux a la demande
// ========================
let camera = null;
let lastViewerPingAt = 0;
let cameraFrames = 0;

// Qualite du signal 4G (SINR/RSRP) lue sur l'interface HiLink de la cle
// Huawei (192.168.8.1), rafraichie en fond. Le SINR commande le debit video :
// bon signal dehors = la cle tient 1+ Mb/s, SINR negatif (interieur) =
// ~150 kb/s reels (mesures du 29/07). null = signal inconnu.
let modemSignal = { sinr: null, rsrp: null, at: 0 };
function pollModemSignal() {
  const api = CONFIG.RTC_MODEM_API;
  if (!api) return;
  // L'API HiLink exige un jeton de session (2 requetes chainées).
  const cmd =
    `TOK=$(curl -s --max-time 3 ${api}/api/webserver/SesTokInfo); ` +
    `SES=$(echo "$TOK" | grep -oP "(?<=<SesInfo>)[^<]+"); ` +
    `T=$(echo "$TOK" | grep -oP "(?<=<TokInfo>)[^<]+"); ` +
    `curl -s --max-time 3 -H "Cookie: $SES" -H "__RequestVerificationToken: $T" ${api}/api/device/signal`;
  require('child_process').exec(cmd, { timeout: 9000 }, (err, out) => {
    if (err || !out) return;
    const sinr = /<sinr>(-?[\d.]+)/.exec(out);
    const rsrp = /<rsrp>(-?[\d.]+)/.exec(out);
    if (sinr) {
      modemSignal = {
        sinr: Number(sinr[1]),
        rsrp: rsrp ? Number(rsrp[1]) : null,
        at: Date.now(),
      };
    }
  });
}
if (CONFIG.RTC_ENABLE && CONFIG.RTC_MODEM_API) {
  pollModemSignal();
  setInterval(pollModemSignal, 20000);
}

// Definitions de capture. Seules ces deux tailles sont utilisees : elles sont
// toutes deux confirmees en MJPEG natif sur la webcam (aucun re-encodage a
// l'entree, donc aucun cout CPU pour capturer).
const SD = { width: 640, height: 360 };
const HD = { width: 1280, height: 720 };

// Choisit le debit H.264 au demarrage de chaque session camera :
// WiFi/Ethernet = confortable ; 4G = selon le SINR de la cle ; signal
// inconnu = reglages de secours prudents.
function rtcLinkProfile() {
  try {
    const { execSync } = require('child_process');
    const route = execSync(`ip route get ${CONFIG.RTC_HOST} 2>/dev/null`, { timeout: 3000 }).toString();
    if (/dev (wlan0|eth0)/.test(route)) {
      // Pas de contrainte de debit a la maison, et le Pi 5 a de la marge :
      // mesure du 03/08, libx264 encode du 640x360@15 a 9,7x le temps reel.
      // Le 720p coute 4x plus de pixels -> il reste ~2,4x le temps reel.
      return { bitrate: '2500k', fps: 25, ...HD, via: 'wifi/ethernet' };
    }
  } catch {}
  // En 4G on reste en 640x360 QUELLE QUE SOIT la puissance du Pi : le facteur
  // limitant n'est pas le processeur mais le lien montant (150-500 kb/s
  // mesures). Du 720p a 250 kb/s serait une bouillie de pixels ; a debit egal,
  // une petite image nette vaut mieux qu'une grande floue.
  const s = modemSignal;
  if (s.sinr != null && Date.now() - s.at < 60000) {
    const via = `4G (SINR ${s.sinr} dB)`;
    if (s.sinr >= 13 && (s.rsrp == null || s.rsrp >= -100)) return { bitrate: '1000k', fps: 15, ...SD, via };
    if (s.sinr >= 6) return { bitrate: '700k', fps: 15, ...SD, via };
    if (s.sinr >= 0) return { bitrate: '450k', fps: 12, ...SD, via };
    return { bitrate: '250k', fps: 10, ...SD, via };
  }
  return {
    bitrate: CONFIG.RTC_BITRATE,
    fps: CONFIG.RTC_FPS,
    width: CONFIG.CAMERA_WIDTH,
    height: CONFIG.CAMERA_HEIGHT,
    via: '4G (signal inconnu)',
  };
}

// URL de publication RTSP vers MediaMTX (vide = video WebRTC desactivee).
function rtcPushUrl() {
  if (!CONFIG.RTC_ENABLE) return '';
  if (CONFIG.RTC_PUSH_URL) return CONFIG.RTC_PUSH_URL;
  if (!CONFIG.RTC_PASS) return '';
  return `rtsp://${CONFIG.RTC_USER}:${CONFIG.RTC_PASS}@${CONFIG.RTC_HOST}:${CONFIG.RTC_PORT}/robot-${CONFIG.CODE}`;
}

// L'app envoie 'robot_rtc' {on:true} regulierement tant que sa lecture WebRTC
// est CONNECTEE. Dans ce cas les images socket ne servent plus qu'aux photos
// et de vignette de secours -> ~1 img/s au lieu de la pleine cadence, pour ne
// pas faire passer la video deux fois sur la meme 4G.
let rtcViewingAt = 0;
socket.on('robot_rtc', (p) => {
  rtcViewingAt = p && p.on ? Date.now() : 0;
});
const rtcViewing = () => Date.now() - rtcViewingAt < 6000;
let lastPushedFrameAt = 0;

// --- Envoi des images auto-regule (anti-lag) ---
// On ne garde QUE la derniere image et on n'envoie la suivante que quand le
// serveur a accuse reception de la precedente. Resultat : jamais de file
// d'attente dans le tampon TCP (c'etait CA le retard video), le debit s'adapte
// tout seul au reseau (WiFi rapide = 12 img/s, 4G faible = moins mais TOUJOURS
// l'image la plus fraiche).
let pendingFrame = null;
let framePumpBusy = false;
// Si le serveur du VPS ne renvoie pas encore d'ACK (ancienne version), on
// bascule sur l'ancien mode volatile apres 3 timeouts consecutifs.
let frameAckSupported = null;
let frameAckTimeouts = 0;

// Derniere image camera gardee en memoire : l'assistant vocal s'en sert pour
// "regarder" sans relancer la camera.
let lastFrame = null;
let lastFrameAt = 0;

function pushCameraFrame(buf) {
  lastFrame = buf;
  lastFrameAt = Date.now();
  if (!socket.connected) return;
  // Tri en JS : avec la sortie H.264 active, ffmpeg copie le MJPEG natif a
  // pleine cadence sur le pipe (gratuit). On ne fait PARTIR sur le socket que
  // le necessaire : ~1 img/s si le WebRTC de l'app est connecte, sinon la
  // cadence de l'echelle reseau (mode secours complet).
  // 1 image/3s pendant le direct WebRTC : a ~20 Ko l'image native, 1/s
  // mangeait ~150 kb/s, enorme sur une 4G bridee. 1/3s suffit pour la photo.
  const minGapMs = rtcViewing() ? 3000 : Math.round(1000 / targetCameraFps());
  if (Date.now() - lastPushedFrameAt < minGapMs) return;
  lastPushedFrameAt = Date.now();
  // Envoi BINAIRE (socket.io gere les Buffer nativement) : 25% de data en
  // moins que l'ancien base64, et zero encodage CPU sur le Pi.
  if (frameAckSupported === false) {
    socket.volatile.emit('robot_frame', { code: CONFIG.CODE, jpeg: buf });
    cameraFrames++;
    if (cameraFrames % 60 === 0) debugLog(`Camera: ${cameraFrames} images envoyees (mode volatile).`);
    return;
  }
  pendingFrame = buf;
  if (!framePumpBusy) pumpCameraFrames();
}

async function pumpCameraFrames() {
  framePumpBusy = true;
  while (pendingFrame && socket.connected && frameAckSupported !== false) {
    const buf = pendingFrame;
    pendingFrame = null;
    const sentAt = Date.now();
    const acked = await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 2500);
      socket.emit('robot_frame', { code: CONFIG.CODE, jpeg: buf }, () => {
        if (!done) { done = true; clearTimeout(timer); resolve(true); }
      });
    });
    if (acked) {
      frameAckSupported = true;
      frameAckTimeouts = 0;
      const rtt = Date.now() - sentAt;
      onFrameRtt(rtt); // alimente l'echelle de debit automatique
      cameraFrames++;
      if (cameraFrames % 60 === 0) {
        debugLog(`Camera: ${cameraFrames} images envoyees (trajet ~${frameRttEma}ms, niveau reseau ${netLevel}).`);
      }
      // Pause anti-embouteillage : apres chaque image on laisse le tuyau 4G
      // respirer ~60% du temps de trajet mesure. Sans ca le lien est plein a
      // 100% et les commandes de pilotage font la queue derriere la video
      // (c'etait LA cause du bouton qui repond en 1 seconde).
      const pause = Math.min(1500, Math.round(rtt * 0.6));
      if (pause > 15) await new Promise((r) => setTimeout(r, pause));
    } else if (frameAckSupported !== true) {
      frameAckTimeouts++;
      if (frameAckTimeouts >= 3) {
        frameAckSupported = false;
        log('Camera: serveur sans ACK image (ancienne version), retour au mode volatile.');
      }
    } else {
      // L'ACK marchait puis une image a mis > 2.5s : reseau tres charge.
      setNetLevel(netLevel + 1, 'image perdue (timeout)');
    }
  }
  framePumpBusy = false;
}

// Vue en cours : 'front' (camera pan-tilt), 'rear' (2e webcam), 'both' (image
// combinee 70/30 avant+arriere, utilisee en plein ecran paysage sur l'app).
let cameraView = 'front';

function currentCameraDevice() {
  return cameraView === 'rear' ? CONFIG.CAMERA_DEVICE_REAR : CONFIG.CAMERA_DEVICE;
}

function applyCameraView() {
  if (!camera) return;
  // En 'both' on impose la camera AVANT comme entree gauche : sinon, si on
  // etait en vue arriere juste avant, le composite prendrait 2x la meme camera.
  if (cameraView === 'both') camera.setView({ mode: 'both', device: CONFIG.CAMERA_DEVICE });
  else camera.setView({ mode: 'single', device: currentCameraDevice() });
}

function switchCameraView(view) {
  if (view !== 'front' && view !== 'rear' && view !== 'both') return;
  if (view === cameraView) return;
  cameraView = view;
  const label = view === 'both' ? 'DOUBLE 70/30' : view === 'rear' ? 'ARRIERE' : 'AVANT';
  log(`Camera: vue ${label}.`);
  applyCameraView();
}

function startCameraStream() {
  if (!CONFIG.CAMERA_ENABLE) {
    log('Camera desactivee (CAMERA_ENABLE=false).');
    return;
  }
  // Pendant un enregistrement HD, le peripherique est pris : un v4l2 ne
  // s'ouvre pas deux fois. Sans ce garde-fou, le premier spectateur qui
  // arrive relancerait le flux et ferait echouer la prise.
  if (recHdProc) return;
  if (!camera) {
    camera = new Camera({
      device: CONFIG.CAMERA_DEVICE,
      deviceRear: CONFIG.CAMERA_DEVICE_REAR,
      width: CONFIG.CAMERA_WIDTH,
      height: CONFIG.CAMERA_HEIGHT,
      fps: targetCameraFps(),
      quality: targetCameraQuality(),
      compositeFps: CONFIG.CAMERA_FPS_BOTH,
      splitPct: CONFIG.CAMERA_SPLIT_PCT,
      rtspUrl: rtcPushUrl(),
      rtcFps: CONFIG.RTC_FPS,
      rtcBitrate: CONFIG.RTC_BITRATE,
      audioDevice: micPartage(),
      rtcAudio: CONFIG.RTC_AUDIO && CONFIG.AUDIO_ENABLE,
      audioBitrate: CONFIG.RTC_AUDIO_BITRATE,
      log,
      onFrame: (buf) => pushCameraFrame(buf),
    });
    applyCameraView(); // applique la vue courante (front/rear/both) au demarrage
  }
  applyCameraBandwidth(); // met les bons reglages avant de demarrer
  if (!camera.streaming) {
    // Ajuste le H.264 a la route du moment (WiFi maison vs cle 4G).
    const prof = rtcLinkProfile();
    if (
      camera.rtcBitrate !== prof.bitrate ||
      camera.rtcFps !== prof.fps ||
      camera.width !== prof.width
    ) {
      log(
        `Camera: liaison ${prof.via} -> ${prof.width}x${prof.height} H.264 ${prof.bitrate}@${prof.fps}.`
      );
      camera.rtcBitrate = prof.bitrate;
      camera.rtcFps = prof.fps;
      // La resolution suit la liaison : 720p a la maison, 640x360 en 4G.
      // Lu par _buildArgs() au prochain camera.start(), comme le debit.
      camera.width = prof.width;
      camera.height = prof.height;
    }
    log('Camera: un spectateur regarde -> demarrage du flux.');
    // La camera va publier le son elle-meme : on coupe le publieur autonome,
    // sinon deux flux se disputeraient le meme chemin RTSP.
    stopRtcAudioOnly();
    camera.start();
  }
}

// --- Echelle de debit reseau automatique ---
// Niveau 0 = reseau parfait (WiFi/4G pleine barre) ... 4 = 4G tres faible.
// On mesure le temps de trajet de CHAQUE image (via l'ACK du serveur) : si ca
// depasse ~700 ms on descend d'un niveau (moins d'images, plus compressees),
// si ca redevient rapide on remonte doucement. Objectif : les commandes de
// pilotage ne font JAMAIS la queue derriere la video.
// (q mjpeg : 2 = net/lourd .. 31 = tres compresse/leger)
const NET_LADDER = [
  { fps: CONFIG.CAMERA_FPS, quality: CONFIG.CAMERA_QUALITY }, // niveau 0
  { fps: 10, quality: 15 },
  { fps: 8, quality: 18 },
  { fps: 6, quality: 22 },
  { fps: 4, quality: 26 },
];
let netLevel = 1; // demarrage prudent ; remonte tout seul en ~12s si reseau bon
let netLevelChangedAt = 0;
let frameRttEma = 0; // moyenne glissante du trajet d'une image (ms)

function currentLadder() {
  // L'ecoute audio passe par la meme 4G -> on se bride d'un niveau de plus.
  const lvl = Math.min(NET_LADDER.length - 1, netLevel + (audioActive ? 1 : 0));
  return NET_LADDER[lvl];
}
function targetCameraFps() {
  return currentLadder().fps;
}
function targetCameraQuality() {
  return currentLadder().quality;
}

function setNetLevel(next, reason) {
  next = Math.max(0, Math.min(NET_LADDER.length - 1, next));
  if (next === netLevel) return;
  netLevel = next;
  netLevelChangedAt = Date.now();
  const l = currentLadder();
  log(`Reseau: niveau ${netLevel} (${reason}) -> camera ${l.fps} img/s q${l.quality}.`);
  applyCameraBandwidth();
}

function onFrameRtt(rtt) {
  frameRttEma = frameRttEma ? Math.round(frameRttEma * 0.7 + rtt * 0.3) : rtt;
  const since = Date.now() - netLevelChangedAt;
  // Reactif a la baisse (le lag se sent tout de suite), prudent a la hausse
  // (chaque changement relance ffmpeg = ~0.5s de gel d'image).
  if (frameRttEma > 700 && since > 4000) setNetLevel(netLevel + 1, `image lente ${frameRttEma}ms`);
  else if (frameRttEma < 220 && since > 12000) setNetLevel(netLevel - 1, `reseau fluide ${frameRttEma}ms`);
}
// Applique le mode eco/normal a la camera. Si elle filme, relance ffmpeg ;
// sinon met juste a jour les valeurs pour le prochain demarrage.
function applyCameraBandwidth() {
  if (!camera) return;
  camera.reconfigure({ fps: targetCameraFps(), quality: targetCameraQuality() });
}

function stopCameraStream() {
  if (camera && camera.streaming) {
    log('Camera: plus de spectateur -> arret du flux.');
    camera.stop();
  }
}

// L'app envoie 'robot_camera' {on:true} regulierement tant qu'elle regarde,
// et {on:false} quand elle ferme la vue.
socket.on('robot_camera', (p) => {
  const on = !!(p && p.on);
  if (on) {
    lastViewerPingAt = Date.now();
    startCameraStream();
  } else {
    lastViewerPingAt = 0;
    stopCameraStream();
  }
});

// Securite : coupe le flux si l'app ne renouvelle plus sa demande
// (app fermee, reseau coupe) -> economise CPU et data du Pi.
setInterval(() => {
  if (camera && camera.streaming && Date.now() - lastViewerPingAt > 6000) {
    stopCameraStream();
  }
}, 2000);

if (CONFIG.CAMERA_ENABLE) {
  log(`Camera prete: ${CONFIG.CAMERA_DEVICE} ${CONFIG.CAMERA_WIDTH}x${CONFIG.CAMERA_HEIGHT}@${CONFIG.CAMERA_FPS} (flux a la demande).`);
}

// ========================
// Micro (audio webradio) — flux a la demande
// ========================
let audio = null;
let lastListenerPingAt = 0;
let audioActive = false; // un auditeur ecoute -> camera en mode eco

// Micro effectivement utilise pour le flux audio (WebRTC / mp3). Il est deja
// normalise vers le peripherique partage et stable de la Webcam ML plus haut.
function micPartage() {
  return CONFIG.AUDIO_DEVICE;
}

function startAudioStream() {
  if (!CONFIG.AUDIO_ENABLE) {
    log('Audio desactive (AUDIO_ENABLE=false).');
    return;
  }
  // Toujours produire le MP3 de secours, meme si une piste WebRTC est
  // annoncee. Une session WHEP peut exister sans recevoir le moindre paquet ;
  // dans ce cas l'app doit avoir un vrai flux de repli. Le micro passe par
  // dsnoop, donc MP3, WebRTC et assistant vocal peuvent le lire en parallele.
  if (!audio) {
    audio = new Audio({
      device: micPartage(),
      serverUrl: CONFIG.SERVER_URL,
      code: CONFIG.CODE,
      sampleRate: CONFIG.AUDIO_SAMPLE_RATE,
      bitrate: CONFIG.AUDIO_BITRATE,
      log,
    });
  }
  if (!audio.streaming) {
    log('Audio: un auditeur ecoute -> demarrage du micro.');
    audio.start();
  }
}

function stopAudioStream() {
  if (audio && audio.streaming) {
    log('Audio: plus d\'auditeur -> arret du micro.');
    audio.stop();
  }
  stopRtcAudioOnly();
}

// --- Ecoute seule en WebRTC (sans la camera) ---
// La piste Opus etait produite par le ffmpeg de la camera : pas de video =
// pas de son. Or sur iPhone le repli mp3 est bloque (regle ATS), donc "juste
// ecouter" ne fonctionnait pas du tout. Ce publieur autonome envoie le micro
// vers le meme chemin RTSP (<url>-audio) quand la camera ne tourne pas.
let rtcAudioProc = null;

function startRtcAudioOnly() {
  if (rtcAudioProc) return;
  const url = rtcPushUrl();
  if (!url || !CONFIG.RTC_AUDIO) return;
  if (camera && camera.streaming) return; // la camera publie deja le son
  const args = [
    '-loglevel', 'error',
    '-f', 'alsa', '-thread_queue_size', '1024',
    '-use_wallclock_as_timestamps', '1',
    '-ar', '48000', '-ac', '1', '-i', micPartage(),
    // Ecoute seule (pas de video) : la bande passante est libre, on soigne
    // donc la qualite. 'audio' au lieu de 'voip' = toute l'ambiance et non
    // seulement la parole filtree.
    '-c:a', 'libopus', '-b:a', CONFIG.RTC_AUDIO_BITRATE, '-application', 'audio',
    '-vbr', 'on', '-frame_duration', '20',
    '-packet_loss', '10', '-fec', '1',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', `${url}-audio`,
  ];
  try {
    rtcAudioProc = require('child_process').spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    log('Audio: publication WebRTC du micro (ecoute seule).');
    rtcAudioProc.stderr.on('data', (d) => {
      const m = String(d).trim();
      if (m) debugLog('Audio RTC:', m.slice(0, 160));
    });
    rtcAudioProc.on('close', () => {
      rtcAudioProc = null;
    });
  } catch (e) {
    log('Audio: publication WebRTC impossible', e.message);
    rtcAudioProc = null;
  }
}

function stopRtcAudioOnly() {
  if (!rtcAudioProc) return;
  try {
    rtcAudioProc.kill('SIGKILL');
  } catch {}
  rtcAudioProc = null;
  log('Audio: arret de la publication WebRTC du micro.');
}

// L'app envoie 'robot_audio' {on:true} regulierement tant qu'elle ecoute.
socket.on('robot_audio', (p) => {
  const on = !!(p && p.on);
  if (on) {
    lastListenerPingAt = Date.now();
    audioActive = true;
    startAudioStream();
    // Ecoute seule : si la camera ne tourne pas, on publie quand meme le
    // micro en WebRTC (indispensable sur iPhone, ou le repli mp3 est bloque).
    if (!camera || !camera.streaming) startRtcAudioOnly();
    applyCameraBandwidth(); // libere la 4G : camera en mode eco
  } else {
    lastListenerPingAt = 0;
    audioActive = false;
    stopAudioStream();
    applyCameraBandwidth(); // plus d'audio -> camera revient en qualite normale
  }
});

setInterval(() => {
  if (audio && audio.streaming && Date.now() - lastListenerPingAt > 6000) {
    audioActive = false;
    stopAudioStream();
    applyCameraBandwidth();
  }
}, 2000);

if (CONFIG.AUDIO_ENABLE) {
  log(`Micro pret: ${CONFIG.AUDIO_DEVICE} (carte ${CONFIG.AUDIO_CARD}, mp3 ${CONFIG.AUDIO_BITRATE}, flux a la demande).`);
}

// Lecture duplex : le micro et WebRTC restent actifs pendant que l'enceinte
// joue. L'app distante entend donc le son reellement repris par le micro du
// robot. Le drapeau sert seulement a empecher l'assistant de s'auto-declencher.
let mediaSuspendedForSpeaker = false;
// Le haut-parleur joue une lecture TTS (robot_say, clip du talkie, tonalite).
// A ne pas confondre avec parole.parle(), qui ne couvre que la reponse de la
// conversation EN DIRECT. Les deux doivent fermer le micro, sinon l'IA
// s'entend et se repond a elle-meme.
let ttsEnLecture = false;
let ttsFinAudio = 0; // instant ou son echo aura vraiment cesse
// Queue apres la fin d'une lecture : aplay a rendu la main, mais le son met
// encore un moment a sortir (liaison Bluetooth ~200 ms) puis a cesser d'etre
// capte par le micro (reverberation de la piece).
const RT_QUEUE_HP_MS = Number(process.env.RT_QUEUE_HP_MS || 900);
function suspendMediaForSpeaker() {
  // Coupe le micro AVANT tout le reste, et sans condition : ce drapeau doit
  // etre pose meme quand la fonction ressort aussitot ci-dessous.
  ttsEnLecture = true;
  if (mediaSuspendedForSpeaker) return;
  mediaSuspendedForSpeaker = true;
  log('Audio enceinte: lecture duplex, micro WebRTC maintenu.');
}

function restoreMediaAfterSpeaker() {
  ttsEnLecture = false;
  ttsFinAudio = Date.now() + RT_QUEUE_HP_MS;
  if (!mediaSuspendedForSpeaker) return;
  mediaSuspendedForSpeaker = false;
  if (Date.now() - lastViewerPingAt <= 6000) startCameraStream();
  if (Date.now() - lastListenerPingAt <= 6000) startAudioStream();
}

// Vrai tant qu'une lecture TTS occupe l'enceinte, queue comprise.
//
// Ce cas n'etait pas couvert : seul parole.parle() fermait le micro, et il ne
// connait que la reponse de la conversation en direct. Une phrase dite par le
// robot de lui-meme (robot_say pendant un "suis-moi") ou un clip du talkie
// sortait donc de l'enceinte avec le micro grand ouvert, et la detection de
// tour de parole y voyait une question a traiter.
function ttsOccupeHautParleur() {
  return ttsEnLecture || Date.now() < ttsFinAudio;
}

// ========================
// Synthese vocale — "le robot parle"
// ========================
let tts = null;
if (CONFIG.TTS_ENABLE) {
  tts = new Tts({
    lang: CONFIG.TTS_LANG,
    speakerMac: CONFIG.SPEAKER_MAC,
    playDevice: CONFIG.TTS_PLAY_DEVICE || undefined,
    prerollMs: CONFIG.TTS_PREROLL_MS,
    keepaliveMs: CONFIG.TTS_KEEPALIVE_MS,
    veilleuse: CONFIG.TTS_VEILLEUSE,
    onPlaybackStart: suspendMediaForSpeaker,
    onPlaybackEnd: restoreMediaAfterSpeaker,
    log,
  });
  log(`TTS pret: langue ${CONFIG.TTS_LANG}, sortie ${tts.playDevice}.`);
  // Le Pi vient peut-etre de redemarrer : on rappelle l'enceinte Bluetooth
  // (BlueZ ne le fait pas tout seul cote source).
  if (CONFIG.SPEAKER_MAC) tts.ensureConnectedAtStartup().catch(() => {});
  // Puis on la tient eveillee pour de bon. Sans attendre la connexion : la
  // veilleuse reessaie d'elle-meme, de plus en plus espace, tant que
  // l'enceinte n'est pas la.
  tts.demarrerVeilleuse();
}

// ========================
// Assistant vocal du robot Solana (mot-cle "alexa")
// ========================
// Le robot ecoute le mot-cle en local (leger), puis delegue tout le reste au
// VPS : transcription + Claude + execution des outils. Ici on ne fait que
// transporter la question et prononcer la reponse.
let voice = null;
if (CONFIG.VOICE_ENABLE && CONFIG.TTS_ENABLE) {
  voice = new Voice({
    device: CONFIG.VOICE_DEVICE,
    micCard: CONFIG.VOICE_CARD,
    micGain: CONFIG.VOICE_MIC_GAIN,
    micAutoGain: CONFIG.VOICE_AUTO_GAIN,
    wakeModel: CONFIG.VOICE_WAKE_MODEL,
    wakeEnabled: CONFIG.VOICE_WAKE,
    threshold: CONFIG.VOICE_THRESHOLD,
    venvPython: CONFIG.VOICE_PYTHON,
    // Signal d'ecoute : 'bip' par defaut (rapide). VOICE_ACK="Oui" pour une
    // reponse parlee (~2s de plus), VOICE_ACK="" pour rester muet.
    ack: process.env.VOICE_ACK === undefined ? 'bip' : process.env.VOICE_ACK,
    speakDevice: tts ? tts.playDevice : 'default',
    log,
    // Le robot parle : on passe par le TTS existant (enceinte Bluetooth).
    speak: (text) => {
      if (tts) tts.say(text);
    },
    // Ne pas se declencher sur sa propre voix.
    isSpeaking: () => mediaSuspendedForSpeaker,
    // Image pour l'outil "regarder" : la derniere image camera si elle est
    // fraiche, sinon une capture ponctuelle (camera eteinte).
    // L'assistant regarde TOUJOURS par la camera choisie (VOICE_CAMERA_DEVICE),
    // meme si l'app affiche l'autre. Deux cas :
    //  - cette camera est justement celle qui filme -> on reutilise sa
    //    derniere image (gratuit, et le peripherique est de toute facon pris)
    //  - sinon -> capture ponctuelle sur ce peripherique, qui lui est libre
    getFrame: async () => {
      const streamingSameCam =
        camera && camera.streaming &&
        (camera.mode === 'both' || camera.device === CONFIG.VOICE_CAMERA_DEVICE);
      if (streamingSameCam && lastFrame && Date.now() - lastFrameAt < 10000) return lastFrame;
      const shot = await grabSingleFrame(CONFIG.VOICE_CAMERA_DEVICE);
      if (shot) return shot;
      // Repli : mieux vaut l'image de l'autre camera que pas d'image du tout.
      return lastFrame && Date.now() - lastFrameAt < 10000 ? lastFrame : null;
    },
    // Envoi de la question au VPS, retour du texte a dire.
    onAsk: ({ audio, frame }) =>
      new Promise((resolve) => {
        if (!socket.connected) return resolve(null);
        let done = false;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            resolve({ text: 'Le serveur ne repond pas.' });
          }
        }, 45000);
        socket.emit('voice_ask', { code: CONFIG.CODE, audio, frame }, (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(res);
        });
      }),
  });
  voice.start();
}

// ========================
// Evitement d'obstacles par la camera (pendant la navigation GPS)
// ========================
// Le robot demande regulierement au serveur "la voie est-elle libre ?" en
// envoyant une image. La reponse est convertie en distance et injectee dans
// navigator.setObstacle() : la logique de contournement deja ecrite s'en
// charge, exactement comme si le capteur a ultrasons avait vu l'obstacle.
// Avantage sur l'ultrason : plusieurs metres de portee au lieu de 25 cm, et
// la camera sait dire de quel cote passer.
let visionObstacleCm = null;
let visionObstacleAt = 0;
let visionBusy = false;

async function verifierVoieLibre() {
  if (!CONFIG.NAV_VISION_ENABLE || visionBusy) return;
  if (!navigator || !navigator.running) return; // uniquement pendant la nav
  if (!socket.connected) return;
  visionBusy = true;
  try {
    const frame = await (async () => {
      if (lastFrame && Date.now() - lastFrameAt < 3000) return lastFrame;
      return grabSingleFrame(CONFIG.VOICE_CAMERA_DEVICE);
    })();
    if (!frame) return;

    // Contexte de navigation : sans lui, le modele choisirait un cote de
    // contournement au hasard, parfois a l'oppose de la destination.
    let nav = null;
    if (navTarget && lastFix) {
      const dist = distanceMeters(lastFix, navTarget);
      const capCible = bearing(lastFix, navTarget);
      // Cap relatif : 0 = destination droit devant, +90 = a droite, -90 = a
      // gauche. Disponible seulement si on connait notre orientation.
      let capRelatif = null;
      if (lastFix.headingValid && Number.isFinite(lastFix.heading)) {
        let d = capCible - lastFix.heading;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        capRelatif = d;
      }
      nav = { distanceM: dist, capRelatif };
    }

    const res = await new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 12000);
      socket.emit('vision_obstacle', { code: CONFIG.CODE, frame, nav }, (r) => {
        if (!done) { done = true; clearTimeout(t); resolve(r); }
      });
    });
    if (!res) return;
    visionObstacleAt = Date.now();
    if (res.libre) {
      visionObstacleCm = null;
      debugLog('[VISION] voie libre');
    } else {
      visionObstacleCm = res.distanceCm;
      log(`Vision: obstacle a ~${Math.round(res.distanceCm / 100)} m${res.coteLibre ? `, passage ${res.coteLibre}` : ''}.`);
      if (navigator) {
        // On force la valeur vue par la camera : c'est elle qui declenche le
        // contournement, bien avant que l'ultrason ne detecte quoi que ce soit.
        navigator.setObstacle(res.distanceCm);
        if (res.coteLibre && typeof navigator.setPreferredSide === 'function') {
          navigator.setPreferredSide(res.coteLibre);
        }
      }
    }
  } catch (e) {
    debugLog('[VISION] echec', e.message);
  } finally {
    visionBusy = false;
  }
}
setInterval(verifierVoieLibre, CONFIG.NAV_VISION_MS);

// Le serveur reclame une image fraiche (asservissement visuel : le robot
// avance vers un objet en le recentrant image par image).
socket.on('robot_grab_frame', async (p, ack) => {
  if (typeof ack !== 'function') return;
  try {
    const streamingSameCam =
      camera && camera.streaming &&
      (camera.mode === 'both' || camera.device === CONFIG.VOICE_CAMERA_DEVICE);
    if (streamingSameCam && lastFrame && Date.now() - lastFrameAt < 1500) return ack(lastFrame);
    const shot = await grabSingleFrame(CONFIG.VOICE_CAMERA_DEVICE);
    ack(shot || (lastFrame && Date.now() - lastFrameAt < 10000 ? lastFrame : null));
  } catch {
    ack(null);
  }
});

// ========================
// Enregistrement HD local — pour filmer
// ========================
// Complementaire de l'enregistrement cote VPS : celui-la recopie le flux
// diffuse, donc il est bride par le lien (640x360 en 4G). Ici on filme
// directement depuis la camera, en pleine definition, sans passer par le
// reseau — au prix de la vue en direct, puisque le peripherique est mono-acces.
let recHdProc = null;
let recHdFichier = '';
let recHdDebut = 0;
let recHdMinuteur = null;

const fs = require('fs');
const REC_HD_DOSSIER = `${require('os').homedir()}/ping/videos`;
const REC_HD_W = Number(process.env.REC_HD_WIDTH || 1280);
const REC_HD_H = Number(process.env.REC_HD_HEIGHT || 720);
const REC_HD_FPS = Number(process.env.REC_HD_FPS || 25);
const REC_HD_BITRATE = process.env.REC_HD_BITRATE || '6000k';
const REC_HD_MAX_MS = Number(process.env.REC_HD_MAX_MS || 10 * 60 * 1000);

// Meme detection que camera.js : ffmpeg annonce h264_v4l2m2m meme sans
// materiel derriere, il faut donc interroger le noyau.
function recHdEncodeur() {
  try {
    const base = '/sys/class/video4linux';
    for (const d of fs.readdirSync(base)) {
      if (/codec-encode/i.test(fs.readFileSync(`${base}/${d}/name`, 'utf8'))) {
        return 'h264_v4l2m2m';
      }
    }
  } catch {}
  return 'libx264';
}

function recHdEtat(extra = {}) {
  socket.emit('robot_record_hd_status', {
    code: CONFIG.CODE,
    actif: !!recHdProc,
    fichier: recHdFichier ? require('path').basename(recHdFichier) : null,
    secondes: recHdProc ? Math.round((Date.now() - recHdDebut) / 1000) : 0,
    ...extra,
  });
}

function demarrerRecHd() {
  if (recHdProc) return;
  if (!CONFIG.CAMERA_ENABLE) return recHdEtat({ erreur: 'Camera desactivee.' });
  try { fs.mkdirSync(REC_HD_DOSSIER, { recursive: true }); } catch {}

  // La carte SD se remplit vite a 6 Mb/s : on refuse plutot que de la saturer.
  try {
    const libre = Number(
      require('child_process')
        .execSync(`df -k --output=avail ${REC_HD_DOSSIER} | tail -1`, { timeout: 3000 })
        .toString().trim()
    );
    if (libre && libre < 500000) {
      return recHdEtat({ erreur: `Espace insuffisant (${Math.round(libre / 1024)} Mo).` });
    }
  } catch {}

  // Libere la camera : un peripherique v4l2 ne s'ouvre pas deux fois.
  stopCameraStream();

  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  recHdFichier =
    `${REC_HD_DOSSIER}/robot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.mp4`;

  const enc = recHdEncodeur();
  const args = [
    '-loglevel', 'error',
    '-f', 'v4l2', '-input_format', 'mjpeg',
    '-video_size', `${REC_HD_W}x${REC_HD_H}`, '-framerate', String(REC_HD_FPS),
    '-i', CONFIG.VOICE_CAMERA_DEVICE,
    '-c:v', enc, '-b:v', REC_HD_BITRATE,
    ...(enc === 'libx264' ? ['-preset', 'veryfast'] : ['-profile:v', '66']),
    '-pix_fmt', 'yuv420p',
    // Fragmente : le fichier reste exploitable meme si le robot s'eteint.
    '-movflags', '+frag_keyframe+empty_moov+default_base_is_moof',
    '-f', 'mp4', recHdFichier,
  ];

  try {
    const { spawn } = require('child_process');
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    recHdProc = proc;
    recHdDebut = Date.now();
    proc.stderr.on('data', (x) => {
      const t = String(x).trim().slice(0, 160);
      if (t) log(`Film HD: ${t}`);
    });
    proc.on('close', () => {
      if (recHdProc !== proc) return;
      clearTimeout(recHdMinuteur);
      recHdProc = null;
      let mo = 0;
      try { mo = fs.statSync(recHdFichier).size / 1048576; } catch {}
      const secondes = Math.round((Date.now() - recHdDebut) / 1000);
      log(`Film HD: termine (${secondes}s, ${mo.toFixed(1)} Mo) -> ${recHdFichier}`);
      if (mo < 0.05) {
        try { fs.unlinkSync(recHdFichier); } catch {}
        recHdEtat({ erreur: 'Enregistrement vide : camera occupee ou indisponible.' });
      } else {
        recHdEtat({ termine: require('path').basename(recHdFichier), mo: +mo.toFixed(1) });
      }
      // Rend la vue en direct si quelqu'un regardait avant la prise.
      if (Date.now() - lastViewerPingAt <= 6000) startCameraStream();
    });
    proc.on('error', (e) => log('Film HD: ffmpeg introuvable', e.message));
    recHdMinuteur = setTimeout(() => {
      log('Film HD: duree maximale atteinte -> arret.');
      arreterRecHd();
    }, REC_HD_MAX_MS);
    log(`Film HD: ${REC_HD_W}x${REC_HD_H} a ${REC_HD_FPS} img/s (${enc}) -> ${recHdFichier}`);
    recHdEtat();
  } catch (e) {
    recHdProc = null;
    log('Film HD: impossible de demarrer', e.message);
    recHdEtat({ erreur: e.message });
  }
}

function arreterRecHd() {
  if (!recHdProc) return;
  clearTimeout(recHdMinuteur);
  // SIGINT et non SIGKILL : ffmpeg doit finir d'ecrire le conteneur.
  try { recHdProc.kill('SIGINT'); } catch {}
  const p = recHdProc;
  setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 4000);
}

socket.on('robot_record_hd', (p) => {
  if (p && p.on) demarrerRecHd();
  else arreterRecHd();
});

// ========================
// Talkie-walkie EN DIRECT
// ========================
// L'app publie sa voix en WebRTC sur le chemin robot-<code>-talk. Le robot lit
// ce flux en continu et l'envoie sur l'enceinte : on parle dans le telephone,
// ca sort ici avec ~0.5 s de decalage, sans enregistrer ni transferer de
// fichier (l'ancien talkie demandait ~15 s entre le relachement et le son).
let talkProc = null;
let talkWanted = false; // l'app est-elle en train de parler ?
let talkRetry = null;

function startTalkLive() {
  if (talkProc) return;
  talkRetry = null;
  const url = rtcPushUrl();
  if (!url || !tts) return;
  const src = `${url}-talk`; // meme URL que la video, chemin "-talk"
  // ffmpeg lit le flux WebRTC (via RTSP) et l'envoie a aplay, qui parle a
  // l'enceinte Bluetooth. Tampon volontairement court : c'est du direct.
  // Sortie en PCM brut 24 kHz mono : c'est a la fois lisible par aplay et le
  // format exact attendu par la Realtime d'OpenAI. Un seul decodage sert donc
  // les deux usages — parler dans le telephone pour se faire entendre AUTOUR
  // du robot, et parler a Solana quand on n'est pas a cote de lui.
  const args = [
    '-loglevel', 'error',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-rtsp_transport', 'tcp', '-i', src,
    '-af', `volume=${process.env.TTS_GAIN || 2},alimiter=limit=0.95`,
    '-ac', '1', '-ar', String(RT_TAUX), '-f', 's16le', 'pipe:1',
  ];
  try {
    const { spawn } = require('child_process');
    const dec = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const play = spawn('aplay', [
      '-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(RT_TAUX), '-c', '1',
      '-D', tts.playDevice, '-',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    talkProc = { dec, play };
    log('Talkie direct: ecoute du flux vocal de l app.');
    let termine = false;
    const fin = (raison = '') => {
      if (termine) return;
      termine = true;
      // Ne nettoie que cette tentative : une nouvelle a peut-etre deja pris
      // sa place pendant l'arrivee asynchrone d'un evenement close/error.
      if (talkProc && talkProc.dec === dec) talkProc = null;
      try { dec.stdout.unpipe(play.stdin); } catch {}
      try { dec.kill('SIGKILL'); } catch {}
      try { play.kill('SIGKILL'); } catch {}
      if (raison) log(`Talkie direct: lecture interrompue (${raison}).`);
      // Le flux met une seconde a apparaitre cote serveur : si on a demarre
      // trop tot, ffmpeg sort aussitot. Tant que l'app parle, on reessaie,
      // mais sans marteler la cle Bluetooth apres une erreur EPIPE.
      if (talkWanted) {
        log('Talkie direct: flux pas encore la, nouvelle tentative.');
        talkRetry = setTimeout(startTalkLive, 2500);
      } else {
        log('Talkie direct: flux termine.');
      }
    };
    // Quand ffmpeg termine normalement, laisse aplay vider son tampon avant
    // de fermer : le tuer ici avalait parfois la fin du message vocal.
    dec.on('close', (code) => {
      if (code !== 0) fin(`ffmpeg termine avec le code ${code}`);
    });
    play.on('close', (code) => fin(code === 0 ? '' : `aplay termine avec le code ${code}`));
    dec.on('error', (e) => fin(`ffmpeg: ${e.message}`));
    play.on('error', (e) => fin(`aplay: ${e.message}`));
    dec.stdout.on('error', (e) => fin(`ffmpeg stdout: ${e.message}`));
    // Cas vu dans le journal : la disparition de hci0 ferme aplay, puis
    // l'ecriture du decodeur dans son stdin emet EPIPE. Il faut l'absorber,
    // sinon cette simple coupure Bluetooth fait tomber tout ping-robot.
    play.stdin.on('error', (e) => fin(`aplay stdin: ${e.message}`));
    dec.stderr.on('data', (d) => debugLog('Talkie direct:', String(d).slice(0, 140)));
    play.stderr.on('data', (d) => debugLog('Talkie direct aplay:', String(d).slice(0, 140)));
    dec.stdout.pipe(play.stdin);

    // Deuxieme destination : la conversation avec Solana. Le meme flux part
    // vers OpenAI, decoupe en morceaux de 40 ms comme le fait micro.js.
    //
    // Interet principal : ce micro-la est celui du TELEPHONE, a plusieurs
    // metres de l'enceinte du robot. Il n'entend donc pas Solana parler, et
    // tout le probleme d'echo disparait — pas de garde-fou, pas de seuil, pas
    // d'auto-coupure. On peut lui couper la parole naturellement.
    let restes = Buffer.alloc(0);
    const TAILLE = (RT_TAUX * 2 * 40) / 1000; // 40 ms de PCM16 mono
    dec.stdout.on('data', (d) => {
      if (!rtActif || !socket.connected) return;
      restes = Buffer.concat([restes, d]);
      while (restes.length >= TAILLE) {
        socket.emit('rt_audio', { code: CONFIG.CODE, pcm: restes.subarray(0, TAILLE) });
        restes = restes.subarray(TAILLE);
      }
    });
  } catch (e) {
    log('Talkie direct: impossible de demarrer', e.message);
    talkProc = null;
  }
}

function stopTalkLive() {
  talkWanted = false;
  if (talkRetry) {
    clearTimeout(talkRetry);
    talkRetry = null;
  }
  if (!talkProc) return;
  const { dec, play } = talkProc;
  talkProc = null;
  try { dec.kill('SIGKILL'); } catch {}
  try { play.kill('SIGKILL'); } catch {}
  log('Talkie direct: arret.');
}

socket.on('robot_talk_live', (p) => {
  if (p && p.on) {
    talkWanted = true;
    // Le flux met ~1 s a etre publie cote serveur ; on attend un peu, et la
    // boucle de reprise s'occupe du reste si ce n'est pas encore pret.
    if (talkRetry) clearTimeout(talkRetry);
    talkRetry = setTimeout(startTalkLive, 1200);
  } else {
    stopTalkLive();
  }
});

// Bouton "parler" de l'app : declenche l'ecoute sans passer par le mot-cle.
socket.on('robot_listen', () => {
  if (!voice) {
    log('Voix: assistant vocal desactive, demande de l app ignoree.');
    return;
  }
  log('Voix: ecoute declenchee depuis l app.');
  voice.trigger();
});

// Capture UNE image sur un peripherique donne (pour l'outil "regarder").
// Renvoie null si la camera est occupee ou absente.
// Capture d'une image unique, avec TEMPS DE CHAUFFE.
//
// La version precedente prenait -frames:v 1, c'est-a-dire la toute premiere
// image sortie par la camera. Or un capteur USB met une a deux secondes a
// regler son exposition et son gain : cette premiere image est NOIRE, et
// d'autant plus dans une piece sombre ou il lui faut une pose longue.
// Constate le 25/09 : toutes les photos d'alerte etaient entierement noires,
// et l'analyse repondait "Rien de visible" — a juste titre.
//
// On laisse donc tourner 1,5 seconde en ecrasant le fichier a chaque image
// (-update 1), et on garde la DERNIERE : celle ou l'exposition est faite.
// Duree et non nombre d'images, car la cadence chute en faible lumiere.
function grabSingleFrame(device) {
  return new Promise((resolve) => {
    if (!CONFIG.CAMERA_ENABLE) return resolve(null);
    const dev = device || currentCameraDevice();
    const { execFile } = require('child_process');
    const fsx = require('fs');
    // La veille visuelle tient le peripherique : elle doit le lacher le temps
    // de la photo, sinon ffmpeg echoue ici sans dire pourquoi.
    mouvSuspendre();
    const fichier = `/tmp/ping-shot-${process.pid}.jpg`;
    execFile(
      'ffmpeg',
      ['-loglevel', 'error', '-f', 'v4l2', '-input_format', 'mjpeg',
        '-video_size', `${CONFIG.CAMERA_WIDTH}x${CONFIG.CAMERA_HEIGHT}`,
        '-i', dev, '-t', String(CONFIG.PHOTO_CHAUFFE_S), '-update', '1', '-y', fichier],
      { timeout: 12000 },
      () => {
        // On lit le fichier meme si ffmpeg a rendu un code d'erreur : il en
        // renvoie un en fin de capture chronometree, alors que l'image est la.
        mouvReprendre();
        try {
          const buf = fsx.readFileSync(fichier);
          resolve(buf && buf.length ? buf : null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// L'app envoie un texte a dire a voix haute.
socket.on('robot_say', (p) => {
  const text = String(p?.text || '').trim();
  if (!text) return;
  if (text.toLowerCase() === '/testaudio') {
    log('TTS: test audio local demande.');
    if (tts) tts.playTestTone();
    return;
  }
  log(`TTS: dire "${text}"`);
  if (tts) tts.say(text);
});

// Talkie-walkie : clip vocal de l'app, joue sur le haut-parleur.
socket.on('robot_voice', (p) => {
  const b64 = p && typeof p.b64 === 'string' ? p.b64 : '';
  if (!b64) return;
  log(`Talkie: clip recu (${Math.round(b64.length / 1024)} Ko).`);
  if (tts) tts.playClip(b64, p.ext);
});

// ========================
// Navigation auto pilotee par l'app (destination choisie sur la carte)
// ========================
socket.on('robot_nav', (p) => {
  const on = !!(p && p.on);
  const t = p && p.target;
  const lat = t ? Number(t.latitude) : NaN;
  const lng = t ? Number(t.longitude) : NaN;
  if (on && Number.isFinite(lat) && Number.isFinite(lng)) {
    navTarget = { latitude: lat, longitude: lng };
    navRoute = null;
    navRouteIdx = 0;
    log(`Nav auto demandee -> ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    if (navigator) navigator.start();

    // Itineraire pieton OSM : le robot suivra les chemins reels au lieu de
    // couper en ligne droite. Charge en tache de fond pour ne pas retarder le
    // depart ; si OSRM ne repond pas, on garde la ligne droite.
    if (lastFix) {
      chargerItineraire(lastFix, navTarget).then((route) => {
        if (!navTarget || !route) return;
        navRoute = route;
        navRouteIdx = 0;
        // Points de passage : rayon large (inutile de viser au metre pres).
        if (navigator) navigator.opts.arrivalRadius = WAYPOINT_RADIUS_M;
        log(`Itineraire charge : ${route.length} points de passage.`);
      });
    } else {
      log('Pas de position GPS : navigation en ligne droite.');
    }
  } else {
    navTarget = null;
    navRoute = null;
    navRouteIdx = 0;
    if (navigator) navigator.opts.arrivalRadius = CONFIG.ARRIVAL_RADIUS_M;
    if (navigator) navigator.stop({ sendStop: true });
    log('Nav auto annulee par l\'app.');
  }
  sendRobotStatus();
});

// --- Conversation vocale en direct (Realtime OpenAI) -----------------------
// Le micro part en flux continu vers le VPS, qui le relaie au modele
// voix-a-voix ; l'audio de reponse revient par morceaux et se joue au fil de
// l'eau. Le tour par tour (voice.js) reste disponible en parallele.
let micro = null;
let parole = null;
let rtActif = false;
// Interruption : niveau sonore (0..1) a depasser, et nombre de morceaux de
// 40 ms consecutifs requis. Monte RT_SEUIL si le robot se coupe encore tout
// seul ; baisse-le s'il ne t'entend pas quand tu lui coupes la parole.
// Plancher fixe, actif tant que la reference adaptative n'a rien appris (debut
// de reponse). Mesure du 08/08 : la voix du robot dans son enceinte produit des
// pics jusqu'a 0.20 au micro. Un plancher a 0.12 etait donc SOUS son propre
// echo, et c'est lui qui a cause les huit auto-coupures observees.
const RT_SEUIL = Number(process.env.RT_SEUIL || 0.25);
const RT_MORCEAUX = Number(process.env.RT_MORCEAUX || 4); // ~160 ms
let rtFort = 0;
// Seuil ADAPTATIF, en plus du seuil fixe.
//
// Mesures du 08/08 : l echo de l enceinte au micro (mediane 0.038) depasse a
// peine le bruit de la piece (0.032), mais les pics de bruit montent a 0.30 —
// soit tres au-dessus du seuil fixe de 0.12. Un seuil constant ne peut donc
// pas separer les deux dans toutes les pieces.
//
// On mesure ce que le micro entend PENDANT que le robot parle : c est par
// definition l echo plus le bruit ambiant. Il faut alors depasser franchement
// ce niveau pour etre considere comme une vraie prise de parole.
// On suit les PICS de l echo, pas sa moyenne. Mesure du 08/08 : pendant que le
// robot parle, le micro entend une moyenne de ~0.04 mais des pics a 0.20 — la
// voix est tres irreguliere. Un seuil calcule sur la moyenne restait donc sous
// les pics du robot, qui se coupait lui-meme huit fois en trois minutes.
const RT_FACTEUR = Number(process.env.RT_FACTEUR || 1.6);
// Decroissance par morceau de 40 ms : demi-vie d environ 5 s. Assez lent pour
// couvrir une phrase entiere, assez rapide pour retomber entre deux reponses.
const RT_DECROISSANCE = Number(process.env.RT_DECROISSANCE || 0.995);
let rtEchoRef = 0;
// Apres une coupure, le VPS a deja emis de l audio en vol. On l ignore
// brievement, sinon la fin de la phrase annulee repartirait toute seule.
let rtIgnorerJusqua = 0;
let rtFrameTimer = null;

// --- Squelch : ne transmettre que de la VRAIE parole ---
//
// Avant, tout ce que le micro captait partait au VPS des que le robot se
// taisait : moteurs, ventilateur, television, pas dans le couloir. C'est la
// detection de tour de parole d'OpenAI qui triait, a l'autre bout — et un
// robot est une machine bruyante. D'ou les tours fantomes : elle entendait une
// "phrase" dans le bruit, la transcription inventait des mots, et l'assistant
// repondait serieusement a une question que personne n'avait posee.
//
// On tranche donc ICI : tant qu'on n'a pas entendu du son franc et SOUTENU,
// on n'envoie rien du tout. Le bruit n'atteint plus jamais le modele.
const RT_SQUELCH = String(process.env.RT_SQUELCH || 'true').toLowerCase() === 'true';
// Le seuil est ADAPTATIF, et c'est indispensable ici : le gain du micro est
// regle automatiquement au demarrage (voir "gain micro regle sur 60%"), donc
// un niveau absolu ne veut rien dire d'un jour a l'autre. Premiere version
// avec un seuil fixe a 0.08 : mesure sur le vrai micro, le bruit ambiant
// plafonne a 0.026 et la parole n'atteignait jamais 0.08 — la porte ne
// s'ouvrait plus jamais et le robot etait devenu sourd.
//
// On mesure donc le bruit de fond en continu, et on ouvre a un multiple de
// ce bruit. Le reglage suit la piece au lieu de la supposer.
const RT_SQ_FACTEUR = Number(process.env.RT_SQ_FACTEUR || 4);
// Plancher absolu : dans le silence complet, le bruit de fond tend vers zero
// et le seuil avec lui. Sans plancher, le moindre souffle ouvrirait la porte.
// Mesure du 13/09 : bruit de fond reel 0.003, pics de voix 0.032 a 0.046. Un
// plancher a 0.02 ecrasait la mesure adaptative (4 x 0.003 = 0.012) et ne
// laissait qu'un rapport de 1,6 avec la voix — trop juste pour une parole
// modulee. A 0.01 le plancher ne mord plus que dans le silence total.
const RT_SQ_PLANCHER = Number(process.env.RT_SQ_PLANCHER || 0.01);
// Plafond du bruit de fond retenu : dans un endroit durablement bruyant, on
// prefere transmettre un peu de bruit plutot que de devenir sourd.
const RT_SQ_PLAFOND = Number(process.env.RT_SQ_PLAFOND || 0.03);
// Forcage manuel (0 = automatique). A ne sortir que si la mesure se trompe.
const RT_SQ_OUVRE = Number(process.env.RT_SQ_OUVRE || 0);
// Duree d'ouverture maximale. Filet de securite contre la porte bloquee
// ouverte : un bruit fort et CONSTANT (ventilateur, moteur qui tourne) passe
// le seuil puis le maintient indefiniment, et tout ce bruit partirait au
// modele. Au-dela de ce delai on referme d'office et on rejuge — le temps que
// l'estimation du bruit de fond ait rattrape le nouvel environnement.
const RT_SQ_MAX_OUVERT_MS = Number(process.env.RT_SQ_MAX_OUVERT_MS || 20000);
let sqOuvertDepuis = 0;
// Morceaux de 40 ms au-dessus du seuil exiges pour ouvrir, comptes dans une
// FENETRE glissante — pas forcement consecutifs.
//
// Premiere version : 3 morceaux consecutifs. Constat du 13/09 sur le terrain,
// deux conversations d'affilee sans une seule detection alors que les pics de
// voix (0.046) depassaient largement le seuil (0.020) : la parole est modulee,
// elle retombe sous le seuil entre deux syllabes, et le compteur repartait de
// zero a chaque creux. Exiger 3 morceaux parmi les 6 derniers tolere ces
// creux tout en rejetant un transitoire isole (1 seul morceau sur 6).
const RT_SQ_MORCEAUX = Number(process.env.RT_SQ_MORCEAUX || 3);
const RT_SQ_FENETRE = Number(process.env.RT_SQ_FENETRE || 6);
// Apres la derniere syllabe, on laisse ouvert : sans ca une respiration au
// milieu d'une phrase la couperait en deux tours.
const RT_SQ_QUEUE_MS = Number(process.env.RT_SQ_QUEUE_MS || 900);
// Morceaux gardes d'avance. Quand la porte s'ouvre, les 120 premieres ms sont
// deja passees : sans ce pre-roll, "allume la camera" arrive en "ume la
// camera" et la transcription bricole le reste.
const RT_SQ_PREROLL = Number(process.env.RT_SQ_PREROLL || 6);
let sqOuvert = false;
let sqFort = 0;
let sqFermeApres = 0;
let sqPreroll = [];
let sqBruitFond = 0.01;   // estimation courante, reajustee en permanence
let sqMaxRecent = 0;      // pic observe depuis le dernier point de diagnostic
let sqChaudsRecent = 0;   // morceaux passes au-dessus du seuil, meme diagnostic
let sqFenetre = [];       // 1/0 sur les RT_SQ_FENETRE derniers morceaux
let sqProchainLog = 0;

// Seuil d'ouverture du moment.
function sqSeuil() {
  if (RT_SQ_OUVRE > 0) return RT_SQ_OUVRE;
  return Math.max(RT_SQ_PLANCHER, sqBruitFond * RT_SQ_FACTEUR);
}

function sqReinit() {
  sqOuvert = false;
  sqFort = 0;
  sqFermeApres = 0;
  sqPreroll = [];
  sqBruitFond = 0.01;
  sqMaxRecent = 0;
  sqChaudsRecent = 0;
  sqFenetre = [];
  sqProchainLog = 0;
  sqOuvertDepuis = 0;
}

function rtDemarrer() {
  if (rtActif) return;
  rtActif = true;
  if (!parole) {
    parole = new Parole({
      playDevice: tts ? tts.playDevice : 'default',
      log,
      gain: Number(process.env.RT_GAIN || 0),
      filtreAudio: process.env.RT_FILTRE || '',
      // Le firmware du dongle Realtek plante par moments et reinitialise
      // hci0 : l'enceinte tombe en pleine phrase. On la rappelle aussitot au
      // lieu d'attendre le prochain passage de la surveillance.
      onCoupure: () => { if (tts) tts.reconnecterMaintenant(); },
    });
  }
  // Mode conversation : le tuyau audio reste ouvert d'un bout a l'autre de
  // l'echange. Fermer le flux a chaque fin de phrase faisait raccrocher
  // l'enceinte Bluetooth en pleine conversation.
  // La conversation directe joue sur le MEME peripherique BlueALSA, qui
  // n'accepte qu'un client : la veilleuse lui cede la place pour toute la
  // duree de l'echange (et pas phrase par phrase, sinon elle se rallumerait
  // entre deux repliques et volerait le haut-parleur).
  if (tts) tts.pauseVeilleuse();
  parole.ouvrirSession();
  // Chaque conversation repart d'une reference d'echo vierge : le volume de
  // l'enceinte ou la piece ont pu changer depuis la derniere.
  rtEchoRef = 0;
  rtFort = 0;
  sqReinit();
  if (!micro) {
    micro = new Micro({
      device: CONFIG.VOICE_DEVICE,
      log,
      // Tant que le robot PARLE, on ne transmet pas : son micro capte sa
      // propre voix dans l'enceinte, et la detection de tour de parole d'OpenAI
      // y verrait une interruption. C'est ce qui hachait chaque phrase.
      //
      // L'interruption est donc decidee ICI, sur le niveau sonore reel : il
      // faut du son franc et SOUTENU (plusieurs morceaux d'affilee) pour couper.
      // Un echo residuel ou un claquement ne suffisent pas.
      onChunk: (pcm, niv) => {
        // L'enceinte joue une lecture TTS : on ne transmet rien, et on ne
        // cherche pas non plus d'interruption — on ne coupe pas une annonce
        // que le robot s'est mise a dire tout seul.
        if (ttsOccupeHautParleur()) {
          rtFort = 0;
          sqReinit(); // ce qu'on entend pendant ce temps n'est pas de la parole
          return;
        }
        if (parole && parole.parle()) {
          // Sommet glissant de ce qu on entend pendant qu il parle : c est le
          // niveau CRETE de son propre echo. Il faut le depasser franchement
          // pour etre pris pour une vraie prise de parole.
          //
          // GELE des qu un candidat d interruption est en cours (rtFort > 0).
          // Sans ce gel, la reference se calait sur la voix de l utilisateur,
          // le seuil montait avec elle et l interruption ne se declenchait
          // JAMAIS — verifie en simulation avant de partir sur le robot.
          // ORDRE CAPITAL : on juge le morceau avec la reference d'AVANT lui.
          // En l'integrant d'abord, la reference vaudrait toujours au moins le
          // niveau courant, le seuil toujours 1,6 fois plus haut, et
          // l'interruption ne pourrait mathematiquement jamais se declencher.
          const seuil = Math.max(RT_SEUIL, rtEchoRef * RT_FACTEUR);
          if (niv >= seuil) {
            rtFort++;
            if (rtFort >= RT_MORCEAUX) {
              parole.couper(`quelqu un parle (${niv.toFixed(2)} > ${seuil.toFixed(2)})`);
              rtFort = 0;
              rtIgnorerJusqua = Date.now() + 800;
              // Annule la reponse cote OpenAI : sans ca il continue de
              // produire, et le robot se remettrait a parler par-dessus toi.
              socket.emit('rt_interrompre', { code: CONFIG.CODE });
            }
          } else {
            // Vraiment CONSECUTIFS : remise a zero. Avec un simple decrement,
            // un bruit intermittent (un pic sur deux) finissait par monter
            // jusqu au declenchement. La parole, elle, est continue sur 160 ms.
            rtFort = 0;
          }
          // La reference n'apprend QUE hors candidat d'interruption : sinon la
          // voix de l'utilisateur la ferait monter et se masquerait elle-meme.
          if (!rtFort) rtEchoRef = Math.max(niv, rtEchoRef * RT_DECROISSANCE);
          return; // on ne transmet rien pendant qu'il parle
        }
        rtFort = 0;
        // Le telephone a la priorite : quand le talkie est ouvert, c'est SON
        // micro qui alimente la conversation (voir startTalkLive). Envoyer les
        // deux melangerait la voix distante et l'ambiance de la piece, et
        // ferait reentendre a Solana sa propre voix par le micro embarque.
        if (talkProc) return;

        if (!RT_SQUELCH) {
          socket.emit('rt_audio', { code: CONFIG.CODE, pcm });
          return;
        }

        // Suivi du bruit de fond, porte ouverte OU fermee. Le faire aussi
        // pendant la transmission est ce qui permet de sortir d'une porte
        // bloquee ouverte : l'estimation continue de monter vers le niveau du
        // bruit, jusqu'a ce que le seuil repasse au-dessus de lui.
        // On colle au MINIMUM, avec une remontee lente (environ +8 % par
        // seconde) : assez reactif pour suivre un ventilateur qui demarre,
        // trop lent pour qu'une phrase fasse monter le seuil en la disant.
        sqBruitFond = niv < sqBruitFond
          ? niv
          : Math.min(sqBruitFond * 1.003, RT_SQ_PLAFOND);

        if (sqOuvert) {
          // Tant que ca parle encore, on repousse la fermeture. Le seuil de
          // maintien vaut la moitie de celui d'ouverture : sans cet ecart, la
          // porte battrait au rythme des syllabes.
          if (niv >= sqSeuil() * 0.5) sqFermeApres = Date.now() + RT_SQ_QUEUE_MS;
          const tropLongtemps = Date.now() - sqOuvertDepuis > RT_SQ_MAX_OUVERT_MS;
          if (tropLongtemps) log('Direct: micro ouvert trop longtemps, on referme et on rejuge.');
          if (tropLongtemps || Date.now() > sqFermeApres) {
            sqOuvert = false;
            sqFort = 0;
          } else {
            socket.emit('rt_audio', { code: CONFIG.CODE, pcm });
            return;
          }
        }

        // Porte fermee : on accumule de quoi ne pas manger le debut du mot.
        sqPreroll.push(pcm);
        if (sqPreroll.length > RT_SQ_PREROLL) sqPreroll.shift();

        const seuil = sqSeuil();
        sqMaxRecent = Math.max(sqMaxRecent, niv);
        // Point de situation periodique : c'est ce qui permet de regler sans
        // deviner. Si "max recent" reste loin sous "seuil" quand tu parles,
        // c'est le seuil qui est trop haut.
        if (Date.now() > sqProchainLog) {
          if (sqProchainLog) {
            log(
              `Direct: a l'ecoute (bruit de fond ${sqBruitFond.toFixed(4)}, ` +
              `seuil ${seuil.toFixed(4)}, pic recent ${sqMaxRecent.toFixed(4)}, ` +
              `${sqChaudsRecent} morceaux au-dessus du seuil).`
            );
          }
          sqProchainLog = Date.now() + 30000;
          sqMaxRecent = 0;
          sqChaudsRecent = 0;
        }

        // Fenetre glissante : assez de morceaux chauds parmi les derniers,
        // sans exiger qu'ils se suivent (voir RT_SQ_FENETRE).
        const chaud = niv >= seuil ? 1 : 0;
        if (chaud) sqChaudsRecent++;
        sqFenetre.push(chaud);
        if (sqFenetre.length > RT_SQ_FENETRE) sqFenetre.shift();
        let chauds = 0;
        for (const c of sqFenetre) chauds += c;
        if (chauds < RT_SQ_MORCEAUX) return;

        sqOuvert = true;
        sqFort = 0;
        sqFenetre = [];
        sqOuvertDepuis = Date.now();
        sqFermeApres = Date.now() + RT_SQ_QUEUE_MS;
        log(`Direct: parole detectee (niv=${niv.toFixed(4)}, seuil=${seuil.toFixed(4)}).`);
        for (const p of sqPreroll) socket.emit('rt_audio', { code: CONFIG.CODE, pcm: p });
        sqPreroll = [];
      },
    });
  }
  socket.emit('rt_start', { code: CONFIG.CODE });
  micro.demarrer();
  // L'outil 'regarder' a besoin d'une image. En tour par tour, le robot en
  // joint une a chaque question ; en direct il n'y a pas de question a
  // laquelle l'accrocher. On pousse donc regulierement une image au VPS, qui
  // la garde en reserve : quand l'IA appelle 'regarder', elle la trouve prete,
  // sans aller-retour.
  //
  // La vue ne depend PLUS de l'affichage dans l'app. Avant, si la camera ne
  // diffusait pas, rien n'etait envoye et l'assistant repondait "la camera est
  // eteinte" alors que l'oeil du robot etait parfaitement disponible. On
  // reprend donc la logique de getFrame() :
  //   - la camera diffuse deja -> on reutilise sa derniere image (gratuit)
  //   - sinon -> capture ponctuelle, plus espacee car elle coute un ffmpeg
  let rtCaptureEnCours = false;
  let rtDerniereCapture = 0;
  const RT_CAPTURE_MS = Number(process.env.RT_CAPTURE_MS || 4000);
  rtFrameTimer = setInterval(() => {
    if (!rtActif) return;
    if (lastFrame && Date.now() - lastFrameAt < 10000) {
      socket.emit('rt_frame', { code: CONFIG.CODE, frame: lastFrame });
      return;
    }
    // Camera eteinte : on va chercher l'image nous-memes. Un seul ffmpeg a la
    // fois, et pas plus d'une capture toutes les RT_CAPTURE_MS — un Pi 3 ne
    // suit pas si on lui en demande une toutes les deux secondes.
    if (rtCaptureEnCours || Date.now() - rtDerniereCapture < RT_CAPTURE_MS) return;
    rtCaptureEnCours = true;
    rtDerniereCapture = Date.now();
    grabSingleFrame(CONFIG.VOICE_CAMERA_DEVICE)
      .then((shot) => {
        if (shot && rtActif) socket.emit('rt_frame', { code: CONFIG.CODE, frame: shot });
      })
      .catch(() => {})
      .finally(() => { rtCaptureEnCours = false; });
  }, Number(process.env.RT_FRAME_MS || 2000));
  log('Direct: conversation temps reel demarree.');
}

function rtArreter() {
  if (!rtActif) return;
  rtActif = false;
  if (rtFrameTimer) { clearInterval(rtFrameTimer); rtFrameTimer = null; }
  if (micro) micro.arreter();
  if (parole) {
    parole.couper('fin de conversation');
    parole.fermerSession();
    if (tts) tts.reprendreVeilleuse();
  }
  socket.emit('rt_stop', { code: CONFIG.CODE });
  log('Direct: conversation temps reel arretee.');
}

socket.on('robot_rt', (p) => {
  if (p && p.on) rtDemarrer();
  else rtArreter();
});

// Morceau d'audio a jouer. On l'empile sans attendre la suite : c'est ce qui
// donne l'impression de direct.
socket.on('rt_audio_out', (p) => {
  if (!rtActif || !p || !p.pcm || !parole) return;
  if (Date.now() < rtIgnorerJusqua) return; // reste de la reponse annulee
  parole.ajouter(Buffer.from(p.pcm));
});

// L'interlocuteur a repris la parole : on coupe net. Fermer proprement ne
// suffirait pas, le tampon d'aplay contient deja plusieurs centaines de ms.
socket.on('rt_couper', () => {
  // Ne couper QUE s'il y a vraiment du son en cours. OpenAI signale souvent
  // une prise de parole a l'instant meme ou la reponse se termine : couper
  // alors ne fait rien gagner, mais detruit le tuyau audio maintenu ouvert
  // pour la conversation. La reponse suivante devait donc rouvrir aplay et
  // repayer son amorce, ce qui rognait ses premieres syllabes.
  if (parole && parole.parle()) parole.couper('interruption');
});

socket.on('rt_etat', (p) => {
  if (!p) return;
  if (p.erreur) log('Direct: ' + p.erreur);
  // FIN de la reponse : on ferme le tuyau audio proprement (aplay vide son
  // tampon) et surtout parole.parle() redevient faux — sans quoi le garde-fou
  // anti-echo bloquerait la transmission du micro pour toujours, et le robot
  // ne repondrait qu'une seule fois.
  if (p.finReponse && parole) parole.terminer();
});

// --- Rondes : pilotage depuis l'app ----------------------------------------
// Une seule voie d'entree, avec une action nommee : plus simple a etendre
// qu'un evenement par bouton.
//   apprendre_debut / apprendre_fin / oublier / demarrer / arreter / etat
// Arret d'urgence venu de l'app. On coupe TOUT ce qui peut faire avancer le
// robot, du plus urgent au moins urgent — et on le fait meme si l'un des
// sous-systemes n'est pas actif, pour n'avoir aucun cas particulier a se
// rappeler le jour ou on appuie dessus.
// Ce que le modele a compris de la derniere prise de parole. Sans cette
// ligne, impossible de distinguer "il m'a mal entendu" de "il a repondu a
// quelqu'un d'autre" : les deux se ressemblent vues de l'exterieur.
socket.on('rt_entendu', (p) => {
  const t = p && p.texte ? String(p.texte).slice(0, 200) : '';
  if (t) log(`Direct: entendu "${t}"`);
});

// Alarme dissuasive, declenchee depuis l'app. Interrupteur et non impulsion :
// on doit pouvoir la couper a distance, sinon elle devient un probleme a son
// tour.
socket.on('robot_mode', (p) => {
  definirMode(p && p.absent, 'app');
  socket.emit('robot_mode_status', { code: CONFIG.CODE, absent: modeAbsent });
  sendRobotStatus();
});

socket.on('robot_alarme', (p) => {
  const on = !!(p && p.on);
  if (!tts) return;
  if (on) {
    tts.demarrerAlarme(p && p.texte).catch((e) => log('ALARME:', e.message));
  } else {
    tts.arreterAlarme();
  }
  socket.emit('robot_alarme_status', { code: CONFIG.CODE, on });
});

socket.on('robot_stop_all', () => {
  log('ARRET D URGENCE demande par l app.');
  // 1. les moteurs, tout de suite
  handleRemoteDrive('S', 'arret-urgence', `stopall-${Date.now()}`).catch(() => {});
  // 2. la navigation GPS
  navTarget = null;
  navRoute = null;
  navRouteIdx = 0;
  if (navigator) {
    navigator.opts.arrivalRadius = CONFIG.ARRIVAL_RADIUS_M;
    navigator.stop({ sendStop: true });
  }
  // 3. la ronde autonome
  if (ronde) ronde.arreter();
  // 4. la conversation en direct : elle aussi commande les moteurs, via les
  //    outils du cerveau vocal. La laisser ouverte, c'est laisser une main
  //    sur le volant.
  rtArreter();
  // 5. l'alarme : c'est le bouton qu'on presse quand quelque chose tourne
  //    mal, et une sirene qu'on ne peut plus arreter en fait partie.
  if (tts && tts.arreterAlarme()) log('Alarme coupee par l arret d urgence.');
  sendRobotStatus();
});

socket.on('robot_ronde', (p) => {
  if (!ronde) return;
  const action = String(p && p.action ? p.action : '').toLowerCase();
  switch (action) {
    case 'apprendre_debut':
      // Une ronde en cours et un apprentissage ne peuvent pas cohabiter :
      // le robot roulerait tout seul pendant qu'on essaie de lui montrer.
      ronde.arreter();
      ronde.apprendreDebut();
      break;
    case 'apprendre_fin':
      ronde.apprendreFin();
      break;
    case 'oublier':
      ronde.oublier();
      break;
    case 'demarrer':
      ronde.demarrer();
      break;
    case 'arreter':
      ronde.arreter();
      break;
    case 'etat':
      break; // l'etat est publie ci-dessous dans tous les cas
    default:
      log(`Ronde: action inconnue "${action}".`);
  }
  socket.emit('robot_ronde_status', { code: CONFIG.CODE, ...ronde.etat() });
  sendRobotStatus();
});

setInterval(() => {
  if (socket.connected) sendRobotStatus();
}, CONFIG.ROBOT_STATUS_INTERVAL_MS);

setInterval(() => {
  if (socket.connected) announceRobotOnline();
}, CONFIG.ROBOT_HEARTBEAT_MS);

if (process.stdin.isTTY) rl.prompt();
else log('Console non interactive: les commandes clavier ne seront pas lues ici.');

process.on('SIGINT', () => {
  log('Arret demande: stop moteurs.');
  arduino.stop();
  stopCameraStream();
  stopAudioStream();
  process.exit(0);
});
