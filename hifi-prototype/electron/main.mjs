/**
 * Electron 主进程（§8.1 / §8.3 / §16.2）
 *
 * 职责边界（按设计报告的进程模型）：
 *  - 本文件是 Electron 组装根：创建原生窗口、托盘、原生对话框、生命周期。
 *  - 真正的业务应该由本地 daemon 承担（§8.1：Electron 主进程把窄接口转发至 daemon）。
 *    原型阶段没有 daemon，因此这里只实现"桌面外壳"能力，业务状态仍在渲染层内存里。
 *  - 渲染进程不直接访问 Node：contextIsolation 开、nodeIntegration 关，
 *    只通过 preload 暴露的白名单方法（§16.2）。
 *
 * 关键桌面语义：
 *  - 关闭窗口 = 隐藏到托盘继续运行；显式"退出"才真正停止（决策 43、§8.3）
 *  - 单实例锁：第二个实例不启动第二份调度器，而是聚焦既有窗口（§8.3）
 *  - 退出前展示正在终止的任务数量与实际状态（§17.4）
 */

import { app, BrowserWindow, Tray, Menu, dialog, ipcMain, nativeImage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 开发模式：由 Vite dev server 提供渲染层；生产：加载打包后的 dist */
const DEV_URL = process.env.ZS_DEV_URL ?? '';
const isDev = Boolean(DEV_URL);

/** 托盘与窗口共用的一套状态；退出确认需要读取"正在跑的任务" */
let mainWindow = null;
let tray = null;
/** 由渲染层同步上来的运行态摘要，用于退出确认与托盘提示 */
let runtimeSummary = { runningTasks: 0, runningTurns: 0, detail: '' };
/** 用户是否已经明确要走"退出"路径（区别于点 × 缩托盘） */
let quitting = false;

const TRAY_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#2563eb"/>
  <text x="16" y="22" font-size="17" font-family="Segoe UI,sans-serif" font-weight="700"
        fill="white" text-anchor="middle">众</text>
</svg>`;

function trayImage() {
  // 用内联 SVG 生成托盘图标，避免依赖外部资源文件
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(TRAY_ICON_SVG, 'utf8').toString('base64')}`;
  const img = nativeImage.createFromDataURL(dataUrl);
  return img.resize({ width: 16, height: 16 });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    // 自绘标题栏：原型要看起来像桌面客户端，而不是浏览器
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#eef0f4',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // §16.2：renderer 关闭 Node 直访并启用 contextIsolation
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 首帧后把当前最大化状态同步给渲染层，用于切换按钮图标
    mainWindow.webContents.send('zs:window-state', windowState());
  });

  // 关闭 = 缩到托盘继续运行（决策 43）
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideToTray();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const notifyState = () => mainWindow?.webContents.send('zs:window-state', windowState());
  mainWindow.on('maximize', notifyState);
  mainWindow.on('unmaximize', notifyState);

  // 外链走系统浏览器，不在应用内打开（§16.2 协议白名单）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  }
}

function windowState() {
  return {
    maximized: mainWindow?.isMaximized() ?? false,
    fullScreen: mainWindow?.isFullScreen() ?? false,
    focused: mainWindow?.isFocused() ?? false,
  };
}

/** 隐藏到托盘，并给一次可见反馈（首次缩托盘时提示怎么找回） */
function hideToTray() {
  if (!mainWindow) return;
  mainWindow.hide();
  if (!app.__trayHintShown) {
    app.__trayHintShown = true;
    tray?.displayBalloon?.({
      title: '众说仍在后台运行',
      content: '窗口已缩到托盘。任务会继续执行；要彻底停止请用托盘菜单的"退出众说"。',
      iconType: 'info',
    });
  }
  refreshTrayMenu();
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  refreshTrayMenu();
}

function buildTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('众说 · 本地项目群聊多 Agent 协同工作台');
  // 左键单击：切换显示（Windows 上最常见的托盘行为）
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else showWindow();
  });
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const running = runtimeSummary.runningTasks;
  const turns = runtimeSummary.runningTurns;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: running > 0 ? `后台任务 ${running} 个 · ${turns} 个 turn 在跑` : '当前没有后台任务',
        enabled: false,
      },
      { type: 'separator' },
      { label: mainWindow?.isVisible() ? '隐藏窗口' : '显示窗口', click: () => (mainWindow?.isVisible() ? mainWindow.hide() : showWindow()) },
      { type: 'separator' },
      {
        label: '退出众说',
        // 明确退出才停止任务（§8.3）
        click: () => requestQuit(),
      },
    ]),
  );
  tray.setToolTip(
    running > 0
      ? `众说 · 后台任务 ${running} 个（${turns} 个 turn 在跑）`
      : '众说 · 空闲',
  );
}

