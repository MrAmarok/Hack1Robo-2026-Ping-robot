import { View, TouchableOpacity, Text } from 'react-native';
import { styles } from './styles';
import React from 'react';

type SurveillanceControlsProps = {
  pairedWith: string;
  modeAbsent: boolean;
  definirMode: (absent: boolean) => void;
  appelAlerte: { actif: boolean; configure: boolean; } | null;
  basculerAppelAlerte: () => void;
};

export function SurveillanceControls({
  pairedWith,
  modeAbsent,
  definirMode,
  appelAlerte,
  basculerAppelAlerte,
}: SurveillanceControlsProps) {
  return (
    <>
      {/* === Mode de surveillance === */}
      {/* Premier element de la page : c'est la question a laquelle on repond
        en ouvrant l'app quand on part de chez soi. */}
      {!!pairedWith && (
        <View style={styles.modeCard}>
          <TouchableOpacity
            style={[styles.modeBtn, !modeAbsent && styles.modeBtnNormalOn]}
            onPress={() => definirMode(false)}
            activeOpacity={0.8}
          >
            <Text style={[styles.modeTexte, !modeAbsent && styles.modeTexteOn]}>
              🏠  NORMAL
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeBtn, modeAbsent && styles.modeBtnAbsentOn]}
            onPress={() => definirMode(true)}
            activeOpacity={0.8}
          >
            <Text style={[styles.modeTexte, modeAbsent && styles.modeTexteOn]}>
              🛡️  ABSENT
            </Text>
          </TouchableOpacity>
        </View>
      )}
      {!!pairedWith && (
        <Text style={styles.modeSous}>
          {modeAbsent
            ? 'Surveillance armee : le robot guette et alerte.'
            : 'Surveillance desarmee : le robot n alerte pas.'}
        </Text>
      )}
      {!!pairedWith && modeAbsent && appelAlerte && (
        <TouchableOpacity
          onPress={basculerAppelAlerte}
          disabled={!appelAlerte.configure}
          activeOpacity={0.8}
        >
          <Text style={[styles.modeSous, appelAlerte.configure && appelAlerte.actif && styles.appelActif]}>
            {!appelAlerte.configure
              ? '📞  Appel si quelqu un est vu : pas configure sur le serveur'
              : appelAlerte.actif
                ? '📞  Appel si quelqu un est vu : ACTIF (toucher pour couper)'
                : '📞  Appel si quelqu un est vu : COUPE (toucher pour activer)'}
          </Text>
        </TouchableOpacity>
      )}

    </>
  );
}
