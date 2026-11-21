import React, { useEffect } from 'react';
import { webrtc } from './config';
import { Socket } from 'socket.io-client';

type CameraStreamOptions = {
  cameraOn: boolean;
  pairedWith: string;
  socketOnline: boolean;
  pairCodeRef: React.RefObject<string>;
  socketRef: React.RefObject<Socket | null>;
  setFrameUri: React.Dispatch<React.SetStateAction<string | null>>;
  rtcSessionRef: React.RefObject<number>;
  rtcPcRef: React.RefObject<any>;
  rtcResourceRef: React.RefObject<string | null>;
  setRtcStreamUrl: React.Dispatch<React.SetStateAction<string | null>>;
  rtcRetryRef: React.RefObject<number | null>;
};

export function useCameraStream({
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
}: CameraStreamOptions) {
  // Camera robot : demander le flux tant que la vue est ouverte (keepalive 3s),
  // et l'arreter proprement en quittant (le Pi coupe alors la webcam).
  useEffect(() => {
    if (!cameraOn || !pairedWith || !socketOnline) return;
    const code = pairCodeRef.current?.trim();
    if (!code) return;
    const requestCamera = (on: boolean) => socketRef.current?.emit('robot_camera', { code, on });
    requestCamera(true);
    const timer = setInterval(() => requestCamera(true), 3000);
    return () => {
      clearInterval(timer);
      requestCamera(false);
      setFrameUri(null);
    };
  }, [cameraOn, pairedWith, socketOnline, pairCodeRef, setFrameUri, socketRef]);

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
    const requestVideo = (on: boolean) => socketRef.current?.emit('robot_rtc', { code, on });
    const pingTimer = setInterval(() => {
      const pc = rtcPcRef.current;
      if (pc && pc.connectionState === 'connected') {
        requestVideo(true);
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
      requestVideo(false);
    };
  }, [
    cameraOn,
    pairedWith,
    socketOnline,
    pairCodeRef,
    rtcPcRef,
    rtcResourceRef,
    rtcRetryRef,
    rtcSessionRef,
    setRtcStreamUrl,
    socketRef,
  ]);
}
