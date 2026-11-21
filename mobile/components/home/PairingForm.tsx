import { Text, TextInput, Platform, View, TouchableOpacity, Alert } from 'react-native';
import { styles } from './styles';
import { openSystemSettings, ensureExpoPushToken } from './notifications';
import * as Notifications from 'expo-notifications';
import type { NotifStatus } from './types';
import * as TaskManager from 'expo-task-manager';
import { BACKGROUND_PUSH_TASK, SOCKET_URL } from './config';
import { PrimaryButton } from './controls';
import React from 'react';
import { Socket } from 'socket.io-client';

type PairingFormProps = {
  pairedWith: string;
  pseudo: string;
  setPseudo: React.Dispatch<React.SetStateAction<string>>;
  pairCode: string;
  setPairCode: React.Dispatch<React.SetStateAction<string>>;
  notifStatus: NotifStatus;
  socketRef: React.RefObject<Socket | null>;
  pairCodeRef: React.RefObject<string>;
  pseudoRef: React.RefObject<string>;
  setNotifStatus: React.Dispatch<React.SetStateAction<NotifStatus>>;
  canNotifyRef: React.RefObject<boolean>;
  onPair: () => Promise<void>;
};

export function PairingForm({
  pairedWith,
  pseudo,
  setPseudo,
  pairCode,
  setPairCode,
  notifStatus,
  socketRef,
  pairCodeRef,
  pseudoRef,
  setNotifStatus,
  canNotifyRef,
  onPair,
}: PairingFormProps) {
  if (pairedWith) return null;

  return (
    <>
      <Text style={styles.warningText}>Connecte-toi au robot</Text>

      <TextInput
        placeholder="Pseudo"
        placeholderTextColor="#7C9C93"
        value={pseudo}
        onChangeText={setPseudo}
        style={styles.input}
      />
      <TextInput
        placeholder="Code en commun"
        placeholderTextColor="#7C9C93"
        keyboardType="number-pad"
        value={pairCode}
        onChangeText={setPairCode}
        style={styles.input}
      />

      {Platform.OS !== 'web' && (
        <View style={{ backgroundColor: '#0B1016', borderRadius: 12, padding: 12, marginTop: 8 }}>
          <Text style={{ color: '#E8FFF8', fontWeight: '700', marginBottom: 6 }}>
            Notifications (optionnel)
          </Text>
          <Text style={{ color: '#A9D6C9', fontSize: 13, marginBottom: 10 }}>
            Active-les pour recevoir un message même si l’app est en arrière-plan.
          </Text>
          {notifStatus === 'granted' ? (
            <>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: '#132029' }]}
                onPress={() => openSystemSettings()}
              >
                <Text style={styles.primaryBtnText}>Gérer dans les Réglages</Text>
              </TouchableOpacity>
              {/* Quand les permissions sont DEJA accordees, aucun bouton ne
              permettait de (re)enregistrer le jeton : le seul qui le
              faisait vivait dans la branche "pas autorisees". Le serveur
              n'avait donc jamais de destinataire. Celui-ci force
              l'enregistrement et affiche le resultat exact. */}
              <TouchableOpacity
                style={[styles.primaryBtn, { marginTop: 8 }]}
                onPress={async () => {
                  try {
                    const tk = await ensureExpoPushToken(false);
                    if (!tk) {
                      Alert.alert('Notifications', "Aucun jeton obtenu. L'app n'a pas pu en generer un.");
                      return;
                    }
                    // Par la SOCKET et non par fetch : iOS bloque le HTTP en
                    // clair (ATS), la socket passe.
                    socketRef.current?.emit('register_token', {
                      code: pairCodeRef.current?.trim(),
                      pseudo: pseudoRef.current,
                      token: tk,
                    });
                    Alert.alert('Notifications', `Jeton envoye
${tk.slice(0, 32)}…`);
                  } catch (e: any) {
                    Alert.alert('Notifications', `Echec : ${String(e?.message || e)}`);
                  }
                }}
              >
                <Text style={styles.primaryBtnText}>Réenregistrer les notifications</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={async () => {
                const token = await ensureExpoPushToken(true);
                const perms = await Notifications.getPermissionsAsync();
                setNotifStatus(perms.status as NotifStatus);
                canNotifyRef.current = perms.status === 'granted';
                if (perms.status === 'granted') {
                  try {
                    const isReg = await TaskManager.isTaskRegisteredAsync(
                      BACKGROUND_PUSH_TASK
                    );
                    if (!isReg)
                      await Notifications.registerTaskAsync(BACKGROUND_PUSH_TASK);
                  } catch { }
                  const tk = token || (await ensureExpoPushToken(false));
                  if (tk) {
                    try {
                      const sid = socketRef.current?.id;
                      if (sid) {
                        await fetch(`${SOCKET_URL}/register-token`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            token: tk,
                            socketId: sid,
                            code: pairCodeRef.current?.trim(),
                            pseudo: pseudoRef.current,
                          }),
                        });
                      }
                    } catch { }
                  }
                  Alert.alert('Notifications', 'Activées.');
                } else {
                  Alert.alert('Notifications', 'Pas activées.');
                }
              }}
            >
              <Text style={styles.primaryBtnText}>Activer les notifications</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <PrimaryButton label="S’APPARIER" onPress={onPair} />
    </>
  );
}
