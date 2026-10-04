'use strict';
/**
 * H1 随包机械自检（第四十九轮 R50 重写——review-r49 §5）：**文件/清单**存在性与完整性检查，
 * 不需要远程启用/配对/daemon。对包内 ZhongshuoDual/MANIFEST-SHA256.json 逐件核对字节/长度/
 * SHA-256（591 件全量，几秒完成），并检查 H1 必备随包件（seed 依赖、说明、模板）。
 * 用法：node h1-self-check.cjs --pkg <包目录>；退出 0=全部一致。
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const pkg = (() => {
  const i = process.argv.indexOf('--pkg');
  if (i < 0 || process.argv[i + 1] == null) { console.error('usage: node h1-self-check.cjs --pkg <package-dir>'); process.exit(2); }
  return path.resolve(process.argv[i + 1]);
})();

const required = [
  'start-server.bat',
  'run-self-check.bat',
  'README-H1.md',
  'RESULTS/SHORT-TEST-template.md',
  'seed/seed-client.cjs',
  'seed/回归幻灯.pptx',
  'seed/h1-self-check.cjs',
  'ZhongshuoDual/electron.exe',
  'ZhongshuoDual/BUILD.json',
  'ZhongshuoDual/MANIFEST-SHA256.json',
];
let bad = 0;
for (const rel of required) {
  if (!fs.existsSync(path.join(pkg, rel))) { console.error(`[h1-self-check] 缺失 ${rel}`); bad += 1; }
}
const manifestPath = path.join(pkg, 'ZhongshuoDual', 'MANIFEST-SHA256.json');
if (!fs.existsSync(manifestPath)) { process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
let checked = 0;
for (const f of manifest.files) {
  const p = path.join(pkg, 'ZhongshuoDual', f.path);
  if (!fs.existsSync(p)) { console.error(`[h1-self-check] 清单缺失 ${f.path}`); bad += 1; continue; }
  const bytes = fs.statSync(p).size;
  if (bytes !== f.bytes) { console.error(`[h1-self-check] 长度不符 ${f.path}`); bad += 1; continue; }
  const sha = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (sha !== f.sha256) { console.error(`[h1-self-check] 哈希不符 ${f.path}`); bad += 1; }
  checked += 1;
}
const build = JSON.parse(fs.readFileSync(path.join(pkg, 'ZhongshuoDual', 'BUILD.json'), 'utf8'));
console.log(`[h1-self-check] 清单核对 ${checked}/${manifest.files.length} 一致，不符 ${bad}；buildId=${build.buildId} commit=${String(build.commit).slice(0, 8)} dirty=${build.dirty}`);
process.exit(bad === 0 ? 0 : 1);
