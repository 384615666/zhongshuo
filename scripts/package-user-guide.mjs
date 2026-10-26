import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guideDir = join(repo, 'docs', 'user-guide');
const sections = [
  ['start', '第一次打开'],
  ['projects', '项目与房间'],
  ['members', '添加AI'],
  ['chat', '发消息与追问'],
  ['dm', '私信'],
  ['progress', '进展与停止'],
  ['find', '搜索与任务看板'],
  ['results', '成果与修改'],
  ['files', '附件与预览'],
  ['git', '浏览项目文件'],
  ['settings', '外观与通知'],
  ['optional', '备份与恢复'],
  ['send', '发送后看哪里'],
  ['help', '常见问题'],
];

export function renderUserGuide({ assetPrefix = '', markdownPath = 'README.md', embedded = false } = {}) {
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false });
  for (const [rule, attribute] of [['image', 'src'], ['link_open', 'href']]) {
    const original = md.renderer.rules[rule];
    md.renderer.rules[rule] = (tokens, index, options, env, renderer) => {
      const value = tokens[index].attrGet(attribute);
      if (value?.startsWith('images/')) tokens[index].attrSet(attribute, assetPrefix + value);
      return original ? original(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
    };
  }
  md.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  const body = md.render(readFileSync(join(guideDir, 'README.md'), 'utf8'));
  const tokens = readFileSync(join(repo, 'src', 'ui', 'hifi', 'styles', 'tokens.css'), 'utf8');
  const nav = sections.map(([id, label], index) => `<a href="#${id}"><span>${String(index + 1).padStart(2, '0')}</span>${label}</a>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>众说操作手册</title>
<style>
${tokens}
:root{font-family:var(--font);color:var(--text);background:var(--bg-surface);font-size:15px;line-height:1.85}
*{box-sizing:border-box}
html{scroll-padding-top:24px;scrollbar-gutter:stable}
body{margin:0}
a{color:var(--accent-text);text-underline-offset:3px}
a:hover{color:var(--accent-hover)}
a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.topbar{position:sticky;top:0;z-index:2;background:var(--bg-surface);border-bottom:1px solid var(--border-subtle);padding:14px 28px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{font-weight:650;font-size:16px}.edition{font-size:12px;font-weight:400;color:var(--text-3);margin-left:12px}.topbar a{font-size:13px}
.layout{max-width:1280px;margin:0 auto;display:grid;grid-template-columns:196px minmax(0,1fr);gap:40px;padding:28px}
aside{position:sticky;top:84px;align-self:start;max-height:calc(100vh - 100px);overflow-y:auto;scrollbar-width:thin;border-right:1px solid var(--border-subtle);padding-right:16px}
aside p{font-size:12px;font-weight:600;color:var(--text-3);margin:0 8px 10px}
aside a{display:flex;align-items:baseline;gap:10px;text-decoration:none;color:var(--text-2);padding:7px 8px;border-radius:6px;font-size:13px;line-height:1.55}
aside a:hover,aside a:focus-visible{background:var(--bg-hover);color:var(--accent-text)}
aside span{color:var(--text-4);font-size:11px;font-variant-numeric:tabular-nums}
main{min-width:0;overflow-wrap:anywhere}
h1,h2,h3{color:var(--text);line-height:1.5;font-weight:650}
h1{font-size:26px;margin:0 0 10px}
h1+p{color:var(--text-3);font-size:12px}
h2{font-size:21px;margin:36px 0 16px;border-top:1px solid var(--border-subtle);padding-top:24px}
h3{font-size:16px;margin:24px 0 10px}
p{margin:10px 0 16px}
li{padding-left:2px;margin:6px 0}
strong{font-weight:650}
code{font-family:var(--font-mono);font-size:.88em;overflow-wrap:anywhere;background:var(--bg-surface-2);padding:2px 5px;border-radius:4px}
.table-scroll{overflow-x:auto;margin:18px 0 24px}
table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.7}
th,td{padding:10px 12px;border-bottom:1px solid var(--border-subtle);text-align:left;vertical-align:top;min-width:100px}
th{background:var(--bg-surface-2);color:var(--text-2);font-weight:600}
tr:last-child td{border-bottom:1px solid var(--border-subtle)}
img{display:block;max-width:100%;height:auto;border:1px solid var(--border);border-radius:6px;margin:24px auto 8px}
.guide-flow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0}
.guide-flow>div{display:flex;flex-direction:column;gap:8px;padding:16px;background:var(--bg-surface-2);border-radius:6px}
.guide-flow strong{color:var(--accent-text)}.guide-flow span{font-size:13px;color:var(--text-2)}.guide-flow b{font-size:13px;font-weight:600}
p:has(>em:only-child){color:var(--text-3);font-size:12px}
hr{border:0;border-top:1px solid var(--border-subtle);margin:28px 0}
summary{cursor:pointer;font-weight:600}
details{border:1px solid var(--border);border-radius:6px;padding:12px 16px}
details p{margin:12px 0 0}
.repair-example{background:var(--bg-surface-2);padding:16px;border:1px solid var(--border);border-radius:6px}
.repair-current{margin-top:12px;border-left:2px solid var(--accent);padding:10px 14px}.repair-current p{margin:6px 0 0}
.footer{margin:0 auto 24px;padding:0 28px;font-size:12px;text-align:center;color:var(--text-3)}
body.embedded .layout{max-width:none;margin:0;grid-template-columns:188px minmax(0,900px);padding:8px 24px 40px 0;gap:32px}
body.embedded aside{top:8px;max-height:calc(100vh - 24px)}
body.embedded .footer{display:none}
@media(max-width:700px){
 .guide-flow{grid-template-columns:minmax(0,1fr)}
 .layout,body.embedded .layout{grid-template-columns:minmax(0,1fr);padding:16px;gap:20px}
 aside,body.embedded aside{position:static;max-height:none;overflow:visible;border:0;border-bottom:1px solid var(--border-subtle);padding:0 0 16px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 8px}
 aside p{grid-column:1/-1;margin-bottom:6px}aside a{padding:5px 6px;font-size:12px}
 h1{font-size:23px}h2{font-size:19px}.topbar{padding:12px 16px}.edition{display:none}
}
@media print{
 :root{background:#fff;color:#111;font-size:11pt}.topbar,aside,.footer{display:none}
 .layout,body.embedded .layout{display:block;padding:0}h2,h3{break-after:avoid}
 table{font-size:10pt}tr,img,.repair-example{break-inside:avoid}img{max-height:150mm;object-fit:contain}
 .table-scroll{overflow:visible}a{color:inherit}
}
</style>
</head>
<body${embedded ? ' class="embedded"' : ''}>
${embedded ? '' : `<header class="topbar"><div class="brand">众说<span class="edition">用户操作手册</span></div><a href="${markdownPath}">查看文字版</a></header>`}
<div class="layout"><aside aria-label="章节导航"><p>按问题找操作</p>${nav}</aside><main>${body}</main></div>
<footer class="footer">${embedded ? '操作手册随当前程序版本提供 · 可离线阅读' : '本手册可离线阅读 · 浏览器 Ctrl + P 可打印或另存为 PDF'}</footer>
</body>
</html>
`;
}

export function writeUserGuide() {
  writeFileSync(join(guideDir, 'index.html'), renderUserGuide(), 'utf8');
}

/** Build the in-app manual from the same source as the offline manual. */
export function packageUserGuideAssets(target) {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'index.html'), renderUserGuide({ embedded: true }), 'utf8');
  if (existsSync(join(guideDir, 'images'))) cpSync(join(guideDir, 'images'), join(target, 'images'), { recursive: true });
}

