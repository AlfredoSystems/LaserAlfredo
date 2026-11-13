import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths, so the build works at any URL (e.g. GitHub Pages under /LaserAlfredo/).
  base: './',
  plugins: [react()],
  server: {
    // Local-first: reachable from other machines on the LAN.
    host: true,
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
  },
});
