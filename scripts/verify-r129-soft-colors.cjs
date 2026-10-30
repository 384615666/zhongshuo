#!/usr/bin/env node
/**
 * R129 isolated visual check for soft interaction colors.
 *
 * The hidden Electron window loads the shipped Hi-Fi CSS with synthetic markup,
 * a temporary profile, and a dedicated CDP port. It reads or writes no user
 * runtime data, starts no daemon, and makes no model calls.
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { build } = require('esbuild');

const repo = path.resolve(__dirname, '..');
const cdpPort = Number(process.env.ZS_R129_CDP_PORT || 9490);
const outArg = process.argv.indexOf('--out');
const outDir = path.resolve(outArg > 0 && process.argv[outArg + 1]
  ? process.argv[outArg + 1]
  : path.join(repo, 'dist', 'r129-soft-colors', `ui-check-${cdpPort}`));
fs.mkdirSync(outDir, { recursive: true });

function electronExecutable() {
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && fs.existsSync(resolved)) return resolved;
  } catch { /* fall through */ }
  const pathFile = path.join(repo, 'node_modules', 'electron', 'path.txt');
  const name = fs.readFileSync(pathFile, 'utf8').trim();
  return path.join(repo, 'node_modules', 'electron', 'dist', name);
}

const slash = (value) => value.replace(/\\/g, '/');
const stylePaths = ['tokens.css', 'base.css', 'components.css', 'preview.css', 'titlebar.css', 'h1-overrides.css']
  .map((name) => slash(path.join(repo, 'src', 'ui', 'hifi', 'styles', name)));

const lightScreenshot = path.join(outDir, 'r129-soft-colors-light.png');
const darkScreenshot = path.join(outDir, 'r129-soft-colors-dark.png');
const capturedResult = path.join(outDir, 'captured-result.json');
const captureError = path.join(outDir, 'capture-error.json');

