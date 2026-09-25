import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5280,
    strictPort: false,
    watch: {
      // 忽略编辑器/工具写入过程中的临时文件与目录。
      // 不忽略的话，写文件的一瞬间可能被 watcher 抓到 EBUSY 而让 dev server 退出。
      ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/.git/**'],
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
