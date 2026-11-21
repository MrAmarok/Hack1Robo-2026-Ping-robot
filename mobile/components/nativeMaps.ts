export function loadNativeMaps(): typeof import('react-native-maps') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load only when the map is needed.
    return require('react-native-maps');
  } catch {
    return null;
  }
}
