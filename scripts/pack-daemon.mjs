/**
 * DEV-15 早期打包验证（第十三轮四）：daemon 侧 esbuild 产物——本地可复核，不发布。
 *
 * 产物：dist/pack/daemon.cjs（CJS bundle，platform=node；原生依赖 external——
 * koffi/better-sqlite3 的 .node 在运行时由 Node 从 node_modules 解析，不进 bundle）。
 * 入口哨兵：entry.ts 的独立入口判定按 argv[1] 尾缀——bundle 后 argv[1]=daemon.cjs，
 * 改由环境变量 ZS_PACKED_ENTRY=1 触发（entry.ts 内已加该分支）。
 */
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

await build({
  entryPoints: ['src/daemon/entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/pack/daemon.cjs',
  external: ['koffi', 'better-sqlite3', 'electron'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
// pdfjs worker 随包携带（第二十八轮五）：自包含 ESM——pdfText 在打包模式按同目录解析。
copyFileSync(join(import.meta.dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'), join(import.meta.dirname, '..', 'dist', 'pack', 'pdf.worker.mjs'));
console.log('[pack] dist/pack/daemon.cjs + pdf.worker.mjs 完成');
