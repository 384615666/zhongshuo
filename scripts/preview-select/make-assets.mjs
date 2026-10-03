/**
 * 预览选型验证（2026-10-03）：样本资产准备。
 * 1) 生成嵌入/外链两幅 PNG 资产；2) 把第三十九轮手造样本复制进同一批样本目录。
 * 产物落 dist/desktop/preview-select/samples/（原型工作区，不入库）。
 */
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as craft from '../lib/craftDocuments.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/desktop/preview-select');
const samples = join(root, 'samples');
const assets = join(samples, 'assets');
mkdirSync(assets, { recursive: true });

writeFileSync(join(assets, 'embed-pic.png'), craft.makePng(320, 200, [30, 144, 140]));
writeFileSync(join(assets, 'linked-pic.png'), craft.makePng(280, 180, [148, 32, 32]));

const loSamples = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/desktop/pptx-lo-proto/samples');
for (const n of ['dense-deck.pptx', 'rich-deck.pptx']) {
  copyFileSync(join(loSamples, n), join(samples, n));
}
console.log('[assets] OK ->', samples);
