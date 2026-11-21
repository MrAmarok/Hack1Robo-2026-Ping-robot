const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // WebRTC imports a private subpath of event-target-shim.
  if (
    moduleName === 'event-target-shim/index' &&
    /[/\\]node_modules[/\\]react-native-webrtc[/\\]/.test(context.originModulePath)
  ) {
    return context.resolveRequest(context, 'event-target-shim', platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
