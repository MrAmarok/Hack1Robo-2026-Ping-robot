import * as MediaLibrary from 'expo-media-library';
import { Alert } from 'react-native';
import { SOCKET_URL } from './config';
import * as FileSystem from 'expo-file-system';

// Range une video du serveur dans la galerie du telephone.
//
// Les enregistrements vivaient uniquement sur le VPS : rien ne permettait de
// les recuperer. Les photos, elles, y allaient deja.
export async function rangerVideoDansGalerie(nom: string, mo?: number) {
  try {
    const perm = await MediaLibrary.requestPermissionsAsync(true); // ecriture seule
    if (!perm.granted) {
      Alert.alert('Video', 'Autorisation galerie refusee.');
      return;
    }
    const url = `${SOCKET_URL}/enregistrement?f=${encodeURIComponent(nom)}`;
    const dest = `${FileSystem.cacheDirectory}${nom}`;
    const r = await FileSystem.downloadAsync(url, dest);
    if (r.status !== 200) throw new Error(`le serveur a repondu ${r.status}`);
    await MediaLibrary.saveToLibraryAsync(r.uri);
    // Le cache n'est pas vide par le systeme avant longtemps : une video de
    // plusieurs dizaines de Mo y resterait en double.
    try { await FileSystem.deleteAsync(r.uri, { idempotent: true }); } catch {}
    Alert.alert('Video', `Enregistree dans ta galerie (${mo ?? '?'} Mo).`);
  } catch (e: any) {
    Alert.alert('Video', `Telechargement impossible : ${String(e?.message || e).slice(0, 120)}`);
  }
}
