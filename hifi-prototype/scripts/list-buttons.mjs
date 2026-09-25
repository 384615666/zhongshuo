/**
 * 源码级按钮清单：把每个 `<button className="...">` 及其文字标签列出来，
 * 用于判断"哪些按钮该是主按钮（--grad）却用了次按钮样式"。
 *
 * 依据规范 §5.8：主按钮 = --grad；次按钮 = 白底 + 描边。
 * 依据规范 §7「empty」：空态要"一个主操作"。
 * 依据规范 §5.3 第 118 行：一个操作区最多一个 --grad 主按钮。
 *
 * 用法：node scripts/list-buttons.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

const ACTION = /新建|创建|发送|保存|引用|添加|提交|确定|开始|导出|打开文件夹|重试|应用|写入|归档|停止|移除|删除|移出|重置|安装|连接|登录|重启|批准|通过|允许|执行/;

const rows = [];
for (const file of walk(root)) {
  const src = readFileSync(file, 'utf8');
  const re = /<button\b([^>]*)>([\s\S]{0,220}?)<\/button>/g;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    const body = m[2];
    const cls = (attrs.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/) ?? [])[1]
      ?? (attrs.match(/className=\{`([^`]*)`\}/) ?? [])[1] ?? '';
    // 去掉 <Icon .../> 与注释，取纯文字
    const text = body
      .replace(/<Icon[^>]*\/>/g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const line = src.slice(0, m.index).split('\n').length;
    rows.push({ file: relative(root, file).replace(/\\/g, '/'), line, cls, text: text.slice(0, 26) });
  }
}

/* 语义上是"主操作"但类名没有 primary 的 —— 这些是候选漏改 */
const suspects = rows.filter((r) => ACTION.test(r.text)
  && !/\bprimary\b/.test(r.cls)
  && !/\bdanger\b/.test(r.cls)
  && !/\bghost\b/.test(r.cls));

console.log(`共 ${rows.length} 个带文字按钮\n`);
console.log('=== 候选：主操作语义但未用 .btn.primary ===');
if (!suspects.length) console.log('  （无）');
for (const s of suspects) {
  console.log(`  ${s.file}:${s.line}  [${s.cls || '(no class)'}]  "${s.text}"`);
}

console.log('\n=== 全部 primary 按钮（--grad）===');
for (const r of rows.filter((x) => /\bprimary\b/.test(x.cls))) {
  console.log(`  ${r.file}:${r.line}  [${r.cls}]  "${r.text}"`);
}
