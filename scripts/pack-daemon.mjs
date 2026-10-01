/**
 * DEV-15 早期打包验证（第十三轮四）：daemon 侧 esbuild 产物——本地可复核，不发布。
 *
 * 产物：dist/pack/daemon.cjs（CJS bundle，platform=node；原生依赖 external——
 * koffi/better-sqlite3 的 .node 在运行时由 Node 从 node_modules 解析，不进 bundle）。
 * 入口哨兵：entry.ts 的独立入口判定按 argv[1] 尾缀——bundle 后 argv[1]=daemon.cjs，
 * 改由环境变量 ZS_PACKED_ENTRY=1 触发（entry.ts 内已加该分支）。
 */
import { build } from 'esbuild';
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

await build({
  entryPoints: ['src/daemon/entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/pack/daemon.cjs',
  // esbuild 仅源码形态按需构建解析 worker 用（动态 import，生产产物恒走随包 parse-worker.mjs
  // 不触达）——外部化避免打包 JS API；koffi/better-sqlite3 原生 .node 运行时解析。
  external: ['koffi', 'better-sqlite3', 'electron', 'esbuild'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
// 文档解析子进程（第二十九轮一）：独立 ESM 产物——pdfjs/mammoth/xlsx/fflate 全部收进
// 本 worker（daemon 主进程零解析依赖）；与 daemon.cjs 同目录部署。
await build({
  entryPoints: ['src/daemon/parseWorker.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/pack/parse-worker.cjs',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});
// pdfjs worker 随包携带（第二十八轮五）：自包含 ESM——解析 worker 在打包模式按同目录解析。
copyFileSync(join(import.meta.dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'), join(import.meta.dirname, '..', 'dist', 'pack', 'pdf.worker.mjs'));
// pdfjs CMap 资源随包（第二十九轮三：预定义 CJK CMap（如 UniGB-UCS2-H/GBK-EUC-H）解码
// 需要——离线携带，不依赖开发机 node_modules）。
mkdirSync(join(import.meta.dirname, '..', 'dist', 'pack', 'cmaps'), { recursive: true });
cpSync(join(import.meta.dirname, '..', 'node_modules', 'pdfjs-dist', 'cmaps'), join(import.meta.dirname, '..', 'dist', 'pack', 'cmaps'), { recursive: true });
console.log('[pack] dist/pack/daemon.cjs + parse-worker.mjs + pdf.worker.mjs + cmaps 完成');
