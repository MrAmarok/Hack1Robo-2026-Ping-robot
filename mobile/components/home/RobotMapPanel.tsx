import { View, Text, TextInput, TouchableOpacity, Platform } from 'react-native';
import { styles } from './styles';
import { ExpandButton } from './controls';
import { distanceMeters, formatCoord } from './navigation';
import type { Coord } from './types';
import React from 'react';

type RobotMapPanelProps = {
  pairedWith: string;
  expanded: "map" | "camera" | "commands" | null;
  toggleExpand: (p: "camera" | "commands" | "map") => void;
  destInput: string;
  setDestInput: React.Dispatch<React.SetStateAction<string>>;
  destination: { latitude: number; longitude: number; label: string; } | null;
  setDestination: React.Dispatch<React.SetStateAction<{ latitude: number; longitude: number; label: string; } | null>>;
  setDestStartDist: React.Dispatch<React.SetStateAction<number | null>>;
  clearDestination: () => void;
  destSuggestions: { label: string; latitude: number; longitude: number; }[];
  selectDestination: (s: { label: string; latitude: number; longitude: number; }) => void;
  progressPct: number;
  remainingDist: number | null;
  navActive: boolean;
  stopNav: () => void;
  startNav: () => void;
  ronde: { apprentissage: boolean; enCours: boolean; points: number; longueurM: number; toursFaits: number; prochainDansS: number; } | null;
  envoyerRonde: (action: "apprendre_debut" | "apprendre_fin" | "demarrer" | "arreter" | "oublier" | "etat") => void;
  robotCoord: Coord | null;
  maps: typeof import("/home/tmendy/Projects/hack1robot/mobile/node_modules/react-native-maps/lib/index") | null;
  robotMapRef: React.RefObject<import('react-native-maps').default | null>;
  mapH: number;
  robotRegion: { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number; } | undefined;
  myCoord: Coord | null;
  setDestSuggestions: React.Dispatch<React.SetStateAction<{ label: string; latitude: number; longitude: number; }[]>>;
  routeCoords: Coord[];
};

