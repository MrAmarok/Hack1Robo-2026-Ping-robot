import { type RecordingOptions, IOSOutputFormat, AudioQuality } from 'expo-audio';

const B64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    parts.push(
      B64_CHARS[b0 >> 2],
      B64_CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)],
      b1 === undefined ? '=' : B64_CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)],
      b2 === undefined ? '=' : B64_CHARS[b2 & 63]
    );
  }
  return parts.join('');
}
export const TALKIE_MIN_BYTES = 2000;
export const TALKIE_MAX_BYTES = 2 * 1024 * 1024;
export const TALKIE_MIN_STOP_DELAY_MS = 350;
export const TALKIE_MAX_DURATION_MS = 20000;
export const TALKIE_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 64000,
  },
};
