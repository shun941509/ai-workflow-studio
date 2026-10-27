import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** This build is served by the authenticated Runner origin; no development server is exported. */
export default defineConfig({ plugins: [react()], build: { outDir: 'dist', sourcemap: false }, base: '/' });
