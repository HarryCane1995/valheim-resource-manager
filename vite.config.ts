import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createDevProxy } from './scripts/vite-proxy.mjs';
export default defineConfig({plugins:[react(),tailwindcss()],server:{host:'127.0.0.1',port:5173,proxy:createDevProxy()}});
