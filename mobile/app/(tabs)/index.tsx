import 'react-native-gesture-handler';
// ⚠️ Ne pas importer 'react-native-reanimated' directement si vous utilisez Expo Go
// import 'react-native-reanimated';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Vibration,
  StyleSheet,
  Alert,
  Platform,
  Linking,
  ActionSheetIOS,
  AppState,
  Modal,
  Image,
  Dimensions,
  useWindowDimensions,
  PanResponder,
} from 'react-native';
import * as Location from 'expo-location';
import {
  useAudioPlayer,
  useAudioRecorder,
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  setAudioModeAsync,
  type RecordingOptions,
} from 'expo-audio';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import * as TaskManager from 'expo-task-manager';
import io, { Socket } from 'socket.io-client';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadNativeMaps } from '@/components/nativeMaps';
import { SonarMapView, type SonarSnapshot } from '@/components/SonarMapView';

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
const ORIGINE_SERVEUR = LOCAL_SERVER_ORIGIN || 'https://api.ping-app.org';
const SERVER_PREFIX = LOCAL_SERVER_ORIGIN ? '' : '/ping';
const SOCKET_URL = `${ORIGINE_SERVEUR}${SERVER_PREFIX}`;
const SOCKET_PATH = `${SERVER_PREFIX}/socket.io/`;
// Video WebRTC : le robot pousse un H.264 vers MediaMTX (sur le VPS), l'app le
// lit en WHEP via le proxy /rtc du serveur (seul port HTTP ouvert). Le module
// natif peut manquer dans un ancien build installe -> require() protege, et
// dans ce cas l'app garde l'affichage MJPEG d'origine.
const webrtc: any = (() => {
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
const keepAwake: any = (() => {
  try {
    return require('expo-keep-awake');
  } catch {
    return null;
  }
})();
// Flux audio du micro robot, servi en HTTPS (nginx -> serveur:3000).
// Sert de SECOURS si le WebRTC audio ne s'etablit pas.
const AUDIO_STREAM_BASE = 'https://api.ping-app.org';

// Pilotage de la session audio du telephone. Pour le micro WebRTC du robot,
// ce module natif active le mode appel et conserve volontairement la sortie
// dans l'ecouteur d'oreille. Necessite un build natif ; require() protege pour
// que l'app fonctionne meme si le module manque dans une ancienne version.
const inCall: any = (() => {
  try {
    const m = require('react-native-incall-manager');
    return m?.default || m;
  } catch (e: any) {
    console.warn('InCallManager absent (rebuild necessaire) :', e?.message || e);
    return null;
  }
})();
const LOCATION_TASK_NAME = 'background-location-task';
const BACKGROUND_PUSH_TASK = 'background-push-sync-task';
const STRONG_VIBRATION_PATTERN = [0, 1000, 500, 1000];
const EAS_PROJECT_ID = (Constants.expoConfig?.extra as any)?.eas
  ?.projectId as string | undefined;

type NotifStatus = 'granted' | 'denied' | 'undetermined';
type Coord = { latitude: number; longitude: number };
type Mode = 'driving' | 'walking' | 'transit' | 'bicycling';
type RobotDriveCommand = 'F' | 'B' | 'L' | 'R' | 'S' | '+' | '-';
type RobotStatus = {
  fix?: boolean;
  coords?: Coord | null;
  gpsAgeMs?: number | null;
  heading?: number | null;
  speedKnots?: number | null;
  obstacleCm?: number | null;
  modeAbsent?: boolean;
  arduinoConnected?: boolean;
  navActive?: boolean;
  sharing?: boolean;
  by?: string;
  error?: string;
  ts?: number;
};

const ONBOARD_KEY = 'hasSeenTutorial_v1';

// ========================
// Notifications — config safe
// ========================
try {
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: STRONG_VIBRATION_PATTERN as number[],
      // Son du systeme, et surtout PAS 'ringtone.mp3' : ce fichier n'existe
      // nulle part dans le projet, et le plugin expo-notifications n'a aucune
      // configuration pour l'embarquer comme ressource Android. Le canal
      // referencait donc un son introuvable — et un canal qui echoue a se
      // creer, c'est une notification qui n'apparait jamais, sans la moindre
      // erreur visible.
    }).catch(() => {});
  }
} catch {}

// Une alerte telle que le serveur la conserve : celles qui ont sonne comme
// celles qu'il a volontairement retenues.
// Un enregistrement tel que le serveur le conserve.
type VideoServeur = { nom: string; mo: number; url: string };

type AlerteHisto = {
  ts: number;
  type: string;
  capteurs?: string[];
  categorie: string;
  phrase?: string | null;
  notifiee: boolean;
  photo?: string | null;
};

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const body = String(notification?.request?.content?.body || '');
    const isRobotInternal = body.startsWith('PING_ROBOT_');
    return {
    shouldShowBanner: !isRobotInternal,
    shouldShowList: !isRobotInternal,
    shouldPlaySound: !isRobotInternal,
    shouldSetBadge: false,
    };
  },
});

function openSystemSettings() {
  if (Platform.OS === 'ios') Linking.openURL('app-settings:');
  else Linking.openSettings?.();
}

// ========================
// Tâches background (anti double-définition)
// ========================
declare global {
  // @ts-ignore
  var __PING_TASKS_DEFINED__: boolean | undefined;
}
if (!global.__PING_TASKS_DEFINED__) {
  try {
    TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
      try {
        if (error) return;
        const { locations } = (data as any) || {};
        if (!locations || !locations[0]) return;

        const { latitude, longitude } = locations[0].coords || {};
        if (typeof latitude !== 'number' || typeof longitude !== 'number')
          return;

        await AsyncStorage.setItem(
          'lastBgLocation',
          JSON.stringify({ latitude, longitude, ts: Date.now() })
        );
      } catch {}
    });
  } catch {}

  try {
    TaskManager.defineTask(BACKGROUND_PUSH_TASK, async ({ data, error }) => {
      try {
        if (error) return;
        const notification: any = (data as any)?.notification;
        const pld = notification?.request?.content?.data || {};
        if (!pld?.type) return;

        const code = (await AsyncStorage.getItem('pairCode'))?.trim();
        const pseudo = (await AsyncStorage.getItem('pseudo'))?.trim();
        if (!code || !pseudo) return;

        const since = Number((await AsyncStorage.getItem('lastSeen')) || 0);

        await fetch(`${SOCKET_URL}/bg-sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, pseudo, since }),
        });
      } catch (e) {
        console.log('[BACKGROUND_PUSH_TASK] error', e);
      }
    });
  } catch {}

  global.__PING_TASKS_DEFINED__ = true;
}

// ========================
// Presets
// ========================
const DEDUPE = (arr: string[]) => Array.from(new Set(arr.map((s) => s.trim())));

const PRESET_MESSAGES = DEDUPE([
  'Tu es là ?',
  'Vous êtes là ?',
  'Oui',
  'Non',
  'Reçu',
  'Appelle-moi',
]);

const JOIN_MESSAGES = DEDUPE([
  'Je démarre',
  'Je suis en route',
  'J’y suis presque',
  "J’arrive",
  'Je suis devant',
  'Je suis au portail',
  'Je suis là',
]);

const SUGGESTIONS = DEDUPE([
  'Oui je suis là',
  'Oui on est là',
  'Je confirme',
  'Ça roule',
  'Parfait',
]);

const ROBOT_DRIVE_LABELS: Record<RobotDriveCommand, string> = {
  F: 'Avancer',
  B: 'Reculer',
  L: 'Gauche',
  R: 'Droite',
  S: 'Stop',
  '+': 'Accelerer',
  '-': 'Ralentir',
};
const ROBOT_DRIVE_BUZZ_PREFIX = 'PING_ROBOT_DRIVE:';
const ROBOT_ACK_BUZZ_PREFIX = 'PING_ROBOT_ACK:';
const ROBOT_ONLINE_BUZZ_PREFIX = 'PING_ROBOT_ONLINE:';
const ROBOT_CAM_BUZZ_PREFIX = 'PING_ROBOT_CAM:';
// Pan-tilt camera : degres ajoutes a chaque pas (le maintien repete ~7x/s).
const CAM_STEP_DEG = 5;

// Encodeur base64 maison : le robot envoie desormais les images camera en
// BINAIRE (25% de data en moins sur la 4G que l'ancien base64). React Native
// ne sait afficher qu'une data-URI base64, donc on convertit ici, cote app,
// ou la puissance CPU ne manque pas (~1-2 ms par image).
const B64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    parts.push(
      B64_CHARS[b0 >> 2],
      B64_CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)],
      b1 === undefined ? '=' : B64_CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)],
      b2 === undefined ? '=' : B64_CHARS[b2 & 63]
    );
  }
  return parts.join('');
}
const TALKIE_MIN_BYTES = 2000;
const TALKIE_MAX_BYTES = 2 * 1024 * 1024;
const TALKIE_MIN_STOP_DELAY_MS = 350;
const TALKIE_MAX_DURATION_MS = 20000;
const TALKIE_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 64000,
  },
};

// Phrases preenregistrees que le robot peut dire a haute voix (TTS).
const SAY_PRESETS_KEY = 'sayPresets_v1';
const DEFAULT_SAY_PRESETS = [
  'Bonjour !',
  'Pousse-toi, je passe',
  'Suis-moi',
  'Attention',
  'Merci !',
  'Au revoir',
];
const ROBOT_DEBUG_LOGS = false;

function distanceMeters(
  a: Coord | null | undefined,
  b: Coord | null | undefined
): number | null {
  if (!a || !b) return null;
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

function formatCoord(coord: Coord | null | undefined) {
  if (!coord) return 'Aucune position';
  return `${coord.latitude.toFixed(6)}, ${coord.longitude.toFixed(6)}`;
}


// ========================
// Navigation externe
// ========================
function modeFlagIOS(mode: Mode) {
  if (mode === 'walking') return 'w';
  if (mode === 'transit') return 'r';
  return 'd';
}
function modeFlagAndroid(mode: Mode) {
  if (mode === 'walking') return 'w';
  if (mode === 'bicycling') return 'b';
  return 'd';
}

async function openExternalNavigation(
  origin: Coord,
  destination: Coord,
  mode: Mode = 'driving'
) {
  const o = `${origin.latitude},${origin.longitude}`;
  const d = `${destination.latitude},${destination.longitude}`;
  const encO = encodeURIComponent(o);
  const encD = encodeURIComponent(d);

  const tryOpen = async (url: string) => {
    try {
      const ok = await Linking.canOpenURL(url);
      if (ok) {
        await Linking.openURL(url);
        return true;
      }
    } catch {}
    return false;
  };

  try {
    if (Platform.OS === 'ios') {
      const gmapsIOS = `comgooglemaps://?daddr=${encD}&directionsmode=${
        mode === 'walking' ? 'walking' : 'driving'
      }`;
      if (await tryOpen(gmapsIOS)) return;

      const appleHttp = `http://maps.apple.com/?saddr=${encO}&daddr=${encD}&dirflg=${modeFlagIOS(
        mode
      )}`;
      if (await tryOpen(appleHttp)) return;

      const wazeIOS = `waze://?ll=${encD}&navigate=yes`;
      if (await tryOpen(wazeIOS)) return;

      await Linking.openURL(
        `https://www.google.com/maps/dir/?api=1&origin=${encO}&destination=${encD}&travelmode=${mode}`
      );
      return;
    }

    const gnav = `google.navigation:q=${encD}&mode=${modeFlagAndroid(mode)}`;
    if (await tryOpen(gnav)) return;

    const waze = `waze://?ll=${encD}&navigate=yes`;
    if (await tryOpen(waze)) return;

    const geo = `geo:${d}?q=${encD}`;
    if (await tryOpen(geo)) return;

    await Linking.openURL(
      `https://www.google.com/maps/dir/?api=1&origin=${encO}&destination=${encD}&travelmode=${mode}`
    );
  } catch (e) {
    Alert.alert('Navigation', 'Impossible d’ouvrir une application de navigation.');
  }
}

// Range une video du serveur dans la galerie du telephone.
//
// Les enregistrements vivaient uniquement sur le VPS : rien ne permettait de
// les recuperer. Les photos, elles, y allaient deja.
async function rangerVideoDansGalerie(nom: string, mo?: number) {
  try {
    const perm = await MediaLibrary.requestPermissionsAsync(true); // ecriture seule
    if (!perm.granted) {
      Alert.alert('Video', 'Autorisation galerie refusee.');
      return;
    }
    const url = `${SOCKET_URL}/enregistrement?f=${encodeURIComponent(nom)}`;
    const dest = `${FileSystem.cacheDirectory}${nom}`;
    const r = await FileSystem.downloadAsync(url, dest);
    if (r.status !== 200) throw new Error(`le serveur a repondu ${r.status}`);
    await MediaLibrary.saveToLibraryAsync(r.uri);
    // Le cache n'est pas vide par le systeme avant longtemps : une video de
    // plusieurs dizaines de Mo y resterait en double.
    try { await FileSystem.deleteAsync(r.uri, { idempotent: true }); } catch {}
    Alert.alert('Video', `Enregistree dans ta galerie (${mo ?? '?'} Mo).`);
  } catch (e: any) {
    Alert.alert('Video', `Telechargement impossible : ${String(e?.message || e).slice(0, 120)}`);
  }
}

// ========================
// Push token
// ========================
// Pourquoi le dernier appel n'a pas rendu de jeton. Remonte au serveur, parce
// qu'un `catch` muet sur un telephone qu'on n'a pas en main ne se debogue pas.
let raisonJetonAbsent: string | null = null;

async function ensureExpoPushToken(interactive = false): Promise<string | null> {
  if (Platform.OS === 'web') {
    raisonJetonAbsent = 'Expo push notifications are unavailable on web';
    return null;
  }
  raisonJetonAbsent = null;
  try {
    // On redemande TOUJOURS un jeton frais : Android le remplace de lui-meme
    // (reinstallation, mise a jour des services Google). Rendre la copie
    // gardee, comme avant, envoyait au serveur un jeton mort que Google
    // refusait (DeviceNotRegistered) — plus aucune alerte sur ce telephone.
    // La copie ne sert plus que de repli si la demande echoue (voir le catch).
    if (!Device.isDevice) {
      raisonJetonAbsent = 'emulateur (Device.isDevice = false)';
      return null;
    }

    let perms = await Notifications.getPermissionsAsync();

    // Permission jamais demandee : on la demande, meme hors mode interactif.
    //
    // Sans ca, une installation NEUVE n'obtient jamais de jeton : le mode non
    // interactif se contentait de constater l'absence de permission et rendait
    // null. Sur iPhone ca ne se voyait pas, la permission ayant ete accordee
    // des les premiers essais ; sur un Android fraichement installe, rien ne
    // la demandait jamais — et Android 13 l'exige explicitement.
    //
    // `interactive` controle l'explication AVANT la demande, pas le fait de
    // demander : le systeme, lui, n'affiche sa fenetre qu'une seule fois.
    if (!interactive && perms.status === 'undetermined') {
      try {
        perms = await Notifications.requestPermissionsAsync();
      } catch {}
    }

    if (interactive && perms.status !== 'granted') {
      await new Promise<void>((resolve) => {
        Alert.alert(
          'Notifications (optionnel)',
          'Active-les pour recevoir un message même si l’app est fermée.',
          [
            { text: 'Plus tard', style: 'cancel', onPress: () => resolve() },
            {
              text: 'Activer',
              onPress: async () => {
                perms = await Notifications.requestPermissionsAsync();
                resolve();
              },
            },
          ],
          { cancelable: true }
        );
      });
    }

    if (perms.status !== 'granted') {
      raisonJetonAbsent = `permission refusee ou absente (statut: ${perms.status})`;
      return null;
    }

    const projectId =
      EAS_PROJECT_ID ?? (Constants as any)?.expoConfig?.extra?.eas?.projectId;
    const { data } = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();

    if (data) {
      await AsyncStorage.setItem('expoPushToken', data);
      return data;
    }
    raisonJetonAbsent = `reponse vide (projectId: ${projectId || 'absent'})`;
    return null;
  } catch (e: any) {
    // C'est ICI que tout se perdait : sur Android, getExpoPushTokenAsync echoue
    // si la configuration Firebase manque dans le build, et le message partait
    // dans une console qu'on ne lit jamais depuis un telephone distant.
    raisonJetonAbsent = `exception: ${String(e?.message || e).slice(0, 200)}`;
    console.log('ensureExpoPushToken error', e);
    // Hors ligne au demarrage par exemple : mieux vaut le dernier jeton
    // connu que rien.
    try {
      const cached = await AsyncStorage.getItem('expoPushToken');
      if (cached && /^ExponentPushToken\[\S+\]$/.test(cached)) return cached;
    } catch {}
    return null;
  }
}

// ========================
// lastSeen helpers
// ========================
async function getLastSeen() {
  const v = await AsyncStorage.getItem('lastSeen');
  return v ? Number(v) : 0;
}
async function setLastSeenNow() {
  await AsyncStorage.setItem('lastSeen', String(Date.now()));
}

