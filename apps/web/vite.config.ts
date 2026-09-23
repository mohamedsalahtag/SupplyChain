import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5300,
    strictPort: true,
    proxy: { '/trpc': 'http://localhost:4300' },
  },
});
