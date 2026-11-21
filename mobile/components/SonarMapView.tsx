import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SvgXml } from 'react-native-svg';

export type SonarSnapshot = {
  code: string;
  image: { format: 'png' | 'svg'; data: string };
  readingCount: number;
  totalReadings: number;
  resolutionM: number;
  updatedAt: number;
};

type Props = {
  connected: boolean;
  snapshot: SonarSnapshot | null;
  onClose: () => void;
};

const legend = [
  { label: 'Free', color: '#FFFFFF' },
  { label: 'Occupied', color: '#000000' },
  { label: 'Unknown', color: '#A0A0A0' },
];

export function SonarMapView({ connected, snapshot, onClose }: Props) {
  const { height } = useWindowDimensions();
  const status = connected
    ? 'Waiting for sonar readings from your pairing room.'
    : 'Waiting for the server connection.';
  const image = snapshot?.image;
  const uri = image?.format === 'png'
    ? `data:image/png;base64,${image.data}`
    : image && Platform.OS === 'web'
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.data)}`
      : undefined;

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>Live sonar map</Text>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.close}>
            <Text style={styles.closeLabel}>Close</Text>
          </Pressable>
        </View>

        <View style={[styles.canvas, { height: Math.max(200, Math.min(height * 0.55, 540)) }]}>
          {uri ? (
            <Image
              accessibilityLabel="Sonar occupancy grid"
              resizeMode="contain"
              source={{ uri }}
              style={styles.map}
            />
          ) : image?.format === 'svg' ? (
            <SvgXml accessibilityLabel="Sonar occupancy grid" xml={image.data} width="100%" height="100%" />
          ) : (
            <Text style={styles.empty}>{status}</Text>
          )}
        </View>

        <View style={styles.legend}>
          {legend.map(({ label, color }) => (
            <View key={label} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: color }]} />
              <Text style={styles.label}>{label}</Text>
            </View>
          ))}
        </View>

        {snapshot && (
          <View style={styles.details}>
            <Text style={styles.label}>
              {snapshot.readingCount} / {snapshot.totalReadings} readings
              {snapshot.readingCount === snapshot.totalReadings ? ' · Replay complete' : ''}
            </Text>
            <Text style={styles.label}>
              {snapshot.resolutionM * 100} cm per cell
            </Text>
            <Text style={styles.label}>
              Updated {new Date(snapshot.updatedAt).toLocaleTimeString()}
              {!connected ? ' · Disconnected' : ''}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B1016' },
  content: { width: '100%', maxWidth: 820, alignSelf: 'center', padding: 20, gap: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { flexShrink: 1, color: '#E8FFF8', fontSize: 26, fontWeight: '700' },
  close: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  closeLabel: { color: '#5CFFC9', fontSize: 16, fontWeight: '600' },
  canvas: {
    justifyContent: 'center',
    backgroundColor: '#101B24',
    borderColor: '#344B53',
    borderWidth: 1,
    padding: 8,
  },
  map: { width: '100%', height: '100%' },
  empty: { textAlign: 'center', color: '#A9D6C9', padding: 12 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, rowGap: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 14, height: 14, borderColor: '#849C9B', borderWidth: 1 },
  label: { color: '#A9D6C9', fontSize: 14 },
  details: { gap: 5 },
});
