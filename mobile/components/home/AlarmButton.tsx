import { TouchableOpacity, Text } from 'react-native';
import { styles } from './styles';
import React from 'react';

type AlarmButtonProps = {
  pairedWith: string;
  alarmeOn: boolean;
  basculerAlarme: (on: boolean) => void;
};

export function AlarmButton({
  pairedWith,
  alarmeOn,
  basculerAlarme,
}: AlarmButtonProps) {
  return (
    <>
      {/* === Alarme === */}
      {/* Seul bouton d'action conserve sur l'accueil, avec la camera. Tout
        le pilotage a migre en plein ecran : sur un robot de surveillance,
        la page principale doit montrer ce que le robot voit et permettre
        de faire du bruit, rien d'autre. */}
      {!!pairedWith && (
        <TouchableOpacity
          style={[styles.alarmeBtn, alarmeOn && styles.alarmeBtnOn]}
          onPress={() => { if (alarmeOn) basculerAlarme(false); }}
          onLongPress={() => { if (!alarmeOn) basculerAlarme(true); }}
          delayLongPress={700}
          activeOpacity={0.75}
        >
          <Text style={[styles.alarmeTexte, alarmeOn && styles.alarmeTexteOn]}>
            {alarmeOn ? '🔊  ALARME EN COURS — APPUIE POUR COUPER' : '🚨  ALARME'}
          </Text>
          {!alarmeOn && (
            <Text style={styles.alarmeSous}>appui long pour declencher</Text>
          )}
        </TouchableOpacity>
      )}

    </>
  );
}
