import { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
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
  canViewScans: boolean;
  isPilot: boolean;
  socketRef: React.RefObject<Socket | null>;
  snapshot: SonarSnapshot | null;
  onClose?: () => void;
};

type ScanStatus = { session: string | null; saving: boolean; recordingError: string | null };
type ScanEntry = { session: string; savedAt: number };
type SavedScan = { session: string; snapshot: SonarSnapshot | null; mapError: string | null };

async function scanRequest<T>(socket: Socket | null, event: string, session?: string): Promise<T> {
  const polling = event === 'sonar_scan_status';
  if (!polling) console.log('[SONAR][APP] Request', { event, session });
  try {
    if (!socket?.connected) throw new Error('Connection lost. Reconnect and try again.');
    const response = await socket.timeout(event === 'sonar_scan_save' ? 60000 : 5000)
      .emitWithAck(event, { session }) as (T & { error?: string; session?: string | null }) | null;
    if (!response) throw new Error('The server did not return a scan response.');
    if (response.error) throw new Error(response.error);
    if (!polling) console.log('[SONAR][APP] ACK', { event, session: response.session ?? session });
    return response;
  } catch (error) {
    console.warn('[SONAR][APP] Request failed', { event, session, error });
    throw error;
  }
}

const legend = [
  { label: 'Free', color: '#FFFFFF' },
  { label: 'Occupied', color: '#000000' },
  { label: 'Unknown', color: '#A0A0A0' },
];

export function SonarMapView({
  connected, canViewScans, isPilot, socketRef, snapshot: liveSnapshot, onClose,
}: Props) {
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [history, setHistory] = useState<ScanEntry[] | null>(null);
  const [selected, setSelected] = useState<SavedScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected || !canViewScans || busy) return;
    let cancelled = false;
    async function refresh() {
      try {
        const status = await scanRequest<ScanStatus>(socketRef.current, 'sonar_scan_status');
        if (!cancelled) setScan(status);
      } catch {
        if (!cancelled) setScan(null);
      }
    }
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connected, canViewScans, busy, socketRef]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Scan request failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const snapshot = selected ? selected.snapshot : scan?.session ? null : liveSnapshot;
  const { height } = useWindowDimensions();
  const status = selected?.mapError ?? (!connected
    ? 'Waiting for the server connection.'
    : scan?.session
      ? 'Save the scan to build its map.'
      : 'Start a scan to map the room.');
  const image = snapshot?.image;
  const uri = image?.format === 'png'
    ? `data:image/png;base64,${image.data}`
    : image && Platform.OS === 'web'
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.data)}`
      : undefined;

  useEffect(() => {
    if (selected?.mapError) {
      console.warn('[SONAR][APP] Map unavailable', { session: selected.session, error: selected.mapError });
    }
    if (snapshot) {
      console.log('[SONAR][APP] Rendering map', {
        session: selected?.session,
        format: snapshot.image.format,
        readings: snapshot.readingCount,
        updatedAt: snapshot.updatedAt,
      });
    }
  }, [selected, snapshot]);

  const Container = onClose ? SafeAreaView : View;

  return (
    <Container style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        {onClose && <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>Indoor map</Text>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.close}>
            <Text style={styles.closeLabel}>Close</Text>
          </Pressable>
        </View>}

        <View style={styles.actions}>
          {isPilot && (
            <>
              <ScanButton label="Start scan" disabled={!connected || busy || !scan || !!scan.session}
                onPress={() => act(async () => {
                  setScan(await scanRequest<ScanStatus>(socketRef.current, 'sonar_scan_start'));
                  setSelected(null);
                  setHistory(null);
                })}
              />
              <ScanButton label="Save scan" disabled={!connected || busy || !scan?.session || scan.saving}
                onPress={() => act(async () => {
                  if (!scan?.session) return;
                  setScan({ ...scan, saving: true });
                  const saved = await scanRequest<SavedScan>(socketRef.current, 'sonar_scan_save', scan.session);
                  setSelected(saved);
                  setScan({ session: null, saving: false, recordingError: null });
                  setHistory(null);
                })}
              />
            </>
          )}
          <ScanButton label={history ? 'Hide saved scans' : 'Saved scans'}
            disabled={!connected || busy || !canViewScans}
            onPress={() => {
              if (history) setHistory(null);
              else void act(async () => {
                const { scans } = await scanRequest<{ scans: ScanEntry[] }>(socketRef.current, 'sonar_scan_list');
                setHistory(scans);
              });
            }}
          />
        </View>
        {!!(error || scan?.recordingError || scan?.session || selected) && (
          <Text accessibilityLiveRegion="polite" style={styles.label}>
            {error ?? (scan?.saving
              ? 'Building map…'
              : scan?.recordingError ?? (scan?.session ? 'Recording sonar readings.' : 'Viewing a saved scan.'))}
          </Text>
        )}
        {history && (
          <View style={styles.history}>
            {history.length === 0 && <Text style={styles.label}>No saved scans yet.</Text>}
            {history.map(({ session, savedAt }) => (
              <ScanButton key={session} label={new Date(savedAt).toLocaleString()}
                selected={selected?.session === session}
                disabled={!connected || busy}
                onPress={() => act(async () => {
                  setSelected(await scanRequest<SavedScan>(socketRef.current, 'sonar_scan_open', session));
                  setHistory(null);
                })}
              />
            ))}
          </View>
        )}
        {selected && (liveSnapshot || scan?.session) && (
          <ScanButton label={scan?.session ? 'Back to current scan' : 'Show live map'} onPress={() => setSelected(null)} />
        )}

        <View style={[styles.canvas, { height: Math.max(200, Math.min(height * 0.55, 540)) }]}>
          {uri ? (
            <Image
              accessibilityLabel="Sonar occupancy grid"
              resizeMode="contain"
              source={{ uri }}
              style={styles.map}
              onLoad={() => console.log('[SONAR][APP] Map image loaded', { updatedAt: snapshot?.updatedAt })}
              onError={() => console.warn('[SONAR][APP] Map image could not be loaded', { updatedAt: snapshot?.updatedAt })}
            />
          ) : image?.format === 'svg' ? (
            <SvgXml
              accessibilityLabel="Sonar occupancy grid" xml={image.data} width="100%" height="100%"
              onError={() => console.warn('[SONAR][APP] Map SVG could not be parsed', { updatedAt: snapshot?.updatedAt })}
            />
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
              {!selected && snapshot.readingCount === snapshot.totalReadings ? ' · Replay complete' : ''}
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
    </Container>
  );
}

function ScanButton({ label, onPress, disabled = false, selected = false }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled, selected }}
      onPress={onPress} disabled={disabled}
      style={[styles.scanButton, selected && styles.selectedButton, disabled && styles.disabledButton]}>
      <Text style={styles.closeLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B1016' },
  content: { width: '100%', maxWidth: 820, alignSelf: 'center', padding: 20, gap: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { flexShrink: 1, color: '#E8FFF8', fontSize: 26, fontWeight: '700' },
  close: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  closeLabel: { color: '#5CFFC9', fontSize: 16, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  scanButton: {
    minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start',
    paddingHorizontal: 12, borderColor: '#344B53', borderWidth: 1, borderRadius: 6,
  },
  selectedButton: { borderColor: '#5CFFC9' },
  disabledButton: { opacity: 0.45 },
  history: { gap: 8 },
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
