import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guideDir = join(repo, 'docs', 'user-guide');
const sections = [
  ['start', '打开与退出'],
  ['projects', '项目与房间'],
  ['members', '成员与AI设置'],
  ['chat', '房间聊天与协作'],
  ['dm', '私信'],
  ['progress', '任务进展'],
  ['find', '搜索、待办与看板'],
  ['results', '成果与修改'],
  ['files', '文件与附件'],
  ['git', '文件与Git'],
  ['settings', '通知和设置'],
  ['optional', '其他已有工具'],
  ['send', '发送异常'],
  ['help', '常见问题'],
];

export function renderUserGuide({ assetPrefix = '', markdownPath = 'README.md' } = {}) {
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
  const nav = sections.map(([id, label], index) => `<a href="#${id}"><span>${String(index + 1).padStart(2, '0')}</span>${label}</a>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>众说操作手册</title>
<style>
:root{font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#253549;background:#f3f6f9;font-size:16px;line-height:1.85;--accent:#087a70;--line:#dfe7ee}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:90px}body{margin:0}a{color:#086f9b;text-underline-offset:3px}a:hover{color:var(--accent)}
.topbar{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid var(--line);padding:12px 32px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{font-weight:800;font-size:20px;letter-spacing:.1em;color:#172d43}.edition{font-size:13px;letter-spacing:0;font-weight:500;color:#607488;margin-left:14px}.topbar a{font-size:13px}
.layout{max-width:1360px;margin:0 auto;display:grid;grid-template-columns:230px minmax(0,1fr);gap:28px;padding:30px}
aside{position:sticky;top:90px;align-self:start;padding:14px 0}aside p{font-size:12px;color:#6a7b8d;margin:0 12px 12px;letter-spacing:.1em}aside a{display:flex;gap:12px;text-decoration:none;color:#53657a;padding:9px 12px;border-radius:8px;font-size:14px}aside a:hover{background:#e4f1ee}aside span{color:#8b9aa9;font-size:12px;padding-top:2px}
main{min-width:0;background:#fff;border:1px solid var(--line);border-radius:16px;padding:38px 46px;box-shadow:0 8px 30px #263f5910}h1,h2,h3{color:#19334b;line-height:1.45}h1{font-size:34px;letter-spacing:-.02em;margin:0 0 12px}h1+p{color:#607488;font-size:14px}h2{font-size:25px;margin:46px 0 18px;border-top:1px solid var(--line);padding-top:26px}h3{font-size:19px;margin:27px 0 12px}p{margin:12px 0 18px}li{padding-left:3px;margin:6px 0}strong{font-weight:700;color:#173a51}
code{font-family:Consolas,monospace;font-size:.88em;overflow-wrap:anywhere;background:#eff3f7;padding:2px 5px;border-radius:4px}.table-scroll{overflow-x:auto;margin:20px 0 24px;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:12px 15px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;min-width:125px}th{background:#edf5f5;color:#24544f;font-weight:700}tr:last-child td{border-bottom:0}td:first-child{color:#23485a}tr:nth-child(even) td{background:#fafcfd}
img{display:block;width:100%;height:auto;border-radius:10px;border:1px solid var(--line);margin:24px auto 8px}p:has(>em:only-child){color:#64768a;font-size:13px}hr{border:0;border-top:1px solid var(--line);margin:36px 0}summary{cursor:pointer;font-weight:600;color:#245c78}details{border:1px solid var(--line);border-radius:8px;padding:12px 16px}details p{margin:12px 0 0}.repair-example{background:#f7fafc;padding:18px;border:1px solid var(--line);border-radius:12px}.repair-current{margin-top:12px;background:#eaf7ef;border:1px solid #b6dfc7;border-radius:8px;padding:14px 16px}.repair-current p{margin:6px 0 0}.footer{max-width:1000px;margin:0 auto 30px;padding:0 30px;font-size:12px;text-align:center;color:#718195}
@media(max-width:1000px){.layout{grid-template-columns:1fr;padding:18px;gap:10px}aside{position:static;padding:0 0 12px;display:flex;flex-wrap:wrap;gap:2px}aside p{width:100%;margin-bottom:4px}aside a{padding:5px 9px}main{padding:28px}h1{font-size:29px}.topbar{padding:12px 20px}}
@media(max-width:580px){:root{font-size:15px}.layout{padding:10px}main{padding:22px 18px;border-radius:10px}.topbar{padding:10px 16px}.edition{display:block;margin:0;font-size:11px}.brand{font-size:18px}.topbar a{font-size:12px}h1{font-size:26px}h2{font-size:22px}aside a{font-size:12px;gap:5px}th,td{padding:10px;min-width:110px}.footer{padding:0 16px}}
@media print{:root{background:#fff;color:#111;font-size:11pt}.topbar,aside,.footer{display:none}.layout{display:block;padding:0}main{border:0;border-radius:0;padding:0;box-shadow:none}h2{break-after:avoid}h3{break-after:avoid}table{font-size:10pt}tr,img,.repair-example{break-inside:avoid}img{max-height:150mm;object-fit:contain}.table-scroll{overflow:visible}a{color:inherit}details>p{display:block!important}summary::after{content:"（历史原文示意）";font-weight:normal}}
</style>
</head>
<body>
<header class="topbar"><div class="brand">众说<span class="edition">用户操作手册</span></div><a href="${markdownPath}">查看文字版</a></header>
<div class="layout"><aside aria-label="章节导航"><p>按问题找操作</p>${nav}</aside><main>${body}</main></div>
<footer class="footer">本手册可离线阅读 · 点击图片可看大图 · 浏览器 Ctrl + P 可打印或另存为 PDF</footer>
</body>
</html>
`;
}

export function writeUserGuide() {
  writeFileSync(join(guideDir, 'index.html'), renderUserGuide(), 'utf8');
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
  const launch = existsSync(join(out, 'start-existing-data.vbs'))
    ? '**继续原来的聊天：双击 `start-existing-data.vbs`。** 普通 `start-desktop.vbs` 使用另一份数据。请保留原启动器指向的旧数据目录。'
    : '首次使用：双击 `start-desktop.vbs`。已有数据请按手册中的数据入口说明核对，不要把空项目当成历史丢失。';
  writeFileSync(readmePath, `<!-- user-guide:start -->
# 先看操作手册

**双击 [众说操作手册.html](众说操作手册.html)**，无需联网；也可阅读 [文字版](操作手册/README.md)。

${launch}

手册包含：打开与日常使用、执行状态、找回刚才的发送、完成通知与静音、原答与补交版、完整示例及常见问题。适用版本和日期见手册首页。

下方保留的是历轮打包记录，可能包含旧入口和旧限制；当前操作请先按随包手册。
<!-- user-guide:end -->

${history}`, 'utf8');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2]) console.log(`操作手册已附带到：${packageUserGuide(process.argv[2])}`);
  else { writeUserGuide(); console.log(`操作手册已生成：${join(guideDir, 'index.html')}`); }
}
