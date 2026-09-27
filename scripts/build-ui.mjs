/**
 * UI 构建（DEV-07）：esbuild 打包 main/preload 为 .cjs（package type:module 下
 * .js 会被按 ESM 解析，ADR-I38 说明）；renderer 为静态文件直接拷贝。
 */
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

rmSync(join(root, 'dist', 'ui'), { recursive: true, force: true });

for (const entry of ['main', 'preload']) {
  await build({
    entryPoints: [join(root, 'src', 'ui', `${entry}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: join(root, 'dist', 'ui', `${entry}.cjs`),
    sourcemap: false,
    logLevel: 'info',
  });
}

cpSync(join(root, 'src', 'ui', 'renderer'), join(root, 'dist', 'ui', 'renderer'), { recursive: true });
process.stdout.write('[build:ui] dist/ui 就绪（main.cjs / preload.cjs / renderer/）\n');
