import { View, Text, TouchableOpacity, Image } from 'react-native';
import { styles } from './styles';
import { webrtc } from './config';
import React from 'react';

type CameraPanelProps = {
  pairedWith: string;
  expanded: "map" | "camera" | "commands" | null;
  setCameraOn: React.Dispatch<React.SetStateAction<boolean>>;
  setCamFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
  cameraOn: boolean;
  rtcStreamUrl: string | null;
  camH: number;
  frameUri: string | null;
};

export function CameraPanel({
  pairedWith,
  expanded,
  setCameraOn,
  setCamFullscreen,
  cameraOn,
  rtcStreamUrl,
  camH,
  frameUri,
}: CameraPanelProps) {
  return (
    <>
      {/* === Camera du robot (flux a la demande) === */}
      {!!pairedWith && (expanded === null || expanded === 'camera') && (
        <View style={styles.cameraCard}>
          <View style={styles.robotControlHeader}>
            <Text style={styles.robotControlTitle}>Camera</Text>
            {/* Page d'accueil volontairement nue : la camera et l'alarme.
              Ecouter, parler, piloter, photographier — tout existe encore,
              mais dans la vue plein ecran, la ou on s'en sert vraiment.
              Un robot de surveillance doit d'abord MONTRER. */}
            <View style={styles.cameraBtnRow}>
              <TouchableOpacity
                style={styles.expandBtn}
                onPress={() => {
                  setCameraOn(true);
                  setCamFullscreen(true);
                }}
              >
                <Text style={styles.expandBtnText}>⛶</Text>
              </TouchableOpacity>
            </View>
          </View>

          {cameraOn ? (
            <View>
              {rtcStreamUrl && webrtc ? (
                // Video WebRTC (fluide, latence basse)
                <webrtc.RTCView
                  streamURL={rtcStreamUrl}
                  style={[styles.cameraImage, { height: camH }]}
                  objectFit="contain"
                />
              ) : frameUri ? (
                <Image
                  source={{ uri: frameUri }}
                  style={[styles.cameraImage, { height: camH }]}
                  resizeMode="contain"
                  fadeDuration={0}
                />
              ) : (
                <View style={[styles.cameraPlaceholder, { height: camH }]}>
                  <Text style={{ color: '#7C9C93' }}>
                    Connexion a la camera du robot…
                  </Text>
                </View>
              )}
              {/* Temoin discret du mode video : direct WebRTC ou secours MJPEG */}
              {(rtcStreamUrl || frameUri) && (
                <Text style={styles.cameraModeBadge}>
                  {rtcStreamUrl
                    ? '● direct'
                    : webrtc
                      ? '● secours'
                      : '● secours (module WebRTC absent du build)'}
                </Text>
              )}

            </View>
          ) : (
            <View style={[styles.cameraPlaceholder, { height: camH }]}>
              <Text style={{ color: '#7C9C93' }}>
                Camera coupee. Appuie sur REGARDER.
              </Text>
            </View>
          )}

        </View>
      )}

    </>
  );
}
