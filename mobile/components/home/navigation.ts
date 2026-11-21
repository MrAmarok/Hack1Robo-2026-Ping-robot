import type { Coord, Mode } from './types';
import { Linking, Platform, Alert } from 'react-native';

export function distanceMeters(
  a: Coord | null | undefined,
  b: Coord | null | undefined
): number | null {
  if (!a || !b) return null;
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

export function formatCoord(coord: Coord | null | undefined) {
  if (!coord) return 'Aucune position';
  return `${coord.latitude.toFixed(6)}, ${coord.longitude.toFixed(6)}`;
}


// ========================
// Navigation externe
// ========================
function modeFlagIOS(mode: Mode) {
  if (mode === 'walking') return 'w';
  if (mode === 'transit') return 'r';
  return 'd';
}
function modeFlagAndroid(mode: Mode) {
  if (mode === 'walking') return 'w';
  if (mode === 'bicycling') return 'b';
  return 'd';
}

export async function openExternalNavigation(
  origin: Coord,
  destination: Coord,
  mode: Mode = 'driving'
) {
  const o = `${origin.latitude},${origin.longitude}`;
  const d = `${destination.latitude},${destination.longitude}`;
  const encO = encodeURIComponent(o);
  const encD = encodeURIComponent(d);

  const tryOpen = async (url: string) => {
    try {
      const ok = await Linking.canOpenURL(url);
      if (ok) {
        await Linking.openURL(url);
        return true;
      }
    } catch {}
    return false;
  };

  try {
    if (Platform.OS === 'ios') {
      const gmapsIOS = `comgooglemaps://?daddr=${encD}&directionsmode=${
        mode === 'walking' ? 'walking' : 'driving'
      }`;
      if (await tryOpen(gmapsIOS)) return;

      const appleHttp = `http://maps.apple.com/?saddr=${encO}&daddr=${encD}&dirflg=${modeFlagIOS(
        mode
      )}`;
      if (await tryOpen(appleHttp)) return;

      const wazeIOS = `waze://?ll=${encD}&navigate=yes`;
      if (await tryOpen(wazeIOS)) return;

      await Linking.openURL(
        `https://www.google.com/maps/dir/?api=1&origin=${encO}&destination=${encD}&travelmode=${mode}`
      );
      return;
    }

    const gnav = `google.navigation:q=${encD}&mode=${modeFlagAndroid(mode)}`;
    if (await tryOpen(gnav)) return;

    const waze = `waze://?ll=${encD}&navigate=yes`;
    if (await tryOpen(waze)) return;

    const geo = `geo:${d}?q=${encD}`;
    if (await tryOpen(geo)) return;

    await Linking.openURL(
      `https://www.google.com/maps/dir/?api=1&origin=${encO}&destination=${encD}&travelmode=${mode}`
    );
  } catch (e) {
    Alert.alert('Navigation', 'Impossible d’ouvrir une application de navigation.');
  }
}
