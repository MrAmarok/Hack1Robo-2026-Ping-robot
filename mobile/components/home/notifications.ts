import { Platform, Linking, Alert } from 'react-native';
import * as Notifications from 'expo-notifications';
import { STRONG_VIBRATION_PATTERN, LOCATION_TASK_NAME, BACKGROUND_PUSH_TASK, SOCKET_URL, EAS_PROJECT_ID } from './config';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

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

export function openSystemSettings() {
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
// Push token
// ========================
// Pourquoi le dernier appel n'a pas rendu de jeton. Remonte au serveur, parce
// qu'un `catch` muet sur un telephone qu'on n'a pas en main ne se debogue pas.
export let raisonJetonAbsent: string | null = null;

export async function ensureExpoPushToken(interactive = false): Promise<string | null> {
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
export async function getLastSeen() {
  const v = await AsyncStorage.getItem('lastSeen');
  return v ? Number(v) : 0;
}
export async function setLastSeenNow() {
  await AsyncStorage.setItem('lastSeen', String(Date.now()));
}
