import { ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';

export default function TabTwoScreen() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ThemedView style={styles.inner}>
        <ThemedText type="title">À propos</ThemedText>
        <ThemedText>
          Ping te permet de te coordonner et de recevoir un robot de livraison
          chez un proche.
        </ThemedText>
        <ThemedText>
          Va dans l’onglet « Home », appaire-toi avec un pseudo et un code,
          puis utilise « Se rejoindre ».
        </ThemedText>
      </ThemedView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingTop: 80, paddingHorizontal: 24 },
  inner: { gap: 14 },
});