/** Only documentation beside the program is changed; app payload and data stay outside this operation. */
export function packageUserGuide(packageDir) {
  const out = resolve(packageDir);
  if (!existsSync(join(out, 'ZhongshuoDual', 'BUILD.json'))) {
    throw new Error(`不是已构建的日常桌面包：${out}`);
  }
  writeUserGuide();
  mkdirSync(join(out, '操作手册'), { recursive: true });
  cpSync(guideDir, join(out, '操作手册'), { recursive: true });
  writeFileSync(join(out, '众说操作手册.html'), renderUserGuide({ assetPrefix: '操作手册/', markdownPath: '操作手册/README.md' }), 'utf8');
  const readmePath = join(out, 'README-DAILY.md');
  const previous = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  const history = previous.replace(/<!-- user-guide:start -->[\s\S]*?<!-- user-guide:end -->\s*/, '');
  const launch = '首次使用便携版：双击 `start-desktop.vbs`。使用已有数据或备份：打开“设置 → 数据与存储”，选择“使用已有数据或从备份恢复”。';
  writeFileSync(readmePath, `<!-- user-guide:start -->
# 先看操作手册

在应用中打开 **设置 → 操作手册**，即可阅读完整操作手册。也可双击 [众说操作手册.html](众说操作手册.html) 离线阅读，或阅读 [文字版](操作手册/README.md)。

${launch}

手册包含：带编号的界面截图、分步操作、操作结果和常见问题。从打开项目、添加AI到发送第一条消息，按图即可上手。

下方保留的是历轮打包记录，可能包含旧入口和旧限制；当前操作请先按随包手册。
<!-- user-guide:end -->

${history}`, 'utf8');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2]) console.log(`操作手册已附带到：${packageUserGuide(process.argv[2])}`);
  else { writeUserGuide(); console.log(`操作手册已生成：${join(guideDir, 'index.html')}`); }
}
