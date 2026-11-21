import React, { useEffect } from 'react';
import io, { Socket } from 'socket.io-client';
import { ORIGINE_SERVEUR, SOCKET_PATH, webrtc, STRONG_VIBRATION_PATTERN } from './config';
import type { SonarSnapshot } from '@/components/SonarMapView';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLastSeen, ensureExpoPushToken, raisonJetonAbsent, setLastSeenNow } from './notifications';
import { Platform, Vibration, Alert, AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { ROBOT_ACK_BUZZ_PREFIX, ROBOT_DRIVE_BUZZ_PREFIX, ROBOT_CAM_BUZZ_PREFIX, ROBOT_ONLINE_BUZZ_PREFIX } from './presets';
import type { PendingRobotCommand, RobotStatus, Coord } from './types';
import { bytesToBase64 } from './talkieConfig';
import { rangerVideoDansGalerie } from './gallery';
import { loadNativeMaps } from '@/components/nativeMaps';

type RobotSocketOptions = {
  socketRef: React.RefObject<Socket | null>;
  pushRobotLog: (text: string) => void;
  pairCodeRef: React.RefObject<string>;
  setSonarSnapshot: React.Dispatch<React.SetStateAction<SonarSnapshot | null>>;
  pseudoRef: React.RefObject<string>;
  setSocketOnline: React.Dispatch<React.SetStateAction<boolean>>;
  suppressHistoryUntilRef: React.RefObject<number>;
  firstSyncDoneRef: React.RefObject<boolean>;
  setPairedWith: React.Dispatch<React.SetStateAction<string>>;
  setMeetRequestFrom: React.Dispatch<React.SetStateAction<string | null>>;
  setMeetStatus: React.Dispatch<React.SetStateAction<"pending" | "accepted" | null>>;
  setPeerCoord: React.Dispatch<React.SetStateAction<Coord | null>>;
  canNotifyRef: React.RefObject<boolean>;
  pendingRobotCmdRef: React.RefObject<PendingRobotCommand | null>;
  setRobotCommandStatus: React.Dispatch<React.SetStateAction<string>>;
  robotLastSeenAtRef: React.RefObject<number>;
  setRobotHeartbeat: React.Dispatch<React.SetStateAction<string>>;
  setRtEveille: React.Dispatch<React.SetStateAction<boolean>>;
  setRtPhrase: React.Dispatch<React.SetStateAction<string>>;
  setRole: React.Dispatch<React.SetStateAction<"pilote" | "spectateur" | "attente" | null>>;
  setAlertePhoto: React.Dispatch<React.SetStateAction<string | null>>;
  urlPhotoAlerte: (code: string) => string;
  setAlerteGrande: React.Dispatch<React.SetStateAction<boolean>>;
  setAlarmeOn: React.Dispatch<React.SetStateAction<boolean>>;
  setAppelAlerte: React.Dispatch<React.SetStateAction<{ actif: boolean; configure: boolean; } | null>>;
  setModeAbsent: React.Dispatch<React.SetStateAction<boolean>>;
  setRobotStatus: React.Dispatch<React.SetStateAction<RobotStatus | null>>;
  capRefAttenduRef: React.RefObject<boolean>;
  setCapRef: React.Dispatch<React.SetStateAction<number | null>>;
  robotHoldTimerRef: React.RefObject<ReturnType<typeof setInterval> | null>;
  lastFrameAtRef: React.RefObject<number>;
  setFrameUri: React.Dispatch<React.SetStateAction<string | null>>;
  setNavActive: React.Dispatch<React.SetStateAction<boolean>>;
  setRonde: React.Dispatch<React.SetStateAction<{ apprentissage: boolean; enCours: boolean; points: number; longueurM: number; toursFaits: number; prochainDansS: number; } | null>>;
  setRtActif: React.Dispatch<React.SetStateAction<boolean>>;
  setRecActif: React.Dispatch<React.SetStateAction<boolean>>;
  setRecInfo: React.Dispatch<React.SetStateAction<string>>;
  setRecHdActif: React.Dispatch<React.SetStateAction<boolean>>;
  setRecHdInfo: React.Dispatch<React.SetStateAction<string>>;
  setIsTyping: React.Dispatch<React.SetStateAction<boolean>>;
  shareMyLocationOnce: () => Promise<Coord | null>;
  setMaps: React.Dispatch<React.SetStateAction<typeof import("/home/tmendy/Projects/hack1robot/mobile/node_modules/react-native-maps/lib/index") | null>>;
  typingTimeoutRef: React.RefObject<number | null>;
};

export function useRobotSocket({
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
}: RobotSocketOptions) {
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
      const wasDriving = robotHoldTimerRef.current !== null || pendingRobotCmdRef.current !== null;
      if (robotHoldTimerRef.current !== null) {
        clearInterval(robotHoldTimerRef.current);
        robotHoldTimerRef.current = null;
      }
      pendingRobotCmdRef.current = null;
      if (wasDriving) {
        setRobotCommandStatus('Pilotage interrompu : connexion au serveur perdue');
      }
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

    s.on('robot_drive_confirmation', (payload: { ok?: boolean; id?: string }) => {
      const pending = pendingRobotCmdRef.current;
      if (!pending || pending.id !== payload?.id || !payload.ok) return;
      pushRobotLog(`robot_drive_confirmation ${JSON.stringify(payload)}`);
      setRobotCommandStatus(`${pending.label} : ordre relayé, attente du retour robot`);
    });

    s.on('robot_drive_status', (payload: { ok?: boolean; message?: string; id?: string }) => {
      const pending = pendingRobotCmdRef.current;
      if (!pending || pending.id !== payload?.id) return;
      pushRobotLog(`robot_drive_status ${JSON.stringify(payload)}`);
      pendingRobotCmdRef.current = null;
      setRobotCommandStatus(
        payload.ok ? `Robot OK : ${pending.label}` : `Erreur robot : ${payload.message || pending.label}`
      );
    });

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
  }, [
    canNotifyRef,
    capRefAttenduRef,
    firstSyncDoneRef,
    lastFrameAtRef,
    pairCodeRef,
    pendingRobotCmdRef,
    pseudoRef,
    pushRobotLog,
    robotHoldTimerRef,
    robotLastSeenAtRef,
    setAlarmeOn,
    setAlerteGrande,
    setAlertePhoto,
    setAppelAlerte,
    setCapRef,
    setFrameUri,
    setIsTyping,
    setMaps,
    setMeetRequestFrom,
    setMeetStatus,
    setModeAbsent,
    setNavActive,
    setPairedWith,
    setPeerCoord,
    setRecActif,
    setRecHdActif,
    setRecHdInfo,
    setRecInfo,
    setRobotCommandStatus,
    setRobotHeartbeat,
    setRobotStatus,
    setRole,
    setRonde,
    setRtActif,
    setRtEveille,
    setRtPhrase,
    setSocketOnline,
    setSonarSnapshot,
    shareMyLocationOnce,
    socketRef,
    suppressHistoryUntilRef,
    typingTimeoutRef,
    urlPhotoAlerte,
  ]);
}
