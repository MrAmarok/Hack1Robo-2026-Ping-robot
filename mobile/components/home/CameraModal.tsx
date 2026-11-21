import { Modal, View, Image, Text, TouchableOpacity, ScrollView } from 'react-native';
import { SonarMapView, type SonarSnapshot } from '@/components/SonarMapView';
import { styles, HUD } from './styles';
import { webrtc } from './config';
import { RobotLinkBadge, SpeedSlider, CamPanTiltPad } from './controls';
import { rangerVideoDansGalerie } from './gallery';
import type { RobotDriveCommand, VideoServeur, AlerteHisto } from './types';
import React from 'react';
import { Socket } from 'socket.io-client';

type CameraModalProps = {
  camFullscreen: boolean;
  sonarOpen: boolean;
  setSonarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setCamFullscreen: React.Dispatch<React.SetStateAction<boolean>>;
  socketOnline: boolean;
  sonarSnapshot: SonarSnapshot | null;
  pairCode: string;
  pinchResponder: import('react-native').PanResponderInstance;
  rtcStreamUrl: string | null;
  camZoom: number;
  frameUri: string | null;
  socketRef: React.RefObject<Socket | null>;
  listening: boolean;
  setListening: React.Dispatch<React.SetStateAction<boolean>>;
  askingVoice: boolean;
  askRobotVoice: () => void;
  talking: boolean;
  stopTalkLive: () => void;
  startTalkLive: () => Promise<void>;
  toggleTalk: () => void;
  rtActif: boolean;
  basculerRt: (on: boolean) => void;
  recActif: boolean;
  basculerRec: (on: boolean) => void;
  bumpZoom: (delta: number) => void;
  setCamZoom: React.Dispatch<React.SetStateAction<number>>;
  videosOuvert: boolean;
  setVideosOuvert: React.Dispatch<React.SetStateAction<boolean>>;
  chargerVideos: () => Promise<void>;
  histoOuvert: boolean;
  setHistoOuvert: React.Dispatch<React.SetStateAction<boolean>>;
  chargerHistorique: () => Promise<void>;
  alertePhoto: string | null;
  setAlerteGrande: React.Dispatch<React.SetStateAction<boolean>>;
  savePhoto: () => Promise<void>;
  savingPhoto: boolean;
  alarmeOn: boolean;
  basculerAlarme: (on: boolean) => void;
  arretUrgence: () => void;
  hautParleur: boolean;
  setHautParleur: React.Dispatch<React.SetStateAction<boolean>>;
  setCameraOn: React.Dispatch<React.SetStateAction<boolean>>;
  ecartCap: number | null;
  capActuel: number | null;
  robotLink: "connecting" | "connected" | "disconnected";
  speedPct: number;
  setSpeedPct: React.Dispatch<React.SetStateAction<number>>;
  sendRobotSpeed: (pct: number) => void;
  startCamHold: (dPan: number, dTilt: number) => void;
  stopCamHold: () => void;
  centerCam: () => void;
  camView: "front" | "rear";
  toggleCamView: () => void;
  rtEveille: boolean;
  rtPhrase: string;
  estPilote: boolean;
  role: "pilote" | "spectateur" | "attente" | null;
  robotCommandStatus: string;
  startRobotDriveHold: (cmd: RobotDriveCommand) => void;
  stopRobotDriveHold: () => void;
  videosChargement: boolean;
  videosListe: VideoServeur[] | null;
  histoChargement: boolean;
  histoListe: AlerteHisto[] | null;
  setAlertePhoto: React.Dispatch<React.SetStateAction<string | null>>;
  alerteGrande: boolean;
};