const html = String.raw`<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="bundle.css">
  <style>
    html, body, #root { margin: 0; min-height: 100%; background: var(--bg-app); color: var(--text); }
    body { font-family: var(--font-ui); }
    .r129-shell { display: grid; grid-template-columns: 246px minmax(0, 1fr); min-height: 100vh; }
    .r129-sidebar { padding: 14px 8px; border-right: 1px solid var(--border); background: var(--bg-app); }
    .r129-brand { margin: 0 8px 20px; }
    .r129-project-label { padding: 7px 8px; color: var(--text-2); font-size: var(--fs-12); font-weight: 600; }
    .r129-main { min-width: 0; padding: 22px 32px 30px; background: var(--bg-surface); }
    .r129-eyebrow { color: var(--text-3); font-size: var(--fs-11); letter-spacing: .08em; text-transform: uppercase; }
    .r129-title { margin: 5px 0 4px; font-size: 22px; line-height: 1.25; }
    .r129-copy { margin: 0 0 22px; color: var(--text-2); font-size: var(--fs-13); }
    .r129-grid { display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 18px; align-items: start; }
    .r129-stack { display: grid; gap: 14px; }
    .r129-card { padding: 15px; }
    .r129-card-label { margin-bottom: 8px; color: var(--text-3); font-size: var(--fs-11); font-weight: 600; }
    .r129-thread { position: relative; min-height: 250px; padding: 16px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg-surface-2); overflow: hidden; }
    .r129-thread::before { content: ""; display: block; height: 150px; border-radius: var(--r-md); background: var(--bg-surface); border: 1px solid var(--border-subtle); }
    .r129-thread .new-msg-pill { bottom: 18px; }
    .r129-actions { display: flex; flex-wrap: wrap; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg-surface-2); }
    .r129-action-note { width: 100%; color: var(--text-3); font-size: var(--fs-11); }
    .r129-swatches { display: grid; gap: 12px; }
    .r129-swatch { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .r129-swatch-name { color: var(--text-2); font-size: var(--fs-12); }
  </style>
</head>
<body>
  <div id="root">
    <div class="r129-shell">
      <aside class="sidebar r129-sidebar">
        <div class="brand r129-brand"><span class="brand-mark">众</span><span>众说</span></div>
        <div class="side-heading"><span>项目</span></div>
        <div class="side-project">
          <div class="r129-project-label">示例项目</div>
          <button id="selected-room" class="side-item sub active" type="button">
            <span class="side-item-label">当前房间</span>
          </button>
          <button class="side-item sub" type="button"><span class="side-item-label">其他房间</span></button>
        </div>
      </aside>
      <main class="r129-main">
        <div class="r129-eyebrow">R129 · visual check</div>
        <h1 class="r129-title">浅色交互配色</h1>
        <p class="r129-copy">新消息、发送与当前房间应属于同一套浅蓝绿交互语言。</p>
        <div class="r129-grid">
          <div class="r129-stack">
            <div class="r129-card root-card selected" id="selected-root">
              <div class="r129-card-label">当前选择的对话串</div>
              <strong>检查浅色选中态</strong>
              <div class="small faint">使用主题面打底与浅蓝绿渐变。</div>
            </div>
            <div class="r129-thread">
              <button id="new-pill" class="new-msg-pill" type="button">
                <span>↓</span><span>有新消息（3）</span>
              </button>
            </div>
          </div>
          <div class="r129-swatches">
            <div class="r129-actions">
              <button id="send-button" class="btn primary sm composer-send" type="button">发送</button>
              <button id="danger-button" class="btn danger sm" type="button">删除</button>
              <button id="warning-button" class="tag-btn warning" type="button">有新版本</button>
              <div class="r129-action-note">危险与警告仍保留各自语义色。</div>
            </div>
            <div class="r129-card brand-swatch">
              <div class="r129-swatch">
                <span class="r129-swatch-name">品牌标识（唯一的深渐变用途）</span>
                <span id="brand-mark" class="brand-mark">众</span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  </div>
  <script>
    function styleOf(selector) {
      const element = document.querySelector(selector);
      if (element == null) return null;
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderColor: style.borderColor,
        color: style.color
      };
    }
    window.__r129 = {
      setTheme: function (theme) {
        document.documentElement.dataset.theme = theme;
        return true;
      },
      snapshot: function () {
        return {
          theme: document.documentElement.dataset.theme,
          ready: document.readyState === 'complete' && document.fonts.status === 'loaded',
          selectedRoom: styleOf('#selected-room'),
          selectedRoot: styleOf('#selected-root'),
          newPill: styleOf('#new-pill'),
          send: styleOf('#send-button'),
          danger: styleOf('#danger-button'),
          warning: styleOf('#warning-button'),
          brand: styleOf('#brand-mark')
        };
      }
    };
  </script>
</body>
</html>`;

function stylesMatch(snapshot) {
  const keys = ['selectedRoom', 'selectedRoot', 'newPill', 'send'];
  const first = snapshot[keys[0]];
  return first != null && keys.slice(1).every((key) => {
    const value = snapshot[key];
    return value != null
      && value.backgroundColor === first.backgroundColor
      && value.backgroundImage === first.backgroundImage;
  });
}

async function waitFor(read, accepted, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accepted(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`${label} timeout: ${JSON.stringify(last)}`);
}

