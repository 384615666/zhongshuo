/**
 * 桌面窗口的**窄宽降级**截图（UX-PREVIEW-01 / §5.3）。
 *
 * 为什么必须单独做、且放在桌面端：
 *  浏览器里用 `Emulation.setDeviceMetricsOverride` 改的是**渲染视口**，
 *  而桌面客户端的宽度必须来自**真实窗口**。两者不能互相代替 ——
 *  本脚本因此通过 Win32 `SetWindowPos` 调整 Electron 真实窗口，
 *  再读 `window.innerWidth` 与布局结果，证据才成立。
 *
 * 用法（先 pnpm run build && pnpm run desktop:debug）：
 *   node scripts/shot-desktop-narrow.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop-preview');
const PORT = process.env.ZS_CDP_PORT ?? '9333';
const DPR = 1.25; // 本机实际缩放，脚本会读回校验
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

/* ---------- Win32 窗口调整（PowerShell 辅助，避免引入原生依赖） ----------
   注意：**不要在传给 powershell 的脚本里写中文**。
   Node → powershell -Command 的字符串会经过一层编码转换，
   中文窗口标题在那里会变成乱码，导致 Where-Object 匹配不到窗口
   （实测表现为稳定的 'NO_WINDOW'，而窗口其实开着）。
   改为按"electron 进程 + 有主窗口句柄"筛选，与标题无关。 */
const PS_SET = (w, h) => `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ZsWin {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'NO_WINDOW'; exit 1 }
$h = $p.MainWindowHandle
$r = New-Object ZsWin+RECT
[void][ZsWin]::GetWindowRect($h, [ref]$r)
[void][ZsWin]::SetWindowPos($h, [IntPtr]::Zero, $r.L, $r.T, ${w}, ${h}, 0x0004)
Start-Sleep -Milliseconds 900
$r2 = New-Object ZsWin+RECT
[void][ZsWin]::GetWindowRect($h, [ref]$r2)
Write-Output ("$($r2.R-$r2.L)x$($r2.B-$r2.T)")
`;

function setWindowPhysical(w, h) {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', PS_SET(w, h)], { encoding: 'utf8' });
  return out.trim();
}

/**
 * 把窗口调到**目标 innerWidth**（CSS 像素）。
 *
 * 不能用"CSS × dpr"换算：实测本机 dpr=1.25，
 * 但 `SetWindowPos` 给的物理宽度与 `window.innerWidth` **几乎相等**
 * （设 1731 → innerWidth 1732），说明 Electron 在这里的内部宽度
 * 并不按 dpr 缩小。硬套公式会把 1372 拍成 1732（我第一次就踩到了）。
 *
 * 因此改为**闭环校正**：设一次 → 读回 innerWidth → 按差值微调，
 * 最多迭代 4 次。这样无论 dpr 与窗口尺寸如何换算，落在截图里的
 * `inner` 都是真实值，报告里引用的宽度就不会错。
 */
async function setInnerWidth(targetCss, targetCssH) {
  let guess = Math.round(targetCss) + FRAME_W;
  for (let i = 0; i < 4; i++) {
    const rect = setWindowPhysical(guess, Math.round(targetCssH) + FRAME_H);
    await sleep(700);
    const c = await connect();
    const inner = await c.ev(`[window.innerWidth, window.innerHeight]`);
    c.ws.close();
    if (!Array.isArray(inner)) return rect;
    const diff = targetCss - inner[0];
    if (Math.abs(diff) <= 2) return rect;
    guess += diff;
  }
  return null;
}

/* ---------- CDP ---------- */
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('找不到 Electron 窗口，请先 pnpm run desktop:debug');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); res({}); }, 15000);
    pending.set(i, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.exceptionDetails ? undefined : r.result?.result?.value;
  };
  return { ws, send, ev };
}

async function reset(hash) {
  const c = await connect();
  await c.ev(`window.zhongshuo?.window.show()`);
  await c.ev(`location.hash = ${JSON.stringify(hash)}; location.reload(); true`);
  c.ws.close();
  await sleep(3000);
}