export function RobotMapPanel({
  pairedWith,
  expanded,
  toggleExpand,
  destInput,
  setDestInput,
  destination,
  setDestination,
  setDestStartDist,
  clearDestination,
  destSuggestions,
  selectDestination,
  progressPct,
  remainingDist,
  navActive,
  stopNav,
  startNav,
  ronde,
  envoyerRonde,
  robotCoord,
  maps,
  robotMapRef,
  mapH,
  robotRegion,
  myCoord,
  setDestSuggestions,
  routeCoords,
}: RobotMapPanelProps) {
  return (
    <>
      {/* === Carte du robot (des que appaire) === */}
      {!!pairedWith && (expanded === null || expanded === 'map') && (
        <View style={styles.mapCard}>
          <View style={styles.mapHeader}>
            <Text style={styles.mapTitle}>Carte du robot</Text>
            <ExpandButton active={expanded === 'map'} onPress={() => toggleExpand('map')} />
          </View>

          <View style={styles.addrBox}>
            <TextInput
              placeholder="Adresse de destination…"
              placeholderTextColor="#7C9C93"
              value={destInput}
              onChangeText={(t) => {
                setDestInput(t);
                if (destination) {
                  setDestination(null);
                  setDestStartDist(null);
                }
              }}
              style={styles.addrInput}
            />
            {!!destInput && (
              <TouchableOpacity style={styles.addrClear} onPress={clearDestination}>
                <Text style={styles.addrClearText}>✕</Text>
              </TouchableOpacity>
            )}
          </View>

          {destSuggestions.length > 0 && (
            <View style={styles.suggestBox}>
              {destSuggestions.map((s, i) => (
                <TouchableOpacity
                  key={`${s.latitude},${s.longitude},${i}`}
                  style={styles.suggestItem}
                  onPress={() => selectDestination(s)}
                >
                  <Text style={styles.suggestText} numberOfLines={2}>
                    {s.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {!!destination && (
            <View style={styles.progressWrap}>
              <View style={styles.progressHeader}>
                <Text style={styles.progressLabel} numberOfLines={1}>
                  {destination.label}
                </Text>
                <Text style={styles.progressPct}>{progressPct}%</Text>
              </View>
              <View style={styles.progressBarBg}>
                <View style={[styles.progressBarFill, { width: `${progressPct}%` }]} />
              </View>
              <Text style={styles.progressMeta}>
                {remainingDist != null
                  ? `${remainingDist} m restants`
                  : 'Position robot inconnue'}
              </Text>
            </View>
          )}

          {!!destination && (
            <TouchableOpacity
              style={[styles.navBtn, navActive ? styles.navStop : styles.navGo]}
              onPress={navActive ? stopNav : startNav}
            >
              <Text style={styles.navBtnText}>
                {navActive ? '⏹  STOP NAVIGATION' : '🤖  Y ALLER (auto)'}
              </Text>
            </TouchableOpacity>
          )}

          <View style={styles.rondeCard}>
            <View style={styles.rondeHeader}>
              <Text style={styles.rondeTitle}>RONDE</Text>
              <Text style={styles.rondeMeta}>
                {ronde?.apprentissage
                  ? `apprentissage · ${ronde.points} pts`
                  : !ronde || ronde.points < 3
                    ? 'aucun circuit'
                    : ronde.enCours
                      ? ronde.prochainDansS > 0
                        ? `tour ${ronde.toursFaits} · reprise dans ${Math.ceil(ronde.prochainDansS / 60)} min`
                        : `tour ${ronde.toursFaits + 1} en cours`
                      : `${ronde.longueurM} m · ${ronde.points} pts`}
              </Text>
            </View>

            {ronde?.apprentissage ? (
              <>
                <Text style={styles.rondeHint}>
                  Conduis le robot sur le tour complet, puis termine.
                </Text>
                <TouchableOpacity
                  style={[styles.navBtn, styles.navGo]}
                  onPress={() => envoyerRonde('apprendre_fin')}
                >
                  <Text style={styles.navBtnText}>⏺  TERMINER L&apos;APPRENTISSAGE</Text>
                </TouchableOpacity>
              </>
            ) : (
              <View style={styles.rondeRow}>
                <TouchableOpacity
                  style={[styles.rondeBtn, ronde?.enCours ? styles.navStop : styles.navGo]}
                  onPress={() => envoyerRonde(ronde?.enCours ? 'arreter' : 'demarrer')}
                  disabled={!ronde || ronde.points < 3}
                >
                  <Text style={styles.navBtnText}>
                    {ronde?.enCours ? '⏹  ARRÊTER' : '🔁  LANCER'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.rondeBtn, styles.rondeBtnSecondaire]}
                  onPress={() => envoyerRonde('apprendre_debut')}
                >
                  <Text style={styles.navBtnText}>🎓  APPRENDRE</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {Platform.OS === 'web' ? (
            <Text style={{ color: '#7C9C93' }}>Open the mobile app to view the map.</Text>
          ) : !robotCoord ? (
            <Text style={{ color: '#7C9C93' }}>
              En attente d&apos;un fix GPS du robot…
            </Text>
          ) : maps ? (
            <maps.default
              ref={robotMapRef}
              style={[styles.map, { height: mapH }]}
              initialRegion={robotRegion}
              showsCompass
              showsUserLocation={!!myCoord}
              onPress={(e: any) => {
                const c = e?.nativeEvent?.coordinate;
                if (!c || typeof c.latitude !== 'number') return;
                setDestination({
                  latitude: c.latitude,
                  longitude: c.longitude,
                  label: 'Point sur la carte',
                });
                setDestInput('Point sur la carte');
                setDestSuggestions([]);
                setDestStartDist(robotCoord ? distanceMeters(robotCoord, c) : null);
              }}
            >
              <maps.Marker
                coordinate={robotCoord}
                title="Robot"
                description={formatCoord(robotCoord)}
                pinColor="#00E5A0"
              />
              {myCoord && (
                <maps.Marker
                  coordinate={myCoord}
                  title="Moi"
                  description="Ta position"
                  pinColor="#00E5A0"
                />
              )}
              {destination && (
                <maps.Marker
                  coordinate={{
                    latitude: destination.latitude,
                    longitude: destination.longitude,
                  }}
                  title="Destination"
                  description={destination.label}
                  pinColor="#FFB020"
                />
              )}
              {routeCoords.length > 1 && (
                <maps.Polyline
                  coordinates={routeCoords}
                  strokeWidth={4}
                  strokeColor="#FFB020"
                />
              )}
            </maps.default>
          ) : (
            <Text style={{ color: '#7C9C93' }}>Carte indisponible.</Text>
          )}

          <Text style={[styles.gpsMeta, { marginTop: 8 }]}>
            Robot: {formatCoord(robotCoord)}
          </Text>
        </View>
      )}
    </>
  );
}
