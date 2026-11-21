module.exports = {
  presets: ['babel-preset-expo'],
  plugins: [
    // Doit ABSOLUMENT être le dernier plugin
    'react-native-reanimated/plugin'
  ],
};
