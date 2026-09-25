/**
 * build.mjs —— 把骨架 + 各方案规范 CSS 组装成独立 HTML
 * 方案 A（mimo）用 _src/body-mimo.html **专属骨架**（摘要行 / 双行输入区 /
 * 文件预览状态，含状态脚本）；方案 B（kimi）/ C（hy4）共用 _src/body.html。
 * 方案 B（kimi）额外注入「任务对话 + 文件预览」状态：
 * 文件引用条、返回主池入口、窄窗切换条、预览面板、preview.js。
 * kimi-preview.html 是 kimi.html 的同内容别名（便于 ?fp=open 深链）。
 * 只写入 design-shootout/，不触碰任何既有原型文件。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '_src');
const read = (f) => readFileSync(join(src, f), 'utf8');

const icons = read('icons.svg');
const base = read('base.css');

function injectOnce(haystack, anchor, insert, label) {
  if (!haystack.includes(anchor)) throw new Error(`注入点未找到：${label}`);
  return haystack.replace(anchor, insert);
}

/** 在共享骨架上注入预览状态所需的 DOM（仅方案 B 使用） */
function withPreview(body) {
  /* 1. 对话中注入 components.md 文件引用条（Codex 消息 #4） */
  const chipAnchor = '<span class="msg-seq">#4</span>\n            </div>';
  body = injectOnce(
    body, chipAnchor,
    chipAnchor + '\n' + read('preview-chip.html').replace(/\r\n/g, '\n').trimEnd(),
    '文件引用条',
  );

  /* 2. 对话栏头部注入「返回主池」入口（仅预览态可见） */
  const barAnchor = '<div class="thread-bar">';
  body = injectOnce(
    body, barAnchor,
    barAnchor + '\n          <button class="btn btn-ghost fp-back" id="fpBack" type="button">‹ 返回主池</button>',
    '返回主池入口',
  );

  /* 3. 回复串之前注入窄窗切换条 */
  const switchAnchor = '<span class="splitter"></span>';
  body = injectOnce(
    body, switchAnchor,
    switchAnchor + '\n\n' + read('preview-inject.html').replace(/\r\n/g, '\n').trimEnd(),
    '窄窗切换条',
  );

  /* 4. 回复串之后注入拖拽条 + 预览面板 */
  const paneAnchor = '    </aside>\n\n  </div>\n</div>';
  body = injectOnce(
    body, paneAnchor,
    '    </aside>\n\n' + read('preview-pane.html').replace(/\r\n/g, '\n').trimEnd() + '\n\n  </div>\n</div>',
    '预览面板',
  );

  return body;
}

const themeScript = `  /* 支持 ?theme=dark 切换深色 */
  var t = new URLSearchParams(location.search).get('theme');
  if (t === 'dark') document.querySelector('.app').setAttribute('data-theme', 'dark');`;

function page(title, cssFile, preview, bodyFile) {
  const bodyLight = read(bodyFile).replace(/\r\n/g, '\n');
  const body = (preview ? withPreview(bodyLight) : bodyLight)
    .replace('{{ICONS}}', icons)
    .replace('{{THEME}}', 'light');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
/* ── 骨架（共用） ── */
${base}
/* ── 方案规范 ── */
${read(cssFile)}
</style>
</head>
<body>
${body}
<script>
${themeScript}
</script>
${preview ? `<script>\n${read('preview.js')}\n</script>\n` : ''}</body>
</html>
`;
}

const targets = [
  { out: ['mimo.html'], title: '众说 · 回复串界面（方案 A：Mimo / ZCode《静默的仪器》）', css: 'theme-zcode.css', body: 'body-mimo.html' },
  { out: ['kimi.html', 'kimi-preview.html'], title: '众说 · 回复串界面（方案 B：Kimi K3《视觉设计规范 v1.5》· 含文件预览状态）', css: 'theme-kimi.css', body: 'body.html', preview: true },
  { out: ['hy4.html'], title: '众说 · 回复串界面（方案 C：hy4《前端视觉规范 v1.0》）', css: 'theme-hy4.css', body: 'body.html' },
];

for (const t of targets) {
  const html = page(t.title, t.css, t.preview, t.body);
  for (const out of t.out) {
    writeFileSync(join(here, out), html, 'utf8');
    console.log('built', out);
  }
}