const manifest = [];

const FRAME_W = 16;
const FRAME_H = 39;

async function shootAt(cssW, cssH, name, note) {
  const rect = await setInnerWidth(cssW, cssH);
  await sleep(1200);
  const c = await connect();
  try {
    const info = await c.ev(`(() => {
      const ws = document.querySelector('.workspace');
      const bad = [];
      for (const el of document.querySelectorAll('.thread-tab, .preview-tab-label, .preview-icon-btn')) {
        const r = el.getBoundingClientRect();
        const t = (el.textContent || '').trim();
        if (r.width > 0 && t.length >= 2 && r.width < 24 && r.height > r.width * 1.2) {
          bad.push({ text: t, w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
      return {
        requestedCssWidth: ${cssW},
        physicalWindow: ${JSON.stringify(rect)},
        inner: [window.innerWidth, window.innerHeight],
        dpr: window.devicePixelRatio,
        bodyWidth: Math.round(document.querySelector('.app-body')?.getBoundingClientRect().width || 0),
        layout: ws?.dataset.layout ?? null,
        navVisible: !!document.querySelector('.sidebar'),
        previewWidth: Math.round(document.querySelector('.preview-pane')?.getBoundingClientRect().width || 0),
        contextWidth: Math.round((document.querySelector('.col-main') || document.querySelector('.col-thread'))?.getBoundingClientRect().width || 0),
        singleSwitch: !!document.querySelector('.single-region-switch'),
        verticalText: bad,
      };
    })()`);
    const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const data = r.result?.data;
    if (!data) { console.log(`MISS ${name}`); return; }
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
    manifest.push({ name, note, ...info });
    console.log(`OK   ${name.padEnd(30)} ${JSON.stringify(info)}`);
  } finally {
    c.ws.close();
  }
}

/* ---------- 场景：L4（线程 + 文件），逐档缩窄 ---------- */
await reset('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0');
{
  const c = await connect();
  await c.ev(`(() => {
    const x = [...document.querySelectorAll('.msg-attach')].find(e => (e.textContent||'').includes('预览交互设计说明'));
    if (x) x.click();
    return !!x;
  })()`);
  c.ws.close();
  await sleep(1300);
}

await shootAt(1372, 872, 'd12-narrow-1372', '真实窗口 1372 CSS：L4 两区并排');
await shootAt(1280, 872, 'd13-narrow-1280', '真实窗口 1280 CSS：L4 最挤的一档（长内容可读性）');
await shootAt(1100, 872, 'd14-narrow-1100', '真实窗口 1100 CSS：自动隐藏导航保住两区');

/**
 * 最低宽度：桌面窗口有 `minWidth: 1040`（electron/main.mjs），
 * 所以**无法**在真实窗口里验证 900px —— 那是浏览器场景。
 *
 * 这里如实记录"缩到下限会发生什么"，而不是假装拍到了 900：
 * 目标是 900 时窗口会停在 1040，布局仍是两区（因为 1040 隐藏导航后
 * 可用约 1040-246+246=1040 ≥ 928）→ **单区域在桌面端默认尺寸约束下不会触发**。
 * 这条结论对报告很重要：浏览器里 900px 能看到的单区域，
 * 桌面用户看不到（除非手动改 minWidth）。
 */
await shootAt(900, 872, 'd15-window-min-width-1040', '真实窗口缩到下限 1040（minWidth 限制，非 900）；单区域在桌面端不触发');

/* ---------- 恢复原尺寸 ---------- */
setWindowPhysical(1480 + FRAME_W, 940 + FRAME_H);

writeFileSync(
  join(outDir, 'manifest-narrow.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    host: 'Electron 真实窗口（Win32 SetWindowPos 调整，非 Emulation 覆盖）',
    note: 'physicalWindow 为窗口外框像素；inner 为渲染视口 CSS 像素；dpr 为实际缩放。',
    shots: manifest,
  }, null, 2),
  'utf8',
);

console.log(`\n完成 ${manifest.length} 张 → ${outDir}`);
process.exit(0);