async function main() {
  await build({
    stdin: {
      contents: stylePaths.map((stylePath) => `import '${stylePath}';`).join('\n'),
      loader: 'ts',
      resolveDir: repo,
      sourcefile: 'r129-css-entry.ts',
    },
    outfile: path.join(outDir, 'bundle.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
  });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({
    name: 'zs-r129-soft-colors',
    version: '0.0.0',
    main: 'main.cjs',
  }));
  fs.writeFileSync(path.join(outDir, 'main.cjs'), String.raw`
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(__dirname, 'profile'));

const screenshots = ${JSON.stringify({ light: lightScreenshot, dark: darkScreenshot })};
const resultPath = ${JSON.stringify(capturedResult)};
const errorPath = ${JSON.stringify(captureError)};

async function snapshot(win) {
  return win.webContents.executeJavaScript('window.__r129.snapshot()');
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const light = await snapshot(win);
      const lightImage = await win.webContents.capturePage({ x: 0, y: 0, width: 1180, height: 780 });
      fs.writeFileSync(screenshots.light, lightImage.toPNG());

      await win.webContents.executeJavaScript("window.__r129.setTheme('dark')");
      await new Promise((resolve) => setTimeout(resolve, 180));
      const dark = await snapshot(win);
      const darkImage = await win.webContents.capturePage({ x: 0, y: 0, width: 1180, height: 780 });
      fs.writeFileSync(screenshots.dark, darkImage.toPNG());

      fs.writeFileSync(resultPath, JSON.stringify({ light, dark }, null, 2));
    } catch (error) {
      fs.writeFileSync(errorPath, JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      }, null, 2));
    } finally {
      win.destroy();
      app.quit();
    }
  });
});
app.on('window-all-closed', () => app.quit());
`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExecutable(), [`--remote-debugging-port=${cdpPort}`, outDir], {
    cwd: outDir,
    env,
    windowsHide: true,
    stdio: 'ignore',
  });

  try {
    await waitFor(
      async () => fs.existsSync(capturedResult) || fs.existsSync(captureError),
      Boolean,
      'Electron capture',
    );
    if (fs.existsSync(captureError)) {
      throw new Error(fs.readFileSync(captureError, 'utf8'));
    }
    const captured = JSON.parse(fs.readFileSync(capturedResult, 'utf8'));
    const checks = [
      {
        name: 'light_soft_family_matches_selected_room_primary_and_send',
        ok: captured.light.theme === 'light'
          && stylesMatch(captured.light)
          && captured.light.newPill.color === captured.light.selectedRoom.color
          && captured.light.send.color === captured.light.selectedRoom.color,
        detail: captured.light,
      },
      {
        name: 'dark_soft_family_matches_selected_room_primary_and_send',
        ok: captured.dark.theme === 'dark'
          && stylesMatch(captured.dark)
          && captured.dark.newPill.color === captured.dark.selectedRoom.color
          && captured.dark.send.color === captured.dark.selectedRoom.color,
        detail: captured.dark,
      },
      {
        name: 'new_message_pill_uses_theme_text_not_white_cta_text',
        ok: captured.light.newPill.color === captured.light.selectedRoom.color
          && captured.dark.newPill.color === captured.dark.selectedRoom.color
          && captured.light.newPill.color !== 'rgb(255, 255, 255)'
          && captured.dark.newPill.color !== 'rgb(13, 17, 23)',
        detail: {
          light: captured.light.newPill,
          dark: captured.dark.newPill,
        },
      },
      {
        name: 'danger_and_warning_keep_semantic_colors',
        ok: captured.light.danger.backgroundImage === 'none'
          && captured.light.danger.color !== captured.light.newPill.color
          && captured.light.warning.backgroundImage === 'none'
          && captured.light.warning.color !== captured.light.newPill.color,
        detail: {
          danger: captured.light.danger,
          warning: captured.light.warning,
        },
      },
      {
        name: 'brand_mark_is_the_only_remaining_deep_gradient_consumer',
        ok: captured.light.brand.backgroundImage !== captured.light.newPill.backgroundImage
          && captured.dark.brand.backgroundImage !== captured.dark.newPill.backgroundImage,
        detail: {
          light: captured.light.brand,
          dark: captured.dark.brand,
        },
      },
    ];
    const result = {
      ok: checks.every((check) => check.ok),
      checks,
      cdpPort,
      output: outDir,
      screenshots: {
        light: lightScreenshot,
        dark: darkScreenshot,
      },
      syntheticData: true,
      hiddenElectron: true,
      realModelCalls: 0,
    };
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  const result = {
    ok: false,
    error: error instanceof Error ? error.stack : String(error),
    cdpPort,
    output: outDir,
    syntheticData: true,
    realModelCalls: 0,
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
});
