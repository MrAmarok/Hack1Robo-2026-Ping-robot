import { Text, View } from 'react-native';
import type { Region } from 'react-native-maps';
import type { loadNativeMaps } from '@/components/nativeMaps';
import { formatCoord } from './navigation';
import { pilotStyles as styles } from './pilotStyles';
import type { Coord } from './types';

export type PilotGpsMapProps = {
  maps: ReturnType<typeof loadNativeMaps>;
  robotCoord: Coord | null;
  robotRegion?: Region;
  myCoord: Coord | null;
  destination: (Coord & { label: string }) | null;
  routeCoords: Coord[];
};

export function PilotGpsMap({ maps, robotCoord, robotRegion, myCoord, destination, routeCoords }: PilotGpsMapProps) {
  if (!maps || !robotCoord || !robotRegion) {
    return (
      <View style={styles.feedMessage}>
        <Text style={styles.message}>
          {robotCoord ? `Carte native indisponible. Robot : ${formatCoord(robotCoord)}` : 'En attente de la position GPS du robot.'}
        </Text>
      </View>
    );
  }

  return (
    <maps.default style={styles.map} initialRegion={robotRegion} showsCompass>
      <maps.Marker coordinate={robotCoord} title="Robot" pinColor="#00E5A0" />
      {myCoord && <maps.Marker coordinate={myCoord} title="Moi" pinColor="#22D3EE" />}
      {destination && <maps.Marker coordinate={destination} title={destination.label} pinColor="#FFB020" />}
      {routeCoords.length > 1 && <maps.Polyline coordinates={routeCoords} strokeWidth={4} strokeColor="#FFB020" />}
    </maps.default>
  );
}