// ========================
// Composant principal
// ========================
export default function App() {
  const [pseudo, setPseudo] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [customMessage, setCustomMessage] = useState('');
  const [socketOnline, setSocketOnline] = useState(false);
  const [sonarOpen, setSonarOpen] = useState(false);
  const [sonarSnapshot, setSonarSnapshot] = useState<SonarSnapshot | null>(null);
  const [pairedWith, setPairedWith] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [robotCommandStatus, setRobotCommandStatus] = useState('');
  const [robotStatus, setRobotStatus] = useState<RobotStatus | null>(null);
  const [robotHeartbeat, setRobotHeartbeat] = useState('');
  // Temoin de connexion du robot (Pi) : en cours / connecte / deconnecte
  const [robotLink, setRobotLink] = useState<'connecting' | 'connected' | 'disconnected'>(
    'disconnected'
  );
  const robotLastSeenAtRef = useRef(0);

  const [meetRequestFrom, setMeetRequestFrom] = useState<string | null>(null);
  const [meetStatus, setMeetStatus] = useState<'pending' | 'accepted' | null>(
    null
  );

  const [myCoord, setMyCoord] = useState<Coord | null>(null);
  const [peerCoord, setPeerCoord] = useState<Coord | null>(null);

  // Camera robot (flux MJPEG relaye par le serveur)
  const [cameraOn, setCameraOn] = useState(false);
  const [frameUri, setFrameUri] = useState<string | null>(null);
  // Video WebRTC (WHEP). Si connectee, elle remplace l'affichage MJPEG ;
  // les images MJPEG continuent a ~1/s en secours et pour le bouton photo.
  const [rtcStreamUrl, setRtcStreamUrl] = useState<string | null>(null);
  const rtcPcRef = useRef<any>(null);
  const rtcResourceRef = useRef<string | null>(null); // URL de fin de session WHEP
  const rtcRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rtcSessionRef = useRef(0); // neutralise les callbacks d'une session fermee
  // Micro du robot recu en piste Opus dans la meme connexion WebRTC.
  // Le bouton 🔊 active/coupe la piste localement (instantane).
  const rtcAudioTrackRef = useRef<any>(null);
  const [rtcAudioLive, setRtcAudioLive] = useState(false);
  // Pan-tilt camera : angles courants cote app (le robot recoit des angles
  // absolus, donc pas grave si un message se perd). 90/90 = camera centree.
  const camPanRef = useRef(90);
  const camTiltRef = useRef(90);
  const camHoldTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mode plein ecran camera + commandes de pilotage
  const [camFullscreen, setCamFullscreen] = useState(false);
  // Photo de la derniere alerte. iOS n'affiche pas l'image d'une notification
  // sans extension native, alors on la montre ici : elle arrive instantanement,
  // pendant que le flux video, lui, met quelques secondes a se connecter.
  const [alertePhoto, setAlertePhoto] = useState<string | null>(null);
  const [alerteGrande, setAlerteGrande] = useState(false);
  // Role dans le salon. 'pilote' = commande le robot ; 'spectateur' = camera
  // seule ; 'attente' = le pilote n'a pas encore repondu.
  const [role, setRole] = useState<'pilote' | 'spectateur' | 'attente' | null>(null);
  const estPilote = role === 'pilote' || role === null;
  // Historique des alertes. `null` signifie ECHEC DE CHARGEMENT, et surtout
  // pas "aucune alerte" : sur une app de surveillance, confondre les deux
  // afficherait un rassurant "rien a signaler" alors qu'on n'en sait rien.
  const [histoOuvert, setHistoOuvert] = useState(false);
  const [histoListe, setHistoListe] = useState<AlerteHisto[] | null>([]);
  const [histoChargement, setHistoChargement] = useState(false);
  // Enregistrements du serveur. `null` = echec de chargement, et surtout pas
  // "aucune video" : afficher "rien a montrer" quand on n'en sait rien ferait
  // croire que des enregistrements ont ete perdus.
  const [videosOuvert, setVideosOuvert] = useState(false);
  const [videosListe, setVideosListe] = useState<VideoServeur[] | null>([]);
  const [videosChargement, setVideosChargement] = useState(false);
  // La conversation ecoute-t-elle vraiment, ou attend-elle son nom ?
  // Sans ce temoin, un robot en veille et un robot en panne se ressemblent.
  const [rtEveille, setRtEveille] = useState(false);
  // Phrase de reveil telle que le serveur la regle : l'app ne la code pas en dur.
  const [rtPhrase, setRtPhrase] = useState('Salut Solana');

  // Le serveur ecrase toujours le meme fichier (<code>.jpg) : sans horodatage
  // dans l'URL, le telephone reafficherait la photo mise en cache, c'est-a-dire
  // celle de l'alerte PRECEDENTE. Le piege est silencieux, d'ou ce parametre.
  const chargerHistorique = useCallback(async () => {
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    setHistoChargement(true);
    try {
      const r = await fetch(`${AUDIO_STREAM_BASE}/alertes?code=${encodeURIComponent(code)}`);
      const j = await r.json();
      setHistoListe(Array.isArray(j?.alertes) ? j.alertes : []);
    } catch {
      setHistoListe(null);
    } finally {
      setHistoChargement(false);
    }
  }, []);

  const chargerVideos = useCallback(async () => {
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    setVideosChargement(true);
    try {
      const r = await fetch(`${SOCKET_URL}/enregistrements?code=${encodeURIComponent(code)}`);
      const j = await r.json();
      setVideosListe(Array.isArray(j?.videos) ? j.videos : []);
    } catch {
      setVideosListe(null);
    } finally {
      setVideosChargement(false);
    }
  }, []);

  const urlPhotoAlerte = (code: string) =>
    `${AUDIO_STREAM_BASE}/alerte-photo?code=${encodeURIComponent(code)}&t=${Date.now()}`;
  // Zoom de l'image en plein ecran : 1 = image entiere (rien de rogne),
  // jusqu'a 3x. Boutons +/- et pincement a deux doigts.
  const [camZoom, setCamZoom] = useState(1);
  const camZoomRef = useRef(1);
  camZoomRef.current = camZoom;
  const pinchStartRef = useRef<{ dist: number; zoom: number } | null>(null);
  const clampZoom = (z: number) => Math.max(1, Math.min(3, z));
  const bumpZoom = (delta: number) => setCamZoom((z) => clampZoom(Number((z + delta).toFixed(2))));
  // Pincement : ne prend la main qu'a DEUX doigts, pour laisser les appuis
  // simples atteindre les boutons de pilotage par-dessus.
  const pinchResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (e) => e.nativeEvent.touches.length === 2,
      onPanResponderMove: (e) => {
        const t = e.nativeEvent.touches;
        if (t.length !== 2) return;
        const dist = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
        if (!pinchStartRef.current) {
          pinchStartRef.current = { dist, zoom: camZoomRef.current };
          return;
        }
        const { dist: d0, zoom: z0 } = pinchStartRef.current;
        if (d0 > 0) setCamZoom(clampZoom(Number(((dist / d0) * z0).toFixed(2))));
      },
      onPanResponderRelease: () => {
        pinchStartRef.current = null;
      },
      onPanResponderTerminate: () => {
        pinchStartRef.current = null;
      },
    })
  ).current;
  // Vitesse robot en % (0% = PWM 140 mini, 100% = PWM 255 maxi). Le robot
  // demarre a fond (255), donc 100 par defaut.
  const [speedPct, setSpeedPct] = useState(100);

  const [savingPhoto, setSavingPhoto] = useState(false);
  // Bouton "parler au robot" : declenche l'assistant vocal a distance, sans
  // avoir a dire "Alexa" (utile de loin ou dans le bruit). Le robot bipe puis
  // ecoute la question, exactement comme avec le mot-cle.
  const [askingVoice, setAskingVoice] = useState(false);
  const askRobotVoice = useCallback(() => {
    const code = pairCodeRef.current?.trim();
    if (!code || !socketRef.current) return;
    socketRef.current.emit('robot_listen', { code });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setAskingVoice(true);
    // Le temoin reste allume le temps que le robot bipe et ecoute la question.
    setTimeout(() => setAskingVoice(false), 6000);
  }, []);

  // Agrandissement d'un panneau (camera / commandes / carte)
  const [expanded, setExpanded] = useState<'camera' | 'commands' | 'map' | null>(null);
  const bigH = Math.round(Dimensions.get('window').height * 0.6);
  const camH = expanded === 'camera' ? bigH : 270;
  // Rotation du tel : paysage -> plein ecran (camera normale, pas de 70/30).
  const { width: winW, height: winH } = useWindowDimensions();
  const isLandscape = winW > winH;
  const mapH = expanded === 'map' ? bigH : 150;
  const padH = expanded === 'commands' ? Math.round(bigH / 5) : 50;
  const toggleExpand = (p: 'camera' | 'commands' | 'map') =>
    setExpanded((cur) => (cur === p ? null : p));

  // Destination / navigation (carte)
  const [destInput, setDestInput] = useState('');
  const [sayInput, setSayInput] = useState('');
  const [sayPresets, setSayPresets] = useState<string[]>(DEFAULT_SAY_PRESETS);
  // Talkie-walkie : maintenir le bouton = enregistrer, relacher = envoyer.
  // AAC mono explicite : plus stable qu'un preset stereo et moins lourd sur le lien 4G.
  const voiceRecorder = useAudioRecorder(TALKIE_RECORDING_OPTIONS);
  const [talking, setTalking] = useState(false);
  const [talkStatus, setTalkStatus] = useState('');
  const talkSessionRef = useRef(0);
  const talkStartingRef = useRef(false);
  const talkRecordingRef = useRef(false);
  const talkStopRequestedRef = useRef(false);
  const talkFinishingRef = useRef(false);
  const talkStartedAtRef = useRef(0);
  const talkAutoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [destSuggestions, setDestSuggestions] = useState<
    { label: string; latitude: number; longitude: number }[]
  >([]);
  const [destination, setDestination] = useState<
    { latitude: number; longitude: number; label: string } | null
  >(null);
  const [destStartDist, setDestStartDist] = useState<number | null>(null);
  const [routeCoords, setRouteCoords] = useState<Coord[]>([]);
  const [navActive, setNavActive] = useState(false);
  // Cap du robot au moment ou on a appuye sur AVANCER. Tout l'interet de la
  // boussole est la : un cap absolu ne dit rien, c'est l'ECART avec le cap de
  // depart qui repond a "est-ce qu'il va tout droit ?".
  const [capRef, setCapRef] = useState<number | null>(null);
  const [alarmeOn, setAlarmeOn] = useState(false);
  const [modeAbsent, setModeAbsent] = useState(false);
  // Appel telephonique quand le robot voit quelqu'un en mode ABSENT. Le VPS
  // fait foi (reglage garde sur son disque) ; null = etat pas encore recu.
  const [appelAlerte, setAppelAlerte] = useState<{ actif: boolean; configure: boolean } | null>(null);
  // Vrai entre l'appui sur AVANCER et le premier cap exploitable recu.
  //
  // Sans boussole, le cap vient du GPS et n'existe QUE si le robot roule
  // deja : au moment precis ou on appuie, il est donc nul. Prendre la
  // reference a cet instant-la revenait a ne jamais en avoir. On la prend
  // donc au premier cap valable qui arrive apres le depart.
  const capRefAttenduRef = useRef(false);
  // Conversation vocale en direct (Realtime). Le robot est la source de
  // verite : il confirme via rt_etat. On garde un etat local pour que le
  // bouton reagisse tout de suite, sans attendre l aller-retour.
  const [rtActif, setRtActif] = useState(false);
  // Enregistrement de la vue camera. Il a lieu sur le VPS, qui recopie le flux
  // deja publie : le telephone ne fait qu'appuyer sur le bouton, et l'app peut
  // etre fermee sans interrompre la prise.
  const [recActif, setRecActif] = useState(false);
  const [recInfo, setRecInfo] = useState('');
  // Enregistrement HD filme par le robot lui-meme. Bien meilleure image, mais
  // il monopolise la camera : la vue en direct s'eteint pendant la prise.
  const [recHdActif, setRecHdActif] = useState(false);
  const [recHdInfo, setRecHdInfo] = useState('');
  // Rondes de surveillance. Le robot est la source de verite : il publie son
  // etat (robot_ronde_status) et l'app ne fait que l'afficher. Une ronde
  // continue meme app fermee, donc deviner l'etat cote telephone serait faux.
  const [ronde, setRonde] = useState<{
    apprentissage: boolean;
    enCours: boolean;
    points: number;
    longueurM: number;
    toursFaits: number;
    prochainDansS: number;
  } | null>(null);

  // Audio robot ("webradio" MP3 relayee par le serveur)
  const [listening, setListening] = useState(false);
  // Compteur de resynchro : changer l'URL recree le lecteur -> retour au direct
  // (le retard du buffer s'accumule sur une webradio et ne se rattrape jamais).
  const [audioEpoch, setAudioEpoch] = useState(0);
  // HTTPS obligatoire : iOS (ATS) bloque tout http://. Le domaine api.ping-app.org
  // proxifie /robot-audio vers le serveur du robot (port 3000).
  // C'est aussi ce qui garantit la sortie HAUT-PARLEUR : lu par expo-audio,
  // iOS reste en mode "lecture". Avec une piste audio WebRTC, il basculait en
  // mode "appel" et envoyait le son dans l'ecouteur de l'oreille.
  const audioUrl = `${AUDIO_STREAM_BASE}/robot-audio?code=${encodeURIComponent(pairCode.trim())}&e=${audioEpoch}`;
  // Lecteur MP3 de SECOURS uniquement : si le micro arrive deja par le
  // WebRTC (rtcAudioLive), on ne cree meme pas le lecteur HTTP.
  // Le lecteur mp3 n'est cree QUE si le WebRTC n'a pas pris la main. Sa simple
  // existence ouvre une session audio concurrente qui coupe la lecture WebRTC
  // (constate le 02/08 : le son demarrait puis s'arretait aussitot).
  // BOUTON HAUT-PARLEUR — exactement celui d'un appel telephonique.
  //
  // On GARDE le son WebRTC : sa latence est ce qui rend l'ecoute utile pour
  // surprendre quelqu'un chez soi. Le repli MP3 a trop de retard.
  //
  // iOS sort le son d'une session WebRTC par l'ecouteur d'oreille. Le journal
  // du 02/08 montre que start() d'InCallManager, qui RECONFIGURE toute la
  // session, coupait le son a tous les coups. Ici on ne reconfigure rien : on
  // ne fait que rediriger la SORTIE de la session existante, ce qui est une
  // operation distincte et bien plus legere.
  const [hautParleur, setHautParleur] = useState(false);
  const [mp3Secours, setMp3Secours] = useState(false);
  const audioPlayer = useAudioPlayer(listening && mp3Secours ? audioUrl : null);

  useEffect(() => {
    if (!listening) {
      setMp3Secours(false);
      return;
    }
    if (rtcAudioLive) {
      setMp3Secours(false); // WebRTC en place : surtout pas de lecteur mp3
      return;
    }
    const t = setTimeout(() => setMp3Secours(true), 6000);
    return () => clearTimeout(t);
  }, [listening, rtcAudioLive]);

  // Carte lazy
  const [maps, setMaps] = useState<ReturnType<typeof loadNativeMaps>>(null);
  const robotMapRef = useRef<import('react-native-maps').default>(null);

  const socketRef = useRef<Socket | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const robotHoldTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRobotCmdRef = useRef<{ id: string; cmd: RobotDriveCommand } | null>(null);
  // Horodatage de la derniere image caméra affichée (pour limiter les re-renders)
  const lastFrameAtRef = useRef(0);

  const pseudoRef = useRef(pseudo);
  useEffect(() => {
    pseudoRef.current = pseudo;
  }, [pseudo]);
  const pairCodeRef = useRef(pairCode);
  useEffect(() => {
    pairCodeRef.current = pairCode;
  }, [pairCode]);

  const pushRobotLog = (text: string) => {
    if (!ROBOT_DEBUG_LOGS) return;
    console.log(`[PING][ROBOT][APP] ${new Date().toLocaleTimeString()} ${text}`);
  };

  const [notifStatus, setNotifStatus] = useState<NotifStatus>('undetermined');
  const canNotifyRef = useRef(false);
  const firstSyncDoneRef = useRef(false);
  const suppressHistoryUntilRef = useRef<number>(Date.now());

  // ========= Onboarding =========
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const TUTORIAL_PAGES = [
    {
      title: 'Bienvenue 👋',
      text:
        'Ping te permet de te coordonner rapidement avec un contact : appairage, messages rapides et “Se rejoindre”.',
    },
    {
      title: '1) Appairage',
      text:
        'Saisis un Pseudo et un Code identiques sur les 2 téléphones, puis appuie sur S’APPARIER.',
    },
    {
      title: '2) Notifications',
      text:
        'Active les notifications pour recevoir les messages quand l’app est en arrière-plan ou fermée.',
    },
    {
      title: '3) Messages',
      text:
        'Envoie des messages rapides (Tu es là ?, Reçu, etc.) ou un message perso.',
    },
    {
      title: '4) Se rejoindre',
      text:
        'Envoie une demande “Se rejoindre”. Si c’est accepté, vous échangez la position et tu peux ouvrir l’itinéraire.',
    },
  ];
  const isLastStep = tutorialStep === TUTORIAL_PAGES.length - 1;
  const handleSkipTutorial = async () => {
    setShowTutorial(false);
    await AsyncStorage.setItem(ONBOARD_KEY, '1');
  };
  const handleNextTutorial = async () => {
    if (!isLastStep) setTutorialStep((s) => s + 1);
    else await handleSkipTutorial();
  };

  // ========================
  // Boot
  // ========================
  useEffect(() => {
    const load = async () => {
      const savedPseudo = await AsyncStorage.getItem('pseudo');
      const savedPairCode = await AsyncStorage.getItem('pairCode');
      if (savedPseudo) setPseudo(savedPseudo);
      if (savedPairCode) setPairCode(savedPairCode);

      const seen = await AsyncStorage.getItem(ONBOARD_KEY);
      if (!seen) setShowTutorial(true);

      const last = await AsyncStorage.getItem('lastBgLocation');
      if (last) {
        try {
          const p = JSON.parse(last);
          if (p?.latitude && p?.longitude)
            setMyCoord({ latitude: p.latitude, longitude: p.longitude });
        } catch {}
      }

      try {
        const perms = await Notifications.getPermissionsAsync();
        setNotifStatus(perms.status as NotifStatus);
        canNotifyRef.current = perms.status === 'granted';
        if (perms.status === 'granted') {
          try {
            const isReg = await TaskManager.isTaskRegisteredAsync(
              BACKGROUND_PUSH_TASK
            );
            if (!isReg) await Notifications.registerTaskAsync(BACKGROUND_PUSH_TASK);
          } catch {}
        }
      } catch (e) {
        console.log('Notifications.getPermissionsAsync error', e);
      }
    };
    load();
  }, []);

  // ========================
  // Socket lifecycle
  // ========================
  useEffect(() => {
    // L'ORIGINE seule, jamais `${ORIGINE}/ping` : socket.io lirait ce suffixe
    // comme un espace de noms et se connecterait a la mauvaise destination.
    // Le prefixe se declare dans `path`.
    const s = io(ORIGINE_SERVEUR, {
      path: SOCKET_PATH,
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    socketRef.current = s;
    pushRobotLog(`socket init -> ${ORIGINE_SERVEUR} (chemin ${SOCKET_PATH})`);

    s.on('sonar_map_snapshot', (snapshot: SonarSnapshot) => {
      if (snapshot.code !== pairCodeRef.current.trim()) return;
      setSonarSnapshot((current) =>
        current?.code === snapshot.code && current.updatedAt >= snapshot.updatedAt
          ? current
          : snapshot
      );
    });

    const savePairLocal = async (p: { code: string; pseudo: string }) =>
      AsyncStorage.setItem('pair', JSON.stringify(p));
    const loadPairLocal = async () => {
      const raw = await AsyncStorage.getItem('pair');
      return raw ? (JSON.parse(raw) as { code: string; pseudo: string }) : null;
    };

    const ensurePairOnline = async () => {
      const saved = await loadPairLocal();
      const effectivePseudo =
        pseudoRef.current?.trim() || saved?.pseudo?.trim();
      const effectiveCode = pairCodeRef.current?.trim() || saved?.code?.trim();
      if (!effectivePseudo || !effectiveCode) return;
      pushRobotLog(`pair emit pseudo=${effectivePseudo} code=${effectiveCode}`);

      const since = await getLastSeen();
      s.emit('pair', {
        pseudo: effectivePseudo,
        code: effectiveCode,
        lastSeen: since,
      });
      // rt_veille n'arrive qu'aux transitions : apres une reconnexion en
      // pleine conversation, on redemande l'etat courant.
      s.emit('rt_veille_etat', { code: effectiveCode });
      s.emit('alerte_appel_etat', { code: effectiveCode });
      // Capacites natives du build, annoncees a chaque connexion.
      //
      // Le bouton "parler" n'appelle startTalkLive QUE si le module WebRTC est
      // present ; sinon il bascule en silence sur l'ancien mode. Un diagnostic
      // place dans startTalkLive ne pouvait donc jamais s'executer dans le cas
      // qui nous interesse. Celui-ci est hors de tout chemin conditionnel.
      s.emit('app_diag', {
        code: effectiveCode,
        pseudo: effectivePseudo,
        sujet: 'capacites',
        detail: `webrtc=${webrtc ? 'present' : 'ABSENT'}`,
        plateforme: Platform.OS,
        version: Platform.Version,
      });
      s.emit('sync', { code: effectiveCode, since });

      const token = await ensureExpoPushToken(false);
      if (!token) {
        // Dire POURQUOI, et au serveur : c'est le seul endroit que je peux lire.
        s.emit('app_diag', {
          code: effectiveCode,
          pseudo: effectivePseudo,
          sujet: 'push',
          detail: raisonJetonAbsent || 'raison inconnue',
          plateforme: Platform.OS,
          version: Platform.Version,
        });
      }
      if (token) {
        try {
          const sid = s.id;
          if (sid) {
            // code + pseudo sont INDISPENSABLES : sans eux le serveur ne
            // garde le jeton que dans sa table volatile liee a la socket, et
            // il le perd des que l'app se ferme — c'est-a-dire exactement
            // quand une alerte de surveillance doit arriver.
            // Canal socket : le POST HTTP est bloque par iOS (ATS).
            s.emit('register_token', {
              code: effectiveCode,
              pseudo: effectivePseudo,
              token,
            });
          }
        } catch (e) {
          console.log('Erreur /register-token', e);
        }
      }
      const last = await AsyncStorage.getItem('lastBgLocation');
      if (last) {
        try {
          const p = JSON.parse(last);
          if (p?.latitude && p?.longitude) {
            s.emit('share_location', {
              code: effectiveCode,
              coords: { latitude: p.latitude, longitude: p.longitude },
            });
          }
        } catch {}
      }
    };

    s.on('connect', async () => {
      setSocketOnline(true);
      pushRobotLog(`socket connect id=${s.id || '?'}`);
      suppressHistoryUntilRef.current = Date.now();
      firstSyncDoneRef.current = false;
      await ensurePairOnline();
    });

    s.on('disconnect', () => {
      setSocketOnline(false);
      pushRobotLog('socket disconnect');
      setPairedWith('');
      setMeetRequestFrom(null);
      setMeetStatus(null);
      setPeerCoord(null);
    });

    s.on('sync_batch', async ({ items }) => {
      try {
        if (Array.isArray(items)) {
          const suppressUntil = suppressHistoryUntilRef.current;
          const ignoreAlerts = !firstSyncDoneRef.current;

          for (const evt of items) {
            const tsOld =
              typeof (evt as any)?.ts === 'number'
                ? (evt as any).ts <= suppressUntil
                : false;
            if (tsOld && !ignoreAlerts) continue;

            if ((evt as any)?.type === 'buzz' && (evt as any)?.payload?.message) {
              const message = String((evt as any).payload.message || '');
              if (message.startsWith('PING_ROBOT_')) continue;
              if (!ignoreAlerts) {
                Vibration.vibrate(STRONG_VIBRATION_PATTERN as number[]);
                Alert.alert('Nouveau message', message);
                if (canNotifyRef.current) {
                  await Notifications.scheduleNotificationAsync({
                    content: {
                      title: 'Nouveau message',
                      body: message,
                      sound: 'default',
                    },
                    trigger: null,
                  });
                }
              }
            } else if ((evt as any)?.type === 'meet_request') {
              if (!ignoreAlerts)
                setMeetRequestFrom((evt as any)?.payload?.from || 'Ton contact');
            } else if ((evt as any)?.type === 'meet_accepted') {
              if (!ignoreAlerts) {
                setMeetRequestFrom(null);
                setMeetStatus('accepted');
              }
            } else if (
              (evt as any)?.type === 'meet_declined' ||
              (evt as any)?.type === 'meet_canceled'
            ) {
              if (!ignoreAlerts) {
                setMeetRequestFrom(null);
                setMeetStatus(null);
              }
            } else if (
              (evt as any)?.type === 'peer_location' &&
              (evt as any)?.payload?.coords
            ) {
              const c = (evt as any).payload.coords;
              if (c?.latitude && c?.longitude) {
                setPeerCoord({ latitude: c.latitude, longitude: c.longitude });
              }
            }
          }
        }
      } finally {
        firstSyncDoneRef.current = true;
        await setLastSeenNow();
      }
    });

    s.on('buzz', async (payload: { message?: string }) => {
      const message = payload?.message || '';
      if (message.startsWith(ROBOT_ACK_BUZZ_PREFIX)) {
        pushRobotLog(`buzz ack raw=${message}`);
        const parts = message.split(':');
        const idRaw = parts.length >= 4 ? parts[1] : 'legacy';
        const cmdRaw = parts.length >= 4 ? parts[2] : parts[1] || '';
        const statusRaw = parts.length >= 4 ? parts[3] : parts[2] || '';
        const cmd = cmdRaw as RobotDriveCommand;
        const label = ROBOT_DRIVE_LABELS[cmd] || cmdRaw;
        pendingRobotCmdRef.current = null;
        setRobotCommandStatus(
          statusRaw === 'OK' ? `Robot OK: ${label} (${idRaw})` : `Robot erreur: ${label} (${idRaw})`
        );
        await setLastSeenNow();
        return;
      }
      if (message.startsWith(ROBOT_DRIVE_BUZZ_PREFIX)) {
        pushRobotLog(`buzz drive interne ignore raw=${message}`);
        await setLastSeenNow();
        return;
      }
      if (message.startsWith(ROBOT_CAM_BUZZ_PREFIX)) {
        pushRobotLog(`buzz cam interne ignore raw=${message}`);
        await setLastSeenNow();
        return;
      }
      if (message.startsWith(ROBOT_ONLINE_BUZZ_PREFIX)) {
        pushRobotLog(`robot online raw=${message}`);
        robotLastSeenAtRef.current = Date.now();
        setRobotHeartbeat(new Date().toLocaleTimeString());
        setRobotCommandStatus('Robot en ligne');
        await setLastSeenNow();
        return;
      }
      Vibration.vibrate(STRONG_VIBRATION_PATTERN as number[]);
      if (message) {
        Alert.alert('Nouveau message', message);
        if (canNotifyRef.current) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Nouveau message',
              body: message,
              sound: 'default',
            },
            trigger: null,
          });
        }
      }
      await setLastSeenNow();
    });

    s.on('pair_state', (state: { code: string; users: Record<string, any> }) => {
      const me = pseudoRef.current;
      if (!me) return;
      const other = Object.keys(state?.users || {}).find((p) => p !== me);
      pushRobotLog(`pair_state users=${Object.keys(state?.users || {}).join(',') || 'none'}`);
      if (other) setPairedWith(other);
    });

    s.on('user_joined', async (payload: { pseudo?: string }) => {
      pushRobotLog(`user_joined pseudo=${payload?.pseudo || '?'}`);
      if (payload?.pseudo) setPairedWith(payload.pseudo);
      await setLastSeenNow();
    });

    s.on('user_left', async () => {
      setPairedWith('');
      setMeetRequestFrom(null);
      setMeetStatus(null);
      setPeerCoord(null);
      await setLastSeenNow();
    });

    s.on(
      'buzz_sent_confirmation',
      (payload: { status?: string; text?: string }) => {
        pushRobotLog(`buzz_sent_confirmation ${JSON.stringify(payload)}`);
        // Popup de confirmation "message transmis" retire (trop intrusif).
        // Le log ci-dessus suffit pour le debug.
      }
    );

    s.on('robot_drive_confirmation', (payload: { ok?: boolean; cmd?: RobotDriveCommand; id?: string }) => {
      pushRobotLog(`robot_drive_confirmation ${JSON.stringify(payload)}`);
      if (payload?.id && pendingRobotCmdRef.current?.id !== payload.id) return;
      if (payload?.ok && payload?.cmd) {
        setRobotCommandStatus(`${ROBOT_DRIVE_LABELS[payload.cmd]} envoye au serveur (${payload.id || '?'})`);
      }
    });

    s.on(
      'robot_drive_status',
      (payload: { ok?: boolean; cmd?: RobotDriveCommand; message?: string; by?: string; id?: string }) => {
        pushRobotLog(`robot_drive_status ${JSON.stringify(payload)}`);
        if (!payload?.cmd) return;
        const label = ROBOT_DRIVE_LABELS[payload.cmd];
        pendingRobotCmdRef.current = null;
        setRobotCommandStatus(
          payload.ok
            ? `Robot OK: ${label} (${payload.id || '?'})`
            : `Robot erreur: ${payload.message || label} (${payload.id || '?'})`
        );
      }
    );

    s.on('rt_veille', (p: { eveille?: boolean; phrase?: string }) => {
      setRtEveille(!!p?.eveille);
      if (p?.phrase) setRtPhrase(p.phrase);
    });

    // Qui commande, et qui regarde.
    s.on('role_acces', (p: { role?: string; raison?: string }) => {
      const r = (p?.role as any) || null;
      setRole(r);
      if (r === 'pilote' && p?.raison) {
        Alert.alert('Commandes', `Tu as repris les commandes : ${p.raison}.`);
      }
    });

    // Quelqu'un demande a entrer : seul le pilote recoit cette demande.
    s.on('acces_demande', (p: { id?: string; pseudo?: string }) => {
      if (!p?.id) return;
      Vibration.vibrate(STRONG_VIBRATION_PATTERN as number[]);
      Alert.alert(
        'Demande de connexion',
        `${p.pseudo || 'Quelqu un'} veut se connecter au robot.\n\nIl ne verra que la camera, sans pouvoir commander.`,
        [
          { text: 'Refuser', style: 'destructive',
            onPress: () => s.emit('acces_reponse', { id: p.id, accepte: false }) },
          { text: 'Accepter',
            onPress: () => s.emit('acces_reponse', { id: p.id, accepte: true }) },
        ],
        { cancelable: false }
      );
    });

    s.on('acces_refuse', () => {
      setRole(null);
      Alert.alert('Connexion refusee', 'Le pilote n a pas accepte ta connexion.');
    });

    // Le serveur a refuse une commande : on le DIT, au lieu de laisser croire
    // a une panne. Un bouton qui ne fait rien sans explication, c'est ce qu'on
    // vient de passer des heures a debusquer ailleurs.
    s.on('acces_refuse_commande', () => {
      Alert.alert('Lecture seule', 'Seul le pilote peut commander le robot.');
    });

    s.on('pilote_change', (p: { pseudo?: string }) => {
      if (p?.pseudo) Alert.alert('Pilote', `${p.pseudo} a maintenant les commandes.`);
    });

    // Le robot a alerte pendant que l'app est ouverte : on recupere la photo.
    s.on('robot_alerte', (payload: { type?: string; photo?: boolean }) => {
      if (!payload?.photo) return;
      const code = pairCodeRef.current?.trim();
      if (code) { setAlertePhoto(urlPhotoAlerte(code)); setAlerteGrande(true); }
    });

    s.on('robot_alarme_status', (payload: { on?: boolean }) => {
      setAlarmeOn(!!payload?.on);
    });

    s.on('alerte_appel_etat', (p: { actif?: boolean; configure?: boolean }) => {
      setAppelAlerte({ actif: !!p?.actif, configure: !!p?.configure });
    });

    s.on('robot_mode_status', (payload: { absent?: boolean }) => {
      setModeAbsent(!!payload?.absent);
    });

    s.on('robot_status', (payload: RobotStatus) => {
      pushRobotLog(`robot_status fix=${payload?.fix ? 'yes' : 'no'} arduino=${payload?.arduinoConnected ? 'yes' : 'no'} error=${payload?.error || '-'}`);
      robotLastSeenAtRef.current = Date.now();
      setRobotStatus(payload || null);
      if (typeof payload?.modeAbsent === 'boolean') setModeAbsent(payload.modeAbsent);
      if (capRefAttenduRef.current) {
        const h = payload?.heading;
        if (typeof h === 'number' && Number.isFinite(h)) {
          setCapRef(h);
          capRefAttenduRef.current = false;
        }
      }
      if (
        typeof payload?.coords?.latitude === 'number' &&
        typeof payload?.coords?.longitude === 'number'
      ) {
        setPeerCoord({
          latitude: payload.coords.latitude,
          longitude: payload.coords.longitude,
        });
      }
    });

    s.on('robot_frame', (payload: { jpeg?: string | ArrayBuffer | Uint8Array }) => {
      const raw = payload?.jpeg;
      if (!raw) return;
      // Chaque image = 1 re-render de tout l'ecran. On limite la cadence pour ne pas
      // saturer le thread JS (freeze). Pendant le pilotage on limite un peu plus
      // (thread prioritaire au controle) mais ~7 img/s reste fluide pour conduire.
      const minGapMs = robotHoldTimerRef.current ? 150 : 100;
      const now = Date.now();
      if (now - lastFrameAtRef.current < minGapMs) return;
      lastFrameAtRef.current = now;
      // Nouveau robot = image BINAIRE (-25% de 4G vs l'ancien base64) ; on ne
      // convertit en base64 qu'ici, juste pour l'affichage. Ancien robot = string.
      const b64 =
        typeof raw === 'string'
          ? raw
          : bytesToBase64(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
      setFrameUri(`data:image/jpeg;base64,${b64}`);
    });

    s.on('robot_nav_status', (payload: { arrived?: boolean }) => {
      setNavActive(false);
      if (payload?.arrived) {
        Vibration.vibrate(STRONG_VIBRATION_PATTERN as number[]);
        Alert.alert('Navigation', 'Le robot est arrivé à destination ✅');
      }
    });

    s.on(
      'robot_ronde_status',
      (payload: {
        apprentissage?: boolean;
        enCours?: boolean;
        points?: number;
        longueurM?: number;
        toursFaits?: number;
        prochainDansS?: number;
      }) => {
        setRonde({
          apprentissage: !!payload?.apprentissage,
          enCours: !!payload?.enCours,
          points: payload?.points ?? 0,
          longueurM: payload?.longueurM ?? 0,
          toursFaits: payload?.toursFaits ?? 0,
          prochainDansS: payload?.prochainDansS ?? 0,
        });
      }
    );

    // Le VPS confirme (ou refuse) la session temps reel. Sans cle OpenAI il
    // repond actif:false avec une raison : le bouton se desarme et l'utilisateur
    // sait pourquoi, au lieu de rester allume sans que rien ne se passe.
    s.on('rt_etat', (payload: { actif?: boolean; erreur?: string }) => {
      if (payload?.actif === false) {
        setRtActif(false);
        setRtEveille(false);
        if (payload?.erreur) Alert.alert('Conversation en direct', payload.erreur);
      } else if (payload?.actif === true) {
        setRtActif(true);
      }
    });

    // Etat de l'enregistrement video, publie par le VPS.
    s.on(
      'robot_record_status',
      (p: { actif?: boolean; secondes?: number; termine?: string; mo?: number; erreur?: string }) => {
        setRecActif(!!p?.actif);
        if (p?.erreur) {
          setRecInfo('');
          Alert.alert('Enregistrement', p.erreur);
        } else if (p?.termine) {
          setRecInfo(`${p.termine} — ${p.mo ?? '?'} Mo`);
          const nom = p.termine;
          const mo = p.mo ?? 0;
          // Au-dela de 50 Mo on DEMANDE : en 4G, telecharger une video de
          // plusieurs centaines de megaoctets sans prevenir serait brutal.
          if (mo > 50) {
            Alert.alert(
              'Video prete',
              `${mo} Mo. La telecharger dans ta galerie maintenant ?`,
              [
                { text: 'Plus tard', style: 'cancel' },
                { text: 'Telecharger', onPress: () => rangerVideoDansGalerie(nom, mo) },
              ]
            );
          } else {
            rangerVideoDansGalerie(nom, mo);
          }
        } else if (p?.actif) {
          setRecInfo('');
        }
      }
    );

    s.on(
      'robot_record_hd_status',
      (p: { actif?: boolean; termine?: string; mo?: number; erreur?: string }) => {
        setRecHdActif(!!p?.actif);
        if (p?.erreur) {
          setRecHdInfo('');
          Alert.alert('Film HD', p.erreur);
        } else if (p?.termine) {
          setRecHdInfo(`${p.termine} — ${p.mo ?? '?'} Mo, sur le robot`);
        } else if (p?.actif) {
          setRecHdInfo('');
        }
      }
    );

    s.on('user_is_typing', () => setIsTyping(true));
    s.on('user_stopped_typing', () => setIsTyping(false));

    s.on('meet_request', async (payload: { from?: string }) => {
      const from = payload?.from || 'Ton contact';
      setMeetRequestFrom(from);
      Alert.alert(
        'Demande “Se rejoindre”',
        `${from} veut te rejoindre.`,
        [
          {
            text: 'Refuser',
            style: 'cancel',
            onPress: () =>
              socketRef.current?.emit('decline_meet', {
                code: pairCodeRef.current,
              }),
          },
          {
            text: 'Accepter',
            onPress: async () => {
              socketRef.current?.emit('accept_meet', {
                code: pairCodeRef.current,
              });
              await shareMyLocationOnce();
            },
          },
        ],
        { cancelable: true }
      );
      await setLastSeenNow();
    });

    s.on('meet_accepted', async (payload: { by?: string }) => {
      setMeetRequestFrom(null);
      setMeetStatus('accepted');
      if (payload?.by) Alert.alert('C’est parti !', `${payload.by} a accepté la demande.`);
      await shareMyLocationOnce();
      await setLastSeenNow();

      setMaps(loadNativeMaps());
    });

    s.on('meet_declined', async (payload: { by?: string }) => {
      setMeetRequestFrom(null);
      setMeetStatus(null);
      Alert.alert('Refusé', `${payload?.by || 'Ton contact'} a refusé la demande.`);
      await setLastSeenNow();
    });

    s.on('meet_canceled', async () => {
      setMeetRequestFrom(null);
      setMeetStatus(null);
      await setLastSeenNow();
    });

    s.on('peer_location', async (payload: { coords?: Coord }) => {
      if (payload?.coords?.latitude && payload?.coords?.longitude) {
        setPeerCoord({
          latitude: payload.coords.latitude,
          longitude: payload.coords.longitude,
        });
      }
      await setLastSeenNow();
    });

    const appStateListener = AppState.addEventListener('change', async (state) => {
      if (state === 'active') {
        const code = pairCodeRef.current?.trim();
        if (!code) return;
        const since = await getLastSeen();
        socketRef.current?.emit('sync', { code, since });
      }
    });

    return () => {
      s.disconnect();
      appStateListener.remove();
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const sub1 = Notifications.addNotificationReceivedListener((notification) => {
      const body = String(notification?.request?.content?.body || '');
      if (body.startsWith(ROBOT_ONLINE_BUZZ_PREFIX)) {
        pushRobotLog(`notification robot online body=${body}`);
        robotLastSeenAtRef.current = Date.now();
        setRobotHeartbeat(new Date().toLocaleTimeString());
        setRobotCommandStatus('Robot en ligne (notification)');
        return;
      }
      if (body.startsWith(ROBOT_ACK_BUZZ_PREFIX)) {
        pushRobotLog(`notification robot ack body=${body}`);
        const parts = body.split(':');
        const idRaw = parts.length >= 4 ? parts[1] : 'legacy';
        const cmdRaw = parts.length >= 4 ? parts[2] : parts[1] || '';
        const statusRaw = parts.length >= 4 ? parts[3] : parts[2] || '';
        const cmd = cmdRaw as RobotDriveCommand;
        pendingRobotCmdRef.current = null;
        setRobotCommandStatus(
          statusRaw === 'OK'
            ? `Robot OK notification: ${ROBOT_DRIVE_LABELS[cmd] || cmdRaw} (${idRaw})`
            : `Robot erreur notification: ${ROBOT_DRIVE_LABELS[cmd] || cmdRaw} (${idRaw})`
        );
        return;
      }
      Vibration.vibrate(STRONG_VIBRATION_PATTERN as number[]);
    });
    // Ouvre directement la vue de surveillance quand on tape une ALERTE :
    // camera allumee, plein ecran, ecoute active. Quand on est prevenu qu'il
    // y a quelqu'un chez soi, on ne veut pas avoir trois boutons a chercher.
    const ouvrirSurveillance = (reponse: any) => {
      const d = reponse?.notification?.request?.content?.data;
      if (d?.type !== 'alerte') return;
      setCameraOn(true);
      setCamFullscreen(true);
      setListening(true);
      // Haut-parleur d'office : quand on t'annonce quelqu'un chez toi, tu ne
      // dois pas avoir a coller le telephone a ton oreille. Verifie fonctionnel
      // le 25/09/2026 — la redirection de sortie sans start() tient.
      setHautParleur(true);
      // La photo du moment de l'alerte : elle montre ce qui a declenche, alors
      // que le flux montrera ce qui se passe quelques secondes plus tard.
      AsyncStorage.getItem('pair')
        .then((saved) => {
          const p = saved ? (JSON.parse(saved) as { code: string }) : null;
          const code = (p?.code || pairCodeRef.current || '').trim();
          if (code) { setAlertePhoto(urlPhotoAlerte(code)); setAlerteGrande(true); }
        })
        .catch(() => {});
    };

    // L'app est le plus souvent FERMEE quand l'alerte arrive : le listener
    // ci-dessous ne verrait alors rien. Celui-ci rattrape la notification qui
    // a servi a lancer l'app.
    Notifications.getLastNotificationResponseAsync()
      .then((r) => { if (r) ouvrirSurveillance(r); })
      .catch(() => {});

    const sub2 = Notifications.addNotificationResponseReceivedListener(
      async (reponse) => {
        ouvrirSurveillance(reponse);
        const saved = await AsyncStorage.getItem('pair');
        const p = saved ? (JSON.parse(saved) as { code: string; pseudo: string }) : null;
        const code = (p?.code || pairCodeRef.current || '').trim();
        const pseudo = (p?.pseudo || pseudoRef.current || '').trim();
        if (!code || !pseudo) return;
        const since = await getLastSeen();
        socketRef.current?.emit('pair', { code, pseudo, lastSeen: since });
        socketRef.current?.emit('sync', { code, since });
      }
    );
    return () => {
      sub1.remove();
      sub2.remove();
    };
  }, []);

  // ========================
  // Actions (dans le composant pour accéder aux refs)
  // ========================
  const shareMyLocationOnce = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Localisation', 'Permission refusée.');
        return null;
      }
      const { coords } = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const mine: Coord = { latitude: coords.latitude, longitude: coords.longitude };
      setMyCoord(mine);
      socketRef.current?.emit('share_location', {
        code: pairCodeRef.current,
        coords: mine,
      });
      await AsyncStorage.setItem(
        'lastBgLocation',
        JSON.stringify({ ...mine, ts: Date.now() })
      );
      await setLastSeenNow();
      return mine;
    } catch (e) {
      console.warn('Location error:', e);
      Alert.alert('Erreur de localisation', 'Impossible de récupérer votre position.');
      return null;
    }
  };

  const savePhoto = async () => {
    if (!frameUri) {
      Alert.alert('Photo', "Aucune image. Lance la camera (REGARDER) d'abord.");
      return;
    }
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      setSavingPhoto(true);
      const perm = await MediaLibrary.requestPermissionsAsync(true); // ecriture seule
      if (!perm.granted) {
        Alert.alert('Photo', 'Autorisation galerie refusee.');
        return;
      }
      const base64 = frameUri.split(',')[1] || '';
      const fileUri = `${FileSystem.cacheDirectory}robot-${Date.now()}.jpg`;
      await FileSystem.writeAsStringAsync(fileUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      await MediaLibrary.saveToLibraryAsync(fileUri);
      Alert.alert('Photo', 'Enregistree dans ta galerie 📸');
    } catch (e: any) {
      Alert.alert('Photo', `Erreur: ${String(e?.message || e)}`);
    } finally {
      setSavingPhoto(false);
    }
  };

  const sendBuzz = async (msg: string) => {
    const text = (msg || '').trim();
    if (!text) return;
    const code = pairCodeRef.current?.trim();
    if (!socketRef.current || !code) return;
    socketRef.current.emit('buzz', { code, message: text });
    await setLastSeenNow();
  };

  const sendRobotSay = (override?: string) => {
    const text = (typeof override === 'string' ? override : sayInput).trim();
    if (!text) return;
    const code = pairCodeRef.current?.trim();
    if (!socketRef.current || !code || !pairedWith) {
      Alert.alert('Robot', 'Appaire-toi au robot avant de le faire parler.');
      return;
    }
    socketRef.current.emit('robot_say', { code, text });
    pushRobotLog(`emit robot_say "${text}"`);
    if (typeof override !== 'string') setSayInput('');
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // En mode appel, InCallManager a deja configure une session duplex
  // (lecture + enregistrement). Expo doit tout de meme recevoir
  // allowsRecording=true pour autoriser son enregistreur iOS. On conserve ce
  // mode tant que l'ecoute est active pour ne pas repasser en Playback et
  // couper WebRTC a l'arret du vocal.
  const configureTalkAudioMode = async (recording: boolean) => {
    if (listening && inCall && !recording) return;
    await setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: recording,
      shouldRouteThroughEarpiece: recording,
    }).catch(() => {});
  };

  // AudioRecorder.prepareToRecordAsync force AVAudioSession en mode default
  // sur iOS. Cela suspend le moteur de lecture WebRTC. Le notifier juste apres
  // la preparation lui rend la session sans renegocier ni fermer la piste.
  const reactivateWebRtcAfterRecorder = () => {
    if (!listening || !webrtc) return;
    try {
      webrtc.RTCAudioSession?.audioSessionDidActivate?.();
    } catch {}
    const track = rtcAudioTrackRef.current;
    if (track) {
      try {
        track.enabled = true;
        track._setVolume?.(1.8);
      } catch {}
    }
  };

  const finishTalk = async (session: number) => {
    if (talkFinishingRef.current || session !== talkSessionRef.current) return;
    if (!talkRecordingRef.current) {
      talkStopRequestedRef.current = true;
      setTalking(false);
      return;
    }

    talkFinishingRef.current = true;
    talkStopRequestedRef.current = false;
    setTalking(false);

    try {
      const elapsedBeforeStop = Date.now() - talkStartedAtRef.current;
      if (elapsedBeforeStop < TALKIE_MIN_STOP_DELAY_MS) {
        await sleep(TALKIE_MIN_STOP_DELAY_MS - elapsedBeforeStop);
      }

      await voiceRecorder.stop();
      const durationMs = Date.now() - talkStartedAtRef.current;
      talkRecordingRef.current = false;

      // Retour au mode lecture (sinon iOS reste en mode "enregistrement").
      await configureTalkAudioMode(false);

      const uri = voiceRecorder.uri;
      if (!uri) {
        setTalkStatus('Aucun fichier audio cree, recommence.');
        pushRobotLog(`talkie ignored no uri duration=${durationMs}ms`);
        return;
      }

      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (!b64 || b64.length < TALKIE_MIN_BYTES) {
        setTalkStatus(`Message trop court (${(durationMs / 1000).toFixed(1)} s).`);
        pushRobotLog(`talkie ignored short clip duration=${durationMs}ms bytes=${b64?.length || 0}`);
        return; // appui trop bref, rien a envoyer
      }
      if (b64.length > TALKIE_MAX_BYTES) {
        Alert.alert('Talkie', 'Message trop long, parle moins de 20 secondes.');
        return;
      }

      const code = pairCodeRef.current?.trim();
      if (!socketRef.current || !code) return;
      const ext = (uri.split('.').pop() || 'm4a').toLowerCase();
      socketRef.current.emit('robot_voice', { code, b64, ext });
      setTalkStatus(`Envoye ${(durationMs / 1000).toFixed(1)} s / ${Math.round(b64.length / 1024)} Ko.`);
      pushRobotLog(
        `emit robot_voice ${Math.round(b64.length / 1024)}Ko ext=${ext} duration=${durationMs}ms`
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      pushRobotLog(`talkie stop error ${String((e as any)?.message || e)}`);
      setTalkStatus('Erreur envoi audio, recommence.');
    } finally {
      if (talkAutoStopRef.current) {
        clearTimeout(talkAutoStopRef.current);
        talkAutoStopRef.current = null;
      }
      if (session === talkSessionRef.current) {
        talkRecordingRef.current = false;
        talkStartingRef.current = false;
        talkFinishingRef.current = false;
        talkStartedAtRef.current = 0;
        setTalking(false);
      }
      await configureTalkAudioMode(false);
    }
  };

  // Talkie-walkie : debut d'enregistrement (bouton maintenu).
  // ========================
  // Talkie-walkie EN DIRECT (WebRTC)
  // ========================
  // On publie le micro du telephone vers MediaMTX (WHIP) ; le robot lit ce
  // flux en continu sur son enceinte. Tu parles, ca sort la-bas avec ~0.5 s
  // de decalage — au lieu d'enregistrer, envoyer puis jouer (~15 s).
  const talkPcRef = useRef<any>(null);
  const talkStreamRef = useRef<any>(null);

  const stopTalkLive = useCallback(() => {
    const code = pairCodeRef.current?.trim();
    if (code) socketRef.current?.emit('robot_talk_live', { code, on: false });
    const pc = talkPcRef.current;
    talkPcRef.current = null;
    if (pc) {
      try {
        pc.close();
      } catch {}
    }
    const st = talkStreamRef.current;
    talkStreamRef.current = null;
    if (st) {
      // Liberer le micro, sinon iOS le garde et bride l'ecoute.
      try {
        st.getTracks().forEach((t: any) => t.stop());
      } catch {}
    }
    setTalking(false);
    setTalkStatus('');
  }, []);

  const startTalkLive = useCallback(async () => {
    const code = pairCodeRef.current?.trim();
    // Trace a l'ENTREE, avant toute condition.
    //
    // Les deux diagnostics precedents etaient places apres des sorties
    // anticipees : ils ne pouvaient pas s'executer dans les cas qu'on
    // cherchait. Celui-ci part toujours, avec l'etat qui decide de la suite.
    socketRef.current?.emit('app_diag', {
      code: code || '-',
      pseudo: pseudoRef.current,
      sujet: 'talk',
      detail: `tentative — paire=${!!pairedWith} socket=${!!socketRef.current} ` +
        `connexionDejaOuverte=${!!talkPcRef.current} enCours=${talking}`,
      plateforme: Platform.OS,
      version: Platform.Version,
    });
    if (!socketRef.current || !code || !pairedWith) {
      Alert.alert('Robot', 'Appaire-toi au robot avant de lui parler.');
      return;
    }
    if (!webrtc) {
      socketRef.current.emit('app_diag', {
        code, pseudo: pseudoRef.current, sujet: 'talk',
        detail: 'module react-native-webrtc absent du build',
        plateforme: Platform.OS, version: Platform.Version,
      });
    }
    if (talkPcRef.current) {
      // Sortie MUETTE jusqu'ici : une connexion restee ouverte apres un echec
      // bloquait tous les essais suivants, sans rien afficher ni envoyer.
      socketRef.current?.emit('app_diag', {
        code, pseudo: pseudoRef.current, sujet: 'talk',
        detail: 'abandon : une connexion precedente est encore ouverte',
        plateforme: Platform.OS, version: Platform.Version,
      });
      return;
    }
    setTalking(true);
    setTalkStatus('Connexion...');
    try {
      // Demande de permission BORNEE, et non bloquante.
      //
      // Sur Android cet appel ne rendait jamais la main : ni accord, ni refus.
      // Tout s'arretait la — pas d'offre, pas d'erreur, et surtout aucune
      // pastille de micro a l'ecran, puisque le micro n'etait jamais ouvert.
      //
      // Cette verification est de toute facon redondante : getUserMedia demande
      // lui-meme RECORD_AUDIO sur Android. Si le pre-controle ne repond pas, on
      // continue donc sans lui et on laisse la vraie capture trancher.
      let perm: any = null;
      try {
        perm = await Promise.race([
          AudioModule.requestRecordingPermissionsAsync(),
          new Promise((r) => setTimeout(() => r({ granted: true, status: 'sans-reponse' }), 3000)),
        ]);
      } catch (e: any) {
        perm = { granted: true, status: `erreur: ${String(e?.message || e).slice(0, 80)}` };
      }
      socketRef.current?.emit('app_diag', {
        code, pseudo: pseudoRef.current, sujet: 'talk',
        detail: `permission micro -> ${perm?.status} (accordee=${perm?.granted})`,
        plateforme: Platform.OS, version: Platform.Version,
      });
      // On ne bloque QUE sur un refus explicite.
      if (perm && perm.granted === false) {
        Alert.alert('Micro', 'Autorise le micro pour parler au robot.');
        stopTalkLive();
        return;
      }
      socketRef.current?.emit('app_diag', {
        code, pseudo: pseudoRef.current, sujet: 'talk',
        detail: 'ouverture du micro (getUserMedia)',
        plateforme: Platform.OS, version: Platform.Version,
      });
      // Delai maximum sur la capture du micro.
      //
      // Sans lui, getUserMedia pouvait ne JAMAIS repondre — ni resolution, ni
      // rejet — et la fonction restait suspendue indefiniment : aucune offre,
      // aucune erreur, aucun message. Il a fallu trois instrumentations pour
      // voir qu'elle se bloquait la. Une attente sans fin est un bug, pas un
      // etat : au-dela de 10 s on echoue franchement, et on le dit.
      const stream = await Promise.race([
        webrtc.mediaDevices.getUserMedia({ audio: true, video: false }),
        new Promise((_r, rejeter) =>
          setTimeout(() => rejeter(new Error('micro muet : getUserMedia sans reponse en 10 s')), 10000)
        ),
      ]);
      talkStreamRef.current = stream;
      const pc = new webrtc.RTCPeerConnection({});
      talkPcRef.current = pc;
      stream.getTracks().forEach((t: any) => pc.addTrack(t, stream));

      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const to = setTimeout(resolve, 800);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc?.iceGatheringState === 'complete') {
            clearTimeout(to);
            resolve();
          }
        });
      });

      const resp: any = await new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => {
          if (!done) {
            done = true;
            resolve(null);
          }
        }, 8000);
        socketRef.current?.emit(
          'rtc_publish_offer',
          { code, sdp: pc.localDescription.sdp },
          (r: any) => {
            if (!done) {
              done = true;
              clearTimeout(t);
              resolve(r);
            }
          }
        );
      });
      if (!resp || resp.status !== 201 || !resp.sdp) {
        throw new Error(`whip ${resp ? resp.status : 'timeout'}`);
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: resp.sdp });

      // A PARTIR D'ICI la publication est etablie : plus rien ne doit pouvoir
      // faire echouer la session. Le moindre throw ici (retour haptique
      // indisponible, par exemple) partait dans le catch et envoyait aussitot
      // l'ordre d'arret au robot — d'ou le "demarre puis arret" en 1 s.
      try {
        socketRef.current?.emit('robot_talk_live', { code, on: true });
        setTalkStatus('En direct — parle');
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      } catch {}

      // Coupure reelle du lien : on previent le robot proprement.
      pc.addEventListener('connectionstatechange', () => {
        const st = pc.connectionState;
        if (st === 'failed' || st === 'closed' || st === 'disconnected') {
          console.warn('Talkie direct: lien perdu', st);
          stopTalkLive();
        }
      });
    } catch (e: any) {
      // Remonte au serveur : ce message partait dans une console que personne
      // ne lit depuis un telephone, et c'est exactement lui qui manquait pour
      // savoir pourquoi aucune offre n'arrivait jamais.
      socketRef.current?.emit('app_diag', {
        code, pseudo: pseudoRef.current, sujet: 'talk',
        detail: `exception: ${String(e?.message || e).slice(0, 220)}`,
        plateforme: Platform.OS, version: Platform.Version,
      });
      console.warn('Talkie direct:', e?.message || e);
      setTalkStatus('Echec de la connexion');
      stopTalkLive();
    }
  }, [pairedWith, stopTalkLive]);

  const startTalk = async () => {
    if (talkStartingRef.current || talkRecordingRef.current || talkFinishingRef.current) return;

    const code = pairCodeRef.current?.trim();
    if (!socketRef.current || !code || !pairedWith) {
      Alert.alert('Robot', 'Appaire-toi au robot avant de lui parler.');
      return;
    }

    const session = talkSessionRef.current + 1;
    talkSessionRef.current = session;
    talkStartingRef.current = true;
    talkStopRequestedRef.current = false;
    setTalking(true);
    setTalkStatus('Preparation du micro...');

    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Micro', 'Autorise le micro pour parler au robot.');
        setTalking(false);
        return;
      }
      // L'ecoute WebRTC reste active pendant tout l'enregistrement.
      await configureTalkAudioMode(true);
      await voiceRecorder.prepareToRecordAsync();
      reactivateWebRtcAfterRecorder();
      setTimeout(reactivateWebRtcAfterRecorder, 150);

      if (session !== talkSessionRef.current || talkStopRequestedRef.current) {
        await voiceRecorder.stop().catch(() => {});
        await configureTalkAudioMode(false);
        setTalking(false);
        return;
      }

      voiceRecorder.record();
      reactivateWebRtcAfterRecorder();
      talkRecordingRef.current = true;
      talkStartedAtRef.current = Date.now();
      setTalkStatus('Enregistrement...');
      pushRobotLog(`talkie recording start session=${session}`);
      if (talkAutoStopRef.current) clearTimeout(talkAutoStopRef.current);
      talkAutoStopRef.current = setTimeout(() => {
        if (session !== talkSessionRef.current || !talkRecordingRef.current) return;
        setTalkStatus('Envoi automatique...');
        void finishTalk(session);
      }, TALKIE_MAX_DURATION_MS);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    } catch (e) {
      pushRobotLog(`talkie start error ${String((e as any)?.message || e)}`);
      setTalking(false);
      await configureTalkAudioMode(false);
    } finally {
      if (session === talkSessionRef.current) {
        talkStartingRef.current = false;
        if (talkStopRequestedRef.current && talkRecordingRef.current) {
          void finishTalk(session);
        }
      }
    }
  };

  // Talkie-walkie : fin d'enregistrement (bouton relache) -> envoi au robot.
  const stopTalk = () => {
    const session = talkSessionRef.current;
    talkStopRequestedRef.current = true;
    setTalking(false);
    if (talkStartingRef.current) return;
    if (!talkRecordingRef.current) return;
    void finishTalk(session);
  };

  const toggleTalk = () => {
    if (talkRecordingRef.current || talkStartingRef.current || talking) {
      stopTalk();
      return;
    }
    void startTalk();
  };

  // Ajoute le texte courant aux phrases preenregistrees (et le sauvegarde).
  const addSayPreset = () => {
    const text = sayInput.trim();
    if (!text) return;
    if (sayPresets.some((p) => p.toLowerCase() === text.toLowerCase())) {
      setSayInput('');
      return; // deja presente
    }
    const next = [...sayPresets, text];
    setSayPresets(next);
    AsyncStorage.setItem(SAY_PRESETS_KEY, JSON.stringify(next)).catch(() => {});
    setSayInput('');
  };

  // Supprime une phrase preenregistree (appui long sur la pastille).
  const removeSayPreset = (text: string) => {
    Alert.alert('Supprimer', `Retirer « ${text} » ?`, [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: () => {
          const next = sayPresets.filter((p) => p !== text);
          setSayPresets(next);
          AsyncStorage.setItem(SAY_PRESETS_KEY, JSON.stringify(next)).catch(() => {});
        },
      },
    ]);
  };

  // Charge les phrases preenregistrees sauvegardees (sinon garde les defauts).
  useEffect(() => {
    AsyncStorage.getItem(SAY_PRESETS_KEY)
      .then((raw) => {
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setSayPresets(arr.filter((x) => typeof x === 'string'));
      })
      .catch(() => {});
  }, []);

  const sendRobotDrive = async (cmd: RobotDriveCommand) => {
    const code = pairCodeRef.current?.trim();
    if (!socketRef.current || !code || !pairedWith) {
      Alert.alert('Robot', 'Appaire-toi au robot avant de piloter.');
      pushRobotLog(`drive blocked cmd=${cmd} socket=${!!socketRef.current} code=${code || '-'} paired=${pairedWith || '-'}`);
      return;
    }
    // Une commande manuelle annule la navigation auto.
    if (navActive) {
      setNavActive(false);
      socketRef.current.emit('robot_nav', { code, on: false });
    }
    const id = `${cmd}-${Date.now().toString(36)}`;
    pendingRobotCmdRef.current = { id, cmd };
    pushRobotLog(`SEND id=${id} cmd=${cmd} code=${code} paired=${pairedWith} socket=${socketRef.current.id || '?'}`);
    socketRef.current.emit('robot_drive', { code, cmd, id });
    pushRobotLog(`emit robot_drive id=${id}`);
    socketRef.current.emit('buzz', { code, message: `${ROBOT_DRIVE_BUZZ_PREFIX}${id}:${cmd}` });
    pushRobotLog(`emit buzz fallback id=${id} message=${ROBOT_DRIVE_BUZZ_PREFIX}${id}:${cmd}`);
    try {
      const response = await fetch(`${SOCKET_URL}/robot-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, cmd, id, from: pseudoRef.current || 'app' }),
      });
      const text = await response.text();
      pushRobotLog(`HTTP /robot-drive status=${response.status} body=${text}`);
      if (response.status === 404) {
        setRobotCommandStatus('Serveur pas a jour: /robot-drive introuvable');
      } else if (!response.ok) {
        setRobotCommandStatus(`Erreur serveur robot: HTTP ${response.status}`);
      }
    } catch (e) {
      pushRobotLog(`HTTP /robot-drive error=${String((e as any)?.message || e)}`);
      setRobotCommandStatus('Erreur reseau vers /robot-drive');
    }
    setRobotCommandStatus((current) =>
      pendingRobotCmdRef.current?.id !== id ||
      current.includes('Serveur pas a jour') || current.includes('Erreur serveur') || current.includes('Erreur reseau')
        ? current
        : `${ROBOT_DRIVE_LABELS[cmd]}: envoye (${id}), attente retour...`
    );
    setTimeout(() => {
      if (pendingRobotCmdRef.current?.id === id) {
        pushRobotLog(`TIMEOUT id=${id} aucun ACK robot apres 10s`);
        setRobotCommandStatus((current) =>
          current.includes('Serveur pas a jour') || current.includes('Erreur serveur') || current.includes('Erreur reseau')
            ? current
            : `${ROBOT_DRIVE_LABELS[cmd]}: pas de retour robot (${id})`
        );
      }
    }, 10000);
    await setLastSeenNow();
  };

  // --- Pilotage differentiel (virage en arc) ---
  //
  // Le joystick calculait l'angle du pouce puis le reduisait a l'une des
  // quatre directions, en jetant tout le reste. Resultat : impossible de
  // tourner EN AVANCANT, alors que c'est la manoeuvre la moins couteuse —
  // en arc les pneus roulent, en pivot ils doivent riper en travers.
  //
  // On envoie maintenant les deux vitesses telles quelles, en pourcentage.
  const mixHoldRef = useRef<{ g: number; d: number } | null>(null);
  const mixTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendRobotMix = (g: number, d: number) => {
    const code = pairCodeRef.current?.trim();
    if (!socketRef.current || !code || !pairedWith) return;
    const cmd = `M${Math.round(g)},${Math.round(d)}`;
    socketRef.current.emit('robot_drive', { code, cmd, id: `mix-${Date.now().toString(36)}` });
  };

  // L'Arduino coupe les moteurs apres 1,5 s sans ordre : tant que le pouce
  // reste sur le joystick, il faut donc repeter le dernier melange.
  const startRobotMixHold = (g: number, d: number) => {
    mixHoldRef.current = { g, d };
    sendRobotMix(g, d);
    if (!mixTimerRef.current) {
      mixTimerRef.current = setInterval(() => {
        const m = mixHoldRef.current;
        if (m) sendRobotMix(m.g, m.d);
      }, 400);
    }
  };

  const stopRobotMixHold = () => {
    if (mixTimerRef.current) {
      clearInterval(mixTimerRef.current);
      mixTimerRef.current = null;
    }
    mixHoldRef.current = null;
    stopRobotDriveHold();
  };

  // Envoie une vitesse absolue au robot (commande V<n>, n borne 140..255 par
  // l'Arduino). Utilise le meme canal que les commandes de direction.
  const sendRobotSpeed = (pct: number) => {
    const code = pairCodeRef.current?.trim();
    if (!socketRef.current || !code || !pairedWith) return;
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    const value = Math.round(140 + (115 * p) / 100);
    const cmd = `V${value}`;
    const id = `${cmd}-${Date.now().toString(36)}`;
    pushRobotLog(`SEND speed id=${id} cmd=${cmd} (${p}%)`);
    socketRef.current.emit('robot_drive', { code, cmd, id });
    socketRef.current.emit('buzz', { code, message: `${ROBOT_DRIVE_BUZZ_PREFIX}${id}:${cmd}` });
  };

  // ========================
  // Pan-tilt camera : envoie des angles ABSOLUS (0..180) au robot.
  // Double canal comme le pilotage : event socket 'robot_cam_move' + buzz de
  // secours (marche meme si le serveur VPS n'a pas encore le nouveau relais).
  // ========================
  const emitCamMove = (payload: {
    pan?: number;
    tilt?: number;
    center?: boolean;
    view?: 'front' | 'rear' | 'both';
  }) => {
    const code = pairCodeRef.current?.trim();
    if (!socketRef.current || !code || !pairedWith) return;
    const id = `cam-${Date.now().toString(36)}`;
    socketRef.current.emit('robot_cam_move', { code, id, ...payload });
    // V0 = avant, V1 = arriere, V2 = double (image combinee 70/30).
    const viewCode = payload.view === 'both' ? 2 : payload.view === 'rear' ? 1 : 0;
    const parts = payload.center
      ? 'C'
      : [
          payload.pan != null ? `P${payload.pan}` : '',
          payload.tilt != null ? `U${payload.tilt}` : '',
          payload.view != null ? `V${viewCode}` : '',
        ]
          .filter(Boolean)
          .join(':');
    if (parts) {
      socketRef.current.emit('buzz', { code, message: `${ROBOT_CAM_BUZZ_PREFIX}${id}:${parts}` });
    }
    pushRobotLog(`SEND cam id=${id} ${parts}`);
  };

  // Un pas de camera (fleches). dPan/dTilt = -1, 0 ou +1.
  const stepCam = (dPan: number, dTilt: number) => {
    const clampPan = (v: number) => Math.max(0, Math.min(180, v));
    // Tilt borne comme dans le sketch Arduino (TILT_MIN/MAX = 20..160).
    // Sans ca, l'angle cote app continue de "monter dans le vide" en butee,
    // et il faut plusieurs appuis inverses avant que la camera rebouge.
    const clampTilt = (v: number) => Math.max(20, Math.min(160, v));
    if (dPan !== 0) camPanRef.current = clampPan(camPanRef.current + dPan * CAM_STEP_DEG);
    if (dTilt !== 0) camTiltRef.current = clampTilt(camTiltRef.current + dTilt * CAM_STEP_DEG);
    emitCamMove({
      ...(dPan !== 0 ? { pan: camPanRef.current } : {}),
      ...(dTilt !== 0 ? { tilt: camTiltRef.current } : {}),
    });
  };

  // Maintien d'une fleche = la camera continue de tourner (comme le pilotage).
  const startCamHold = (dPan: number, dTilt: number) => {
    if (camHoldTimerRef.current) clearInterval(camHoldTimerRef.current);
    stepCam(dPan, dTilt);
    camHoldTimerRef.current = setInterval(() => stepCam(dPan, dTilt), 140);
  };

  const stopCamHold = () => {
    if (camHoldTimerRef.current) {
      clearInterval(camHoldTimerRef.current);
      camHoldTimerRef.current = null;
    }
  };

  const centerCam = () => {
    stopCamHold();
    camPanRef.current = 90;
    camTiltRef.current = 90;
    emitCamMove({ center: true });
  };

  // Bascule camera avant / arriere (2e webcam sur le robot), en vue portrait.
  const [camView, setCamView] = useState<'front' | 'rear'>('front');
  const toggleCamView = () => {
    const next = camView === 'front' ? 'rear' : 'front';
    setCamView(next);
    emitCamMove({ view: next });
  };

  // Tourne le tel a l'horizontale -> plein ecran (allume la camera si besoin).
  // Retour en portrait -> ferme. On ne reagit qu'au CHANGEMENT d'axe pour ne pas
  // rouvrir apres une fermeture manuelle (✕) restee en paysage. La vue caméra ne
  // change pas : c'est la camera normale (bouton AV/AR pour basculer).
  // NB: necessite un build avec app.json orientation="default".
  const prevLandscapeRef = useRef(false);
  useEffect(() => {
    if (isLandscape === prevLandscapeRef.current) return;
    prevLandscapeRef.current = isLandscape;
    if (!pairedWith) return;
    if (isLandscape) {
      setCameraOn(true);
      setCamFullscreen(true);
    } else {
      setCamFullscreen(false);
    }
  }, [isLandscape, pairedWith]);

  // Nettoyage si l'ecran se demonte pendant un maintien de fleche camera.
  useEffect(
    () => () => {
      if (camHoldTimerRef.current) clearInterval(camHoldTimerRef.current);
    },
    []
  );

  const startRobotDriveHold = (cmd: RobotDriveCommand) => {
    // Nouvelle marche avant = nouvelle reference. On ne la prend PAS sur les
    // virages, sinon elle serait remise a zero a chaque correction et
    // l'ecart n'aurait plus aucun sens.
    if (cmd === 'F') {
      const h = robotStatus?.heading;
      if (typeof h === 'number' && Number.isFinite(h)) {
        // Cap deja disponible (boussole, ou robot deja en mouvement).
        setCapRef(h);
        capRefAttenduRef.current = false;
      } else {
        setCapRef(null);
        capRefAttenduRef.current = true;
      }
    }
    if (robotHoldTimerRef.current) clearInterval(robotHoldTimerRef.current);
    void sendRobotDrive(cmd);
    robotHoldTimerRef.current = setInterval(() => {
      void sendRobotDrive(cmd);
    }, 650);
  };

  const stopRobotDriveHold = () => {
    if (robotHoldTimerRef.current) {
      clearInterval(robotHoldTimerRef.current);
      robotHoldTimerRef.current = null;
    }
    // Envoi du STOP en triple : si un paquet se perd (freeze/reseau), le robot
    // s'arrete quand meme. Le safe-stop 900ms de l'Arduino reste le dernier filet.
    void sendRobotDrive('S');
    setTimeout(() => void sendRobotDrive('S'), 120);
    setTimeout(() => void sendRobotDrive('S'), 300);
  };

  useEffect(() => {
    if (!pairedWith || !socketOnline) return;
    const request = () => {
      const code = pairCodeRef.current?.trim();
      if (!socketRef.current || !code) return;
      socketRef.current.emit('robot_status_request', { code });
    };
    request();
    const timer = setInterval(request, 3000);
    return () => clearInterval(timer);
  }, [pairedWith, socketOnline]);

  // Etat de la ronde a l'appairage : une ronde peut tourner depuis des heures
  // sans que ce telephone ait jamais ete connecte. On demande, on n'invente pas.
  // Rafraichi lentement (30 s) : le robot publie deja a chaque changement, ce
  // sondage ne sert qu'a recaler le compte a rebours entre deux tours.
  useEffect(() => {
    if (!pairedWith || !socketOnline) return;
    envoyerRonde('etat');
    const timer = setInterval(() => envoyerRonde('etat'), 30000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairedWith, socketOnline]);

  // Temoin de connexion du robot : recalcule l'etat chaque seconde.
  //  - connecte      : signe de vie recu il y a moins de 8 s
  //  - en connexion  : appaire + socket ok, mais en attente (< 15 s de silence)
  //  - deconnecte    : socket coupee, ou robot muet depuis plus de 15 s
  useEffect(() => {
    if (!pairedWith) {
      setRobotLink('disconnected');
      return;
    }
    const watchStart = Date.now();
    const compute = () => {
      if (!socketOnline) {
        setRobotLink('disconnected');
        return;
      }
      const seen = robotLastSeenAtRef.current;
      if (seen > 0 && Date.now() - seen < 8000) {
        setRobotLink('connected');
        return;
      }
      const base = seen > 0 ? seen : watchStart;
      setRobotLink(Date.now() - base < 15000 ? 'connecting' : 'disconnected');
    };
    compute();
    const t = setInterval(compute, 1000);
    return () => clearInterval(t);
  }, [pairedWith, socketOnline]);

  // Charger la lib de carte des qu'on est appaire (pour la carte robot,
  // sans attendre un "Se rejoindre").
  useEffect(() => {
    if (pairedWith && !maps) setMaps(loadNativeMaps());
  }, [pairedWith, maps]);

  // Suivre le robot : recentrer la carte a chaque nouvelle position.
  const robotLat = robotStatus?.coords?.latitude;
  const robotLng = robotStatus?.coords?.longitude;
  useEffect(() => {
    if (!robotMapRef.current) return;
    if (typeof robotLat !== 'number' || typeof robotLng !== 'number') return;
    robotMapRef.current.animateToRegion(
      {
        latitude: robotLat,
        longitude: robotLng,
        latitudeDelta: 0.0015,
        longitudeDelta: 0.0015,
      },
      600
    );
  }, [robotLat, robotLng]);

  // Camera robot : demander le flux tant que la vue est ouverte (keepalive 3s),
  // et l'arreter proprement en quittant (le Pi coupe alors la webcam).
  useEffect(() => {
    if (!cameraOn || !pairedWith || !socketOnline) return;
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    const ask = () => socketRef.current?.emit('robot_camera', { code, on: true });
    ask();
    const timer = setInterval(ask, 3000);
    return () => {
      clearInterval(timer);
      socketRef.current?.emit('robot_camera', { code, on: false });
      setFrameUri(null);
    };
  }, [cameraOn, pairedWith, socketOnline]);

  // Camera robot en WebRTC (WHEP) : H.264 fluide a ~300-800 ms de latence au
  // lieu du MJPEG image par image. Tant que ca ne se connecte pas (robot pas a
  // jour, reseau recalcitrant, module natif absent), l'affichage MJPEG
  // ci-dessus reste tel quel : le passage WebRTC est un pur bonus.
  useEffect(() => {
    if (!cameraOn || !pairedWith || !socketOnline || !webrtc) return;
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    const session = ++rtcSessionRef.current;
    const alive = () => rtcSessionRef.current === session;

    const cleanupPc = () => {
      const pc = rtcPcRef.current;
      rtcPcRef.current = null;
      if (pc) {
        try {
          pc.close();
        } catch {}
      }
      // Libere la session cote MediaMTX (sinon elle expire toute seule).
      // Via le socket : sur iPhone, un fetch http:// serait bloque par ATS.
      const res = rtcResourceRef.current;
      rtcResourceRef.current = null;
      if (res) {
        socketRef.current?.emit('rtc_stop', { location: res });
      }
    };

    const scheduleRetry = () => {
      if (!alive()) return;
      cleanupPc();
      setRtcStreamUrl(null);
      if (rtcRetryRef.current) clearTimeout(rtcRetryRef.current);
      rtcRetryRef.current = setTimeout(connect, 2500);
    };

    const connect = async () => {
      if (!alive()) return;
      try {
        const pc = new webrtc.RTCPeerConnection({});
        rtcPcRef.current = pc;
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addEventListener('track', (ev: any) => {
          if (!alive()) return;
          const stream = ev.streams?.[0] || new webrtc.MediaStream([ev.track]);
          setRtcStreamUrl(stream.toURL());
        });
        pc.addEventListener('connectionstatechange', () => {
          if (!alive()) return;
          const st = pc.connectionState;
          // Publieur relance (changement de vue...) ou reseau perdu -> on retente.
          if (st === 'failed' || st === 'disconnected' || st === 'closed') {
            scheduleRetry();
          }
        });
        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        // Petite attente de la collecte ICE (pas de STUN -> quasi instantane),
        // pour envoyer une offre complete et se passer du "trickle".
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === 'complete') return resolve();
          const to = setTimeout(resolve, 800);
          pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') {
              clearTimeout(to);
              resolve();
            }
          });
        });
        if (!alive()) return;
        // Negociation WHEP via le socket deja connecte (le serveur fait le
        // POST vers MediaMTX en local) : indispensable sur iPhone, ou ATS
        // bloque tout fetch http:// — le websocket, lui, passe.
        const resp: any = await new Promise((resolve) => {
          let done = false;
          const t = setTimeout(() => {
            if (!done) {
              done = true;
              resolve(null);
            }
          }, 8000);
          socketRef.current?.emit(
            'rtc_offer',
            { code, sdp: pc.localDescription.sdp },
            (r: any) => {
              if (!done) {
                done = true;
                clearTimeout(t);
                resolve(r);
              }
            }
          );
        });
        // 404 = le robot ne publie pas (encore) : on repassera.
        if (!resp || resp.status !== 201 || !resp.sdp) {
          throw new Error(`whep ${resp ? resp.status : 'timeout'}`);
        }
        rtcResourceRef.current = resp.location || null;
        if (!alive()) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: resp.sdp });
      } catch (e: any) {
        // "whep 404" = le robot ne publie pas encore (normal au demarrage).
        console.warn('WHEP: connexion video echouee, nouvel essai dans 2.5s :', e?.message || e);
        scheduleRetry();
      }
    };
    connect();

    // Tant que la video WebRTC est connectee, on le signale au robot : il
    // reduit alors ses images socket a ~1/s (photos + secours) pour ne pas
    // envoyer la video en double sur la 4G.
    const pingTimer = setInterval(() => {
      const pc = rtcPcRef.current;
      if (pc && pc.connectionState === 'connected') {
        socketRef.current?.emit('robot_rtc', { code, on: true });
      }
    }, 3000);

    return () => {
      rtcSessionRef.current++;
      clearInterval(pingTimer);
      if (rtcRetryRef.current) {
        clearTimeout(rtcRetryRef.current);
        rtcRetryRef.current = null;
      }
      cleanupPc();
      setRtcStreamUrl(null);
      socketRef.current?.emit('robot_rtc', { code, on: false });
    };
  }, [cameraOn, pairedWith, socketOnline]);

  // Audio: jouer meme si le telephone est en mode silencieux.
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  // Ecran toujours allume tant que l'app est au premier plan : on pilote le
  // robot en regardant la camera, sans toucher l'ecran -> le telephone se
  // verrouillait en pleine conduite. Libere quand l'app passe en fond.
  useEffect(() => {
    if (!keepAwake?.activateKeepAwakeAsync) return;
    const TAG = 'ping-robot';
    const apply = (state: string) => {
      if (state === 'active') keepAwake.activateKeepAwakeAsync(TAG).catch(() => {});
      else keepAwake.deactivateKeepAwake(TAG).catch?.(() => {});
    };
    apply(AppState.currentState);
    const sub = AppState.addEventListener('change', apply);
    return () => {
      sub.remove();
      try {
        keepAwake.deactivateKeepAwake(TAG);
      } catch {}
    };
  }, []);

  // Micro du robot en WebRTC : connexion SEPAREE de la video (son propre
  // tuyau TCP -> les paquets audio ne font pas la queue derriere les rafales
  // video, c'etait la cause des ~2s de retard). Active tant que 🔊 est
  // enfonce et que la camera tourne (le robot ne publie le micro qu'avec la
  // camera) ; sinon le repli MP3 plus bas prend la main.
  // Mode appel volontaire : le son WebRTC sort dans l'ecouteur d'oreille du
  // telephone. Le MP3/HTTPS reste le secours si aucun paquet Opus n'arrive.
  const RTC_AUDIO_ACTIF = true;
  // Compteur de reprise : l'incrementer relance la connexion d'ecoute.
  // Indispensable quand on parle : publier le micro du telephone fait basculer
  // iOS en mode "communication", ce qui interrompt la lecture WebRTC en cours.
  // On rebranche donc l'ecoute apres chaque changement d'etat du talkie.
  const [ecouteTick, setEcouteTick] = useState(0);
  const talkingPrecedent = useRef(false);
  useEffect(() => {
    if (talkingPrecedent.current === talking) return;
    talkingPrecedent.current = talking;
    if (!listening) return;
    // Laisse la session audio se stabiliser avant de relancer l'ecoute.
    const t = setTimeout(() => setEcouteTick((n) => n + 1), 900);
    return () => clearTimeout(t);
  }, [talking, listening]);


  useEffect(() => {
    if (!RTC_AUDIO_ACTIF) return;
    if (!listening || !pairedWith || !socketOnline || !webrtc) return;
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    let stopped = false;
    let pc: any = null;
    let resource: string | null = null;
    let retryT: ReturnType<typeof setTimeout> | null = null;
    let statsT: ReturnType<typeof setInterval> | null = null;
    let audioReceiver: any = null;
    let lastAudioBytes = 0;
    let lastAudioPacketAt = 0;
    let audioFlowing = false;

    // Une piste "track" est creee des la reponse SDP, meme quand aucun paquet
    // RTP ne vient du robot. Ne declarer WebRTC actif qu'apres reception
    // effective d'octets audio ; sinon le lecteur MP3 de secours etait coupe
    // par une piste parfaitement muette.
    const setAudioFlowing = (flowing: boolean) => {
      if (audioFlowing === flowing) return;
      audioFlowing = flowing;
      setRtcAudioLive(flowing);
      console.log(flowing ? '[AUDIO] paquets WebRTC recus' : '[AUDIO] WebRTC muet -> secours MP3');
    };

    const checkAudioPackets = async () => {
      if (stopped || !pc || !audioReceiver) return;
      try {
        const stats = audioReceiver.getStats
          ? await audioReceiver.getStats()
          : await pc.getStats(rtcAudioTrackRef.current);
        const rows = stats instanceof Map ? Array.from(stats.values()) : Object.values(stats || {});
        let bytes = 0;
        for (const row of rows as any[]) {
          if (row?.type !== 'inbound-rtp') continue;
          if (row.kind && row.kind !== 'audio') continue;
          if (row.mediaType && row.mediaType !== 'audio') continue;
          bytes += Number(row.bytesReceived || 0);
        }
        const now = Date.now();
        if (bytes > 0 && bytes !== lastAudioBytes) {
          lastAudioBytes = bytes;
          lastAudioPacketAt = now;
          setAudioFlowing(true);
        } else if (lastAudioPacketAt === 0 || now - lastAudioPacketAt > 3000) {
          setAudioFlowing(false);
        }
      } catch {
        // En cas de stats indisponibles, garder le secours MP3 actif.
        setAudioFlowing(false);
      }
    };

    const cleanup = () => {
      if (statsT) {
        clearInterval(statsT);
        statsT = null;
      }
      audioReceiver = null;
      lastAudioBytes = 0;
      lastAudioPacketAt = 0;
      audioFlowing = false;
      rtcAudioTrackRef.current = null;
      setRtcAudioLive(false);
      if (pc) {
        try {
          pc.close();
        } catch {}
        pc = null;
      }
      if (resource) {
        socketRef.current?.emit('rtc_stop', { location: resource });
        resource = null;
      }
    };
    const retry = () => {
      if (stopped) return;
      cleanup();
      retryT = setTimeout(connect, 3000);
    };
    const connect = async () => {
      if (stopped) return;
      try {
        pc = new webrtc.RTCPeerConnection({});
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.addEventListener('track', (ev: any) => {
          if (stopped) return;
          ev.track.enabled = true;
          // Petit renfort logiciel pour les sons captes loin du robot. La
          // methode native accepte un gain de 0 a 10 (1 = volume normal).
          try {
            ev.track._setVolume?.(1.8);
          } catch {}
          rtcAudioTrackRef.current = ev.track;
          audioReceiver = ev.receiver || null;
          // La presence de la piste ne prouve pas encore que le robot envoie
          // du son. checkAudioPackets fera le basculement apres le premier RTP.
          console.log(
            `[AUDIO] piste WebRTC recue: kind=${ev.track.kind} enabled=${ev.track.enabled} muted=${ev.track.muted} readyState=${ev.track.readyState}`
          );
        });
        pc.addEventListener('connectionstatechange', () => {
          if (stopped || !pc) return;
          const st = pc.connectionState;
          if (st === 'failed' || st === 'disconnected' || st === 'closed') retry();
        });
        const offer = await pc.createOffer({});
        await pc.setLocalDescription(offer);
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === 'complete') return resolve();
          const to = setTimeout(resolve, 800);
          pc.addEventListener('icegatheringstatechange', () => {
            if (pc?.iceGatheringState === 'complete') {
              clearTimeout(to);
              resolve();
            }
          });
        });
        if (stopped) return;
        const resp: any = await new Promise((resolve) => {
          let done = false;
          const t = setTimeout(() => {
            if (!done) {
              done = true;
              resolve(null);
            }
          }, 8000);
          socketRef.current?.emit(
            'rtc_offer',
            { code, sdp: pc.localDescription.sdp, kind: 'audio' },
            (r: any) => {
              if (!done) {
                done = true;
                clearTimeout(t);
                resolve(r);
              }
            }
          );
        });
        if (!resp || resp.status !== 201 || !resp.sdp) {
          throw new Error(`whep audio ${resp ? resp.status : 'timeout'}`);
        }
        resource = resp.location || null;
        if (stopped) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: resp.sdp });
        await checkAudioPackets();
        statsT = setInterval(checkAudioPackets, 750);
      } catch (e: any) {
        console.warn('WHEP audio:', e?.message || e);
        retry();
      }
    };
    connect();
    return () => {
      stopped = true;
      if (retryT) clearTimeout(retryT);
      cleanup();
    };
    // ecouteTick : force une reconnexion apres chaque bascule du talkie.
  }, [listening, pairedWith, socketOnline, ecouteTick]);

  // ROUTAGE AUDIO — on ne touche a RIEN, volontairement.
  //
  // iOS traite toute session WebRTC comme un appel telephonique et sort le son
  // par l'ecouteur d'oreille. C'est moins fort, mais ca FONCTIONNE.
  // Journal des tentatives pour le basculer sur le haut-parleur (02/08) :
  //   1. setAudioModeAsync repete       -> sans effet, et coupait la sortie
  //      WebRTC des le 1er rappel (son present ~1 s puis silence)
  //   2. InCallManager media:'audio'    -> plus aucun son
  //   3. InCallManager media:'video'    -> plus aucun son
  // Chaque manipulation de la session native casse la lecture WebRTC. On la
  // laisse donc entierement a iOS.
  //
  // Pour retenter un jour : le module natif est deja dans le build, il suffit
  // de repasser ce drapeau a true. Mais teste d'abord sans WebRTC audio (le
  // flux mp3 en HTTPS, lui, sort bien par le haut-parleur).
  // Redirection de la sortie audio, SANS start().
  //
  // C'est la seule piste que le journal du 02/08 n'avait pas isolee : les
  // trois tentatives passaient toutes par start({media}), qui impose une
  // nouvelle categorie a AVAudioSession et suspend la lecture WebRTC.
  // setSpeakerphoneOn se contente de basculer la sortie de la session en
  // cours — c'est ce que fait le bouton haut-parleur pendant un appel.
  //
  // Reapplique quand l'ecoute ou la piste audio redemarrent : iOS remet la
  // sortie par defaut a chaque fois qu'il recree la session.
  useEffect(() => {
    if (!inCall || !listening) return;
    const appliquer = () => {
      try { inCall.setSpeakerphoneOn?.(hautParleur); } catch {}
      try { inCall.setForceSpeakerphoneOn?.(hautParleur); } catch {}
    };
    appliquer();
    // Second passage differe : la session n'est pas toujours etablie au
    // moment ou l'utilisateur appuie.
    const t = setTimeout(appliquer, 700);
    return () => clearTimeout(t);
  }, [hautParleur, listening, rtcAudioLive]);

  // KEEPALIVE MICRO — a envoyer TANT QU'ON ECOUTE, quel que soit le chemin
  // (WebRTC ou mp3). Sans ces messages, le robot croit qu'il n'y a plus
  // d'auditeur et coupe son micro au bout de 6 s : la piste WebRTC mourait
  // juste apres s'etre connectee, d'ou "aucun son".
  useEffect(() => {
    if (!listening || !pairedWith || !socketOnline) return;
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    const ping = () => socketRef.current?.emit('robot_audio', { code, on: true });
    ping();
    const timer = setInterval(ping, 3000);
    return () => {
      clearInterval(timer);
      socketRef.current?.emit('robot_audio', { code, on: false });
    };
  }, [listening, pairedWith, socketOnline]);

  // Lecture du secours mp3. Le lecteur n'existe que si mp3Secours est vrai
  // (voir plus haut) : tant que le WebRTC assure, aucun lecteur n'est cree,
  // donc aucune session audio concurrente.
  useEffect(() => {
    if (!listening || !mp3Secours) return;
    const startTimer = setTimeout(() => {
      try {
        audioPlayer.play();
      } catch {}
    }, 250);
    return () => {
      clearTimeout(startTimer);
      try {
        audioPlayer.pause();
      } catch {}
    };
  }, [listening, mp3Secours, audioPlayer]);

  const handleTyping = (text: string) => {
    setCustomMessage(text);
    if (!socketRef.current) return;
    socketRef.current.emit('user_is_typing');
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current?.emit('user_stopped_typing');
    }, 1200);
  };

  const onPair = async () => {
    if (!socketRef.current || !pseudo || !pairCode) return;
    await AsyncStorage.setItem('pseudo', pseudo);
    await AsyncStorage.setItem('pairCode', pairCode);
    await AsyncStorage.setItem(
      'pair',
      JSON.stringify({ code: pairCode.trim(), pseudo: pseudo.trim() })
    );
    const since = await getLastSeen();
    socketRef.current.emit('pair', {
      pseudo: pseudo.trim(),
      code: pairCode.trim(),
      lastSeen: since,
    });
    socketRef.current.emit('sync', { code: pairCode.trim(), since });

    const token = await ensureExpoPushToken(false);
    if (token) {
      try {
        const sid = socketRef.current.id;
        if (sid) {
          socketRef.current.emit('register_token', {
            code: pairCode.trim(),
            pseudo: pseudo.trim(),
            token,
          });
        }
      } catch {}
    }
  };

  const onUnpair = async () => {
    if (!socketRef.current) return;
    socketRef.current.emit('leave', { code: pairCode });
    await AsyncStorage.multiRemove(['pair', 'pseudo', 'pairCode', 'lastSeen']);
    setPseudo('');
    setPairCode('');
    setSonarSnapshot(null);
    setPairedWith('');
    setMeetRequestFrom(null);
    setMeetStatus(null);
    setMyCoord(null);
    setPeerCoord(null);
  };

  const onCancelMeet = () => {
    if (!socketRef.current || !pairCode) return;
    socketRef.current.emit('cancel_meet', { code: pairCode });
    setMeetRequestFrom(null);
    setMeetStatus(null);
    setPeerCoord(null);
  };

  const onRequestMeet = async () => {
    if (!socketRef.current || !pairCode || !pairedWith) {
      Alert.alert('Info', 'Apparie-toi d’abord avec ton contact.');
      return;
    }
    const myLocation = await shareMyLocationOnce();
    if (!myLocation) return;
    socketRef.current.emit('request_meet', { code: pairCode, from: pseudo || 'Moi' });
    setMeetStatus('pending');
    Alert.alert('Demande envoyée', 'En attente de la réponse de ton contact.');
  };

  const onOpenItinerary = () => {
    if (!myCoord || !peerCoord) {
      Alert.alert('Navigation', 'Ta position ou celle du contact est manquante.');
      return;
    }
    const doOpen = (mode: Mode) => openExternalNavigation(myCoord, peerCoord, mode);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['🚗 En voiture', '🚶 À pied', '🚇 Transport', 'Annuler'],
          cancelButtonIndex: 3,
          userInterfaceStyle: 'dark',
        },
        (i) => {
          if (i === 0) doOpen('driving');
          else if (i === 1) doOpen('walking');
          else if (i === 2) doOpen('transit');
        }
      );
    } else {
      Alert.alert('Choisir le mode', 'Ouvrir l’itinéraire avec…', [
        { text: '🚗 Voiture', onPress: () => doOpen('driving') },
        { text: '🚶 À pied', onPress: () => doOpen('walking') },
        { text: '🚇 Transport', onPress: () => doOpen('transit') },
        { text: 'Annuler', style: 'cancel' },
      ]);
    }
  };

  // Region initiale pour la carte
  const initialRegion = (() => {
    const base = peerCoord || myCoord;
    if (!base) return undefined;
    return {
      latitude: base.latitude,
      longitude: base.longitude,
      latitudeDelta: 0.01,
      longitudeDelta: 0.01,
    };
  })();

  // Position du robot (priorite au statut robot, sinon derniere position recue).
  const robotCoord: Coord | null =
    robotStatus?.coords &&
    typeof robotStatus.coords.latitude === 'number' &&
    typeof robotStatus.coords.longitude === 'number'
      ? { latitude: robotStatus.coords.latitude, longitude: robotStatus.coords.longitude }
      : peerCoord;
  const robotRegion = robotCoord
    ? {
        latitude: robotCoord.latitude,
        longitude: robotCoord.longitude,
        latitudeDelta: 0.0015,
        longitudeDelta: 0.0015,
      }
    : undefined;

  // Suggestions d'adresse (OpenStreetMap / Nominatim) pendant la saisie.
  useEffect(() => {
    const q = destInput.trim();
    if (q.length < 3 || destination) {
      setDestSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=fr&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        const data = await res.json();
        if (Array.isArray(data)) {
          setDestSuggestions(
            data
              .map((d: any) => ({
                label: String(d.display_name || ''),
                latitude: parseFloat(d.lat),
                longitude: parseFloat(d.lon),
              }))
              .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
          );
        }
      } catch {}
    }, 500);
    return () => clearTimeout(t);
  }, [destInput, destination]);

  // Distance de depart, figee une fois la destination posee (base du %).
  useEffect(() => {
    if (destination && robotCoord && destStartDist == null) {
      const d = distanceMeters(robotCoord, destination);
      if (d != null) setDestStartDist(d);
    }
  }, [destination, robotCoord, destStartDist]);

  // Itineraire (route qui suit les rues, via OSRM) recalcule quand la
  // destination change. Repli en ligne droite si le service repond mal.
  useEffect(() => {
    let cancelled = false;
    if (!destination) {
      setRouteCoords([]);
      return;
    }
    const from = robotCoord; // position du robot au moment ou on pose la destination
    if (!from) {
      setRouteCoords([]);
      return;
    }
    const straight = [
      { latitude: from.latitude, longitude: from.longitude },
      { latitude: destination.latitude, longitude: destination.longitude },
    ];
    (async () => {
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${from.longitude},${from.latitude};${destination.longitude},${destination.latitude}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        const data = await res.json();
        const coords = data?.routes?.[0]?.geometry?.coordinates;
        if (cancelled) return;
        if (Array.isArray(coords) && coords.length > 1) {
          setRouteCoords(
            coords.map((c: number[]) => ({ latitude: c[1], longitude: c[0] }))
          );
        } else {
          setRouteCoords(straight);
        }
      } catch {
        if (!cancelled) setRouteCoords(straight);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [destination]);

  const selectDestination = (s: { label: string; latitude: number; longitude: number }) => {
    setDestination({ latitude: s.latitude, longitude: s.longitude, label: s.label });
    setDestInput(s.label);
    setDestSuggestions([]);
    setDestStartDist(robotCoord ? distanceMeters(robotCoord, s) : null);
  };

  // Ecart de cap par rapport au depart, ramene dans [-180, +180].
  // Sans ce repliement, passer de 359 a 1 degre afficherait -358 au lieu de
  // +2 et l'indicateur deviendrait absurde juste au passage du nord.
  const capActuel = typeof robotStatus?.heading === 'number' && Number.isFinite(robotStatus.heading)
    ? robotStatus.heading
    : null;
  const ecartCap = (() => {
    if (capRef == null || capActuel == null) return null;
    let d = capActuel - capRef;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  })();

  const startNav = () => {
    const code = pairCodeRef.current?.trim();
    if (!socketRef.current || !code || !destination) return;
    socketRef.current.emit('robot_nav', {
      code,
      target: { latitude: destination.latitude, longitude: destination.longitude },
      on: true,
    });
    setNavActive(true);
  };

  const stopNav = () => {
    const code = pairCodeRef.current?.trim();
    if (code) socketRef.current?.emit('robot_nav', { code, on: false });
    setNavActive(false);
  };

  // Alarme dissuasive. Interrupteur, jamais impulsion : on doit pouvoir la
  // couper a distance. Le declenchement se fait en appui LONG, l'arret en
  // appui simple — il doit etre plus facile d'eteindre que d'allumer.
  // Le bouton REGARDER a quitte l'accueil : la camera doit donc s'allumer
  // d'elle-meme, sinon la page principale serait un cadre vide sans issue.
  // Elle reste coupable depuis le plein ecran, pour maitriser la 4G.
  useEffect(() => {
    if (pairedWith) setCameraOn(true);
  }, [pairedWith]);

  // Mode de surveillance. Le robot garde cet etat sur son disque : il le
  // retrouve apres un redemarrage, et c'est LUI qui fait foi — l'app ne fait
  // que le demander et l'afficher.
  const definirMode = (absent: boolean) => {
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    socketRef.current?.emit('robot_mode', { code, absent });
    setModeAbsent(absent);
  };

  // Couper les appels ne coupe pas les notifications ni Telegram.
  const basculerAppelAlerte = () => {
    const code = pairCodeRef.current?.trim();
    if (!code || !appelAlerte) return;
    socketRef.current?.emit('alerte_appel', { code, actif: !appelAlerte.actif });
  };

  const basculerAlarme = (on: boolean) => {
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    socketRef.current?.emit('robot_alarme', { code, on });
    setAlarmeOn(on);
  };

  // ARRET D'URGENCE. Volontairement redondant : c'est le seul bouton dont on
  // ne peut pas se permettre qu'il echoue a moitie.
  //
  // Quatre choses peuvent faire avancer le robot, et elles ne vivent pas au
  // meme endroit :
  //   - le pilotage manuel et la navigation GPS, sur le robot ;
  //   - la ronde autonome, sur le robot ;
  //   - le suivi de personne et "va vers la poubelle", sur le SERVEUR ;
  //   - la conversation en direct, qui peut commander les trois premiers.
  // Un simple "stop" moteur n'en coupe qu'une : les boucles du serveur
  // reenvoient un ordre 400 ms plus tard et le robot repart. D'ou robot_stop_all.
  //
  // sendRobotDrive('S') part en plus par ses trois canaux habituels (socket,
  // buzz, HTTP) : si la liaison socket est mauvaise, il en reste deux.
  const arretUrgence = () => {
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    const s = socketRef.current;
    s?.emit('robot_stop_all', { code });
    // Repli si le serveur n'a pas encore la nouvelle version : ces quatre
    // ordres-la existent depuis longtemps.
    s?.emit('robot_nav', { code, on: false });
    s?.emit('robot_ronde', { code, action: 'arreter' });
    s?.emit('robot_rt', { code, on: false });
    // Une sirene qu'on ne peut plus arreter fait partie des problemes que ce
    // bouton doit resoudre.
    s?.emit('robot_alarme', { code, on: false });
    setNavActive(false);
    setRtActif(false);
    setRtEveille(false);
    setAlarmeOn(false);
    pushRobotLog('ARRET URGENCE');
    sendRobotDrive('S');
    setRobotCommandStatus('ARRET D URGENCE envoye');
  };

  // Rondes : une seule voie, avec une action nommee. L'app n'anticipe jamais
  // le resultat — c'est robot_ronde_status qui met l'affichage a jour.
  const envoyerRonde = (
    action: 'apprendre_debut' | 'apprendre_fin' | 'demarrer' | 'arreter' | 'oublier' | 'etat'
  ) => {
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    socketRef.current?.emit('robot_ronde', { code, action });
  };

  // Conversation avec l'IA. Volontairement INDEPENDANT du talkie : c'est toi
  // qui decides quand ouvrir ton micro.
  //
  // Deux facons de lui parler, au choix :
  //   - a cote du robot : son micro embarque suffit, ne touche a rien
  //   - a distance : ouvre le talkie et LAISSE-LE OUVERT pendant l'echange.
  //     Chaque bascule reconstruit la liaison d'ecoute (voir ecouteTick), ce
  //     qui coupe le son une a deux secondes — en appui-maintenu, ca coupe
  //     donc deux fois par phrase.
  const basculerRt = (on: boolean) => {
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    setRtActif(on);
    // Une session neuve demarre en veille : le serveur confirmera a l'ouverture.
    setRtEveille(false);
    socketRef.current?.emit('robot_rt', { code, on });
  };

  // L'enregistrement se fait sur le VPS a partir du flux deja publie : il faut
  // donc que la camera soit allumee, sinon il n'y a rien a recopier.
  const basculerRec = (on: boolean) => {
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    if (on && !cameraOn) {
      Alert.alert('Enregistrement', 'Allume la camera avant de lancer l’enregistrement.');
      return;
    }
    setRecActif(on);
    socketRef.current?.emit('robot_record', { code, on });
  };

  // Film HD : le robot filme lui-meme, en pleine definition, sans passer par
  // le reseau. La contrepartie est qu'il garde la camera pour lui — la vue en
  // direct s'eteint le temps de la prise, et revient toute seule apres.
  const basculerRecHd = (on: boolean) => {
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    setRecHdActif(on);
    socketRef.current?.emit('robot_record_hd', { code, on });
  };

  const clearDestination = () => {
    if (navActive) stopNav();
    setDestination(null);
    setDestStartDist(null);
    setDestInput('');
    setDestSuggestions([]);
  };

  const remainingDist =
    destination && robotCoord ? distanceMeters(robotCoord, destination) : null;
  const progressPct =
    destStartDist && destStartDist > 0 && remainingDist != null
      ? Math.max(0, Math.min(100, Math.round((1 - remainingDist / destStartDist) * 100)))
      : 0;

  // ========================
  // UI (aucun Fragment stylé)
  // ========================
  // Le defilement etait bloque pendant que le talkie etait ouvert
  // (scrollEnabled={!talking}). C'etait justifie du temps ou il fallait
  // MAINTENIR le bouton enfonce : la page ne devait pas glisser sous le doigt.
  // Depuis qu'il fonctionne par bascule, `talking` reste vrai toute la
  // conversation — et on ne pouvait plus remonter voir la camera.
  return (
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.innerContainer}>
        <View style={styles.header}>
          <Text style={styles.title}>Ping</Text>
          <Text style={styles.emoji}>⚡</Text>
        </View>

        {!pairedWith && (
          <>
        <Text style={styles.warningText}>Connecte-toi au robot</Text>

        <TextInput
          placeholder="Pseudo"
          placeholderTextColor="#7C9C93"
          value={pseudo}
          onChangeText={setPseudo}
          style={styles.input}
        />
        <TextInput
          placeholder="Code en commun"
          placeholderTextColor="#7C9C93"
          keyboardType="number-pad"
          value={pairCode}
          onChangeText={setPairCode}
          style={styles.input}
        />

        {Platform.OS !== 'web' && (
        <View style={{ backgroundColor: '#0B1016', borderRadius: 12, padding: 12, marginTop: 8 }}>
          <Text style={{ color: '#E8FFF8', fontWeight: '700', marginBottom: 6 }}>
            Notifications (optionnel)
          </Text>
          <Text style={{ color: '#A9D6C9', fontSize: 13, marginBottom: 10 }}>
            Active-les pour recevoir un message même si l’app est en arrière-plan.
          </Text>
          {notifStatus === 'granted' ? (
            <>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: '#132029' }]}
                onPress={() => openSystemSettings()}
              >
                <Text style={styles.primaryBtnText}>Gérer dans les Réglages</Text>
              </TouchableOpacity>
              {/* Quand les permissions sont DEJA accordees, aucun bouton ne
                  permettait de (re)enregistrer le jeton : le seul qui le
                  faisait vivait dans la branche "pas autorisees". Le serveur
                  n'avait donc jamais de destinataire. Celui-ci force
                  l'enregistrement et affiche le resultat exact. */}
              <TouchableOpacity
                style={[styles.primaryBtn, { marginTop: 8 }]}
                onPress={async () => {
                  try {
                    const tk = await ensureExpoPushToken(false);
                    if (!tk) {
                      Alert.alert('Notifications', "Aucun jeton obtenu. L'app n'a pas pu en generer un.");
                      return;
                    }
                    // Par la SOCKET et non par fetch : iOS bloque le HTTP en
                    // clair (ATS), la socket passe.
                    socketRef.current?.emit('register_token', {
                      code: pairCodeRef.current?.trim(),
                      pseudo: pseudoRef.current,
                      token: tk,
                    });
                    Alert.alert('Notifications', `Jeton envoye
${tk.slice(0, 32)}…`);
                  } catch (e: any) {
                    Alert.alert('Notifications', `Echec : ${String(e?.message || e)}`);
                  }
                }}
              >
                <Text style={styles.primaryBtnText}>Réenregistrer les notifications</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={async () => {
                const token = await ensureExpoPushToken(true);
                const perms = await Notifications.getPermissionsAsync();
                setNotifStatus(perms.status as NotifStatus);
                canNotifyRef.current = perms.status === 'granted';
                if (perms.status === 'granted') {
                  try {
                    const isReg = await TaskManager.isTaskRegisteredAsync(
                      BACKGROUND_PUSH_TASK
                    );
                    if (!isReg)
                      await Notifications.registerTaskAsync(BACKGROUND_PUSH_TASK);
                  } catch {}
                  const tk = token || (await ensureExpoPushToken(false));
                  if (tk) {
                    try {
                      const sid = socketRef.current?.id;
                      if (sid) {
                        await fetch(`${SOCKET_URL}/register-token`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            token: tk,
                            socketId: sid,
                            code: pairCodeRef.current?.trim(),
                            pseudo: pseudoRef.current,
                          }),
                        });
                      }
                    } catch {}
                  }
                  Alert.alert('Notifications', 'Activées.');
                } else {
                  Alert.alert('Notifications', 'Pas activées.');
                }
              }}
            >
              <Text style={styles.primaryBtnText}>Activer les notifications</Text>
            </TouchableOpacity>
          )}
        </View>
        )}

            <PrimaryButton label="S’APPARIER" onPress={onPair} />
          </>
        )}

        <View style={styles.statusContainer}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: pairedWith ? '#5CFFC9' : '#FF7A8C' },
            ]}
          />
          <Text style={styles.statusText}>
            {pairedWith ? `Connecté à ${pairedWith}` : "En attente de l'autre..."}
          </Text>
        </View>

        {/* === Mode de surveillance === */}
        {/* Premier element de la page : c'est la question a laquelle on repond
            en ouvrant l'app quand on part de chez soi. */}
        {!!pairedWith && (
          <View style={styles.modeCard}>
            <TouchableOpacity
              style={[styles.modeBtn, !modeAbsent && styles.modeBtnNormalOn]}
              onPress={() => definirMode(false)}
              activeOpacity={0.8}
            >
              <Text style={[styles.modeTexte, !modeAbsent && styles.modeTexteOn]}>
                🏠  NORMAL
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeBtn, modeAbsent && styles.modeBtnAbsentOn]}
              onPress={() => definirMode(true)}
              activeOpacity={0.8}
            >
              <Text style={[styles.modeTexte, modeAbsent && styles.modeTexteOn]}>
                🛡️  ABSENT
              </Text>
            </TouchableOpacity>
          </View>
        )}
        {!!pairedWith && (
          <Text style={styles.modeSous}>
            {modeAbsent
              ? 'Surveillance armee : le robot guette et alerte.'
              : 'Surveillance desarmee : le robot n alerte pas.'}
          </Text>
        )}
        {!!pairedWith && modeAbsent && appelAlerte && (
          <TouchableOpacity
            onPress={basculerAppelAlerte}
            disabled={!appelAlerte.configure}
            activeOpacity={0.8}
          >
            <Text style={[styles.modeSous, appelAlerte.configure && appelAlerte.actif && styles.appelActif]}>
              {!appelAlerte.configure
                ? '📞  Appel si quelqu un est vu : pas configure sur le serveur'
                : appelAlerte.actif
                  ? '📞  Appel si quelqu un est vu : ACTIF (toucher pour couper)'
                  : '📞  Appel si quelqu un est vu : COUPE (toucher pour activer)'}
            </Text>
          </TouchableOpacity>
        )}

        {/* === Camera du robot (flux a la demande) === */}
        {!!pairedWith && (expanded === null || expanded === 'camera') && (
          <View style={styles.cameraCard}>
            <View style={styles.robotControlHeader}>
              <Text style={styles.robotControlTitle}>Camera</Text>
              {/* Page d'accueil volontairement nue : la camera et l'alarme.
                  Ecouter, parler, piloter, photographier — tout existe encore,
                  mais dans la vue plein ecran, la ou on s'en sert vraiment.
                  Un robot de surveillance doit d'abord MONTRER. */}
              <View style={styles.cameraBtnRow}>
                <TouchableOpacity
                  style={styles.expandBtn}
                  onPress={() => {
                    setCameraOn(true);
                    setCamFullscreen(true);
                  }}
                >
                  <Text style={styles.expandBtnText}>⛶</Text>
                </TouchableOpacity>
              </View>
            </View>

            {cameraOn ? (
              <View>
                {rtcStreamUrl && webrtc ? (
                  // Video WebRTC (fluide, latence basse)
                  <webrtc.RTCView
                    streamURL={rtcStreamUrl}
                    style={[styles.cameraImage, { height: camH }]}
                    objectFit="contain"
                  />
                ) : frameUri ? (
                  <Image
                    source={{ uri: frameUri }}
                    style={[styles.cameraImage, { height: camH }]}
                    resizeMode="contain"
                    fadeDuration={0}
                  />
                ) : (
                  <View style={[styles.cameraPlaceholder, { height: camH }]}>
                    <Text style={{ color: '#7C9C93' }}>
                      Connexion a la camera du robot…
                    </Text>
                  </View>
                )}
                {/* Temoin discret du mode video : direct WebRTC ou secours MJPEG */}
                {(rtcStreamUrl || frameUri) && (
                  <Text style={styles.cameraModeBadge}>
                    {rtcStreamUrl
                      ? '● direct'
                      : webrtc
                        ? '● secours'
                        : '● secours (module WebRTC absent du build)'}
                  </Text>
                )}

              </View>
            ) : (
              <View style={[styles.cameraPlaceholder, { height: camH }]}>
                <Text style={{ color: '#7C9C93' }}>
                  Camera coupee. Appuie sur REGARDER.
                </Text>
              </View>
            )}

          </View>
        )}

        {/* === Alarme === */}
        {/* Seul bouton d'action conserve sur l'accueil, avec la camera. Tout
            le pilotage a migre en plein ecran : sur un robot de surveillance,
            la page principale doit montrer ce que le robot voit et permettre
            de faire du bruit, rien d'autre. */}
        {!!pairedWith && (
          <TouchableOpacity
            style={[styles.alarmeBtn, alarmeOn && styles.alarmeBtnOn]}
            onPress={() => { if (alarmeOn) basculerAlarme(false); }}
            onLongPress={() => { if (!alarmeOn) basculerAlarme(true); }}
            delayLongPress={700}
            activeOpacity={0.75}
          >
            <Text style={[styles.alarmeTexte, alarmeOn && styles.alarmeTexteOn]}>
              {alarmeOn ? '🔊  ALARME EN COURS — APPUIE POUR COUPER' : '🚨  ALARME'}
            </Text>
            {!alarmeOn && (
              <Text style={styles.alarmeSous}>appui long pour declencher</Text>
            )}
          </TouchableOpacity>
        )}

        {/* === Carte du robot (des que appaire) === */}
        {!!pairedWith && (expanded === null || expanded === 'map') && (
          <View style={styles.mapCard}>
            <View style={styles.mapHeader}>
              <Text style={styles.mapTitle}>Carte du robot</Text>
              <ExpandButton active={expanded === 'map'} onPress={() => toggleExpand('map')} />
            </View>

            <View style={styles.addrBox}>
              <TextInput
                placeholder="Adresse de destination…"
                placeholderTextColor="#7C9C93"
                value={destInput}
                onChangeText={(t) => {
                  setDestInput(t);
                  if (destination) {
                    setDestination(null);
                    setDestStartDist(null);
                  }
                }}
                style={styles.addrInput}
              />
              {!!destInput && (
                <TouchableOpacity style={styles.addrClear} onPress={clearDestination}>
                  <Text style={styles.addrClearText}>✕</Text>
                </TouchableOpacity>
              )}
            </View>

            {destSuggestions.length > 0 && (
              <View style={styles.suggestBox}>
                {destSuggestions.map((s, i) => (
                  <TouchableOpacity
                    key={`${s.latitude},${s.longitude},${i}`}
                    style={styles.suggestItem}
                    onPress={() => selectDestination(s)}
                  >
                    <Text style={styles.suggestText} numberOfLines={2}>
                      {s.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {!!destination && (
              <View style={styles.progressWrap}>
                <View style={styles.progressHeader}>
                  <Text style={styles.progressLabel} numberOfLines={1}>
                    {destination.label}
                  </Text>
                  <Text style={styles.progressPct}>{progressPct}%</Text>
                </View>
                <View style={styles.progressBarBg}>
                  <View style={[styles.progressBarFill, { width: `${progressPct}%` }]} />
                </View>
                <Text style={styles.progressMeta}>
                  {remainingDist != null
                    ? `${remainingDist} m restants`
                    : 'Position robot inconnue'}
                </Text>
              </View>
            )}

            {!!destination && (
              <TouchableOpacity
                style={[styles.navBtn, navActive ? styles.navStop : styles.navGo]}
                onPress={navActive ? stopNav : startNav}
              >
                <Text style={styles.navBtnText}>
                  {navActive ? '⏹  STOP NAVIGATION' : '🤖  Y ALLER (auto)'}
                </Text>
              </TouchableOpacity>
            )}

            <View style={styles.rondeCard}>
              <View style={styles.rondeHeader}>
                <Text style={styles.rondeTitle}>RONDE</Text>
                <Text style={styles.rondeMeta}>
                  {ronde?.apprentissage
                    ? `apprentissage · ${ronde.points} pts`
                    : !ronde || ronde.points < 3
                      ? 'aucun circuit'
                      : ronde.enCours
                        ? ronde.prochainDansS > 0
                          ? `tour ${ronde.toursFaits} · reprise dans ${Math.ceil(ronde.prochainDansS / 60)} min`
                          : `tour ${ronde.toursFaits + 1} en cours`
                        : `${ronde.longueurM} m · ${ronde.points} pts`}
                </Text>
              </View>

              {ronde?.apprentissage ? (
                <>
                  <Text style={styles.rondeHint}>
                    Conduis le robot sur le tour complet, puis termine.
                  </Text>
                  <TouchableOpacity
                    style={[styles.navBtn, styles.navGo]}
                    onPress={() => envoyerRonde('apprendre_fin')}
                  >
                    <Text style={styles.navBtnText}>⏺  TERMINER L&apos;APPRENTISSAGE</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <View style={styles.rondeRow}>
                  <TouchableOpacity
                    style={[styles.rondeBtn, ronde?.enCours ? styles.navStop : styles.navGo]}
                    onPress={() => envoyerRonde(ronde?.enCours ? 'arreter' : 'demarrer')}
                    disabled={!ronde || ronde.points < 3}
                  >
                    <Text style={styles.navBtnText}>
                      {ronde?.enCours ? '⏹  ARRÊTER' : '🔁  LANCER'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.rondeBtn, styles.rondeBtnSecondaire]}
                    onPress={() => envoyerRonde('apprendre_debut')}
                  >
                    <Text style={styles.navBtnText}>🎓  APPRENDRE</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {Platform.OS === 'web' ? (
              <Text style={{ color: '#7C9C93' }}>Open the mobile app to view the map.</Text>
            ) : !robotCoord ? (
              <Text style={{ color: '#7C9C93' }}>
                En attente d&apos;un fix GPS du robot…
              </Text>
            ) : maps ? (
              <maps.default
                ref={robotMapRef}
                style={[styles.map, { height: mapH }]}
                initialRegion={robotRegion}
                showsCompass
                showsUserLocation={!!myCoord}
                onPress={(e: any) => {
                  const c = e?.nativeEvent?.coordinate;
                  if (!c || typeof c.latitude !== 'number') return;
                  setDestination({
                    latitude: c.latitude,
                    longitude: c.longitude,
                    label: 'Point sur la carte',
                  });
                  setDestInput('Point sur la carte');
                  setDestSuggestions([]);
                  setDestStartDist(robotCoord ? distanceMeters(robotCoord, c) : null);
                }}
              >
                <maps.Marker
                  coordinate={robotCoord}
                  title="Robot"
                  description={formatCoord(robotCoord)}
                  pinColor="#00E5A0"
                />
                {myCoord && (
                  <maps.Marker
                    coordinate={myCoord}
                    title="Moi"
                    description="Ta position"
                    pinColor="#00E5A0"
                  />
                )}
                {destination && (
                  <maps.Marker
                    coordinate={{
                      latitude: destination.latitude,
                      longitude: destination.longitude,
                    }}
                    title="Destination"
                    description={destination.label}
                    pinColor="#FFB020"
                  />
                )}
                {routeCoords.length > 1 && (
                  <maps.Polyline
                    coordinates={routeCoords}
                    strokeWidth={4}
                    strokeColor="#FFB020"
                  />
                )}
              </maps.default>
            ) : (
              <Text style={{ color: '#7C9C93' }}>Carte indisponible.</Text>
            )}

            <Text style={[styles.gpsMeta, { marginTop: 8 }]}>
              Robot: {formatCoord(robotCoord)}
            </Text>
          </View>
        )}

        {!!pairedWith && (
          <PrimaryButton label="SE DÉCONNECTER" onPress={onUnpair} />
        )}
      </View>

      {/* ======== TUTORIEL (MODAL) ======== */}
      {/* === Camera plein ecran + commandes de pilotage === */}
      <Modal
        visible={camFullscreen || sonarOpen}
        animationType="fade"
        statusBarTranslucent
        supportedOrientations={['portrait', 'landscape']}
        onRequestClose={() => {
          if (sonarOpen) setSonarOpen(false);
          else setCamFullscreen(false);
        }}
      >
        {sonarOpen && (
          <SonarMapView
            connected={socketOnline}
            snapshot={sonarSnapshot?.code === pairCode.trim() ? sonarSnapshot : null}
            onClose={() => setSonarOpen(false)}
          />
        )}
        <View style={[styles.fsRoot, sonarOpen && styles.fsHidden]} {...pinchResponder.panHandlers}>
          {rtcStreamUrl && webrtc ? (
            // contain = on voit TOUTE l'image (plus de rognage) ; le zoom
            // eventuel est applique par-dessus (boutons +/- ou pincement).
            <webrtc.RTCView
              streamURL={rtcStreamUrl}
              style={[styles.fsImage, { transform: [{ scale: camZoom }] }]}
              objectFit="contain"
            />
          ) : frameUri ? (
            <Image
              source={{ uri: frameUri }}
              style={[styles.fsImage, { transform: [{ scale: camZoom }] }]}
              resizeMode="contain"
              fadeDuration={0}
            />
          ) : (
            <View style={styles.fsWait}>
              <Text style={{ color: '#7C9C93' }}>Connexion a la camera du robot…</Text>
            </View>
          )}

          {/* Barre du haut : fermer / audio / temoin robot / vitesse */}
          <View style={styles.fsTopRow}>
            <View style={styles.fsSpeedGroup}>
              <TouchableOpacity
                style={styles.camPadSpeedBtn}
                onPress={() => setCamFullscreen(false)}
              >
                <Text style={styles.camPadSymbol}>✕</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                style={[styles.camPadSpeedBtn, styles.fsSonarBtn]}
                onPress={() => {
                  setSonarOpen(true);
                  socketRef.current?.emit('sonar_map_request');
                }}
              >
                <Text style={styles.fsSonarLabel}>Live sonar map</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, listening && styles.fsAudioOn]}
                onPress={() => setListening((v) => !v)}
              >
                <Text style={styles.camPadSymbol}>{listening ? '🔊' : '🔈'}</Text>
              </TouchableOpacity>
              {/* Parler au robot sans dire le mot-cle */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, askingVoice && styles.fsAudioOn]}
                onPress={askRobotVoice}
              >
                <Text style={styles.camPadSymbol}>🎤</Text>
              </TouchableOpacity>
              {/* Les trois actions qu'on veut sous la main sans quitter la vue.
                  Elles vivaient tout en bas de la page principale. */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, talking && styles.fsAudioOn]}
                onPress={webrtc ? (talking ? stopTalkLive : startTalkLive) : toggleTalk}
              >
                <Text style={styles.camPadSymbol}>🎙️</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, rtActif && styles.fsAudioOn]}
                onPress={() => basculerRt(!rtActif)}
              >
                <Text style={styles.camPadSymbol}>💬</Text>
              </TouchableOpacity>
              {/* Enregistrement cote serveur : il recopie le flux deja
                  diffuse, donc la vue reste affichee. Le film HD, lui,
                  monopoliserait la camera et eteindrait cet ecran. */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, recActif && styles.fsAudioOn]}
                onPress={() => basculerRec(!recActif)}
              >
                <Text style={styles.camPadSymbol}>{recActif ? '⏹' : '⏺'}</Text>
              </TouchableOpacity>
              {/* Zoom image : - / + (ou pincement a deux doigts sur l'image) */}
              <TouchableOpacity style={styles.camPadSpeedBtn} onPress={() => bumpZoom(-0.25)}>
                <Text style={styles.camPadSymbol}>−</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.camPadSpeedBtn}
                onPress={() => bumpZoom(0.25)}
                onLongPress={() => setCamZoom(1)}
              >
                <Text style={styles.camPadSymbol}>+</Text>
              </TouchableOpacity>
              {/* Enregistrements conservees sur le serveur. */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, videosOuvert && styles.fsAudioOn]}
                onPress={() => { setVideosOuvert(true); chargerVideos(); }}
              >
                <Text style={styles.camPadSymbol}>🎞</Text>
              </TouchableOpacity>

              {/* Historique : ce qui a sonne ET ce qui a ete retenu. */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, histoOuvert && styles.fsAudioOn]}
                onPress={() => { setHistoOuvert(true); chargerHistorique(); }}
              >
                <Text style={styles.camPadSymbol}>📋</Text>
              </TouchableOpacity>

              {/* Revoir la photo de la derniere alerte. */}
              {!!alertePhoto && (
                <TouchableOpacity
                  style={styles.camPadSpeedBtn}
                  onPress={() => setAlerteGrande(true)}
                >
                  <Text style={styles.camPadSymbol}>🖼</Text>
                </TouchableOpacity>
              )}

              {/* Photo : descendu de l'accueil. Un robot de surveillance sert
                  d'abord a rapporter une image. */}
              <TouchableOpacity
                style={styles.camPadSpeedBtn}
                onPress={savePhoto}
                disabled={savingPhoto}
              >
                <Text style={styles.camPadSymbol}>{savingPhoto ? '⏳' : '📷'}</Text>
              </TouchableOpacity>

              {/* Alarme : appui LONG pour declencher, simple pour couper.
                  Meme regle qu'a l'accueil — plus facile d'eteindre que
                  d'allumer. */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, alarmeOn && styles.fsAlarmeOn]}
                onPress={() => { if (alarmeOn) basculerAlarme(false); }}
                onLongPress={() => { if (!alarmeOn) basculerAlarme(true); }}
                delayLongPress={700}
              >
                <Text style={styles.camPadSymbol}>🚨</Text>
              </TouchableOpacity>

              {/* Arret d'urgence : il a quitte l'accueil avec le reste du
                  pilotage, mais il ne doit JAMAIS devenir introuvable — c'est
                  ici qu'on conduit, c'est donc ici qu'il doit etre. */}
              <TouchableOpacity style={[styles.camPadSpeedBtn, styles.fsStopAll]} onPress={arretUrgence}>
                <Text style={styles.camPadSymbol}>⛔</Text>
              </TouchableOpacity>

              {/* Haut-parleur / ecouteur. Le son fort passe par le flux MP3,
                  le mode discret par WebRTC (plus reactif, mais iOS le sort
                  dans l'ecouteur d'oreille). */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, hautParleur && styles.fsAudioOn]}
                onPress={() => setHautParleur((v) => !v)}
              >
                <Text style={styles.camPadSymbol}>{hautParleur ? '📢' : '📞'}</Text>
              </TouchableOpacity>

              {/* Couper la camera : le bouton REGARDER a disparu de l'accueil
                  (la camera s'y allume seule), il faut donc garder un moyen
                  d'arreter le flux — sinon la 4G tourne en permanence. */}
              <TouchableOpacity
                style={styles.camPadSpeedBtn}
                onPress={() => {
                  setCameraOn(false);
                  setCamFullscreen(false);
                }}
              >
                <Text style={styles.camPadSymbol}>⏻</Text>
              </TouchableOpacity>

              {/* Trajectoire : version compacte de la boussole de la page
                  principale. C'est en plein ecran qu'on pilote vraiment, donc
                  c'est la qu'il faut voir si le robot part de travers. */}
              <View
                style={[
                  styles.fsCap,
                  ecartCap != null &&
                    (Math.abs(ecartCap) <= 3
                      ? styles.fsCapOk
                      : Math.abs(ecartCap) <= 10
                        ? styles.fsCapMoyen
                        : styles.fsCapMauvais),
                ]}
              >
                <Text
                  style={[
                    styles.fsCapFleche,
                    { transform: [{ rotate: `${ecartCap ?? 0}deg` }] },
                    capActuel == null && styles.fsCapOff,
                  ]}
                >
                  ▲
                </Text>
                <Text style={styles.fsCapTexte}>
                  {capActuel == null
                    ? 'cap ?'
                    : ecartCap == null
                      ? `${Math.round(capActuel)}°`
                      : Math.abs(ecartCap) <= 3
                        ? 'droit'
                        : `${Math.abs(Math.round(ecartCap))}°${ecartCap > 0 ? 'D' : 'G'}`}
                </Text>
              </View>
              {camZoom > 1 && (
                <TouchableOpacity style={styles.camPadSpeedBtn} onPress={() => setCamZoom(1)}>
                  <Text style={styles.fsZoomText}>{camZoom.toFixed(1)}x</Text>
                </TouchableOpacity>
              )}
            </View>
            <RobotLinkBadge status={robotLink} />
            <View style={styles.fsSpeedGroup}>
              <SpeedSlider
                compact
                pct={speedPct}
                onPreview={setSpeedPct}
                onCommit={(p) => {
                  setSpeedPct(p);
                  sendRobotSpeed(p);
                }}
              />
              <Text style={styles.speedPctTextLight}>{speedPct}%</Text>
            </View>
          </View>

          {/* Pan-tilt : oriente la camera sans bouger le robot */}
          <CamPanTiltPad
            fullscreen
            onHoldStart={startCamHold}
            onHoldEnd={stopCamHold}
            onCenter={centerCam}
            view={camView}
            onToggleView={toggleCamView}
          />

          {/* Commandes du bas : conduite a deux pouces */}
          {/*
            Direction a GAUCHE, avancer-reculer a DROITE : on tient le
            telephone a deux mains et chaque pouce reste sur son groupe, sans
            traverser l'ecran. C'est la disposition des manettes de jeu, pour
            la meme raison.

            Le joystick occupait la place de gauche et ne repondait plus. Il
            etait aussi le SEUL a pouvoir tourner, car le seul a envoyer le
            pilotage differentiel M<g>,<d> — un format qui n'arrivait jamais
            jusqu'au robot, alors que son ordre d'arret, lui, partait bien.
            D'ou un robot qui ne repondait plus qu'en s'arretant.
          */}
          {/* Conduite : pilote uniquement. Le serveur refuse de toute facon les
              ordres d'un spectateur — ceci evite surtout de lui presenter des
              boutons qui ne feraient rien. */}
          {rtActif && (
            <View style={styles.fsVeilleBandeau}>
              <Text style={styles.fsVeilleTexte}>
                {rtEveille
                  ? 'SOLANA ECOUTE'
                  : `EN VEILLE — DITES "${rtPhrase.toUpperCase()}"`}
              </Text>
            </View>
          )}
          {!estPilote && (
            <View style={styles.fsRoleBandeau}>
              <Text style={styles.fsRoleTexte}>
                {role === 'attente' ? 'EN ATTENTE D ACCEPTATION' : 'SPECTATEUR, CAMERA SEULE'}
              </Text>
            </View>
          )}
          {estPilote && (
          <View style={styles.fsBottomRow}>
            {/* Pouce gauche : la direction. */}
            <View style={styles.camPadGroupRow}>
              <TouchableOpacity
                style={styles.camPadBtn}
                onPressIn={() => startRobotDriveHold('L')}
                onPressOut={stopRobotDriveHold}
              >
                <Text style={styles.camPadSymbol}>◀</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.camPadBtn}
                onPressIn={() => startRobotDriveHold('R')}
                onPressOut={stopRobotDriveHold}
              >
                <Text style={styles.camPadSymbol}>▶</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.camPadBtn, styles.camPadStop]}
              onPress={stopRobotDriveHold}
            >
              <Text style={styles.camPadSymbol}>■</Text>
            </TouchableOpacity>

            {/* Pouce droit : avancer et reculer. */}
            <View style={styles.camPadGroupCol}>
              <TouchableOpacity
                style={styles.camPadBtn}
                onPressIn={() => startRobotDriveHold('F')}
                onPressOut={stopRobotDriveHold}
              >
                <Text style={styles.camPadSymbol}>▲</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.camPadBtn}
                onPressIn={() => startRobotDriveHold('B')}
                onPressOut={stopRobotDriveHold}
              >
                <Text style={styles.camPadSymbol}>▼</Text>
              </TouchableOpacity>
            </View>
          </View>
          )}

          {/* === Enregistrements video === */}
          {videosOuvert && (
            <View style={styles.histoFond}>
              <View style={styles.histoBarre}>
                <Text style={styles.histoTitre}>ENREGISTREMENTS</Text>
                <TouchableOpacity onPress={chargerVideos} style={styles.histoAction}>
                  <Text style={styles.histoActionTexte}>{videosChargement ? '...' : 'ACTUALISER'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setVideosOuvert(false)} style={styles.histoAction}>
                  <Text style={styles.histoActionTexte}>FERMER</Text>
                </TouchableOpacity>
              </View>

              {videosListe === null ? (
                <Text style={styles.histoVide}>
                  Liste indisponible : le serveur n a pas repondu.{'\n'}
                  Cela ne veut pas dire qu il n y a aucun enregistrement.
                </Text>
              ) : videosListe.length === 0 ? (
                <Text style={styles.histoVide}>
                  {videosChargement ? 'Chargement...' : 'Aucun enregistrement.'}
                </Text>
              ) : (
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
                  {videosListe.map((v) => {
                    // Nom de la forme robot-<code>-AAAAMMJJ-HHMMSS.mp4 : on en
                    // tire une date lisible plutot que d'afficher le fichier brut.
                    const m = v.nom.match(/-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.mp4$/);
                    const quand = m
                      ? `${m[3]}/${m[2]} a ${m[4]}h${m[5]}`
                      : v.nom;
                    return (
                      <TouchableOpacity
                        key={v.nom}
                        style={styles.histoLigne}
                        activeOpacity={0.7}
                        onPress={() => rangerVideoDansGalerie(v.nom, v.mo)}
                      >
                        <View style={[styles.histoVignette, styles.histoSansPhoto]}>
                          <Text style={{ color: HUD.ACCENT, fontSize: 20 }}>▶</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.histoHeure}>{quand}</Text>
                          <Text style={styles.histoPhrase}>{v.mo} Mo</Text>
                          <Text style={styles.histoCapteurs}>appuyer pour enregistrer dans la galerie</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}
            </View>
          )}

          {/* === Historique des alertes === */}
          {/* Le filtrage porte sur la sonnerie, jamais sur la trace : on
              retrouve ici les alertes retenues, marquees comme telles. */}
          {histoOuvert && (
            <View style={styles.histoFond}>
              <View style={styles.histoBarre}>
                <Text style={styles.histoTitre}>DERNIERES ALERTES</Text>
                <TouchableOpacity onPress={chargerHistorique} style={styles.histoAction}>
                  <Text style={styles.histoActionTexte}>{histoChargement ? '...' : 'ACTUALISER'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setHistoOuvert(false)} style={styles.histoAction}>
                  <Text style={styles.histoActionTexte}>FERMER</Text>
                </TouchableOpacity>
              </View>

              {histoListe === null ? (
                <Text style={styles.histoVide}>
                  Historique indisponible : le serveur n a pas repondu.{'\n'}
                  Cela ne veut pas dire qu il n y a eu aucune alerte.
                </Text>
              ) : histoListe.length === 0 ? (
                <Text style={styles.histoVide}>
                  {histoChargement ? 'Chargement...' : 'Aucune alerte enregistree.'}
                </Text>
              ) : (
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
                  {histoListe.map((a) => (
                    <TouchableOpacity
                      key={a.ts}
                      style={styles.histoLigne}
                      activeOpacity={a.photo ? 0.7 : 1}
                      onPress={() => {
                        if (!a.photo) return;
                        setAlertePhoto(a.photo);
                        setAlerteGrande(true);
                      }}
                    >
                      {a.photo ? (
                        <Image source={{ uri: a.photo }} style={styles.histoVignette} resizeMode="cover" />
                      ) : (
                        <View style={[styles.histoVignette, styles.histoSansPhoto]}>
                          <Text style={{ color: '#5E7B87', fontSize: 9 }}>sans{'\n'}photo</Text>
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <View style={styles.histoEnTete}>
                          <Text style={styles.histoHeure}>
                            {new Date(a.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                          </Text>
                          <Text
                            style={[
                              styles.histoBadge,
                              a.categorie === 'personne' && styles.histoBadgePersonne,
                              a.categorie === 'animal' && styles.histoBadgeAnimal,
                            ]}
                          >
                            {a.categorie === 'personne' ? 'PERSONNE' : a.categorie === 'animal' ? 'ANIMAL' : 'RIEN VU'}
                          </Text>
                          {!a.notifiee && <Text style={styles.histoRetenue}>retenue</Text>}
                        </View>
                        <Text style={styles.histoPhrase} numberOfLines={2}>
                          {a.phrase || 'Aucune description.'}
                        </Text>
                        <Text style={styles.histoCapteurs}>
                          {(a.capteurs && a.capteurs.length ? a.capteurs : [a.type]).join(' + ')}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          )}

          {/* === Photo de l'alerte === */}
          {/* Elle passe PAR-DESSUS le direct, volontairement : la photo montre
              ce qui a declenche l'alerte, le flux ne montrera que la suite,
              quelques secondes plus tard — l'intrus a pu sortir du champ.
              C'est aussi le seul endroit ou on la voit : iOS n'affiche pas
              l'image d'une notification sans extension native. */}
          {!!alertePhoto && alerteGrande && (
            <View style={styles.alerteFond}>
              <Text style={styles.alerteTitre}>Photo de l'alerte</Text>
              <Image
                source={{ uri: alertePhoto }}
                style={styles.alerteImage}
                resizeMode="contain"
              />
              <TouchableOpacity
                style={styles.alerteBtn}
                onPress={() => setAlerteGrande(false)}
              >
                <Text style={styles.alerteBtnTexte}>VOIR EN DIRECT</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      <Modal visible={showTutorial} transparent animationType="fade">
        <View style={styles.tutoBackdrop}>
          <View style={styles.tutoCard}>
            <Text style={styles.tutoTitle}>{TUTORIAL_PAGES[tutorialStep].title}</Text>
            <Text style={styles.tutoText}>{TUTORIAL_PAGES[tutorialStep].text}</Text>

            <View style={styles.tutoDotsRow}>
              {TUTORIAL_PAGES.map((_, i) => (
                <View
                  key={i}
                  style={[styles.tutoDot, tutorialStep === i && styles.tutoDotActive]}
                />
              ))}
            </View>

            <View style={styles.tutoActions}>
              <TouchableOpacity
                onPress={handleSkipTutorial}
                style={[styles.primaryBtn, { backgroundColor: '#132029', flex: 1, marginRight: 8 }]}
              >
                <Text style={styles.primaryBtnText}>Passer</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleNextTutorial}
                style={[styles.primaryBtn, { flex: 1 }]}
              >
                <Text style={styles.primaryBtnText}>{isLastStep ? 'Terminer' : 'Suivant'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function PrimaryButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.primaryBtn}>
      <Text style={styles.primaryBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

// Joystick virtuel type jeu video : glisser le pouce = F/B/L/R selon l'angle,
// zone morte au centre et relacher = stop. Traduit en commandes discretes,
// donc 100% compatible avec le sketch Arduino actuel (rien a re-televerser).
// Pad pan-tilt de la camera : 4 fleches (maintien = mouvement continu) +
// bouton central pour recentrer. Si la camera part dans le mauvais sens,
// ajuste PAN_INVERT / TILT_INVERT dans le sketch Arduino (pas ici).
function CamPanTiltPad({
  fullscreen,
  onHoldStart,
  onHoldEnd,
  onCenter,
  view,
  onToggleView,
  showViewToggle = true,
}: {
  fullscreen?: boolean;
  onHoldStart: (dPan: number, dTilt: number) => void;
  onHoldEnd: () => void;
  onCenter: () => void;
  view: 'front' | 'rear';
  onToggleView: () => void;
  showViewToggle?: boolean;
}) {
  const arrow = (label: string, dPan: number, dTilt: number) => (
    <TouchableOpacity
      style={styles.camPtBtn}
      onPressIn={() => onHoldStart(dPan, dTilt)}
      onPressOut={onHoldEnd}
    >
      <Text style={styles.camPtSymbol}>{label}</Text>
    </TouchableOpacity>
  );
  // En plein ecran (paysage), la croix verticale descendait jusque sur le
  // joystick : on la remplace par une barre horizontale compacte, calee sous
  // la barre du haut, qui ne croise aucune commande de pilotage.
  if (fullscreen) {
    return (
      <View style={styles.camPtBarFs}>
        <Text style={styles.camPtTitle}>🎥</Text>
        {arrow('◀', +1, 0)}
        {arrow('▲', 0, +1)}
        {arrow('▼', 0, -1)}
        {arrow('▶', -1, 0)}
        <TouchableOpacity style={[styles.camPtBtn, styles.camPtCenter]} onPress={onCenter}>
          <Text style={styles.camPtSymbol}>◎</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.camPtPad}>
      <Text style={styles.camPtTitle}>🎥</Text>
      {arrow('▲', 0, +1)}
      <View style={styles.camPtRow}>
        {arrow('◀', +1, 0)}
        <TouchableOpacity style={[styles.camPtBtn, styles.camPtCenter]} onPress={onCenter}>
          <Text style={styles.camPtSymbol}>◎</Text>
        </TouchableOpacity>
        {arrow('▶', -1, 0)}
      </View>
      {arrow('▼', 0, -1)}
      {/* Bascule avant/arriere : le libelle indique la vue QUE L'ON VERRA en
          appuyant. Masquee en plein ecran (les 2 cameras sont deja affichees). */}
      {showViewToggle && (
        <TouchableOpacity style={[styles.camPtBtn, styles.camPtView]} onPress={onToggleView}>
          <Text style={styles.camPtViewText}>{view === 'front' ? 'AR' : 'AV'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function DriveJoystick({
  size = 150,
  onCommand,
  onMix,
  onRelease,
}: {
  size?: number;
  onCommand: (cmd: RobotDriveCommand) => void;
  // Quand il est fourni, on pilote en proportionnel (virage en arc possible).
  // Sinon on retombe sur les quatre directions, ce qui garde le composant
  // utilisable avec un firmware qui ne connait pas la commande M.
  onMix?: (g: number, d: number) => void;
  onRelease: () => void;
}) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const lastCmdRef = useRef<RobotDriveCommand | null>(null);
  const lastMixRef = useRef<string | null>(null);
  // Refs pour que le PanResponder (cree une seule fois) appelle toujours
  // la derniere version des callbacks.
  const onCommandRef = useRef(onCommand);
  const onMixRef = useRef(onMix);
  const onReleaseRef = useRef(onRelease);
  onCommandRef.current = onCommand;
  onMixRef.current = onMix;
  onReleaseRef.current = onRelease;

  const knobSize = size * 0.42;
  const maxDist = (size - knobSize) / 2;

  const reset = () => {
    setKnob({ x: 0, y: 0 });
    lastCmdRef.current = null;
    lastMixRef.current = null;
    onReleaseRef.current();
  };

  const panRef = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Ne pas ceder le geste au ScrollView parent pendant le pilotage
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_evt, g) => {
        const dist = Math.hypot(g.dx, g.dy);
        const capped = Math.min(dist, maxDist);
        const angle = Math.atan2(g.dy, g.dx);
        setKnob({ x: Math.cos(angle) * capped, y: Math.sin(angle) * capped });

        const enZoneMorte = dist < maxDist * 0.3;

        if (onMixRef.current) {
          // Melange d'arcade : l'avant fait avancer les deux cotes, le
          // lateral en ralentit un. On normalise pour qu'aucun cote ne
          // depasse 100 %, sinon pousser en diagonale saturerait et le
          // joystick deviendrait tout ou rien dans les coins.
          if (enZoneMorte) {
            if (lastMixRef.current !== null) {
              lastMixRef.current = null;
              onReleaseRef.current();
            }
            return;
          }
          const av = -(Math.sin(angle) * capped) / maxDist;  // y est vers le bas
          const tour = (Math.cos(angle) * capped) / maxDist;
          let g = av + tour;
          let d = av - tour;
          const m = Math.max(1, Math.abs(g), Math.abs(d));
          g = Math.round((g / m) * 100);
          d = Math.round((d / m) * 100);
          const cle = `${g},${d}`;
          if (cle !== lastMixRef.current) {
            lastMixRef.current = cle;
            onMixRef.current(g, d);
          }
          return;
        }

        let cmd: RobotDriveCommand | null = null;
        if (!enZoneMorte) {
          const deg = (angle * 180) / Math.PI; // 0 = droite, -90 = haut
          if (deg >= -135 && deg < -45) cmd = 'F';
          else if (deg >= -45 && deg < 45) cmd = 'R';
          else if (deg >= 45 && deg < 135) cmd = 'B';
          else cmd = 'L';
        }
        if (cmd !== lastCmdRef.current) {
          lastCmdRef.current = cmd;
          if (cmd) onCommandRef.current(cmd);
          else onReleaseRef.current(); // retour en zone morte = stop
        }
      },
      onPanResponderRelease: reset,
      onPanResponderTerminate: reset,
    })
  );

  return (
    <View
      style={[styles.joyBase, { width: size, height: size, borderRadius: size / 2 }]}
      {...panRef.current.panHandlers}
    >
      <Text style={[styles.joyHint, styles.joyHintTop]}>▲</Text>
      <Text style={[styles.joyHint, styles.joyHintBottom]}>▼</Text>
      <Text style={[styles.joyHint, styles.joyHintLeft]}>◀</Text>
      <Text style={[styles.joyHint, styles.joyHintRight]}>▶</Text>
      <View
        style={[
          styles.joyKnob,
          {
            width: knobSize,
            height: knobSize,
            borderRadius: knobSize / 2,
            transform: [{ translateX: knob.x }, { translateY: knob.y }],
          },
        ]}
      />
    </View>
  );
}

// Curseur de vitesse : glisser pour choisir, la valeur est envoyee au relacher.
function SpeedSlider({
  pct,
  onPreview,
  onCommit,
  compact,
}: {
  pct: number;
  onPreview: (p: number) => void;
  onCommit: (p: number) => void;
  compact?: boolean;
}) {
  const widthRef = useRef(1);
  const startPctRef = useRef(pct);
  const lastPctRef = useRef(pct);
  const pctRef = useRef(pct);
  pctRef.current = pct;
  const onPreviewRef = useRef(onPreview);
  const onCommitRef = useRef(onCommit);
  onPreviewRef.current = onPreview;
  onCommitRef.current = onCommit;

  const panRef = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        startPctRef.current = pctRef.current;
        lastPctRef.current = pctRef.current;
      },
      onPanResponderMove: (_evt, g) => {
        const p = Math.max(
          0,
          Math.min(100, startPctRef.current + (g.dx / widthRef.current) * 100)
        );
        lastPctRef.current = p;
        onPreviewRef.current(Math.round(p));
      },
      onPanResponderRelease: () => onCommitRef.current(Math.round(lastPctRef.current)),
      onPanResponderTerminate: () => onCommitRef.current(Math.round(lastPctRef.current)),
    })
  );

  return (
    <View
      style={[styles.speedTrack, compact && styles.speedTrackCompact]}
      onLayout={(e) => {
        widthRef.current = Math.max(1, e.nativeEvent.layout.width);
      }}
      {...panRef.current.panHandlers}
    >
      <View style={[styles.speedFill, { width: `${pct}%` }]} />
      <View style={[styles.speedThumb, { left: `${pct}%` }]} />
    </View>
  );
}

function ExpandButton({ active, onPress }: { active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.expandBtn} onPress={onPress}>
      <Text style={styles.expandBtnText}>{active ? '✕' : '⤢'}</Text>
    </TouchableOpacity>
  );
}

// Temoin de connexion du robot (Pi) : pastille coloree + libelle.
function RobotLinkBadge({
  status,
  detail,
}: {
  status: 'connecting' | 'connected' | 'disconnected';
  detail?: string;
}) {
  const conf = {
    connected: { color: '#00E5A0', label: 'Robot connecté' },
    connecting: { color: '#FFC24D', label: 'Connexion…' },
    disconnected: { color: '#FF5069', label: 'Robot déconnecté' },
  }[status];
  return (
    <View style={styles.linkBadge}>
      <View style={[styles.linkDot, { backgroundColor: conf.color }]} />
      <Text style={[styles.linkBadgeText, { color: conf.color }]}>{conf.label}</Text>
      {status === 'connected' && !!detail && (
        <Text style={styles.linkBadgeDetail}>· {detail}</Text>
      )}
    </View>
  );
}

// --- Theme "HUD tactique" -------------------------------------------------
// Palette unique de l'app. Les valeurs sont aussi ecrites en clair dans les
// styles ci-dessous (React Native n'a pas de variables CSS) ; ce bloc sert de
// reference quand on ajoute un ecran, pour ne pas reintroduire une teinte
// etrangere. Regle de lisibilite : ACCENT et CYAN sont des couleurs CLAIRES —
// tout texte pose dessus doit etre sombre (FOND), jamais blanc.
const HUD = {
  FOND: '#05070A', // fond d'ecran
  PANNEAU: '#0B1016', // cartes
  SURFACE: '#101B24', // elements poses sur une carte
  CHAMP: '#0D151D', // champs de saisie
  LIGNE: 'rgba(0,229,160,0.18)', // filet de separation / contour au repos
  ACCENT: '#00E5A0', // vert phosphore : action, marche, OK
  CYAN: '#22D3EE', // information secondaire
  ALERTE: '#FF3B5C', // arret, danger
  AMBRE: '#FFB020', // avertissement
  TEXTE: '#E8FFF8', // texte principal
  TEXTE_DOUX: '#BCE4D8', // texte courant
  TEXTE_EFFACE: '#7C9C93', // legendes, aides
};
// Chiffres et donnees techniques : chasse fixe, comme un instrument de bord.
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: HUD.FOND },
  innerContainer: { paddingHorizontal: 20, paddingTop: 36, paddingBottom: 20 },
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 32, fontWeight: '900', color: HUD.TEXTE, letterSpacing: 2 },
  emoji: { fontSize: 30, marginLeft: 10 },
  warningText: {
    color: '#7C9C93',
    fontSize: 13,
    textAlign: 'left',
    marginBottom: 16,
    fontStyle: 'italic',
  },
  input: {
    backgroundColor: HUD.CHAMP,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: HUD.LIGNE,
    padding: 16,
    color: '#E8FFF8',
    marginBottom: 14,
    fontSize: 16,
  },
  // Le SEUL aplat plein de l'app : l'action principale doit sauter aux yeux.
  // Texte SOMBRE, le vert phosphore etant une couleur claire.
  primaryBtn: {
    backgroundColor: HUD.ACCENT,
    padding: 16,
    alignItems: 'center',
    borderRadius: 8,
    marginVertical: 8,
    ...Platform.select({
      web: { boxShadow: `0 0 12px ${HUD.ACCENT}80` },
      default: {
        shadowColor: HUD.ACCENT,
        shadowOpacity: 0.5,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 0 },
        elevation: 6,
      },
    }),
  },
  primaryBtnText: {
    color: HUD.FOND,
    fontWeight: '900',
    fontSize: 15,
    letterSpacing: 1.5,
  },
  sectionTitle: {
    color: HUD.TEXTE,
    fontSize: 17,
    fontWeight: '800',
    marginTop: 20,
    marginBottom: 10,
    letterSpacing: 1.6,
  },
  presetContainer: { flexDirection: 'row', flexWrap: 'wrap' },
  messageButton: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: '#132029',
    marginRight: 10,
    marginBottom: 10,
  },
  messageButtonText: { color: '#E8FFF8', fontSize: 14 },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 6,
    padding: 8,
    backgroundColor: '#0D151D',
    borderRadius: 12,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  statusText: { color: '#E8FFF8', fontSize: 16 },
  robotControlCard: {
    backgroundColor: '#0B1016',
    borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(0,229,160,0.18)', 
    padding: 10,
    marginTop: 6,
    marginBottom: 6,
  },
  robotControlHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  robotControlTitle: { color: '#E8FFF8', fontWeight: '800', fontSize: 18 },
  robotControlStatus: { color: '#7C9C93', fontSize: 11, maxWidth: '48%', textAlign: 'right', fontFamily: MONO },
  robotControlRow: { flexDirection: 'row', gap: 10, marginBottom: 6 },
  // Boutons a etat : surface sombre teintee + contour lumineux. C'est le
  // CONTOUR qui porte le code couleur, pas un aplat — le style de texte est
  // partage entre marche et arret, il doit rester lisible sur les deux.
  robotStartBtn: {
    backgroundColor: 'rgba(0,229,160,0.12)',
    borderWidth: 1.5,
    borderColor: HUD.ACCENT,
  },
  robotStopBtn: {
    backgroundColor: 'rgba(255,59,92,0.14)',
    borderWidth: 1.5,
    borderColor: HUD.ALERTE,
  },
  robotActionText: { color: HUD.TEXTE, fontWeight: '900', fontSize: 14, letterSpacing: 1.2 },
  robotSpeedBtn: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    backgroundColor: '#132029',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  robotSpeedSymbol: { color: '#E8FFF8', fontWeight: '900', fontSize: 20, lineHeight: 22 },
  robotSpeedText: { color: '#BCE4D8', fontWeight: '800', fontSize: 12 },
  robotPad: { alignItems: 'center', marginTop: 0 },
  robotPadMiddle: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  robotPadBtn: {
    width: '31%',
    height: 50,
    borderRadius: 10,
    backgroundColor: '#101B24',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  robotPadTop: { width: '60%', marginBottom: 6 },
  robotPadBottom: { width: '60%', marginTop: 6 },
  robotPadStop: { backgroundColor: '#170D14' },
  capCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#0A1218',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#17303B',
    padding: 10,
    marginBottom: 10,
  },
  capDial: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 1.5,
    borderColor: '#1F3C49',
    backgroundColor: '#060D12',
    alignItems: 'center',
    justifyContent: 'center',
  },
  capArrowWrap: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  capArrow: { color: HUD.ACCENT, fontSize: 26, lineHeight: 28, marginTop: -14 },
  capArrowOff: { color: '#33505C' },
  capRefMark: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  capRefTick: { color: '#5E8598', fontSize: 20, lineHeight: 22, marginTop: -18 },
  capInfo: { flex: 1 },
  capTitre: { color: HUD.TEXTE, fontWeight: '800', fontSize: 14 },
  capEcart: { fontWeight: '900', fontSize: 16, letterSpacing: 0.8 },
  capOk: { color: HUD.ACCENT },
  capMoyen: { color: '#FFC46B' },
  capMauvais: { color: HUD.ALERTE },
  capSous: { color: '#8FB3C2', fontSize: 10, marginTop: 3 },
  modeCard: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#1F3C49',
    backgroundColor: '#0A1218',
    alignItems: 'center',
  },
  // Deux couleurs franchement differentes : d'un coup d'oeil, depuis la rue,
  // on doit savoir si la maison est sous surveillance ou non.
  modeBtnNormalOn: { borderColor: HUD.ACCENT, backgroundColor: 'rgba(0,229,160,0.14)' },
  modeBtnAbsentOn: { borderColor: '#FFC46B', backgroundColor: 'rgba(255,196,107,0.16)' },
  modeTexte: { color: '#6E8E9C', fontWeight: '900', fontSize: 14, letterSpacing: 1 },
  modeTexteOn: { color: HUD.TEXTE },
  modeSous: { color: '#8FB3C2', fontSize: 11, marginBottom: 10, marginTop: 2 },
  appelActif: { color: HUD.ACCENT, fontWeight: '700' },
  camPadGroupRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  fsVeilleBandeau: {
    pointerEvents: 'none',
    position: 'absolute',
    top: 96,
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#1F3C49',
    backgroundColor: 'rgba(6,12,16,0.88)',
  },
  fsVeilleTexte: { color: HUD.ACCENT, fontWeight: '900', fontSize: 10.5, letterSpacing: 1.4 },
  fsRoleBandeau: {
    pointerEvents: 'none',
    position: 'absolute',
    bottom: 18,
    alignSelf: 'center',
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#7A5A22',
    backgroundColor: 'rgba(255,196,107,0.16)',
  },
  fsRoleTexte: { color: '#FFC46B', fontWeight: '900', fontSize: 11, letterSpacing: 1.6 },
  histoFond: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(6,12,16,0.97)',
    paddingHorizontal: 14,
    paddingTop: 54,
    paddingBottom: 14,
    zIndex: 40,
  },
  histoBarre: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  histoTitre: { flex: 1, color: HUD.TEXTE, fontWeight: '900', fontSize: 13, letterSpacing: 2 },
  histoAction: {
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 9,
    borderWidth: 1, borderColor: '#1F3C49', backgroundColor: '#0A1218',
  },
  histoActionTexte: { color: '#8FB3C2', fontWeight: '800', fontSize: 10, letterSpacing: 1 },
  histoVide: { color: '#8FB3C2', fontSize: 13, lineHeight: 20, marginTop: 20, textAlign: 'center' },
  histoLigne: {
    flexDirection: 'row', gap: 12, alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#14242C',
  },
  histoVignette: { width: 76, height: 57, borderRadius: 7, backgroundColor: '#0A1218' },
  histoSansPhoto: { alignItems: 'center', justifyContent: 'center' },
  histoEnTete: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  histoHeure: { color: HUD.TEXTE, fontWeight: '800', fontSize: 13 },
  // Trois couleurs franchement distinctes : la categorie doit se lire d'un
  // coup d'oeil, sans relire la phrase.
  histoBadge: {
    color: '#8FB3C2', fontWeight: '900', fontSize: 9, letterSpacing: 1,
    borderWidth: 1, borderColor: '#2A4551', borderRadius: 4,
    paddingHorizontal: 5, paddingVertical: 2,
  },
  histoBadgePersonne: { color: '#FF8A8A', borderColor: '#7A2E2E' },
  histoBadgeAnimal: { color: '#FFC46B', borderColor: '#7A5A22' },
  histoRetenue: { color: '#6E8E9C', fontSize: 10, fontStyle: 'italic' },
  histoPhrase: { color: '#C8DDE5', fontSize: 12, lineHeight: 16 },
  histoCapteurs: { color: '#5E7B87', fontSize: 10, marginTop: 2, letterSpacing: 0.5 },

  // Occupe tout le plein ecran : une alerte n'est pas une vignette.
  alerteFond: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 24,
    zIndex: 50,
  },
  alerteTitre: {
    color: '#FF6B6B',
    fontWeight: '900',
    fontSize: 13,
    letterSpacing: 2,
    marginBottom: 10,
  },
  alerteImage: {
    width: '100%',
    flex: 1,
    borderRadius: 10,
    backgroundColor: '#000',
  },
  alerteBtn: {
    marginTop: 14,
    paddingVertical: 13,
    paddingHorizontal: 30,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: HUD.ACCENT,
    backgroundColor: 'rgba(0,229,160,0.16)',
  },
  alerteBtnTexte: { color: HUD.TEXTE, fontWeight: '900', letterSpacing: 1.5, fontSize: 13 },
  alarmeBtn: {
    backgroundColor: 'rgba(255,196,107,0.10)',
    borderWidth: 1.5,
    borderColor: '#FFC46B',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  // En marche, le bouton devient franchement rouge : d'un coup d'oeil on sait
  // que le robot est en train de hurler quelque part.
  alarmeBtnOn: { backgroundColor: 'rgba(255,59,92,0.22)', borderColor: HUD.ALERTE },
  alarmeTexte: { color: '#FFD9A0', fontWeight: '900', fontSize: 14, letterSpacing: 1 },
  alarmeTexteOn: { color: '#FFE9ED' },
  alarmeSous: { color: '#C79A5E', fontSize: 10, marginTop: 3 },
  fsCap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    height: 34,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#2A4854',
    backgroundColor: 'rgba(6,13,18,0.72)',
  },
  fsCapOk: { borderColor: HUD.ACCENT, backgroundColor: 'rgba(0,229,160,0.16)' },
  fsCapMoyen: { borderColor: '#FFC46B', backgroundColor: 'rgba(255,196,107,0.16)' },
  fsCapMauvais: { borderColor: HUD.ALERTE, backgroundColor: 'rgba(255,59,92,0.18)' },
  // La fleche pivote de l'ECART, pas du cap absolu : en plein ecran on veut
  // lire "de combien il part de travers", pas savoir ou est le nord.
  fsCapFleche: { color: '#E8FFF8', fontSize: 15, lineHeight: 17 },
  fsCapOff: { color: '#44646F' },
  fsCapTexte: { color: '#DDEFF6', fontWeight: '800', fontSize: 12 },
  fsAlarmeOn: { backgroundColor: 'rgba(255,59,92,0.35)', borderColor: HUD.ALERTE, borderWidth: 1.5 },
  fsStopAll: { borderColor: HUD.ALERTE, borderWidth: 1.5 },
  // Le seul bouton plein contour epais de l'ecran : il doit se distinguer du
  // STOP du pad, qui ne coupe que les moteurs.
  arretUrgenceBtn: {
    backgroundColor: 'rgba(255,59,92,0.16)',
    borderWidth: 2,
    borderColor: HUD.ALERTE,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  arretUrgenceText: { color: '#FFE9ED', fontWeight: '900', fontSize: 16, letterSpacing: 1.5 },
  arretUrgenceSub: { color: '#FFB8C4', fontSize: 10, marginTop: 3, letterSpacing: 0.3 },
  robotPadSymbol: { color: '#E8FFF8', fontWeight: '900', fontSize: 20, lineHeight: 22 },
  robotPadText: { color: '#BCE4D8', fontWeight: '800', fontSize: 11 },
  gpsMeta: { color: '#A9D6C9', fontSize: 11, marginTop: 5, fontFamily: MONO },
  robotLogsCard: {
    backgroundColor: '#070B0F',
    borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(0,229,160,0.18)', 
    padding: 14,
    marginTop: 10,
    marginBottom: 6,
    maxHeight: 360,
  },
  robotLogsClearBtn: {
    backgroundColor: '#132029',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  robotLogsClearText: { color: '#E8FFF8', fontSize: 11, fontWeight: '900' },
  robotLogLine: {
    color: '#BCE4D8',
    fontSize: 11,
    lineHeight: 16,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    marginBottom: 4,
  },
  socketStatusContainer: { alignItems: 'center', marginTop: 30, paddingBottom: 20 },
  socketStatusLabel: { color: '#BCE4D8', fontSize: 16 },
  typingIndicator: {
    color: '#7C9C93',
    fontSize: 14,
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: 10,
    height: 20,
  },
  meetCard: { backgroundColor: '#0B1016', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(0,229,160,0.18)',  padding: 14, marginTop: 10 },
  meetTitle: { color: '#E8FFF8', fontWeight: '800', fontSize: 18 },
  meetText: { color: '#BCE4D8', fontSize: 14, marginTop: 6, marginBottom: 12 },
  meetActions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 10 },
  meetBtnCancel: { backgroundColor: '#132029', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10 },
  meetBtnPrimary: { backgroundColor: 'rgba(0,229,160,0.12)', borderWidth: 1.5, borderColor: '#00E5A0', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, marginRight: 8 },
  meetBtnText: { color: '#E8FFF8', fontWeight: '800', fontSize: 13, textAlign: 'center' },

  mapCard: { backgroundColor: '#0B1016', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(0,229,160,0.18)',  padding: 10, marginTop: 6 },
  mapHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  mapTitle: { color: '#E8FFF8', fontWeight: '800', fontSize: 18 },
  expandBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#132029',
    alignItems: 'center',
    justifyContent: 'center',
  },
  expandBtnText: { color: '#E8FFF8', fontSize: 18, fontWeight: '900' },
  map: { width: '100%', height: 150, borderRadius: 10 },

  sayPresetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  sayPresetChip: {
    backgroundColor: '#132029',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    maxWidth: '100%',
  },
  sayPresetText: { color: '#CDEFE4', fontSize: 13, fontWeight: '700' },
  sayBox: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  sayAddBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#132029',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sayAddBtnText: { color: '#E8FFF8', fontSize: 22, fontWeight: '900', lineHeight: 24 },
  sayHint: { color: '#5F7A73', fontSize: 11, marginTop: 6 },
  talkBtn: {
    marginTop: 10,
    minHeight: 54,
    borderRadius: 12,
    backgroundColor: '#132029',
    borderWidth: 2,
    borderColor: '#00E5A0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 12,
  },
  talkBtnActive: {
    backgroundColor: '#4A1620',
    borderColor: '#FF3B5C',
  },
  talkBtnIcon: { fontSize: 22 },
  talkBtnText: { color: '#E8FFF8', fontWeight: '900', fontSize: 13 },
  talkStatus: { color: '#7C9C93', fontSize: 12, marginTop: 6, textAlign: 'center' },
  sayInput: {
    flex: 1,
    backgroundColor: '#101B24',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#E8FFF8',
    fontSize: 14,
  },
  sayBtn: {
    width: 48,
    height: 44,
    borderRadius: 8,
    backgroundColor: 'rgba(0,229,160,0.14)',
    borderWidth: 1,
    borderColor: '#00E5A0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sayBtnText: { fontSize: 20 },
  addrBox: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  addrInput: {
    flex: 1,
    backgroundColor: '#101B24',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#E8FFF8',
    fontSize: 14,
  },
  addrClear: {
    marginLeft: 8,
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#132029',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addrClearText: { color: '#E8FFF8', fontSize: 16, fontWeight: '900' },
  suggestBox: {
    backgroundColor: '#101B24',
    borderRadius: 10,
    marginBottom: 8,
    overflow: 'hidden',
  },
  suggestItem: { paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#16242E' },
  suggestText: { color: '#BCE4D8', fontSize: 13 },
  progressWrap: { marginBottom: 8 },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  progressLabel: { color: '#7C9C93', fontSize: 12, flex: 1, marginRight: 8 },
  progressPct: { color: '#00E5A0', fontWeight: '900', fontSize: 14, fontFamily: MONO },
  progressBarBg: { height: 12, borderRadius: 6, backgroundColor: '#132029', overflow: 'hidden' },
  progressBarFill: { height: 12, borderRadius: 6, backgroundColor: '#00E5A0' },
  progressMeta: { color: '#A9D6C9', fontSize: 11, marginTop: 4, fontFamily: MONO },
  navBtn: { paddingVertical: 12, borderRadius: 10, alignItems: 'center', marginBottom: 8 },
  navGo: { backgroundColor: 'rgba(0,229,160,0.12)', borderWidth: 1.5, borderColor: '#00E5A0' },
  navStop: { backgroundColor: 'rgba(255,59,92,0.14)', borderWidth: 1.5, borderColor: '#FF3B5C' },
  navBtnText: { color: '#E8FFF8', fontWeight: '900', fontSize: 14 },

  rtBtn: {
    marginTop: 10,
    minHeight: 50,
    borderRadius: 8,
    backgroundColor: 'rgba(34,211,238,0.10)',
    borderWidth: 1.5,
    borderColor: HUD.CYAN,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 12,
  },
  // En conversation : bordure d'alerte, comme un enregistrement en cours.
  rtBtnActif: {
    backgroundColor: 'rgba(255,59,92,0.14)',
    borderColor: HUD.ALERTE,
  },
  rtHint: { color: HUD.TEXTE_EFFACE, fontSize: 11, marginTop: 5, textAlign: 'center' },
  // Bouton talkie mis en veille pendant une conversation avec l'IA : visible,
  // pour qu'on comprenne que le micro est ouvert, mais visiblement inactif.
  talkBtnNeutralise: { opacity: 0.45 },
  rondeCard: {
    backgroundColor: '#070B0F',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(34,211,238,0.22)', // cyan : c'est un mode, pas une action ponctuelle
    padding: 10,
    marginTop: 8,
    marginBottom: 4,
  },
  rondeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  rondeTitle: { color: HUD.CYAN, fontWeight: '900', fontSize: 13, letterSpacing: 2 },
  rondeMeta: {
    color: HUD.TEXTE_EFFACE,
    fontSize: 11,
    fontFamily: MONO,
    flexShrink: 1,
    textAlign: 'right',
  },
  rondeHint: { color: HUD.TEXTE_EFFACE, fontSize: 12, marginBottom: 8, fontStyle: 'italic' },
  rondeRow: { flexDirection: 'row', gap: 8 },
  rondeBtn: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  rondeBtnSecondaire: {
    backgroundColor: 'rgba(34,211,238,0.10)',
    borderWidth: 1.5,
    borderColor: HUD.CYAN,
  },
  cameraCard: { backgroundColor: '#0B1016', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(0,229,160,0.18)',  padding: 10, marginTop: 6 },
  cameraBtnRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  cameraToggleBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10 },
  cameraToggleOn: { backgroundColor: 'rgba(255,59,92,0.14)', borderWidth: 1.5, borderColor: '#FF3B5C' },
  cameraToggleOff: { backgroundColor: 'rgba(0,229,160,0.12)', borderWidth: 1.5, borderColor: '#00E5A0' },
  cameraToggleText: { color: '#E8FFF8', fontWeight: '900', fontSize: 13 },
  cameraModeBadge: {
    position: 'absolute',
    left: 10,
    bottom: 8,
    color: 'rgba(232,255,248,0.9)',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
  },
  cameraImage: {
    width: '100%',
    height: 270,
    borderRadius: 10,
    backgroundColor: '#000',
  },
  cameraPlaceholder: {
    width: '100%',
    height: 270,
    borderRadius: 10,
    backgroundColor: '#05070A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Pad de pilotage par-dessus la camera agrandie
  camPadOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  camPadSpeedRow: {
    position: 'absolute',
    top: 10,
    right: 10,
    flexDirection: 'row',
    gap: 10,
  },
  // 40 et non 46 : la barre du haut compte maintenant NEUF boutons. A 46 avec
  // 10 d'ecart, la rangee depassait la largeur d'un telephone en paysage et
  // les boutons se chevauchaient.
  camPadSpeedBtn: {
    // 34 et non 40 : depuis l'ajout de la photo, de l'alarme, de l'arret
    // d'urgence et de l'extinction camera, la rangee ne tenait plus sur une
    // ligne et debordait sur les commandes pan-tilt.
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(5,12,16,0.62)',
    borderWidth: 1,
    borderColor: 'rgba(0,229,160,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  camPadBottomRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  camPadGroupCol: { gap: 12, alignItems: 'center' },
  // Camera plein ecran
  fsRoot: { flex: 1, backgroundColor: '#000' },
  fsHidden: { display: 'none' },
  fsSonarBtn: { width: 'auto', paddingHorizontal: 10 },
  fsSonarLabel: { color: HUD.TEXTE, fontSize: 12, fontWeight: '800' },
  fsImage: { ...StyleSheet.absoluteFillObject },
  fsWait: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  fsTopRow: {
    pointerEvents: 'box-none',
    position: 'absolute',
    top: 46,
    left: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // flexShrink + flexWrap : sur un ecran etroit, la rangee passe a la ligne
  // au lieu de deborder et de faire se chevaucher les boutons.
  fsSpeedGroup: { flexDirection: 'row', gap: 5, flexShrink: 1, flexWrap: 'wrap' },
  fsAudioOn: { backgroundColor: 'rgba(255,59,92,0.7)', borderColor: 'rgba(255,90,110,0.6)' },
  fsZoomText: { color: '#E8FFF8', fontWeight: '900', fontSize: 12 },
  fsBottomRow: {
    pointerEvents: 'box-none',
    position: 'absolute',
    bottom: 28,
    left: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  // Temoin de connexion du robot
  linkBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  linkDot: { width: 10, height: 10, borderRadius: 5 },
  linkBadgeText: { fontSize: 12, fontWeight: '800' },
  linkBadgeDetail: { fontSize: 10, color: '#22D3EE', fontWeight: '600', fontFamily: MONO },
  // Curseur de vitesse
  speedRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  speedEmoji: { fontSize: 16 },
  speedTrack: {
    flex: 1,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#101B24',
    justifyContent: 'center',
  },
  speedTrackCompact: {
    flex: 0,
    width: 130,
    backgroundColor: 'rgba(5,12,16,0.62)',
    borderWidth: 1,
    borderColor: 'rgba(0,229,160,0.28)',
  },
  speedFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 15,
    backgroundColor: 'rgba(0,229,160,0.45)',
  },
  speedThumb: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    marginLeft: -11,
    backgroundColor: '#D6F6EC',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.35)',
  },
  speedPctText: { color: '#00E5A0', fontWeight: '800', minWidth: 42, textAlign: 'right', fontFamily: MONO },
  speedPctTextLight: { color: '#E8FFF8', fontWeight: '800', minWidth: 42, textAlign: 'right' },
  // Joystick virtuel
  joyRow: { alignItems: 'center', marginTop: 14 },
  joyBase: {
    backgroundColor: 'rgba(8,18,24,0.66)',
    borderWidth: 1,
    borderColor: 'rgba(0,229,160,0.24)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  joyKnob: {
    backgroundColor: 'rgba(20,44,52,0.92)',
    borderWidth: 2,
    borderColor: 'rgba(0,229,160,0.45)',
  },
  joyHint: {
    position: 'absolute',
    color: 'rgba(0,229,160,0.45)',
    fontSize: 12,
    fontWeight: '900',
  },
  joyHintTop: { top: 6, left: 0, right: 0, textAlign: 'center' },
  joyHintBottom: { bottom: 6, left: 0, right: 0, textAlign: 'center' },
  joyHintLeft: { left: 8, top: '50%', marginTop: -8 },
  joyHintRight: { right: 8, top: '50%', marginTop: -8 },
  camPadBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(5,12,16,0.62)',
    borderWidth: 1,
    borderColor: 'rgba(0,229,160,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  camPadStop: {
    backgroundColor: 'rgba(90,16,32,0.62)',
    borderColor: 'rgba(255,59,92,0.5)',
    alignSelf: 'flex-end',
    marginBottom: 0,
  },
  camPadSymbol: { color: '#E8FFF8', fontWeight: '900', fontSize: 22, lineHeight: 24 },
  // Pad pan-tilt camera (surimpression en haut a gauche de l'image)
  camPtPad: {
    pointerEvents: 'box-none',
    position: 'absolute',
    top: 8,
    left: 8,
    alignItems: 'center',
    gap: 5,
  },
  // En plein ecran : barre horizontale sous la barre du haut (✕ / son / zoom).
  // Horizontale et non plus en colonne : en paysage la colonne descendait
  // jusque sur le joystick de pilotage.
  camPtBarFs: {
    pointerEvents: 'box-none',
    position: 'absolute',
    // 130 : laisse la place a une rangee du haut sur DEUX lignes. Le
    // chevauchement observe le 24/09 venait de cette marge trop courte.
    top: 130,
    left: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  camPtRow: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  camPtBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(5,12,16,0.62)',
    borderWidth: 1,
    borderColor: 'rgba(0,229,160,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  camPtCenter: {
    backgroundColor: 'rgba(34,211,238,0.45)',
    borderColor: 'rgba(34,211,238,0.5)',
  },
  // Bouton bascule avant/arriere (vert pour le distinguer du recentrage bleu)
  camPtView: {
    backgroundColor: 'rgba(0,229,160,0.42)',
    borderColor: 'rgba(0,229,160,0.55)',
  },
  camPtViewText: { color: '#E8FFF8', fontWeight: '900', fontSize: 13, lineHeight: 15 },
  camPtSymbol: { color: '#E8FFF8', fontWeight: '900', fontSize: 17, lineHeight: 19 },
  camPtTitle: { fontSize: 13 },
  recordRow: { alignItems: 'center', marginTop: 10 },
  recordBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 4,
    borderColor: '#E8FFF8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordInner: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#FF3B5C' },
  recordInnerActive: { width: 26, height: 26, borderRadius: 6, backgroundColor: '#8E1526' },
  recordHint: { color: '#7C9C93', fontSize: 12, marginTop: 6 },

  // Onboarding modal
  tutoBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  tutoCard: { backgroundColor: '#080E13', borderRadius: 16, padding: 18, width: '100%' },
  tutoTitle: { color: '#E8FFF8', fontSize: 20, fontWeight: '800', marginBottom: 8 },
  tutoText: { color: '#BCE4D8', fontSize: 15, lineHeight: 20, marginBottom: 14 },
  tutoActions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  tutoDotsRow: { flexDirection: 'row', alignSelf: 'center', marginBottom: 12 },
  tutoDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1E323C', marginHorizontal: 4 },
  tutoDotActive: { backgroundColor: '#00E5A0' },
});
