import { inCall, webrtc } from './config';
import { setAudioModeAsync, AudioModule, useAudioRecorder } from 'expo-audio';
import { TALKIE_MIN_STOP_DELAY_MS, TALKIE_MIN_BYTES, TALKIE_MAX_BYTES, TALKIE_MAX_DURATION_MS, TALKIE_RECORDING_OPTIONS } from './talkieConfig';
import * as FileSystem from 'expo-file-system';
import { Alert, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import React, { useRef, useCallback, useState } from 'react';
import { Socket } from 'socket.io-client';

type TalkieOptions = {
  listening: boolean;
  rtcAudioTrackRef: React.RefObject<any>;
  pushRobotLog: (text: string) => void;
  pairCodeRef: React.RefObject<string>;
  socketRef: React.RefObject<Socket | null>;
  pseudoRef: React.RefObject<string>;
  pairedWith: string;
};

export function useTalkie({
  listening,
  rtcAudioTrackRef,
  pushRobotLog,
  pairCodeRef,
  socketRef,
  pseudoRef,
  pairedWith,
}: TalkieOptions) {
  // Talkie-walkie : maintenir le bouton = enregistrer, relacher = envoyer.
  // AAC mono explicite : plus stable qu'un preset stereo et moins lourd sur le lien 4G.
  const voiceRecorder = useAudioRecorder(TALKIE_RECORDING_OPTIONS);
  const [talking, setTalking] = useState(false);
  const [, setTalkStatus] = useState('');
  const talkSessionRef = useRef(0);
  const talkStartingRef = useRef(false);
  const talkRecordingRef = useRef(false);
  const talkStopRequestedRef = useRef(false);
  const talkFinishingRef = useRef(false);
  const talkStartedAtRef = useRef(0);
  const talkAutoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [pairCodeRef, socketRef]);

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
  }, [pairedWith, stopTalkLive, pairCodeRef, pseudoRef, socketRef]);

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

  return { talking, startTalkLive, stopTalkLive, toggleTalk };
}
