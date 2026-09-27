// 文档完整性检查：不是 runtime/业务实现测试。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const main=read('docs/zhongshuo-development-design-v1.md');
const matrix=read('docs/development-delivery-matrix-v1.23.md');
const baseline=read('docs/development-baseline-v1.23.md');
const checklist=read('docs/pre-development-checklist.md');
let count=0;
function check(name,ok){if(!ok)throw Error(name);count++;console.log('PASS '+name)}
const ids=s=>[...s.matchAll(/^\|\s*([A-Z]+-\d+)\s*\|/gm)].map(m=>m[1]);
const original=ids(main.slice(main.indexOf('\n## 27.'),main.indexOf('\n## 28.')));
const mapped=ids(matrix).filter(id=>!id.startsWith('DEV-')&&!id.startsWith('FULL-'));
check('137 项无重复且与主设计完全一致',original.length===137&&mapped.length===137&&new Set(mapped).size===137&&original.every(id=>mapped.includes(id)));
for(const n of [21,22,23,24,25])check('新增 DEV-'+n+' 有工作包定义',matrix.includes('| DEV-'+n+' |'));
check('主设计版本已同步',main.includes('开发设计报告 v1.23 · 2026-09-26'));
check('DEV-16 包含新增发布依赖',main.includes('DEV-10—15、17—19、21—25'));
check('开工清单设计勾选与实现未认证分开',checklist.includes('当前执行状态（2026-09-26，v1.23）')&&checklist.includes('- [ ] B6')&&checklist.includes('- [ ] D6'));
check('DM 保留 record_only 与内部执行/上下文区别',baseline.includes('record_only 只保存')&&baseline.includes('kind=dm_turn')&&baseline.includes('不同 conversationId 永不共享 session'));
check('七类附件与额外范围明确',matrix.includes('文本、代码、图片、PDF、Word、Excel、PPT')&&matrix.includes('音视频（FULL-03）'));
for(const p of ['docs/development-baseline-v1.23.md','docs/development-delivery-matrix-v1.23.md','docs/dev-briefs/dev-01-contracts-and-routing.md']){
  const s=read(p);
  for(const m of s.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
    if(/^https?:/.test(m[1])||m[1].startsWith('#'))continue;
    const target=m[1].split('#')[0];
    check(`${p} 的链接 ${target}`,fs.existsSync(path.resolve(root,path.dirname(p),target)));
  }
}
console.log(`${count}/${count} 文档完整性检查通过；不认证运行能力。`);
