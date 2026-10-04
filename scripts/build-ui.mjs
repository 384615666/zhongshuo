/**
 * UI 构建（DEV-07）：esbuild 打包 main/preload 为 .cjs（package type:module 下
 * .js 会被按 ESM 解析，ADR-I38 说明）；renderer 为静态文件直接拷贝。
 */
import { build } from 'esbuild';
import { cpSync, rmSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// hifi 换装壳（第四十六轮 H1）：原型批准组件（src/ui/hifi 原样拷贝）+ 真实 store/桥——
// esbuild 打包为 ESM（.mjs——zsres/HTTP 下模块 MIME 正确）。样式不在 JS 里 import：
// 壳挂载时才注入 <link>（legacy 专项对照运行不加载——原型全局样式不污染原界面），
// 此处把四份原型 CSS 汇成 hifi/app.css。
await build({
  entryPoints: [join(root, 'src', 'ui', 'hifi', 'main.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  outfile: join(root, 'dist', 'ui', 'renderer', 'hifi', 'app.mjs'),
  sourcemap: false,
  logLevel: 'info',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
});
mkdirSync(join(root, 'dist', 'ui', 'renderer', 'hifi'), { recursive: true });
writeFileSync(
  join(root, 'dist', 'ui', 'renderer', 'hifi', 'app.css'),
  ['tokens.css', 'base.css', 'components.css', 'titlebar.css'].map((f) => readFileSync(join(root, 'src', 'ui', 'hifi', 'styles', f), 'utf8')).join('\n'),
  'utf8',
);

// 渲染器 pdfjs 资产（第二十九轮三）：受限预览侧视觉渲染用——vendored（node_modules 拷贝，
// 不入库；.gitignore 覆盖 src/ui/renderer/assets/）。先同步进 src 再整体拷贝 dist。
const assetsDir = join(root, 'src', 'ui', 'renderer', 'assets', 'pdfjs');
mkdirSync(assetsDir, { recursive: true });
const pdfjsBuild = join(root, 'node_modules', 'pdfjs-dist', 'build');
copyFileSync(join(pdfjsBuild, 'pdf.min.mjs'), join(assetsDir, 'pdf.min.mjs'));
copyFileSync(join(pdfjsBuild, 'pdf.worker.min.mjs'), join(assetsDir, 'pdf.worker.min.mjs'));
cpSync(join(root, 'node_modules', 'pdfjs-dist', 'cmaps'), join(assetsDir, 'cmaps'), { recursive: true });

// 预览引擎 vendor（第四十轮·选型决定 A）：
// - PPTX=pptx-renderer 1.3.0 浏览器 ESM 单文件——**受管 vendored 产物入库**
//   （src/ui/vendor/pptx-renderer/，PROVENANCE.json 钉版本+sha256+许可；peerOptional
//   pdfjs>=5 仅 EMF 回退用，产品显式 pdfjs:false 不升级既有 4.10 链）。
// - Word=docx-preview 0.4.1 UMD + 其 peer JSZip 3.10.2——固定版本依赖，从 node_modules 同步。
// 全部本地随包（不走 CDN）；构建后哈希核对与 PROVENANCE 一致性见 verify 脚本。
const vendorDir = join(root, 'src', 'ui', 'renderer', 'assets', 'vendor');
mkdirSync(vendorDir, { recursive: true });
copyFileSync(join(root, 'src', 'ui', 'vendor', 'pptx-renderer', 'aiden0z-pptx-renderer.browser.es.js'), join(vendorDir, 'pptx-renderer.es.mjs')); // .mjs——zsres 下 ESM MIME 保证（与 pdfjs 同法）
copyFileSync(join(root, 'node_modules', 'docx-preview', 'dist', 'docx-preview.min.js'), join(vendorDir, 'docx-preview.min.js'));
copyFileSync(join(root, 'node_modules', 'jszip', 'dist', 'jszip.min.js'), join(vendorDir, 'jszip.min.js'));
// 第三十九轮净化组件（DOMPurify/markdown-it）——此前手工拷贝未入构建，补同步（正式依赖）。
copyFileSync(join(root, 'node_modules', 'dompurify', 'dist', 'purify.min.js'), join(vendorDir, 'purify.min.js'));
copyFileSync(join(root, 'node_modules', 'markdown-it', 'dist', 'markdown-it.min.js'), join(vendorDir, 'markdown-it.min.js'));

cpSync(join(root, 'src', 'ui', 'renderer'), join(root, 'dist', 'ui', 'renderer'), { recursive: true });
process.stdout.write('[build:ui] dist/ui 就绪（main.cjs / preload.cjs / renderer/ + assets/pdfjs + assets/vendor）\n');
