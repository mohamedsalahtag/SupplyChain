import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5300,
    strictPort: true,
    // 127.0.0.1, not localhost: on Windows "localhost" tries IPv6 (::1) first and the API listens on IPv4 only,
    // which added ~200 ms to every call.
    proxy: { '/trpc': 'http://127.0.0.1:4300', '/files': 'http://127.0.0.1:4300' },
  },
});
