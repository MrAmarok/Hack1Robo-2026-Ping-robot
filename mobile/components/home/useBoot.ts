import React, { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ONBOARD_KEY } from './presets';
import * as Notifications from 'expo-notifications';
import type { NotifStatus, Coord } from './types';
import * as TaskManager from 'expo-task-manager';
import { BACKGROUND_PUSH_TASK } from './config';

type BootOptions = {
  setPseudo: React.Dispatch<React.SetStateAction<string>>;
  setPairCode: React.Dispatch<React.SetStateAction<string>>;
  setShowTutorial: React.Dispatch<React.SetStateAction<boolean>>;
  setMyCoord: React.Dispatch<React.SetStateAction<Coord | null>>;
  setNotifStatus: React.Dispatch<React.SetStateAction<NotifStatus>>;
  canNotifyRef: React.RefObject<boolean>;
};

export function useBoot({
  setPseudo,
  setPairCode,
  setShowTutorial,
  setMyCoord,
  setNotifStatus,
  canNotifyRef,
}: BootOptions) {
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
  }, [canNotifyRef, setMyCoord, setNotifStatus, setPairCode, setPseudo, setShowTutorial]);
}
