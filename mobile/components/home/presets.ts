import type { RobotDriveCommand } from './types';

export const ONBOARD_KEY = 'hasSeenTutorial_v1';

// ========================
// Presets
// ========================
const DEDUPE = (arr: string[]) => Array.from(new Set(arr.map((s) => s.trim())));

const PRESET_MESSAGES = DEDUPE([
  'Tu es là ?',
  'Vous êtes là ?',
  'Oui',
  'Non',
  'Reçu',
  'Appelle-moi',
]);

const JOIN_MESSAGES = DEDUPE([
  'Je démarre',
  'Je suis en route',
  'J’y suis presque',
  "J’arrive",
  'Je suis devant',
  'Je suis au portail',
  'Je suis là',
]);

const SUGGESTIONS = DEDUPE([
  'Oui je suis là',
  'Oui on est là',
  'Je confirme',
  'Ça roule',
  'Parfait',
]);

export const ROBOT_DRIVE_LABELS: Record<RobotDriveCommand, string> = {
  F: 'Avancer',
  B: 'Reculer',
  L: 'Gauche',
  R: 'Droite',
  S: 'Stop',
  '+': 'Accelerer',
  '-': 'Ralentir',
};
export const ROBOT_DRIVE_BUZZ_PREFIX = 'PING_ROBOT_DRIVE:';
export const ROBOT_ACK_BUZZ_PREFIX = 'PING_ROBOT_ACK:';
export const ROBOT_ONLINE_BUZZ_PREFIX = 'PING_ROBOT_ONLINE:';
export const ROBOT_CAM_BUZZ_PREFIX = 'PING_ROBOT_CAM:';
// Pan-tilt camera : degres ajoutes a chaque pas (le maintien repete ~7x/s).
export const CAM_STEP_DEG = 5;

// Encodeur base64 maison : le robot envoie desormais les images camera en
// BINAIRE (25% de data en moins sur la 4G que l'ancien base64). React Native
// ne sait afficher qu'une data-URI base64, donc on convertit ici, cote app,

export const SAY_PRESETS_KEY = 'sayPresets_v1';
export const DEFAULT_SAY_PRESETS = [
  'Bonjour !',
  'Pousse-toi, je passe',
  'Suis-moi',
  'Attention',
  'Merci !',
  'Au revoir',
];
export const ROBOT_DEBUG_LOGS = false;
