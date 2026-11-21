import { Modal, View, Image, Text, TouchableOpacity, ScrollView, Pressable } from 'react-native';
import { SonarMapView, type SonarSnapshot } from '@/components/SonarMapView';
import { styles, HUD } from './styles';
import { webrtc } from './config';
import { RobotLinkBadge, SpeedSlider } from './controls';
import { rangerVideoDansGalerie } from './gallery';
import type { RobotDriveCommand, VideoServeur, AlerteHisto } from './types';
import { useEffect, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PilotButton } from './PilotButton';
import { PilotGpsMap, type PilotGpsMapProps } from './PilotGpsMap';
import { pilotStyles as pilot } from './pilotStyles';
import { Socket } from 'socket.io-client';

type CameraModalProps = {
  camFullscreen: boolean;
  isLandscape: boolean;
  cameraOn: boolean;
  gps: PilotGpsMapProps;
  stopHeldDrive: () => void;
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
  robotCommandStatus: string;
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
  isLandscape,
  cameraOn,
  gps,
  stopHeldDrive,
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
  robotCommandStatus,
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
  startRobotDriveHold,
  stopRobotDriveHold,
  videosChargement,
  videosListe,
  histoChargement,
  histoListe,
  setAlertePhoto,
  alerteGrande,
}: CameraModalProps) {
  const [dialog, setDialog] = useState<'options' | 'map' | null>(null);
  const [option, setOption] = useState<'camera' | 'audio' | 'alerts'>('camera');
  const [mapTab, setMapTab] = useState<'gps' | 'sonar'>('gps');

  useEffect(() => {
    if (!camFullscreen) setDialog(null);
  }, [camFullscreen]);

  const closeDialog = () => {
    stopCamHold();
    setDialog(null);
  };

  const closePilot = () => {
    stopHeldDrive();
    closeDialog();
    setCamFullscreen(false);
  };

  const closeLayer = () => {
    if (alertePhoto && alerteGrande) setAlerteGrande(false);
    else if (videosOuvert) setVideosOuvert(false);
    else if (histoOuvert) setHistoOuvert(false);
    else if (dialog) closeDialog();
    else closePilot();
  };

  const openOptions = () => {
    stopHeldDrive();
    setOption('camera');
    setDialog('options');
  };

  const openMap = (tab: 'gps' | 'sonar') => {
    stopHeldDrive();
    setMapTab(tab);
    setDialog('map');
    if (tab === 'sonar') socketRef.current?.emit('sonar_map_request');
  };

  const toggleListening = () => setListening((value) => !value);
  const handleTalk = webrtc ? (talking ? stopTalkLive : startTalkLive) : toggleTalk;
  const emergency = <PilotButton label="Arrêt d’urgence" onPress={arretUrgence} emergency />;
  const options = <PilotButton label="Options" onPress={openOptions} />;
  const map = <PilotButton label="Carte" onPress={() => openMap('gps')} />;
  const speed = (
    <View style={pilot.speed}>
      <Text style={pilot.speedLabel}>Vitesse</Text>
      <SpeedSlider
        pct={speedPct}
        onPreview={setSpeedPct}
        onCommit={(value) => {
          setSpeedPct(value);
          sendRobotSpeed(value);
        }}
      />
      <Text style={[pilot.speedLabel, pilot.speedValue]}>{speedPct}%</Text>
    </View>
  );

  const driveButton = (cmd: RobotDriveCommand, label: string, accessibilityLabel: string) => (
    <PilotButton
      label={label}
      accessibilityLabel={accessibilityLabel}
      symbol
      onPressIn={() => startRobotDriveHold(cmd)}
      onPressOut={stopRobotDriveHold}
    />
  );
  const drive = estPilote && (
    <View style={pilot.controls} pointerEvents="box-none">
      <View style={pilot.group}>
        {driveButton('L', '◀', 'Tourner à gauche')}
        {driveButton('R', '▶', 'Tourner à droite')}
      </View>
      <View style={pilot.group}>
        <PilotButton label="■" accessibilityLabel="Stop moteurs" symbol onPress={stopRobotDriveHold} />
        {isLandscape && options}
      </View>
      <View style={pilot.group}>
        {driveButton('F', '▲', 'Avancer')}
        {driveButton('B', '▼', 'Reculer')}
      </View>
    </View>
  );
  const error = robotLink === 'disconnected'
    ? 'Robot hors ligne'
    : !cameraOn
      ? 'Caméra coupée'
      : 'Connexion au flux…';
  const archiveOpen = videosOuvert || histoOuvert || (!!alertePhoto && alerteGrande);
  const layerOpen = !!dialog || archiveOpen;

  return (
    <Modal
      visible={camFullscreen}
      animationType="fade"
      supportedOrientations={['portrait', 'landscape']}
      onRequestClose={closeLayer}
    >
      <SafeAreaView style={pilot.root}>
        <View style={pilot.stage}>
          <View
            style={pilot.stage}
            accessibilityElementsHidden={layerOpen}
            importantForAccessibility={layerOpen ? 'no-hide-descendants' : 'auto'}
          >
            {!isLandscape && (
              <View style={pilot.top}>
                <PilotButton label="‹" accessibilityLabel="Retour à l’accueil" onPress={closePilot} symbol />
                <Text style={pilot.title}>Pilotage</Text>
                <RobotLinkBadge status={robotLink} />
              </View>
            )}

            <View style={[pilot.feed, isLandscape && pilot.landscapeFeed]} {...pinchResponder.panHandlers}>
              {cameraOn && rtcStreamUrl && webrtc ? (
                <webrtc.RTCView
                  streamURL={rtcStreamUrl}
                  style={[pilot.image, { transform: [{ scale: camZoom }] }]}
                  objectFit="contain"
                />
              ) : cameraOn && frameUri ? (
                <Image
                  source={{ uri: frameUri }}
                  style={[pilot.image, { transform: [{ scale: camZoom }] }]}
                  resizeMode="contain"
                  fadeDuration={0}
                />
              ) : (
                <View style={pilot.feedMessage}>
                  <Text style={pilot.title}>{error}</Text>
                  {!cameraOn && <PilotButton label="Allumer la caméra" onPress={() => setCameraOn(true)} />}
                </View>
              )}
            </View>

            {isLandscape && (
              <>
                <View style={pilot.top} pointerEvents="box-none">
                  <PilotButton label="‹" accessibilityLabel="Retour à l’accueil" onPress={closePilot} symbol />
                  <View style={pilot.status}><RobotLinkBadge status={robotLink} /></View>
                  {emergency}
                </View>
                <View style={pilot.landscapeMap}>{map}</View>
              </>
            )}

            <View style={isLandscape ? pilot.landscapeControls : pilot.portraitControls} pointerEvents="box-none">
              {!isLandscape && (
                <View style={pilot.groupFill}>
                  <PilotButton label="Écouter" active={listening} onPress={toggleListening} style={pilot.fill} />
                  <PilotButton label="Parler" active={talking} onPress={handleTalk} style={pilot.fill} />
                  <PilotButton label="Carte" onPress={() => openMap('gps')} style={pilot.fill} />
                  <PilotButton label="Options" onPress={openOptions} style={pilot.fill} />
                </View>
              )}
              {(rtActif || !estPilote || capActuel != null || !!robotCommandStatus) && (
                <View style={pilot.badgeRow} pointerEvents="none">
                  {rtActif && <Text style={pilot.statusText}>{rtEveille ? 'Solana écoute' : `En veille · ${rtPhrase}`}</Text>}
                  {!estPilote && <Text style={pilot.statusText}>{role === 'attente' ? 'Demande en attente' : 'Spectateur'}</Text>}
                  {estPilote && !!robotCommandStatus && (
                    <Text accessibilityLiveRegion="polite" numberOfLines={1} style={pilot.statusText}>
                      {robotCommandStatus}
                    </Text>
                  )}
                  {estPilote && capActuel != null && (
                    <Text style={pilot.statusText}>
                      {ecartCap == null
                        ? `Cap ${Math.round(capActuel)}°`
                        : Math.abs(ecartCap) <= 3 ? 'Trajectoire droite' : `${Math.abs(Math.round(ecartCap))}° ${ecartCap > 0 ? 'droite' : 'gauche'}`}
                    </Text>
                  )}
                </View>
              )}
              {estPilote && speed}
              {drive}
              {isLandscape && !estPilote && <View style={pilot.group}>{options}</View>}
              {!isLandscape && emergency}
            </View>
          </View>

          {dialog && (
            <View
              style={pilot.overlay}
              accessibilityViewIsModal={!archiveOpen}
              accessibilityElementsHidden={archiveOpen}
              importantForAccessibility={archiveOpen ? 'no-hide-descendants' : 'auto'}
            >
              <Pressable accessibilityLabel="Fermer la modale" onPress={closeDialog} style={pilot.backdrop} />
              <View style={[pilot.dialog, dialog === 'map' && pilot.mapDialog]}>
                <View style={pilot.dialogHeader}>
                  <Text accessibilityRole="header" style={pilot.title}>{dialog === 'options' ? 'Options de pilotage' : 'Carte du robot'}</Text>
                  <PilotButton label="Fermer" onPress={closeDialog} />
                </View>
                {dialog === 'map' ? (
                  <>
                    <View style={pilot.optionRow}>
                      <PilotButton label="GPS" active={mapTab === 'gps'} onPress={() => setMapTab('gps')} style={pilot.fill} />
                      <PilotButton label="Sonar" active={mapTab === 'sonar'} onPress={() => openMap('sonar')} style={pilot.fill} />
                    </View>
                    <View style={pilot.map}>
                      {mapTab === 'gps' ? <PilotGpsMap {...gps} /> : (
                        <SonarMapView
                          key={pairCode}
                          connected={socketOnline}
                          canViewScans={estPilote || role === 'spectateur'}
                          isPilot={estPilote}
                          socketRef={socketRef}
                          snapshot={sonarSnapshot?.code === pairCode.trim() ? sonarSnapshot : null}
                        />
                      )}
                    </View>
                  </>
                ) : (
                  <>
                    <View style={pilot.optionRow}>
                      <PilotButton label="Caméra" active={option === 'camera'} onPress={() => setOption('camera')} style={pilot.fill} />
                      <PilotButton label="Audio" active={option === 'audio'} onPress={() => { stopCamHold(); setOption('audio'); }} style={pilot.fill} />
                      <PilotButton label="Alertes" active={option === 'alerts'} onPress={() => { stopCamHold(); setOption('alerts'); }} style={pilot.fill} />
                    </View>
                    <ScrollView style={pilot.optionScroll} contentContainerStyle={pilot.options}>
                      {option === 'camera' && (
                        <>
                          <View style={pilot.optionRow}>
                            <PilotButton label={camView === 'front' ? 'Caméra arrière' : 'Caméra avant'} onPress={toggleCamView} style={pilot.fill} />
                            <PilotButton label={cameraOn ? 'Couper la caméra' : 'Allumer la caméra'} onPress={() => setCameraOn(!cameraOn)} style={pilot.fill} />
                          </View>
                          <View style={pilot.optionRow}>
                            <PilotButton label={savingPhoto ? 'Enregistrement…' : 'Prendre une photo'} onPress={savePhoto} disabled={savingPhoto || !cameraOn} style={pilot.fill} />
                            <PilotButton label={recActif ? 'Arrêter la vidéo' : 'Enregistrer la vidéo'} active={recActif} onPress={() => basculerRec(!recActif)} style={pilot.fill} />
                          </View>
                          <View style={pilot.controls}>
                            <Text style={pilot.message}>Zoom</Text>
                            <View style={pilot.group}>
                              <PilotButton label="−" accessibilityLabel="Réduire le zoom" symbol onPress={() => bumpZoom(-0.25)} />
                              <PilotButton label={`${camZoom.toFixed(2).replace('.', ',')}×`} accessibilityLabel="Réinitialiser le zoom" onPress={() => setCamZoom(1)} />
                              <PilotButton label="+" accessibilityLabel="Augmenter le zoom" symbol onPress={() => bumpZoom(0.25)} />
                            </View>
                          </View>
                          <Text style={pilot.message}>Orientation de la caméra</Text>
                          <View style={[pilot.group, { justifyContent: 'center' }]}>
                            <PilotButton label="◀" accessibilityLabel="Orienter à gauche" symbol onPressIn={() => startCamHold(1, 0)} onPressOut={stopCamHold} />
                            <PilotButton label="▲" accessibilityLabel="Orienter vers le haut" symbol onPressIn={() => startCamHold(0, 1)} onPressOut={stopCamHold} />
                            <PilotButton label="◎" accessibilityLabel="Recentrer la caméra" symbol onPress={centerCam} />
                            <PilotButton label="▼" accessibilityLabel="Orienter vers le bas" symbol onPressIn={() => startCamHold(0, -1)} onPressOut={stopCamHold} />
                            <PilotButton label="▶" accessibilityLabel="Orienter à droite" symbol onPressIn={() => startCamHold(-1, 0)} onPressOut={stopCamHold} />
                          </View>
                        </>
                      )}
                      {option === 'audio' && (
                        <>
                          <View style={pilot.optionRow}>
                            <PilotButton label="Écouter" active={listening} onPress={toggleListening} style={pilot.fill} />
                            <PilotButton label="Parler au talkie" active={talking} onPress={handleTalk} style={pilot.fill} />
                          </View>
                          <PilotButton label="Réveiller l’assistant vocal" active={askingVoice} onPress={askRobotVoice} />
                          <PilotButton label="Conversation IA en direct" active={rtActif} onPress={() => basculerRt(!rtActif)} />
                          <PilotButton label={hautParleur ? 'Sortie : haut-parleur' : 'Sortie : écouteur'} active={hautParleur} onPress={() => setHautParleur((value) => !value)} />
                        </>
                      )}
                      {option === 'alerts' && (
                        <>
                          <View style={pilot.optionRow}>
                            <PilotButton label="Carte sonar" onPress={() => openMap('sonar')} style={pilot.fill} />
                            <PilotButton label="Enregistrements" onPress={() => {
                              setVideosOuvert(true);
                              void chargerVideos();
                            }} style={pilot.fill} />
                          </View>
                          <View style={pilot.optionRow}>
                            <PilotButton label="Historique des alertes" onPress={() => {
                              setHistoOuvert(true);
                              void chargerHistorique();
                            }} style={pilot.fill} />
                            <PilotButton label="Dernière photo d’alerte" disabled={!alertePhoto} onPress={() => {
                              setAlerteGrande(true);
                            }} style={pilot.fill} />
                          </View>
                          <PilotButton
                            label={alarmeOn ? 'Couper l’alarme' : 'Alarme · appui long'}
                            warning
                            active={alarmeOn}
                            onPress={() => { if (alarmeOn) basculerAlarme(false); }}
                            onLongPress={() => { if (!alarmeOn) basculerAlarme(true); }}
                            delayLongPress={700}
                          />
                        </>
                      )}
                    </ScrollView>
                  </>
                )}
              </View>
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
              <Text style={styles.alerteTitre}>Photo de l’alerte</Text>
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
      </SafeAreaView>
    </Modal>
  );
}
