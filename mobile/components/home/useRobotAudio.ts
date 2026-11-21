import React, { useState, useRef, useEffect } from 'react';
import { webrtc, inCall } from './config';
import { useAudioPlayer } from 'expo-audio';
import { Socket } from 'socket.io-client';

type RobotAudioOptions = {
  talking: boolean;
  listening: boolean;
  pairedWith: string;
  socketOnline: boolean;
  pairCodeRef: React.RefObject<string>;
  setRtcAudioLive: React.Dispatch<React.SetStateAction<boolean>>;
  rtcAudioTrackRef: React.RefObject<any>;
  socketRef: React.RefObject<Socket | null>;
  hautParleur: boolean;
  rtcAudioLive: boolean;
  mp3Secours: boolean;
  audioPlayer: ReturnType<typeof useAudioPlayer>;
};

export function useRobotAudio({
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
}: RobotAudioOptions) {
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
  }, [
    listening,
    pairedWith,
    socketOnline,
    ecouteTick,
    pairCodeRef,
    rtcAudioTrackRef,
    setRtcAudioLive,
    socketRef,
  ]);

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
    const requestAudio = (on: boolean) => socketRef.current?.emit('robot_audio', { code, on });
    requestAudio(true);
    const timer = setInterval(() => requestAudio(true), 3000);
    return () => {
      clearInterval(timer);
      requestAudio(false);
    };
  }, [listening, pairedWith, socketOnline, pairCodeRef, socketRef]);

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
}