/** 退出前先确认：展示正在终止的任务数量与实际状态（§17.4） */
async function requestQuit() {
  const running = runtimeSummary.runningTasks;
  const turns = runtimeSummary.runningTurns;

  showWindow();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: running > 0 ? 'warning' : 'question',
    buttons: ['取消', '停止并退出'],
    defaultId: 0,
    cancelId: 0,
    title: '退出众说',
    message: running > 0 ? `仍有 ${running} 个任务在执行` : '确认退出众说？',
    detail:
      running > 0
        ? `即将停止 ${running} 个任务（${turns} 个正在运行的 turn）。\n\n` +
          '停止不是撤销：已经写入磁盘的改动会保留，界面会展示残留 diff。\n' +
          '正在运行的成员进程会被终止，未完成的结果标记为中断或结果不明。'
        : '关闭窗口只是缩到托盘继续运行；这里是彻底退出。',
  });

  if (response === 1) {
    quitting = true;
    app.quit();
  }
}

/* ============================================================
   IPC：白名单方法（preload 只转发这些，渲染层拿不到任意通道）
   ============================================================ */

ipcMain.handle('zs:window-minimize', () => mainWindow?.minimize());
ipcMain.handle('zs:window-show', () => {
  showWindow();
  return windowState();
});
ipcMain.handle('zs:window-toggle-maximize', () => {
  if (!mainWindow) return windowState();
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  // 返回完整窗口状态，渲染层可直接用作新状态
  return windowState();
});
ipcMain.handle('zs:window-close', () => hideToTray());
ipcMain.handle('zs:window-state', () => windowState());

/** 原生目录选择器（§8.2：Electron 提供原生目录选择） */
ipcMain.handle('zs:pick-directory', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择项目文件夹',
    properties: ['openDirectory'],
    buttonLabel: '作为项目打开',
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

/** 在资源管理器中**定位并选中**（reveal-path 与 open-path 是两种不同动作） */
ipcMain.handle('zs:reveal-path', async (_e, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) return false;
  shell.showItemInFolder(targetPath);
  return true;
});

/**
 * 用系统默认程序**打开**该路径（第十七批 §七"在资源管理器中打开项目目录"）。
 * 与 reveal-path 的区别：这个打开目录本身，那个是在父目录里选中它。
 * `shell.openPath` 返回空字符串表示成功，非空是错误原因 —— 如实回给渲染层。
 */
ipcMain.handle('zs:open-path', async (_e, targetPath) => {
  if (typeof targetPath !== 'string' || !targetPath) return { ok: false, reason: '路径为空' };
  const err = await shell.openPath(targetPath);
  return err ? { ok: false, reason: err } : { ok: true };
});

ipcMain.handle('zs:open-external', async (_e, url) => {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

/**
 * 真实的应用数据目录（应用设置 → 数据与存储 → 打开目录）。
 *
 * 为什么单独开一个只读通道：界面显示的 `<appData>/zhongshuo/` 是文档口径，
 * 而「打开目录」必须真的能打开一个存在的目录（§2.4：不能让按钮变成假成功）。
 * `app.getPath('userData')` 就是这台机器上真实存在的数据目录。
 */
ipcMain.handle('zs:app-data-dir', () => {
  try {
    return app.getPath('userData');
  } catch {
    return null;
  }
});

/** 渲染层同步运行态摘要：托盘提示与退出确认都依赖它 */
ipcMain.handle('zs:report-runtime', (_e, summary) => {
  if (summary && typeof summary === 'object') {
    runtimeSummary = {
      runningTasks: Number(summary.runningTasks) || 0,
      runningTurns: Number(summary.runningTurns) || 0,
      detail: String(summary.detail ?? ''),
    };
    refreshTrayMenu();
  }
  return true;
});

/** 渲染层请求走"显式退出"流程（顶栏关闭按钮的长按/菜单项） */
ipcMain.handle('zs:request-quit', () => requestQuit());

/* ============================================================
   生命周期
   ============================================================ */

// 单实例锁：第二个实例不启动第二份调度器，改为聚焦既有窗口（§8.3）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    app.setAppUserModelId('com.zhongshuo.app');
    createWindow();
    buildTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // 托盘常驻：所有窗口关闭也不退出（除非走了显式退出）
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
  });
}
