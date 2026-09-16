module.exports = {
  dependencies: {
    '@react-native-firebase/app': {
      platforms: {
        android: {
          packageInstance: 'new ReactNativeFirebaseAppPackage()',
        },
      },
    },
    '@react-native-firebase/messaging': {
      platforms: {
        android: {
          packageInstance: 'new ReactNativeFirebaseMessagingPackage()',
        },
      },
    },
  },
};
