import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5174,
    // Bind on all interfaces so the exit test's second half — "usable on your phone" — can be
    // run by pointing the phone at this machine's LAN address. A laptop-only benchmark does
    // not settle G0.4.
    host: true,
  },
  build: { target: 'es2022' },
});
