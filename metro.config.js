const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const defaultConfig = getDefaultConfig(__dirname);
const config = {
  resolver: {
    blockList: new RegExp(
      `(${defaultConfig.resolver.blockList.source}|${/[\\/]android[\\/]build[\\/].*/.source})`,
    ),
  },
};

module.exports = mergeConfig(defaultConfig, config);
