import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.idm.bizdash',
  appName: 'Business Dashboard',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    App: {
      launchUrl: 'bizdash://auth',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;

