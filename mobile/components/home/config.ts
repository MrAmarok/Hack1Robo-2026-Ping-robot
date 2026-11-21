import Constants from 'expo-constants';

// ========================
// Constantes & config
// ========================
// Serveur Ping, en HTTPS.
//
// C'etait 'http://<ip-serveur>:3000', en clair sur une IP nue. Sur iPhone la
// socket passait malgre tout ; sur Android, RIEN : le systeme bloque le trafic
// non chiffre par defaut depuis Android 9. L'app s'installait, s'ouvrait, et
// n'apparaissait meme pas dans les journaux de connexion du serveur.
//
// nginx expose desormais le serveur sous /ping/ et retire ce prefixe avant de
// transmettre au port 3000. /socket.io/ n'etait pas libre : il appartient deja
// a une autre application du VPS. Le robot, lui, garde son acces direct.
//
// Au passage, le flux de surveillance ne circule plus en clair.
const LOCAL_SERVER_ORIGIN = process.env.EXPO_PUBLIC_PING_SERVER_ORIGIN?.replace(/\/+$/, '');
export const ORIGINE_SERVEUR = LOCAL_SERVER_ORIGIN || 'https://api.ping-app.org';
const SERVER_PREFIX = LOCAL_SERVER_ORIGIN ? '' : '/ping';
export const SOCKET_URL = `${ORIGINE_SERVEUR}${SERVER_PREFIX}`;
export const SOCKET_PATH = `${SERVER_PREFIX}/socket.io/`;
// Video WebRTC : le robot pousse un H.264 vers MediaMTX (sur le VPS), l'app le
// lit en WHEP via le proxy /rtc du serveur (seul port HTTP ouvert). Le module
// natif peut manquer dans un ancien build installe -> require() protege, et
// dans ce cas l'app garde l'affichage MJPEG d'origine.
export const webrtc: any = (() => {
  try {
    return require('react-native-webrtc');
  } catch (e: any) {
    // Visible dans le terminal Metro : dit POURQUOI le module natif manque.
    console.warn('WebRTC indisponible -> video en mode secours :', e?.message || e);
    return null;
  }
})();
// Veille ecran : module natif deja embarque par Expo. require() protege au
// cas ou il manquerait dans un ancien build (l'app marche juste sans).
export const keepAwake: any = (() => {
  try {
    return require('expo-keep-awake');
  } catch {
    return null;
  }
})();
// Flux audio du micro robot, servi en HTTPS (nginx -> serveur:3000).
// Sert de SECOURS si le WebRTC audio ne s'etablit pas.
export const AUDIO_STREAM_BASE = 'https://api.ping-app.org';

// Pilotage de la session audio du telephone. Pour le micro WebRTC du robot,
// ce module natif active le mode appel et conserve volontairement la sortie
// dans l'ecouteur d'oreille. Necessite un build natif ; require() protege pour
// que l'app fonctionne meme si le module manque dans une ancienne version.
export const inCall: any = (() => {
  try {
    const m = require('react-native-incall-manager');
    return m?.default || m;
  } catch (e: any) {
    console.warn('InCallManager absent (rebuild necessaire) :', e?.message || e);
    return null;
  }
})();
export const LOCATION_TASK_NAME = 'background-location-task';
export const BACKGROUND_PUSH_TASK = 'background-push-sync-task';
export const STRONG_VIBRATION_PATTERN = [0, 1000, 500, 1000];
export const EAS_PROJECT_ID = (Constants.expoConfig?.extra as any)?.eas
  ?.projectId as string | undefined;
