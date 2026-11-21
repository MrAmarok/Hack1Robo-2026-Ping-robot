import React, { useRef, useState, useEffect } from 'react';
import type { PendingRobotCommand, RobotDriveCommand, RobotStatus } from './types';
import { Alert } from 'react-native';
import { ROBOT_DRIVE_LABELS, ROBOT_CAM_BUZZ_PREFIX, CAM_STEP_DEG } from './presets';
import { Socket } from 'socket.io-client';

type DriveControlsOptions = {
  pairCodeRef: React.RefObject<string>;
  socketRef: React.RefObject<Socket | null>;
  pairedWith: string;
  pushRobotLog: (text: string) => void;
  navActive: boolean;
  setNavActive: React.Dispatch<React.SetStateAction<boolean>>;
  pendingRobotCmdRef: React.RefObject<PendingRobotCommand | null>;
  setRobotCommandStatus: React.Dispatch<React.SetStateAction<string>>;
  isLandscape: boolean;
  setCameraOn: React.Dispatch<React.SetStateAction<boolean>>;
  setCamFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
  robotStatus: RobotStatus | null;
  setCapRef: React.Dispatch<React.SetStateAction<number | null>>;
  capRefAttenduRef: React.RefObject<boolean>;
  robotHoldTimerRef: React.RefObject<ReturnType<typeof setInterval> | null>;
};

export function useDriveControls({
  pairCodeRef,
  socketRef,
  pairedWith,
  pushRobotLog,
  navActive,
  setNavActive,
  pendingRobotCmdRef,
  setRobotCommandStatus,
  isLandscape,
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

  const commandSequence = useRef(0);
  const stopGeneration = useRef(0);
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendRobotDrive = (cmd: string, label: string, track: boolean) => {
    const code = pairCodeRef.current?.trim();
    const socket = socketRef.current;
    if (!code || !pairedWith || !socket?.connected) {
      if (track) setRobotCommandStatus('Pilotage indisponible : connexion au serveur requise');
      return;
    }

    const id = `${socket.id}-${++commandSequence.current}`;
    if (!track) {
      socket.volatile.emit('robot_drive', { code, cmd, id, feedback: false });
      return;
    }

    if (replyTimerRef.current !== null) clearTimeout(replyTimerRef.current);
    pendingRobotCmdRef.current = { id, label };
    pushRobotLog(`SEND robot_drive id=${id} cmd=${cmd}`);
    setRobotCommandStatus(`${label} : attente du retour robot`);
    socket.emit('robot_drive', { code, cmd, id });
    replyTimerRef.current = setTimeout(() => {
      replyTimerRef.current = null;
      if (pendingRobotCmdRef.current?.id === id) {
        pendingRobotCmdRef.current = null;
        setRobotCommandStatus(`${label} : pas de retour robot`);
      }
    }, 2500);
  };

  const sendRobotSpeed = (pct: number) => {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    const value = Math.round(140 + (115 * p) / 100);
    sendRobotDrive(`V${value}`, `Vitesse ${p} %`, true);
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
  }, [isLandscape, pairedWith, setCamFullscreen, setCameraOn]);

  // Nettoyage si l'ecran se demonte pendant un maintien de fleche camera.
  useEffect(
    () => () => {
      if (camHoldTimerRef.current) clearInterval(camHoldTimerRef.current);
    },
    []
  );

  const cancelRobotDriveHold = () => {
    stopGeneration.current += 1;
    if (robotHoldTimerRef.current !== null) {
      clearInterval(robotHoldTimerRef.current);
      robotHoldTimerRef.current = null;
    }
  };

  useEffect(() => () => {
    if (replyTimerRef.current !== null) clearTimeout(replyTimerRef.current);
    if (robotHoldTimerRef.current !== null) clearInterval(robotHoldTimerRef.current);
    stopGeneration.current += 1;
  }, [robotHoldTimerRef]);

  const startRobotDriveHold = (cmd: RobotDriveCommand) => {
    cancelRobotDriveHold();
    const socket = socketRef.current;
    const code = pairCodeRef.current?.trim();
    if (!socket?.connected || !code || !pairedWith) {
      Alert.alert('Robot', 'Connecte-toi et appaire-toi au robot avant de piloter.');
      return;
    }
    if (navActive) {
      setNavActive(false);
      socket.emit('robot_nav', { code, on: false });
    }
    if (cmd === 'F') {
      const heading = robotStatus?.heading;
      if (typeof heading === 'number' && Number.isFinite(heading)) {
        setCapRef(heading);
        capRefAttenduRef.current = false;
      } else {
        setCapRef(null);
        capRefAttenduRef.current = true;
      }
    }

    const label = ROBOT_DRIVE_LABELS[cmd];
    sendRobotDrive(cmd, label, true);
    const socketId = socket.id;
    robotHoldTimerRef.current = setInterval(() => {
      if (socket !== socketRef.current || !socket.connected ||
          socket.id !== socketId || pairCodeRef.current?.trim() !== code) {
        cancelRobotDriveHold();
        return;
      }
      sendRobotDrive(cmd, label, false);
    }, 650);
  };

  const stopRobotDriveHold = () => {
    cancelRobotDriveHold();
    const socket = socketRef.current;
    const socketId = socket?.id;
    const code = pairCodeRef.current?.trim();
    const generation = stopGeneration.current;
    const label = ROBOT_DRIVE_LABELS.S;

    sendRobotDrive('S', label, true);
    for (const delay of [120, 300]) {
      setTimeout(() => {
        if (generation !== stopGeneration.current || socket !== socketRef.current ||
            !socket?.connected || socket.id !== socketId || pairCodeRef.current?.trim() !== code) return;
        sendRobotDrive('S', label, false);
      }, delay);
    }
  };

  return {
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
