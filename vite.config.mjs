import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import browserslistToEsbuild from 'browserslist-to-esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default project (linked IDM Dashboard); override per client via `.env` / CI. */
const DEFAULT_SUPABASE_URL = 'https://ausivxesedagohjlthiy.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1c2l2eGVzZWRhZ29oamx0aGl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNTU3MTEsImV4cCI6MjA5MDYzMTcxMX0.H5PRdJVXCq8_9CbB12F6xFzy0ljqz1-aiVZmguErLxk';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const supabaseUrl = (env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const supabaseAnon = env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

  return {
  root: __dirname,
  publicDir: 'public',
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  define: {
    __BIZDASH_SUPABASE_URL__: JSON.stringify(supabaseUrl),
    __BIZDASH_SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnon),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: browserslistToEsbuild(),
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        manualChunks: {
          supabase: ['@supabase/supabase-js'],
          charts: ['chart.js'],
          radix: [
            '@radix-ui/react-dialog',
            '@radix-ui/react-popover',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-checkbox',
            '@radix-ui/react-label',
            '@radix-ui/react-slot',
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
};
});
