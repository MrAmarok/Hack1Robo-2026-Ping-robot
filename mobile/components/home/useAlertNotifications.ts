import React, { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { ROBOT_ONLINE_BUZZ_PREFIX, ROBOT_ACK_BUZZ_PREFIX } from './presets';
import { Vibration } from 'react-native';
import { STRONG_VIBRATION_PATTERN } from './config';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLastSeen } from './notifications';
import { Socket } from 'socket.io-client';

type AlertNotificationsOptions = {
  pushRobotLog: (text: string) => void;
  robotLastSeenAtRef: React.RefObject<number>;
  setRobotHeartbeat: React.Dispatch<React.SetStateAction<string>>;
  setCameraOn: React.Dispatch<React.SetStateAction<boolean>>;
  setCamFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
  setListening: React.Dispatch<React.SetStateAction<boolean>>;
  setHautParleur: React.Dispatch<React.SetStateAction<boolean>>;
  pairCodeRef: React.RefObject<string>;
  setAlertePhoto: React.Dispatch<React.SetStateAction<string | null>>;
  urlPhotoAlerte: (code: string) => string;
  setAlerteGrande: React.Dispatch<React.SetStateAction<boolean>>;
  pseudoRef: React.RefObject<string>;
  socketRef: React.RefObject<Socket | null>;
};

export function useAlertNotifications({
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
}: AlertNotificationsOptions) {
  useEffect(() => {
    const sub1 = Notifications.addNotificationReceivedListener((notification) => {
      const body = String(notification?.request?.content?.body || '');
      if (body.startsWith(ROBOT_ONLINE_BUZZ_PREFIX)) {
        pushRobotLog(`notification robot online body=${body}`);
        robotLastSeenAtRef.current = Date.now();
        setRobotHeartbeat(new Date().toLocaleTimeString());
        return;
      }
      if (body.startsWith(ROBOT_ACK_BUZZ_PREFIX)) {
        pushRobotLog(`notification robot ack body=${body}`);
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
  }, [
    pairCodeRef,
    pseudoRef,
    pushRobotLog,
    robotLastSeenAtRef,
    setAlerteGrande,
    setAlertePhoto,
    setCamFullscreen,
    setCameraOn,
    setHautParleur,
    setListening,
    setRobotHeartbeat,
    socketRef,
    urlPhotoAlerte,
  ]);
}
