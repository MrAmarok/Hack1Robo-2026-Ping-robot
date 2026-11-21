import { TouchableOpacity, Text, View, PanResponder } from 'react-native';
import { styles } from './styles';
import type { RobotDriveCommand } from './types';
import { useState, useRef } from 'react';

export function PrimaryButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.primaryBtn}>
      <Text style={styles.primaryBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

// Joystick virtuel type jeu video : glisser le pouce = F/B/L/R selon l'angle,
// zone morte au centre et relacher = stop. Traduit en commandes discretes,
// donc 100% compatible avec le sketch Arduino actuel (rien a re-televerser).
// Pad pan-tilt de la camera : 4 fleches (maintien = mouvement continu) +
// bouton central pour recentrer. Si la camera part dans le mauvais sens,
// ajuste PAN_INVERT / TILT_INVERT dans le sketch Arduino (pas ici).
export function CamPanTiltPad({
  fullscreen,
  onHoldStart,
  onHoldEnd,
  onCenter,
  view,
  onToggleView,
  showViewToggle = true,
}: {
  fullscreen?: boolean;
  onHoldStart: (dPan: number, dTilt: number) => void;
  onHoldEnd: () => void;
  onCenter: () => void;
  view: 'front' | 'rear';
  onToggleView: () => void;
  showViewToggle?: boolean;
}) {
  const arrow = (label: string, dPan: number, dTilt: number) => (
    <TouchableOpacity
      style={styles.camPtBtn}
      onPressIn={() => onHoldStart(dPan, dTilt)}
      onPressOut={onHoldEnd}
    >
      <Text style={styles.camPtSymbol}>{label}</Text>
    </TouchableOpacity>
  );
  // En plein ecran (paysage), la croix verticale descendait jusque sur le
  // joystick : on la remplace par une barre horizontale compacte, calee sous
  // la barre du haut, qui ne croise aucune commande de pilotage.
  if (fullscreen) {
    return (
      <View style={styles.camPtBarFs}>
        <Text style={styles.camPtTitle}>🎥</Text>
        {arrow('◀', +1, 0)}
        {arrow('▲', 0, +1)}
        {arrow('▼', 0, -1)}
        {arrow('▶', -1, 0)}
        <TouchableOpacity style={[styles.camPtBtn, styles.camPtCenter]} onPress={onCenter}>
          <Text style={styles.camPtSymbol}>◎</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.camPtPad}>
      <Text style={styles.camPtTitle}>🎥</Text>
      {arrow('▲', 0, +1)}
      <View style={styles.camPtRow}>
        {arrow('◀', +1, 0)}
        <TouchableOpacity style={[styles.camPtBtn, styles.camPtCenter]} onPress={onCenter}>
          <Text style={styles.camPtSymbol}>◎</Text>
        </TouchableOpacity>
        {arrow('▶', -1, 0)}
      </View>
      {arrow('▼', 0, -1)}
      {/* Bascule avant/arriere : le libelle indique la vue QUE L'ON VERRA en
          appuyant. Masquee en plein ecran (les 2 cameras sont deja affichees). */}
      {showViewToggle && (
        <TouchableOpacity style={[styles.camPtBtn, styles.camPtView]} onPress={onToggleView}>
          <Text style={styles.camPtViewText}>{view === 'front' ? 'AR' : 'AV'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function DriveJoystick({
  size = 150,
  onCommand,
  onMix,
  onRelease,
}: {
  size?: number;
  onCommand: (cmd: RobotDriveCommand) => void;
  // Quand il est fourni, on pilote en proportionnel (virage en arc possible).
  // Sinon on retombe sur les quatre directions, ce qui garde le composant
  // utilisable avec un firmware qui ne connait pas la commande M.
  onMix?: (g: number, d: number) => void;
  onRelease: () => void;
}) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const lastCmdRef = useRef<RobotDriveCommand | null>(null);
  const lastMixRef = useRef<string | null>(null);
  // Refs pour que le PanResponder (cree une seule fois) appelle toujours
  // la derniere version des callbacks.
  const onCommandRef = useRef(onCommand);
  const onMixRef = useRef(onMix);
  const onReleaseRef = useRef(onRelease);
  onCommandRef.current = onCommand;
  onMixRef.current = onMix;
  onReleaseRef.current = onRelease;

  const knobSize = size * 0.42;
  const maxDist = (size - knobSize) / 2;

  const reset = () => {
    setKnob({ x: 0, y: 0 });
    lastCmdRef.current = null;
    lastMixRef.current = null;
    onReleaseRef.current();
  };

  const panRef = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Ne pas ceder le geste au ScrollView parent pendant le pilotage
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_evt, g) => {
        const dist = Math.hypot(g.dx, g.dy);
        const capped = Math.min(dist, maxDist);
        const angle = Math.atan2(g.dy, g.dx);
        setKnob({ x: Math.cos(angle) * capped, y: Math.sin(angle) * capped });

        const enZoneMorte = dist < maxDist * 0.3;

        if (onMixRef.current) {
          // Melange d'arcade : l'avant fait avancer les deux cotes, le
          // lateral en ralentit un. On normalise pour qu'aucun cote ne
          // depasse 100 %, sinon pousser en diagonale saturerait et le
          // joystick deviendrait tout ou rien dans les coins.
          if (enZoneMorte) {
            if (lastMixRef.current !== null) {
              lastMixRef.current = null;
              onReleaseRef.current();
            }
            return;
          }
          const av = -(Math.sin(angle) * capped) / maxDist;  // y est vers le bas
          const tour = (Math.cos(angle) * capped) / maxDist;
          let g = av + tour;
          let d = av - tour;
          const m = Math.max(1, Math.abs(g), Math.abs(d));
          g = Math.round((g / m) * 100);
          d = Math.round((d / m) * 100);
          const cle = `${g},${d}`;
          if (cle !== lastMixRef.current) {
            lastMixRef.current = cle;
            onMixRef.current(g, d);
          }
          return;
        }

        let cmd: RobotDriveCommand | null = null;
        if (!enZoneMorte) {
          const deg = (angle * 180) / Math.PI; // 0 = droite, -90 = haut
          if (deg >= -135 && deg < -45) cmd = 'F';
          else if (deg >= -45 && deg < 45) cmd = 'R';
          else if (deg >= 45 && deg < 135) cmd = 'B';
          else cmd = 'L';
        }
        if (cmd !== lastCmdRef.current) {
          lastCmdRef.current = cmd;
          if (cmd) onCommandRef.current(cmd);
          else onReleaseRef.current(); // retour en zone morte = stop
        }
      },
      onPanResponderRelease: reset,
      onPanResponderTerminate: reset,
    })
  );

  return (
    <View
      style={[styles.joyBase, { width: size, height: size, borderRadius: size / 2 }]}
      {...panRef.current.panHandlers}
    >
      <Text style={[styles.joyHint, styles.joyHintTop]}>▲</Text>
      <Text style={[styles.joyHint, styles.joyHintBottom]}>▼</Text>
      <Text style={[styles.joyHint, styles.joyHintLeft]}>◀</Text>
      <Text style={[styles.joyHint, styles.joyHintRight]}>▶</Text>
      <View
        style={[
          styles.joyKnob,
          {
            width: knobSize,
            height: knobSize,
            borderRadius: knobSize / 2,
            transform: [{ translateX: knob.x }, { translateY: knob.y }],
          },
        ]}
      />
    </View>
  );
}

// Curseur de vitesse : glisser pour choisir, la valeur est envoyee au relacher.
export function SpeedSlider({
  pct,
  onPreview,
  onCommit,
  compact,
}: {
  pct: number;
  onPreview: (p: number) => void;
  onCommit: (p: number) => void;
  compact?: boolean;
}) {
  const widthRef = useRef(1);
  const startPctRef = useRef(pct);
  const lastPctRef = useRef(pct);
  const pctRef = useRef(pct);
  pctRef.current = pct;
  const onPreviewRef = useRef(onPreview);
  const onCommitRef = useRef(onCommit);
  onPreviewRef.current = onPreview;
  onCommitRef.current = onCommit;

  const panRef = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        startPctRef.current = pctRef.current;
        lastPctRef.current = pctRef.current;
      },
      onPanResponderMove: (_evt, g) => {
        const p = Math.max(
          0,
          Math.min(100, startPctRef.current + (g.dx / widthRef.current) * 100)
        );
        lastPctRef.current = p;
        onPreviewRef.current(Math.round(p));
      },
      onPanResponderRelease: () => onCommitRef.current(Math.round(lastPctRef.current)),
      onPanResponderTerminate: () => onCommitRef.current(Math.round(lastPctRef.current)),
    })
  );

  return (
    <View
      style={[styles.speedTrack, compact && styles.speedTrackCompact]}
      onLayout={(e) => {
        widthRef.current = Math.max(1, e.nativeEvent.layout.width);
      }}
      {...panRef.current.panHandlers}
    >
      <View style={[styles.speedFill, { width: `${pct}%` }]} />
      <View style={[styles.speedThumb, { left: `${pct}%` }]} />
    </View>
  );
}

export function ExpandButton({ active, onPress }: { active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.expandBtn} onPress={onPress}>
      <Text style={styles.expandBtnText}>{active ? '✕' : '⤢'}</Text>
    </TouchableOpacity>
  );
}

// Temoin de connexion du robot (Pi) : pastille coloree + libelle.
export function RobotLinkBadge({
  status,
  detail,
}: {
  status: 'connecting' | 'connected' | 'disconnected';
  detail?: string;
}) {
  const conf = {
    connected: { color: '#00E5A0', label: 'Robot connecté' },
    connecting: { color: '#FFC24D', label: 'Connexion…' },
    disconnected: { color: '#FF5069', label: 'Robot déconnecté' },
  }[status];
  return (
    <View style={styles.linkBadge}>
      <View style={[styles.linkDot, { backgroundColor: conf.color }]} />
      <Text style={[styles.linkBadgeText, { color: conf.color }]}>{conf.label}</Text>
      {status === 'connected' && !!detail && (
        <Text style={styles.linkBadgeDetail}>· {detail}</Text>
      )}
    </View>
  );
}
