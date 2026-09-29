import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3021,
    proxy: {
      '/auth': 'http://localhost:8005',
      '/feed': 'http://localhost:8005',
      '/suggestions': 'http://localhost:8005',
      '/tags': 'http://localhost:8005',
      '/clips': 'http://localhost:8005',
      '/interactions': 'http://localhost:8005',
      '/comments': 'http://localhost:8005',
      '/share': 'http://localhost:8005',
      '/follow': 'http://localhost:8005',
      '/profile': 'http://localhost:8005'
    }
  }
})