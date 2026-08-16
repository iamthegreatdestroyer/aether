import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the same build serves at "/" locally and under "/<repo>/" on GitHub
  // Pages without a rebuild — the Tier B hosting story depends on Pages working as-is.
  base: '',
  server: {
    port: 5175,
    // All interfaces, so the P0 exit test ("PWA installs on phone") can run over LAN.
    host: true,
  },
  build: { target: 'es2022' },
});
