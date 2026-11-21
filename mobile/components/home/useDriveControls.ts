import React, { useRef, useState, useEffect, useCallback } from 'react';
import type { RobotDriveCommand, RobotStatus } from './types';
import { Alert } from 'react-native';
import { ROBOT_DRIVE_BUZZ_PREFIX, ROBOT_DRIVE_LABELS, ROBOT_CAM_BUZZ_PREFIX, CAM_STEP_DEG } from './presets';
import { SOCKET_URL } from './config';
import { setLastSeenNow } from './notifications';
import { Socket } from 'socket.io-client';

type DriveControlsOptions = {
  pairCodeRef: React.RefObject<string>;
  socketRef: React.RefObject<Socket | null>;
  pairedWith: string;
  pushRobotLog: (text: string) => void;
  navActive: boolean;
  setNavActive: React.Dispatch<React.SetStateAction<boolean>>;
  pendingRobotCmdRef: React.RefObject<{ id: string; cmd: RobotDriveCommand; } | null>;
  pseudoRef: React.RefObject<string>;
  setRobotCommandStatus: React.Dispatch<React.SetStateAction<string>>;
  isLandscape: boolean;
  camFullscreen: boolean;
  setCameraOn: React.Dispatch<React.SetStateAction<boolean>>;
  setCamFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
  robotStatus: RobotStatus | null;
  setCapRef: React.Dispatch<React.SetStateAction<number | null>>;
  capRefAttenduRef: React.RefObject<boolean>;
  robotHoldTimerRef: React.RefObject<number | null>;
};

export function useDriveControls({
  pairCodeRef,
  socketRef,
  pairedWith,
  pushRobotLog,
  navActive,
  setNavActive,
  pendingRobotCmdRef,
  pseudoRef,
  setRobotCommandStatus,
  isLandscape,
  camFullscreen,
  setCameraOn,
  setCamFullscreen,
  robotStatus,
  setCapRef,
  capRefAttenduRef,
  robotHoldTimerRef,
}: DriveControlsOptions) {
  // Pan-tilt camera : angles courants cote app (le robot recoit des angles
  // absolus, donc pas grave si un message se perd). 90/90 = camera centree.
  const camPanRef = useRef(90);
  const camTiltRef = useRef(90);
  const camHoldTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendRobotDrive = useCallback(async (cmd: RobotDriveCommand) => {
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
  }, [
    navActive,
    pairCodeRef,
    pairedWith,
    pendingRobotCmdRef,
    pseudoRef,
    pushRobotLog,
    setNavActive,
    setRobotCommandStatus,
    socketRef,
  ]);

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

  const stopCamHold = useCallback(() => {
    if (camHoldTimerRef.current) {
      clearInterval(camHoldTimerRef.current);
      camHoldTimerRef.current = null;
    }
  }, []);

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

  const stopRobotDriveHold = useCallback(() => {
    if (robotHoldTimerRef.current) {
      clearInterval(robotHoldTimerRef.current);
      robotHoldTimerRef.current = null;
    }
    // Envoi du STOP en triple : si un paquet se perd (freeze/reseau), le robot
    // s'arrete quand meme. Le safe-stop 900ms de l'Arduino reste le dernier filet.
    void sendRobotDrive('S');
    setTimeout(() => void sendRobotDrive('S'), 120);
    setTimeout(() => void sendRobotDrive('S'), 300);
  }, [robotHoldTimerRef, sendRobotDrive]);

  // Keep the pilot open when switching back to portrait.
  const prevLandscapeRef = useRef(false);
  useEffect(() => {
    if (isLandscape === prevLandscapeRef.current) return;
    prevLandscapeRef.current = isLandscape;
    if (robotHoldTimerRef.current) stopRobotDriveHold();
    stopCamHold();
    if (isLandscape && pairedWith && !camFullscreen) {
      setCameraOn(true);
      setCamFullscreen(true);
    }
  }, [
    camFullscreen,
    isLandscape,
    pairedWith,
    robotHoldTimerRef,
    setCamFullscreen,
    setCameraOn,
    stopCamHold,
    stopRobotDriveHold,
  ]);

  return {
    sendRobotDrive,
    sendRobotSpeed,
    startCamHold,
    stopCamHold,
    centerCam,
    camView,
    toggleCamView,
    startRobotDriveHold,
    stopRobotDriveHold,
  };
}
