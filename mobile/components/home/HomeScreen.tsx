import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { SonarSnapshot } from '@/components/SonarMapView';
import type { RobotStatus, Coord, AlerteHisto, VideoServeur, PendingRobotCommand, NotifStatus, Mode } from './types';
import { AUDIO_STREAM_BASE, SOCKET_URL, keepAwake } from './config';
import { PanResponder, Dimensions, useWindowDimensions, Alert, AppState, Platform, ActionSheetIOS, ScrollView, View, Text } from 'react-native';
import * as Haptics from 'expo-haptics';
import { DEFAULT_SAY_PRESETS, ROBOT_DEBUG_LOGS, ONBOARD_KEY, SAY_PRESETS_KEY } from './presets';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { loadNativeMaps } from '@/components/nativeMaps';
import { Socket } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { setLastSeenNow, getLastSeen, ensureExpoPushToken } from './notifications';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { openExternalNavigation } from './navigation';
import { styles } from './styles';
import { PrimaryButton } from './controls';
import { useBoot } from './useBoot';
import { useRobotSocket } from './useRobotSocket';
import { useAlertNotifications } from './useAlertNotifications';
import { useTalkie } from './useTalkie';
import { useDriveControls } from './useDriveControls';
import { useCameraStream } from './useCameraStream';
import { useRobotAudio } from './useRobotAudio';
import { useRobotNavigation } from './useRobotNavigation';
import { PairingForm } from './PairingForm';
import { SurveillanceControls } from './SurveillanceControls';
import { CameraPanel } from './CameraPanel';
import { AlarmButton } from './AlarmButton';
import { RobotMapPanel } from './RobotMapPanel';
import { CameraModal } from './CameraModal';
import { TutorialModal } from './TutorialModal';

const urlPhotoAlerte = (code: string) =>
  `${AUDIO_STREAM_BASE}/alerte-photo?code=${encodeURIComponent(code)}&t=${Date.now()}`;

const pushRobotLog = (text: string) => {
  if (!ROBOT_DEBUG_LOGS) return;
  console.log(`[PING][ROBOT][APP] ${new Date().toLocaleTimeString()} ${text}`);
};

