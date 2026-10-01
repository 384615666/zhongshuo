/**
 * Electron main（DEV-07）：窄接口 + daemon 组装。
 * - 进程内启动 daemon（startDaemon；fake 需 ZS_ALLOW_FAKE=1，见 entry 纪律）。
 * - preload 暴露的唯一能力是 invoke('zs:command', envelope)——renderer 不接触
 *   SQLite、不拉起 runtime 进程，也不在失败时回退种子数据。
 * - 连接断开时通知 renderer（'zs:disconnect'），重连由 main 负责。
 * - ZS_UI_DEMO=<json 路径> 自动化演示：开项目→发任务→轮询→截图→退出（G3 取证）。
 */
import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectPipe, daemonPipeNameFor, ensureLocalCredential, localUserId } from '../contracts/daemonIpc.ts';
import type { PipeClient } from '../contracts/daemonIpc.ts';

// zsres:// 特权协议（第二十九轮三）：受限预览侧加载随包 pdfjs ESM 模块与 worker 需要——
// file:// 源下 ES 模块被模块 CORS 拦截（Chromium 对 file 源互为 opaque）。standard+secure
// 的特权 scheme 同源可加载模块/worker/fetch（cmaps）。必须在 app ready 前注册。
protocol.registerSchemesAsPrivileged([{ scheme: 'zsres', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const rendererRoot = resolve(__dirname, 'renderer');

// daemon 独立进程承载（§8.3：界面与 daemon 进程分离；native 模块只在 Node
// 进程加载，Electron 主进程仅经命名管道连接——不做 Electron ABI rebuild）。
let daemonProcess: ChildProcess | null = null;
let pipe: PipeClient | null = null;
let daemonShuttingDown = false;

/**
 * 打包形态（DEV-15）：resources/app 下自带 daemon.cjs+随包 Node（daemon/node/node.exe）
 * ——运行不依赖开发机 PATH 上的 node；受管运行时默认开（REC-LIFE-1 产品立场：koffi 缺失
 * =daemon 拒绝启动→本应用明确失败退出，不静默降级为未受管执行；ZS_MANAGED_RUNTIME=0 显式
 * 关闭仅排障用）。开发/测试（node_modules/electron + dist/ui）维持源码 entry.ts+PATH node。
 */
const appRoot = resolve(__dirname, '..', '..'); // dist/ui/main.cjs → 应用根（打包=resources/app）
const isPackagedUi = process.env.ZS_PACKAGED_UI === '1'
  || existsSync(join(appRoot, 'daemon', 'daemon.cjs')); // 布局判定：便携 exe 未改名时 app.isPackaged=false，不可作依据

/** 启动独立 daemon 子进程（打包=随包 Node+daemon.cjs；开发=PATH node+源码 entry）。 */
async function startDaemonProcess(appDataDirToUse: string, runtime: 'fake' | 'codex' | 'claude'): Promise<void> {
  const entry = process.env.ZS_DAEMON_ENTRY ?? (isPackagedUi
    ? join(appRoot, 'daemon', 'daemon.cjs')
    : join(__dirname, '..', '..', 'src', 'daemon', 'entry.ts'));
  mkdirSync(appDataDirToUse, { recursive: true }); // 凭据/数据库目录可能尚不存在
  const credential = ensureLocalCredential(appDataDirToUse);
  // 管道名默认按本机用户（单实例语义）；显式 ZS_PIPE_NAME 供多实例/端到端隔离。
  daemonPipe = process.env.ZS_PIPE_NAME ?? daemonPipeNameFor(localUserId());
  daemonToken = credential.token;
  // daemon 用随包 Node 运行（ELECTRON_RUN_AS_NODE 的 electron.exe 是 Electron ABI，
  // better-sqlite3 原生模块按 Node ABI 预编译——混用即 NODE_MODULE_VERSION 不匹配）。
  const nodeBin = process.env.ZS_NODE_BIN ?? (isPackagedUi
    ? join(appRoot, 'daemon', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    : 'node');
  const daemonArgs = isPackagedUi ? [entry] : ['--experimental-strip-types', entry];
  daemonProcess = spawn(nodeBin, daemonArgs, {
    env: {
      ...process.env,
      ZS_APP_DATA: appDataDirToUse,
      ZS_RUNTIME: runtime,
      ZS_ALLOW_FAKE: process.env.ZS_ALLOW_FAKE ?? '1',
      ZS_PIPE_NAME: daemonPipe,
      ...(isPackagedUi ? {
        ZS_PACKED_ENTRY: '1',
        ZS_MANAGED_RUNTIME: process.env.ZS_MANAGED_RUNTIME ?? '1',
      } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stopResultLine: string | null = null;
  daemonProcess.stderr?.on('data', (d: Buffer) => {
    const text = d.toString('utf8');
    process.stderr.write(`[daemon] ${text}`);
    // daemon 结构化停机尾行（第十四轮三）：捕获进停机事实——未确认执行/收拢失败不因退出码 0 被掩盖。
    const m = text.split('\n').find((l) => l.includes('stop-result '));
    if (m != null) {
      stopResultLine = m.slice(m.indexOf('stop-result ') + 'stop-result '.length).trim();
      try {
        const parsed = JSON.parse(stopResultLine) as DaemonShutdownFacts['daemonStopResult'];
        daemonStopResult = parsed;
      } catch { /* 残缺尾行不虚构 */ }
    }
  });
  daemonProcess.once('error', (error: Error) => {
    spawnError = error.message;
    process.stderr.write(`[zhongshuo-ui] daemon spawn 失败：${error.message}
`);
    app.exit(1); // 明确失败退出——不留静默未就绪窗口
  });
  process.stderr.write(`[zhongshuo-ui] ready: spawn ok（+${Date.now() - uiSpawnAt}ms，pid=${daemonProcess.pid}，pipe=${daemonPipe}）
`);
  daemonProcess.once('exit', (code, signal) => {
    daemonExitFacts = { code: code ?? null, signal: signal ?? null };
    process.stderr.write(`[zhongshuo-ui] daemon 退出（code=${code}${signal != null ? ` signal=${signal}` : ''}）\n`);
    // 启动失败/异常退出（含受管依赖缺失的拒绝启动）：应用明确失败退出——不静默以未受管
    // 状态继续（空管道重连永远失败=挂死窗口，比明确退出更糟）。
    if (!daemonShuttingDown && code !== 0) {
      process.stderr.write('[zhongshuo-ui] daemon 异常退出——应用退出（明确失败，不降级）\n');
      app.exit(1);
    }
  });
}

/** daemon 停机结构化事实（第十四轮三：正常优雅/明确失败/超时未确认分开呈现，不隐藏失败）。 */
export interface DaemonShutdownFacts {
  requestDelivered: boolean;
  requestError?: string;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  forceKilled: boolean;
  alreadyExited: boolean;
  daemonStopResult?: { complete?: boolean; phase?: string; exitCode?: number; forced?: boolean; inFlightRemaining?: string[]; disposeUnconfirmed?: number; disposeFailed?: number; stopRecord?: string };
  stopRecordPath: string;
}

let daemonExitFacts: { code: number | null; signal: NodeJS.Signals | null } | null = null;
/** 经函数读取（exit 回调闭包写入后控制流收窄不可见）。 */
function readDaemonExitFacts(): { code: number | null; signal: NodeJS.Signals | null } | null {
  return daemonExitFacts;
}
let daemonStopResult: DaemonShutdownFacts['daemonStopResult'] | null = null;

/**
 * 正式停机（DEV-15 第十四轮三/四）：daemon.shutdown IPC（优雅：拒新命令→收拢→关库→退出
 * 0）+ 有界等待；超时 kill 兜底。全部入口（window-all-closed/演示结束/app 菜单）共用；重复
 * 调用复用同一过程不重复发起。返回结构化事实并落盘 appData/desktop-shutdown.json——强制
 * 终止不标为优雅成功，daemon 侧 stop-result 尾行（未确认执行/收拢失败）一并转写。
 */
let shutdownOnce: Promise<DaemonShutdownFacts> | null = null;
function shutdownDaemon(): Promise<DaemonShutdownFacts> {
  if (shutdownOnce != null) return shutdownOnce;
  shutdownOnce = (async (): Promise<DaemonShutdownFacts> => {
    daemonShuttingDown = true;
    readyAbort.abort(); // 收束在途就绪尝试（第二十二轮三）——关停后不再等待/重连。
    const stopRecordPath = join(appDataDir, 'state.sqlite');
    const facts: DaemonShutdownFacts = {
      requestDelivered: false, exited: false, exitCode: null, signal: null,
      timedOut: false, forceKilled: false, alreadyExited: daemonExitFacts != null, stopRecordPath,
    };
    try {
      if (pipe != null && !pipe.closed) {
        await pipe.send({ protocolVersion: 1, commandId: `ui-shutdown-${randomUUID()}`, method: 'daemon.shutdown', params: {} });
        facts.requestDelivered = true;
      }
    } catch (error) {
      facts.requestError = error instanceof Error ? error.message : String(error);
    }
    const d = daemonProcess;
    if (d != null) {
      if (daemonExitFacts != null) {
        facts.exited = true;
        facts.exitCode = daemonExitFacts.code;
        facts.signal = daemonExitFacts.signal;
      } else {
        const exited = new Promise<boolean>((r) => { d.once('exit', () => r(true)); });
        const grace = (ms: number): Promise<boolean> => new Promise((r) => { const t = setTimeout(() => r(false), ms); t.unref?.(); });
        if (!await Promise.race([exited, grace(10_000)])) {
          facts.timedOut = true;
          facts.forceKilled = true;
          d.kill();
          if (await Promise.race([exited, grace(3_000)])) facts.exited = true;
        } else {
          facts.exited = true;
        }
        // exit 回调（闭包）可能已写入——经函数读取避免控制流收窄。
        const observed = readDaemonExitFacts();
        if (observed != null) { facts.exitCode = observed.code; facts.signal = observed.signal; }
      }
      if (daemonStopResult != null) facts.daemonStopResult = daemonStopResult;
    }
    try {
      writeFileSync(join(appDataDir, 'desktop-shutdown.json'), JSON.stringify({ at: Date.now(), ...facts }, null, 2), 'utf8');
    } catch { /* 落盘尽力而为——事实已在 stderr */ }
    process.stderr.write(`[zhongshuo-ui] 停机事实：${JSON.stringify(facts)}\n`);
    return facts;
  })();
  return shutdownOnce;
}

let daemonPipe = '';
let daemonToken = '';

// UI 本地状态（localStorage 等）与 daemon 同仓隔离：不写宿主 %APPDATA%/Electron，
// 测试/多实例（ZS_APP_DATA）互不串扰。userData 必须在 app ready 前设定。
const appDataDir = process.env.ZS_APP_DATA ?? join(app.getPath('appData'), 'zhongshuo');
app.setPath('userData', join(appDataDir, 'electron-user-data'));

// 就绪链阶段（第二十一轮一）：spawnOk（进程已创建）→ pipeListening（daemon 侧 listen）→
// authOk（首次 auth.ok=真正可用）→ failed/exit（spawn error/提前退出/截止超时——立即失败，
// 不悬挂）。并发请求共享同一连接过程；统一次就绪截止（READY_DEADLINE_MS，覆盖重试+握手），
// 超时明确反馈并结束本次尝试。
const READY_DEADLINE_MS = Number(process.env.ZS_UI_READY_DEADLINE_MS ?? 90_000);
const uiSpawnAt = Date.now();
let daemonAuthed = false;
let connectInFlight: Promise<void> | null = null;
let spawnError: string | null = null;
// 就绪尝试取消（第二十二轮三）：退出/关停时收束在途握手——最后一次 connectPipe 的自身
// 超时不再额外超出就绪截止（剩余时间传入），且 app 退出路径不再等待悬挂的连接尝试。
const readyAbort = new AbortController();

async function ensureConnection(): Promise<void> {
  if (pipe != null && !pipe.closed) return;
  if (daemonPipe.length === 0) throw new Error('daemon 未启动（管道名未定）');
  if (spawnError != null) throw new Error(`daemon 启动失败：${spawnError}`);
  const exitFacts = readDaemonExitFacts();
  if (exitFacts != null && !daemonShuttingDown) throw new Error(`daemon 已退出（code=${exitFacts.code}）——连接不可用`);
  // 并发共享：同一段时间内所有请求等同一次连接过程（不各自重试放大负载）。
  if (connectInFlight != null) return connectInFlight;
  const deadline = Date.now() + READY_DEADLINE_MS;
  connectInFlight = (async () => {
    let lastError: unknown = null;
    for (;;) {
      if (Date.now() > deadline) break;
      const ex = readDaemonExitFacts();
      if (ex != null && !daemonShuttingDown) throw new Error(`daemon 启动中退出（code=${ex.code}）——连接中止`);
      try {
        // 剩余时间传入连接/握手时限（第二十二轮三）：最后一次握手不额外超出截止。
        pipe = await connectPipe(daemonPipe, {
          token: daemonToken,
          connectTimeoutMs: Math.max(1_000, deadline - Date.now()),
          signal: readyAbort.signal,
        });
        if (!daemonAuthed) {
          daemonAuthed = true;
          process.stderr.write(`[zhongshuo-ui] ready: auth.ok（spawn→认证 ${Date.now() - uiSpawnAt}ms，pipe=${daemonPipe}）
`);
        }
        pipeClosedCheck();
        return;
      } catch (error) {
        if (readyAbort.signal.aborted) throw new Error(`daemon 连接已取消（应用退出/关停）：${error instanceof Error ? error.message : String(error)}`);
        lastError = error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`daemon 连接截止超时（${READY_DEADLINE_MS}ms）`);
  })().finally(() => { connectInFlight = null; });
  return connectInFlight;
}

let closedNotified = false;
function pipeClosedCheck(): void {
  if (pipe == null) return;
  if (pipe.closed && !closedNotified) {
    closedNotified = true;
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('zs:disconnect', '连接已断开，正在重连…');
    void ensureConnection()
      .then(() => {
        closedNotified = false;
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('zs:reconnected', {});
      })
      .catch(() => { /* 下一次命令触发重连 */ });
  } else {
    setTimeout(pipeClosedCheck, 500).unref?.();
  }
}

// 远程壳证书钉选（第三十一轮五）：必须在 Chromium 初始化（app ready）前 appendSwitch——
// ready 后追加无效（实测 ERR_CERT_INVALID）。SPKI=证书公钥 SHA-256（标准 base64）。
if (process.env.ZS_REMOTE_SHELL_URL != null && process.env.ZS_REMOTE_SHELL_SPKI != null && process.env.ZS_REMOTE_SHELL_SPKI.length > 0) {
  app.commandLine.appendSwitch('ignore-certificate-errors-spki-list', process.env.ZS_REMOTE_SHELL_SPKI);
}

app.whenReady().then(async () => {
  // 远程浏览器验收壳（第三十一轮五；仅显式 ZS_REMOTE_SHELL_URL）：复用本包 Chromium 打开
  // 远程客户端页——**无 preload**（远程页不获本机桥）；证书以 SPKI 钉选信任（等价「用户核对
  // 指纹后信任」，不关闭证书校验）。用于 DEV-25 本机浏览器闭环/双机验收的客户端侧。
  const shellUrl = process.env.ZS_REMOTE_SHELL_URL;
  if (shellUrl != null) {
    const { BrowserWindow: ShellWindow } = await import('electron');
    const shell = new ShellWindow({ width: 1100, height: 820, webPreferences: {} });
    await shell.loadURL(shellUrl);
    if (process.env.ZS_REMOTE_SHELL_READY != null) {
      writeFileSync(process.env.ZS_REMOTE_SHELL_READY, JSON.stringify({ ok: true, url: shellUrl, at: Date.now() }));
    }
    return; // 不启动 daemon/主窗口——纯浏览器壳
  }
  // zsres://app/<相对路径> → renderer 目录内文件（穿越拒绝）；页面自身经该协议加载（模块/
  // worker/fetch 同源可用——见文件头注释）。
  protocol.handle('zsres', (request) => {
    const url = new URL(request.url);
    // host 白名单（第三十轮四：standard+secure 注册本身不是访问校验——跨 host/越界/编码穿越
    // 均须拒绝；路径解码后按段拒绝 `..`，再 normalize 比对根前缀）。
    if (url.hostname !== 'app') {
      return new Response(`zsres host 不在白名单：${url.hostname}`, { status: 403 });
    }
    let rel: string;
    try { rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')); }
    catch { return new Response('zsres 路径含非法编码', { status: 400 }); }
    if (rel.split('/').some((seg) => seg === '..')) {
      return new Response('zsres 路径越界拒绝', { status: 403 });
    }
    const filePath = normalize(join(rendererRoot, rel));
    const rootSep = sep;
    if (filePath !== rendererRoot && !filePath.startsWith(rendererRoot + rootSep)) {
      return new Response(null, { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
  const rawRuntime = process.env.ZS_RUNTIME ?? 'fake';
  const runtime = (rawRuntime === 'codex' || rawRuntime === 'claude' ? rawRuntime : 'fake') as 'fake' | 'codex' | 'claude';
  if (runtime === 'fake' && process.env.ZS_ALLOW_FAKE !== '1') {
    process.stderr.write('[zhongshuo-ui] fake 仅限开发模式（需 ZS_ALLOW_FAKE=1）；生产用 ZS_RUNTIME=codex|claude\n');
    app.quit();
    return;
  }
  // 就绪链（第二十轮一）：IPC handler **先注册**再等 daemon——renderer 加载/点击早于 daemon
  // 启动完成时，命令在 handler 内有界等待就绪（不再 reject→renderer alert 阻塞挂死）；
  // pickFolder 与 daemon 无依赖，立即可用。受控延迟钩子（测试同步点）：
  // ZS_UI_DAEMON_DELAY_MS=daemon 启动前延迟；ZS_UI_FIRST_COMMAND_DELAY_MS=首条命令响应延迟。
  let firstCommandDelayed = false;
  // 本机可信 UI 的 IPC sender 校验（第三十一轮三）：preload 桥（zs:command/openPath/pickFolder）
  // 只接受**本应用窗口**（zsres://app/ 源）的帧——其他任何加载进该窗口的内容拿不到桥；
  // 不以 loopback 地址替代来源校验（远程页面即使被误载也无法调用本机保留命令）。
  const assertTrustedSender = (event: Electron.IpcMainInvokeEvent): void => {
    const frameUrl = event.senderFrame?.url ?? '';
    if (!frameUrl.startsWith('zsres://app/')) {
      throw new Error(`IPC 来源不可信（${frameUrl.slice(0, 60) || '空'}）——本机桥仅限应用窗口`);
    }
  };
  ipcMain.handle('zs:command', async (event, envelope: unknown) => {
    assertTrustedSender(event);
    // 指定方法延迟钩子（第二十一轮二：按方法定向——project.open 响应延迟同步点；app 设置
    // 读取等先行的命令不再无谓消耗延迟）。
    const delayEnv = process.env.ZS_UI_DELAY_METHOD_MS;
    if (delayEnv != null && !firstCommandDelayed) {
      const [method, ms] = delayEnv.split(':');
      if (method === (envelope as { method?: string })?.method) {
        firstCommandDelayed = true;
        await new Promise((r) => setTimeout(r, Number(ms) || 0));
      }
    }
    await ensureConnection(); // 就绪截止/并发共享/退出即败（见函数头）
    return pipe!.send(envelope);
  });
  ipcMain.handle('zs:openPath', async (event, target: unknown) => {
    assertTrustedSender(event);
    // 导出目录打开（第三十轮五）：仅允许应用数据区 exports/ 内路径——外部任意路径不打开。
    if (typeof target !== 'string' || target.length === 0) throw new Error('openPath 需要路径');
    const resolved = resolve(String(target));
    const exportsRoot = resolve(join(appDataDir, 'exports'));
    const sep2 = sep;
    if (resolved !== exportsRoot && !resolved.startsWith(exportsRoot + sep2)) {
      throw new Error(`仅允许打开导出目录（${exportsRoot}）内的路径`);
    }
    const { shell } = await import('electron');
    shell.showItemInFolder(join(resolved, '.'));
    return resolved;
  });
  ipcMain.handle('zs:pickFolder', async (event) => {
    assertTrustedSender(event);
    // 自动化测试钩子（仅显式 ZS_PICK_FOLDER 时替代原生对话框返回值；后续链路不变）。
    if (process.env.ZS_PICK_FOLDER != null) return process.env.ZS_PICK_FOLDER;
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  if (process.env.ZS_UI_DAEMON_DELAY_MS != null) {
    await new Promise((r) => setTimeout(r, Number(process.env.ZS_UI_DAEMON_DELAY_MS) || 0));
  }
  await startDaemonProcess(appDataDir, runtime);
  // 就绪不再以 spawn 返回为准（第二十一轮一）：认证完成（ensureConnection 内 auth.ok）才可用；
  // 预热连接立即发起——首条命令与预热共享同一过程。
  void ensureConnection().catch((error) => {
    process.stderr.write(`[zhongshuo-ui] 预热连接失败（将由首条命令重试/报错）：${error instanceof Error ? error.message : String(error)}
`);
  });

  // 模拟验证模式（第十六轮二/四：本地体验入口 ZS_APP_MODE=fake-sim）——窗口标题明示 +
  // 日志说明：fake runtime+真实派发防护（保存真实绑定也不发真实请求）。
  const simMode = process.env.ZS_APP_MODE === 'fake-sim';
  if (simMode) {
    process.stderr.write('[zhongshuo-ui] 模拟验证模式：ZS_RUNTIME=fake + 真实派发防护——即使保存了真实 runtime 绑定，派发也会在 spawn 前被拒绝（不发出真实模型请求）\n');
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    ...(simMode ? { title: '众说（模拟验证模式——真实派发已防护，不会发出真实模型请求）' } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 后台/被遮挡窗口不被 Chromium 节流（第二十七轮一实证：提醒到点 2m11s 后才通知——
      // renderer 的 1.5s 轮询 setInterval 被后台节流挂起，直到窗口被交互激活）。提醒通知是
      // 本应用的核心交付通道，遮挡不得延迟。
      backgroundThrottling: false,
    },
  });
  // 模拟验证模式标题持久（页面 <title> 会在 loadFile 后覆盖 BrowserWindow title——标题是
  // 用户识别"当前实例不发真实请求"的第一标识，不得被冲掉）。
  if (simMode) {
    win.on('page-title-updated', (event) => { event.preventDefault(); });
  }
  // 外链与导航拦截（第三十一轮三）：携带高权 preload 桥的窗口不得加载/打开任何非
  // zsres://app/ 内容（window.open 一律拒绝；外部浏览器打开由用户自行复制——不在本窗口）。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('zsres://app/')) {
      event.preventDefault();
      process.stderr.write(`[zhongshuo-ui] 拦截窗口导航至非应用源：${url.slice(0, 80)}
`);
    }
  });
  await win.loadURL('zsres://app/index.html');

  const demo = process.env.ZS_UI_DEMO;
  if (demo != null) {
    void runDemo(win, demo).catch((error) => {
      process.stderr.write(`[zhongshuo-ui] demo failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      writeFileSync(demo, JSON.stringify({ ok: false, error: String(error) }));
      app.quit();
    });
  }
}).catch((error) => {
  process.stderr.write(`[zhongshuo-ui] 启动失败：${String(error)}\n`);
  app.quit();
});

app.on('window-all-closed', () => {
  // 停机命令须在关闭管道**之前**发出（shutdownDaemon 内部：daemon.shutdown→有界等待→
  // kill 兜底→关管道）；此处不再先行 close（否则 requestDelivered 恒 false）。
  // 受控同步点（第二十二轮二）：关闭请求后延迟开始停机——制造"旧实例窗口已关、进程
  // （含 daemon）仍在"的真实共存窗口，供下一实例启动时核对。测试专用，生产不设。
  const shutdownDelay = Number(process.env.ZS_UI_SHUTDOWN_DELAY_MS ?? 0);
  const beginShutdown = (): void => { void shutdownDaemon().finally(() => app.quit()); };
  if (shutdownDelay > 0) {
    process.stderr.write(`[zhongshuo-ui] shutdown 受控延迟 ${shutdownDelay}ms（ZS_UI_SHUTDOWN_DELAY_MS——窗口已关，进程仍在）\n`);
    setTimeout(beginShutdown, shutdownDelay).unref?.();
  } else beginShutdown();
});

/** 自动化演示（G3 取证）：open → submit → 等待 → history → screenshot → 写结果退出。 */
async function runDemo(win: BrowserWindow, resultPath: string): Promise<void> {
  const fixtureDir = process.env.ZS_DEMO_DIR;
  const rawDemo = process.env.ZS_RUNTIME ?? 'fake';
  const demoRuntime = rawDemo === 'codex' || rawDemo === 'claude' ? rawDemo : 'fake';
  if (fixtureDir == null) throw new Error('ZS_UI_DEMO 需要 ZS_DEMO_DIR');
  const shotDir = process.env.ZS_DEMO_SHOTS ?? join(resultPath, '..');
  mkdirSync(shotDir, { recursive: true });
  const t0 = Date.now();
  const e = (method: string, params: unknown) => ({ protocolVersion: 1 as const, commandId: `demo-${randomUUID()}`, method, params });

  try {
    await ensureConnection();
  } catch (connError) {
    process.stderr.write(`[demo] ensureConnection failed: ${String(connError)}\n`);
    throw connError;
  }
  process.stderr.write('[demo] connected, opening project\n');
  const open = (await pipe!.send(e('project.open', { path: fixtureDir }))) as { ok: boolean; data?: { project: { id: string } }; error?: { message: string } };
  process.stderr.write(`[demo] project.open -> ok=${open.ok}\n`);
  if (!open.ok) throw new Error(`project.open 失败：${open.error?.message}`);
  const projectId = open.data!.project.id;

  const rooms = (await pipe!.send(e('room.list', { projectId }))) as { data: { items: Array<{ id: string; conversationId: string | null }> } };
  const room = rooms.data.items[0]!;
  const members = (await pipe!.send(e('member.list', { projectId, roomId: room.id }))) as { data: { items: Array<{ id: string; principalType: string }> } };
  const agent = members.data.items.find((m) => m.principalType === 'agent')!;

  const submit = (await pipe!.send(e('message.submit', {
    target: { kind: 'room_root', projectId, conversationId: room.conversationId, roomId: room.id },
    body: process.env.ZS_DEMO_TASK ?? '请读取当前目录 notes.md 并告诉我宇宙密码',
    intent: 'default',
    mentions: [{ kind: 'member', memberId: agent.id }],
  }))) as { ok: boolean; data?: { taskId: string | null; threadId: string }; error?: { message: string } };
  if (!submit.ok) throw new Error(`message.submit 失败：${submit.error?.message}`);

  // 轮询任务状态（经命令面，不直连 DB）。
  const deadline = Date.now() + (Number(process.env.ZS_DEMO_TIMEOUT_MS ?? 240_000));
  let taskStatus: string;
  for (;;) {
    const task = (await pipe!.send(e('task.get', { taskId: submit.data!.taskId }))) as { data: { task: { status: string } } };
    taskStatus = task.data.task.status;
    win.webContents.send('zs:demo-status', taskStatus);
    if (taskStatus === 'DONE' || taskStatus === 'BLOCKED' || ['FAILED', 'CANCELLED'].includes(taskStatus)) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }

  const history = (await pipe!.send(e('thread.history', { threadId: submit.data!.threadId }))) as { data: { items: Array<{ authorType: string; body: { text: string } }> } };
  await new Promise((r) => setTimeout(r, 1_500)); // renderer 渲染
  let shot: string | null = null;
  try {
    const image = await win.webContents.capturePage();
    shot = join(shotDir, `g3-${demoRuntime}-${Date.now()}.png`);
    writeFileSync(shot, image.toPNG());
  } catch (shotError) {
    // 合成器不可用（如 RDP/无 GPU 会话）时截图失败不否定业务链路结果。
    process.stderr.write(`[demo] capturePage 失败（合成器不可用）：${String(shotError)}\n`);
  }

  writeFileSync(resultPath, JSON.stringify({
    ok: taskStatus === 'DONE',
    runtime: demoRuntime,
    projectId,
    taskId: submit.data!.taskId,
    threadId: submit.data!.threadId,
    taskStatus,
    agentReplies: history.data.items.filter((m) => m.authorType === 'agent').map((m) => m.body.text),
    elapsedMs: Date.now() - t0,
    screenshot: shot,
  }, null, 2));
  // 演示结束：正式停机（daemon.shutdown→优雅收拢→退出 0；超时 kill 兜底）——正常退出
  // 验收走同一路径，不因演示快捷方式绕过。
  void shutdownDaemon().finally(() => app.quit());
}