export function CameraModal({
  camFullscreen,
  sonarOpen,
  setSonarOpen,
  setCamFullscreen,
  socketOnline,
  sonarSnapshot,
  pairCode,
  pinchResponder,
  rtcStreamUrl,
  camZoom,
  frameUri,
  socketRef,
  listening,
  setListening,
  askingVoice,
  askRobotVoice,
  talking,
  stopTalkLive,
  startTalkLive,
  toggleTalk,
  rtActif,
  basculerRt,
  recActif,
  basculerRec,
  bumpZoom,
  setCamZoom,
  videosOuvert,
  setVideosOuvert,
  chargerVideos,
  histoOuvert,
  setHistoOuvert,
  chargerHistorique,
  alertePhoto,
  setAlerteGrande,
  savePhoto,
  savingPhoto,
  alarmeOn,
  basculerAlarme,
  arretUrgence,
  hautParleur,
  setHautParleur,
  setCameraOn,
  ecartCap,
  capActuel,
  robotLink,
  speedPct,
  setSpeedPct,
  sendRobotSpeed,
  startCamHold,
  stopCamHold,
  centerCam,
  camView,
  toggleCamView,
  rtEveille,
  rtPhrase,
  estPilote,
  role,
  robotCommandStatus,
  startRobotDriveHold,
  stopRobotDriveHold,
  videosChargement,
  videosListe,
  histoChargement,
  histoListe,
  setAlertePhoto,
  alerteGrande,
}: CameraModalProps) {
  return (
    <>
      {/* === Camera plein ecran + commandes de pilotage === */}
      <Modal
        visible={camFullscreen || sonarOpen}
        animationType="fade"
        statusBarTranslucent
        supportedOrientations={['portrait', 'landscape']}
        onRequestClose={() => {
          if (sonarOpen) setSonarOpen(false);
          else setCamFullscreen(false);
        }}
      >
        {sonarOpen && (
          <SonarMapView
            connected={socketOnline}
            snapshot={sonarSnapshot?.code === pairCode.trim() ? sonarSnapshot : null}
            onClose={() => setSonarOpen(false)}
          />
        )}
        <View style={[styles.fsRoot, sonarOpen && styles.fsHidden]} {...pinchResponder.panHandlers}>
          {rtcStreamUrl && webrtc ? (
            // contain = on voit TOUTE l'image (plus de rognage) ; le zoom
            // eventuel est applique par-dessus (boutons +/- ou pincement).
            <webrtc.RTCView
              streamURL={rtcStreamUrl}
              style={[styles.fsImage, { transform: [{ scale: camZoom }] }]}
              objectFit="contain"
            />
          ) : frameUri ? (
            <Image
              source={{ uri: frameUri }}
              style={[styles.fsImage, { transform: [{ scale: camZoom }] }]}
              resizeMode="contain"
              fadeDuration={0}
            />
          ) : (
            <View style={styles.fsWait}>
              <Text style={{ color: '#7C9C93' }}>Connexion a la camera du robot…</Text>
            </View>
          )}

          {/* Barre du haut : fermer / audio / temoin robot / vitesse */}
          <View style={styles.fsTopRow}>
            <View style={styles.fsSpeedGroup}>
              <TouchableOpacity
                style={styles.camPadSpeedBtn}
                onPress={() => setCamFullscreen(false)}
              >
                <Text style={styles.camPadSymbol}>✕</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                style={[styles.camPadSpeedBtn, styles.fsSonarBtn]}
                onPress={() => {
                  setSonarOpen(true);
                  socketRef.current?.emit('sonar_map_request');
                }}
              >
                <Text style={styles.fsSonarLabel}>Live sonar map</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, listening && styles.fsAudioOn]}
                onPress={() => setListening((v) => !v)}
              >
                <Text style={styles.camPadSymbol}>{listening ? '🔊' : '🔈'}</Text>
              </TouchableOpacity>
              {/* Parler au robot sans dire le mot-cle */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, askingVoice && styles.fsAudioOn]}
                onPress={askRobotVoice}
              >
                <Text style={styles.camPadSymbol}>🎤</Text>
              </TouchableOpacity>
              {/* Les trois actions qu'on veut sous la main sans quitter la vue.
                Elles vivaient tout en bas de la page principale. */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, talking && styles.fsAudioOn]}
                onPress={webrtc ? (talking ? stopTalkLive : startTalkLive) : toggleTalk}
              >
                <Text style={styles.camPadSymbol}>🎙️</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, rtActif && styles.fsAudioOn]}
                onPress={() => basculerRt(!rtActif)}
              >
                <Text style={styles.camPadSymbol}>💬</Text>
              </TouchableOpacity>
              {/* Enregistrement cote serveur : il recopie le flux deja
                diffuse, donc la vue reste affichee. Le film HD, lui,
                monopoliserait la camera et eteindrait cet ecran. */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, recActif && styles.fsAudioOn]}
                onPress={() => basculerRec(!recActif)}
              >
                <Text style={styles.camPadSymbol}>{recActif ? '⏹' : '⏺'}</Text>
              </TouchableOpacity>
              {/* Zoom image : - / + (ou pincement a deux doigts sur l'image) */}
              <TouchableOpacity style={styles.camPadSpeedBtn} onPress={() => bumpZoom(-0.25)}>
                <Text style={styles.camPadSymbol}>−</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.camPadSpeedBtn}
                onPress={() => bumpZoom(0.25)}
                onLongPress={() => setCamZoom(1)}
              >
                <Text style={styles.camPadSymbol}>+</Text>
              </TouchableOpacity>
              {/* Enregistrements conservees sur le serveur. */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, videosOuvert && styles.fsAudioOn]}
                onPress={() => { setVideosOuvert(true); chargerVideos(); }}
              >
                <Text style={styles.camPadSymbol}>🎞</Text>
              </TouchableOpacity>

              {/* Historique : ce qui a sonne ET ce qui a ete retenu. */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, histoOuvert && styles.fsAudioOn]}
                onPress={() => { setHistoOuvert(true); chargerHistorique(); }}
              >
                <Text style={styles.camPadSymbol}>📋</Text>
              </TouchableOpacity>

              {/* Revoir la photo de la derniere alerte. */}
              {!!alertePhoto && (
                <TouchableOpacity
                  style={styles.camPadSpeedBtn}
                  onPress={() => setAlerteGrande(true)}
                >
                  <Text style={styles.camPadSymbol}>🖼</Text>
                </TouchableOpacity>
              )}

              {/* Photo : descendu de l'accueil. Un robot de surveillance sert
                d'abord a rapporter une image. */}
              <TouchableOpacity
                style={styles.camPadSpeedBtn}
                onPress={savePhoto}
                disabled={savingPhoto}
              >
                <Text style={styles.camPadSymbol}>{savingPhoto ? '⏳' : '📷'}</Text>
              </TouchableOpacity>

              {/* Alarme : appui LONG pour declencher, simple pour couper.
                Meme regle qu'a l'accueil — plus facile d'eteindre que
                d'allumer. */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, alarmeOn && styles.fsAlarmeOn]}
                onPress={() => { if (alarmeOn) basculerAlarme(false); }}
                onLongPress={() => { if (!alarmeOn) basculerAlarme(true); }}
                delayLongPress={700}
              >
                <Text style={styles.camPadSymbol}>🚨</Text>
              </TouchableOpacity>

              {/* Arret d'urgence : il a quitte l'accueil avec le reste du
                pilotage, mais il ne doit JAMAIS devenir introuvable — c'est
                ici qu'on conduit, c'est donc ici qu'il doit etre. */}
              <TouchableOpacity style={[styles.camPadSpeedBtn, styles.fsStopAll]} onPress={arretUrgence}>
                <Text style={styles.camPadSymbol}>⛔</Text>
              </TouchableOpacity>

              {/* Haut-parleur / ecouteur. Le son fort passe par le flux MP3,
                le mode discret par WebRTC (plus reactif, mais iOS le sort
                dans l'ecouteur d'oreille). */}
              <TouchableOpacity
                style={[styles.camPadSpeedBtn, hautParleur && styles.fsAudioOn]}
                onPress={() => setHautParleur((v) => !v)}
              >
                <Text style={styles.camPadSymbol}>{hautParleur ? '📢' : '📞'}</Text>
              </TouchableOpacity>

              {/* Couper la camera : le bouton REGARDER a disparu de l'accueil
                (la camera s'y allume seule), il faut donc garder un moyen
                d'arreter le flux — sinon la 4G tourne en permanence. */}
              <TouchableOpacity
                style={styles.camPadSpeedBtn}
                onPress={() => {
                  setCameraOn(false);
                  setCamFullscreen(false);
                }}
              >
                <Text style={styles.camPadSymbol}>⏻</Text>
              </TouchableOpacity>

              {/* Trajectoire : version compacte de la boussole de la page
                principale. C'est en plein ecran qu'on pilote vraiment, donc
                c'est la qu'il faut voir si le robot part de travers. */}
              <View
                style={[
                  styles.fsCap,
                  ecartCap != null &&
                  (Math.abs(ecartCap) <= 3
                    ? styles.fsCapOk
                    : Math.abs(ecartCap) <= 10
                      ? styles.fsCapMoyen
                      : styles.fsCapMauvais),
                ]}
              >
                <Text
                  style={[
                    styles.fsCapFleche,
                    { transform: [{ rotate: `${ecartCap ?? 0}deg` }] },
                    capActuel == null && styles.fsCapOff,
                  ]}
                >
                  ▲
                </Text>
                <Text style={styles.fsCapTexte}>
                  {capActuel == null
                    ? 'cap ?'
                    : ecartCap == null
                      ? `${Math.round(capActuel)}°`
                      : Math.abs(ecartCap) <= 3
                        ? 'droit'
                        : `${Math.abs(Math.round(ecartCap))}°${ecartCap > 0 ? 'D' : 'G'}`}
                </Text>
              </View>
              {camZoom > 1 && (
                <TouchableOpacity style={styles.camPadSpeedBtn} onPress={() => setCamZoom(1)}>
                  <Text style={styles.fsZoomText}>{camZoom.toFixed(1)}x</Text>
                </TouchableOpacity>
              )}
            </View>
            <RobotLinkBadge status={robotLink} />
            <View style={styles.fsSpeedGroup}>
              <SpeedSlider
                compact
                pct={speedPct}
                onPreview={setSpeedPct}
                onCommit={(p) => {
                  setSpeedPct(p);
                  sendRobotSpeed(p);
                }}
              />
              <Text style={styles.speedPctTextLight}>{speedPct}%</Text>
            </View>
          </View>

          {/* Pan-tilt : oriente la camera sans bouger le robot */}
          <CamPanTiltPad
            fullscreen
            onHoldStart={startCamHold}
            onHoldEnd={stopCamHold}
            onCenter={centerCam}
            view={camView}
            onToggleView={toggleCamView}
          />

          {/* Commandes du bas : conduite a deux pouces */}
          {/*
          Direction a GAUCHE, avancer-reculer a DROITE : on tient le
          telephone a deux mains et chaque pouce reste sur son groupe, sans
          traverser l'ecran. C'est la disposition des manettes de jeu, pour
          la meme raison.

          Le joystick occupait la place de gauche et ne repondait plus. Il
          etait aussi le SEUL a pouvoir tourner, car le seul a envoyer le
          pilotage differentiel M<g>,<d> — un format qui n'arrivait jamais
          jusqu'au robot, alors que son ordre d'arret, lui, partait bien.
          D'ou un robot qui ne repondait plus qu'en s'arretant.
        */}
          {/* Conduite : pilote uniquement. Le serveur refuse de toute facon les
            ordres d'un spectateur — ceci evite surtout de lui presenter des
            boutons qui ne feraient rien. */}
          {rtActif && (
            <View style={styles.fsVeilleBandeau}>
              <Text style={styles.fsVeilleTexte}>
                {rtEveille
                  ? 'SOLANA ECOUTE'
                  : `EN VEILLE — DITES "${rtPhrase.toUpperCase()}"`}
              </Text>
            </View>
          )}
          {!estPilote && (
            <View style={styles.fsRoleBandeau}>
              <Text style={styles.fsRoleTexte}>
                {role === 'attente' ? 'EN ATTENTE D ACCEPTATION' : 'SPECTATEUR, CAMERA SEULE'}
              </Text>
            </View>
          )}
          {estPilote && (
            <View style={styles.fsBottomRow}>
              {/* Pouce gauche : la direction. */}
              <View style={styles.camPadGroupRow}>
                <TouchableOpacity
                  style={styles.camPadBtn}
                  onPressIn={() => startRobotDriveHold('L')}
                  onPressOut={stopRobotDriveHold}
                >
                  <Text style={styles.camPadSymbol}>◀</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.camPadBtn}
                  onPressIn={() => startRobotDriveHold('R')}
                  onPressOut={stopRobotDriveHold}
                >
                  <Text style={styles.camPadSymbol}>▶</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.camPadBtn, styles.camPadStop]}
                onPress={stopRobotDriveHold}
              >
                <Text style={styles.camPadSymbol}>■</Text>
              </TouchableOpacity>

              {/* Pouce droit : avancer et reculer. */}
              <View style={styles.camPadGroupCol}>
                <TouchableOpacity
                  style={styles.camPadBtn}
                  onPressIn={() => startRobotDriveHold('F')}
                  onPressOut={stopRobotDriveHold}
                >
                  <Text style={styles.camPadSymbol}>▲</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.camPadBtn}
                  onPressIn={() => startRobotDriveHold('B')}
                  onPressOut={stopRobotDriveHold}
                >
                  <Text style={styles.camPadSymbol}>▼</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {estPilote && !!robotCommandStatus && (
            <View style={styles.fsDriveStatus}>
              <Text accessibilityLiveRegion="polite" numberOfLines={1} style={styles.fsDriveStatusText}>
                {robotCommandStatus}
              </Text>
            </View>
          )}

          {/* === Enregistrements video === */}
          {videosOuvert && (
            <View style={styles.histoFond}>
              <View style={styles.histoBarre}>
                <Text style={styles.histoTitre}>ENREGISTREMENTS</Text>
                <TouchableOpacity onPress={chargerVideos} style={styles.histoAction}>
                  <Text style={styles.histoActionTexte}>{videosChargement ? '...' : 'ACTUALISER'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setVideosOuvert(false)} style={styles.histoAction}>
                  <Text style={styles.histoActionTexte}>FERMER</Text>
                </TouchableOpacity>
              </View>

              {videosListe === null ? (
                <Text style={styles.histoVide}>
                  Liste indisponible : le serveur n a pas repondu.{'\n'}
                  Cela ne veut pas dire qu il n y a aucun enregistrement.
                </Text>
              ) : videosListe.length === 0 ? (
                <Text style={styles.histoVide}>
                  {videosChargement ? 'Chargement...' : 'Aucun enregistrement.'}
                </Text>
              ) : (
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
                  {videosListe.map((v) => {
                    // Nom de la forme robot-<code>-AAAAMMJJ-HHMMSS.mp4 : on en
                    // tire une date lisible plutot que d'afficher le fichier brut.
                    const m = v.nom.match(/-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.mp4$/);
                    const quand = m
                      ? `${m[3]}/${m[2]} a ${m[4]}h${m[5]}`
                      : v.nom;
                    return (
                      <TouchableOpacity
                        key={v.nom}
                        style={styles.histoLigne}
                        activeOpacity={0.7}
                        onPress={() => rangerVideoDansGalerie(v.nom, v.mo)}
                      >
                        <View style={[styles.histoVignette, styles.histoSansPhoto]}>
                          <Text style={{ color: HUD.ACCENT, fontSize: 20 }}>▶</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.histoHeure}>{quand}</Text>
                          <Text style={styles.histoPhrase}>{v.mo} Mo</Text>
                          <Text style={styles.histoCapteurs}>appuyer pour enregistrer dans la galerie</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}
            </View>
          )}

          {/* === Historique des alertes === */}
          {/* Le filtrage porte sur la sonnerie, jamais sur la trace : on
            retrouve ici les alertes retenues, marquees comme telles. */}
          {histoOuvert && (
            <View style={styles.histoFond}>
              <View style={styles.histoBarre}>
                <Text style={styles.histoTitre}>DERNIERES ALERTES</Text>
                <TouchableOpacity onPress={chargerHistorique} style={styles.histoAction}>
                  <Text style={styles.histoActionTexte}>{histoChargement ? '...' : 'ACTUALISER'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setHistoOuvert(false)} style={styles.histoAction}>
                  <Text style={styles.histoActionTexte}>FERMER</Text>
                </TouchableOpacity>
              </View>

              {histoListe === null ? (
                <Text style={styles.histoVide}>
                  Historique indisponible : le serveur n a pas repondu.{'\n'}
                  Cela ne veut pas dire qu il n y a eu aucune alerte.
                </Text>
              ) : histoListe.length === 0 ? (
                <Text style={styles.histoVide}>
                  {histoChargement ? 'Chargement...' : 'Aucune alerte enregistree.'}
                </Text>
              ) : (
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
                  {histoListe.map((a) => (
                    <TouchableOpacity
                      key={a.ts}
                      style={styles.histoLigne}
                      activeOpacity={a.photo ? 0.7 : 1}
                      onPress={() => {
                        if (!a.photo) return;
                        setAlertePhoto(a.photo);
                        setAlerteGrande(true);
                      }}
                    >
                      {a.photo ? (
                        <Image source={{ uri: a.photo }} style={styles.histoVignette} resizeMode="cover" />
                      ) : (
                        <View style={[styles.histoVignette, styles.histoSansPhoto]}>
                          <Text style={{ color: '#5E7B87', fontSize: 9 }}>sans{'\n'}photo</Text>
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <View style={styles.histoEnTete}>
                          <Text style={styles.histoHeure}>
                            {new Date(a.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                          </Text>
                          <Text
                            style={[
                              styles.histoBadge,
                              a.categorie === 'personne' && styles.histoBadgePersonne,
                              a.categorie === 'animal' && styles.histoBadgeAnimal,
                            ]}
                          >
                            {a.categorie === 'personne' ? 'PERSONNE' : a.categorie === 'animal' ? 'ANIMAL' : 'RIEN VU'}
                          </Text>
                          {!a.notifiee && <Text style={styles.histoRetenue}>retenue</Text>}
                        </View>
                        <Text style={styles.histoPhrase} numberOfLines={2}>
                          {a.phrase || 'Aucune description.'}
                        </Text>
                        <Text style={styles.histoCapteurs}>
                          {(a.capteurs && a.capteurs.length ? a.capteurs : [a.type]).join(' + ')}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>
          )}

          {/* === Photo de l'alerte === */}
          {/* Elle passe PAR-DESSUS le direct, volontairement : la photo montre
            ce qui a declenche l'alerte, le flux ne montrera que la suite,
            quelques secondes plus tard — l'intrus a pu sortir du champ.
            C'est aussi le seul endroit ou on la voit : iOS n'affiche pas
            l'image d'une notification sans extension native. */}
          {!!alertePhoto && alerteGrande && (
            <View style={styles.alerteFond}>
              <Text style={styles.alerteTitre}>Photo de l'alerte</Text>
              <Image
                source={{ uri: alertePhoto }}
                style={styles.alerteImage}
                resizeMode="contain"
              />
              <TouchableOpacity
                style={styles.alerteBtn}
                onPress={() => setAlerteGrande(false)}
              >
                <Text style={styles.alerteBtnTexte}>VOIR EN DIRECT</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>
    </>
  );
}