export default function HomeScreen() {
  const [pseudo, setPseudo] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [customMessage, setCustomMessage] = useState('');
  const [socketOnline, setSocketOnline] = useState(false);
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


  const [sayInput, setSayInput] = useState('');
  const [sayPresets, setSayPresets] = useState<string[]>(DEFAULT_SAY_PRESETS);



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
  const pendingRobotCmdRef = useRef<PendingRobotCommand | null>(null);
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

  const shareMyLocationOnce = useCallback(async () => {
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
  }, []);

  useBoot({
    setPseudo,
    setPairCode,
    setShowTutorial,
    setMyCoord,
    setNotifStatus,
    canNotifyRef,
  });

  useRobotSocket({
    socketRef,
    pushRobotLog,
    pairCodeRef,
    setSonarSnapshot,
    pseudoRef,
    setSocketOnline,
    suppressHistoryUntilRef,
    firstSyncDoneRef,
    setPairedWith,
    setMeetRequestFrom,
    setMeetStatus,
    setPeerCoord,
    canNotifyRef,
    pendingRobotCmdRef,
    setRobotCommandStatus,
    robotLastSeenAtRef,
    setRobotHeartbeat,
    setRtEveille,
    setRtPhrase,
    setRole,
    setAlertePhoto,
    urlPhotoAlerte,
    setAlerteGrande,
    setAlarmeOn,
    setAppelAlerte,
    setModeAbsent,
    setRobotStatus,
    capRefAttenduRef,
    setCapRef,
    robotHoldTimerRef,
    lastFrameAtRef,
    setFrameUri,
    setNavActive,
    setRonde,
    setRtActif,
    setRecActif,
    setRecInfo,
    setRecHdActif,
    setRecHdInfo,
    setIsTyping,
    shareMyLocationOnce,
    setMaps,
    typingTimeoutRef,
  });

  useAlertNotifications({
    pushRobotLog,
    robotLastSeenAtRef,
    setRobotHeartbeat,
    setCameraOn,
    setCamFullscreen,
    setListening,
    setHautParleur,
    pairCodeRef,
    setAlertePhoto,
    urlPhotoAlerte,
    setAlerteGrande,
    pseudoRef,
    socketRef,
  });

  // ========================
  // Actions (dans le composant pour accéder aux refs)
  // ========================
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

  const { talking, startTalkLive, stopTalkLive, toggleTalk } = useTalkie({
    listening,
    rtcAudioTrackRef,
    pushRobotLog,
    pairCodeRef,
    socketRef,
    pseudoRef,
    pairedWith,
  });

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

  const {
    sendRobotSpeed,
    startCamHold,
    stopCamHold,
    centerCam,
    camView,
    toggleCamView,
    startRobotDriveHold,
    stopRobotDriveHold,
  } = useDriveControls({
    pairCodeRef,
    socketRef,
    pairedWith,
    pushRobotLog,
    navActive,
    setNavActive,
    pendingRobotCmdRef,
    setRobotCommandStatus,
    isLandscape,
    camFullscreen,
    setCameraOn,
    setCamFullscreen,
    robotStatus,
    setCapRef,
    capRefAttenduRef,
    robotHoldTimerRef,
  });

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

  useCameraStream({
    cameraOn,
    pairedWith,
    socketOnline,
    pairCodeRef,
    socketRef,
    setFrameUri,
    rtcSessionRef,
    rtcPcRef,
    rtcResourceRef,
    setRtcStreamUrl,
    rtcRetryRef,
  });

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

  useRobotAudio({
    talking,
    listening,
    pairedWith,
    socketOnline,
    pairCodeRef,
    setRtcAudioLive,
    rtcAudioTrackRef,
    socketRef,
    hautParleur,
    rtcAudioLive,
    mp3Secours,
    audioPlayer,
  });

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

  const {
    robotCoord,
    robotRegion,
    destInput,
    setDestInput,
    destSuggestions,
    setDestSuggestions,
    destination,
    setDestination,
    setDestStartDist,
    routeCoords,
    selectDestination,
    startNav,
    stopNav,
    clearDestination,
    remainingDist,
    progressPct,
  } = useRobotNavigation({
    robotStatus,
    peerCoord,
    pairCodeRef,
    socketRef,
    setNavActive,
    navActive,
  });
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
  const arretUrgence = () => {
    if (robotHoldTimerRef.current) {
      clearInterval(robotHoldTimerRef.current);
      robotHoldTimerRef.current = null;
    }
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
    stopRobotDriveHold();
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

        <PairingForm
          pairedWith={pairedWith}
          pseudo={pseudo}
          setPseudo={setPseudo}
          pairCode={pairCode}
          setPairCode={setPairCode}
          notifStatus={notifStatus}
          socketRef={socketRef}
          pairCodeRef={pairCodeRef}
          pseudoRef={pseudoRef}
          setNotifStatus={setNotifStatus}
          canNotifyRef={canNotifyRef}
          onPair={onPair}
        />

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

        <SurveillanceControls
          pairedWith={pairedWith}
          modeAbsent={modeAbsent}
          definirMode={definirMode}
          appelAlerte={appelAlerte}
          basculerAppelAlerte={basculerAppelAlerte}
        />

        <CameraPanel
          pairedWith={pairedWith}
          expanded={expanded}
          setCameraOn={setCameraOn}
          setCamFullscreen={setCamFullscreen}
          cameraOn={cameraOn}
          rtcStreamUrl={rtcStreamUrl}
          camH={camH}
          frameUri={frameUri}
        />

        <AlarmButton
          pairedWith={pairedWith}
          alarmeOn={alarmeOn}
          basculerAlarme={basculerAlarme}
        />

        <RobotMapPanel
          pairedWith={pairedWith}
          expanded={expanded}
          toggleExpand={toggleExpand}
          destInput={destInput}
          setDestInput={setDestInput}
          destination={destination}
          setDestination={setDestination}
          setDestStartDist={setDestStartDist}
          clearDestination={clearDestination}
          destSuggestions={destSuggestions}
          selectDestination={selectDestination}
          progressPct={progressPct}
          remainingDist={remainingDist}
          navActive={navActive}
          stopNav={stopNav}
          startNav={startNav}
          ronde={ronde}
          envoyerRonde={envoyerRonde}
          robotCoord={robotCoord}
          maps={maps}
          robotMapRef={robotMapRef}
          mapH={mapH}
          robotRegion={robotRegion}
          myCoord={myCoord}
          setDestSuggestions={setDestSuggestions}
          routeCoords={routeCoords}
        />

        {!!pairedWith && (
          <PrimaryButton label="SE DÉCONNECTER" onPress={onUnpair} />
        )}
      </View>

      <CameraModal
        key={pairCode.trim()}
        camFullscreen={camFullscreen}
        isLandscape={isLandscape}
        cameraOn={cameraOn}
        gps={{ maps, robotCoord, robotRegion, myCoord, destination, routeCoords }}
        stopHeldDrive={() => { if (robotHoldTimerRef.current) stopRobotDriveHold(); }}
        setCamFullscreen={setCamFullscreen}
        socketOnline={socketOnline}
        sonarSnapshot={sonarSnapshot}
        pairCode={pairCode}
        pinchResponder={pinchResponder}
        rtcStreamUrl={rtcStreamUrl}
        camZoom={camZoom}
        frameUri={frameUri}
        socketRef={socketRef}
        listening={listening}
        setListening={setListening}
        askingVoice={askingVoice}
        askRobotVoice={askRobotVoice}
        talking={talking}
        stopTalkLive={stopTalkLive}
        startTalkLive={startTalkLive}
        toggleTalk={toggleTalk}
        rtActif={rtActif}
        basculerRt={basculerRt}
        recActif={recActif}
        basculerRec={basculerRec}
        bumpZoom={bumpZoom}
        setCamZoom={setCamZoom}
        videosOuvert={videosOuvert}
        setVideosOuvert={setVideosOuvert}
        chargerVideos={chargerVideos}
        histoOuvert={histoOuvert}
        setHistoOuvert={setHistoOuvert}
        chargerHistorique={chargerHistorique}
        alertePhoto={alertePhoto}
        setAlerteGrande={setAlerteGrande}
        savePhoto={savePhoto}
        savingPhoto={savingPhoto}
        alarmeOn={alarmeOn}
        basculerAlarme={basculerAlarme}
        arretUrgence={arretUrgence}
        hautParleur={hautParleur}
        setHautParleur={setHautParleur}
        setCameraOn={setCameraOn}
        ecartCap={ecartCap}
        capActuel={capActuel}
        robotLink={robotLink}
        speedPct={speedPct}
        setSpeedPct={setSpeedPct}
        sendRobotSpeed={sendRobotSpeed}
        startCamHold={startCamHold}
        stopCamHold={stopCamHold}
        centerCam={centerCam}
        camView={camView}
        toggleCamView={toggleCamView}
        rtEveille={rtEveille}
        rtPhrase={rtPhrase}
        estPilote={estPilote}
        role={role}
        startRobotDriveHold={startRobotDriveHold}
        stopRobotDriveHold={stopRobotDriveHold}
        robotCommandStatus={robotCommandStatus}
        videosChargement={videosChargement}
        videosListe={videosListe}
        histoChargement={histoChargement}
        histoListe={histoListe}
        setAlertePhoto={setAlertePhoto}
        alerteGrande={alerteGrande}
      />

      <TutorialModal
        showTutorial={showTutorial}
        TUTORIAL_PAGES={TUTORIAL_PAGES}
        tutorialStep={tutorialStep}
        handleSkipTutorial={handleSkipTutorial}
        handleNextTutorial={handleNextTutorial}
        isLastStep={isLastStep}
      />
    </ScrollView>
  );
}
