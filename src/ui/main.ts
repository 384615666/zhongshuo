/**
 * Electron main（DEV-07）：窄接口 + daemon 组装。
 * - 进程内启动 daemon（startDaemon；fake 需 ZS_ALLOW_FAKE=1，见 entry 纪律）。
 * - preload 暴露的唯一能力是 invoke('zs:command', envelope)——renderer 不接触
 *   SQLite、不拉起 runtime 进程，也不在失败时回退种子数据。
 * - 连接断开时通知 renderer（'zs:disconnect'），重连由 main 负责。
 * - ZS_UI_DEMO=<json 路径> 自动化演示：开项目→发任务→轮询→截图→退出（G3 取证）。
 */
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectPipe, daemonPipeNameFor, ensureLocalCredential, localUserId } from '../contracts/daemonIpc.ts';
import type { PipeClient } from '../contracts/daemonIpc.ts';

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

async function ensureConnection(): Promise<void> {
  if (pipe != null && !pipe.closed) return;
  if (daemonPipe.length === 0) throw new Error('daemon 未启动');
  // 重试连接（子进程启动与管道就绪有窗口）。
  let lastError: unknown = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      pipe = await connectPipe(daemonPipe, { token: daemonToken });
      pipeClosedCheck();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('daemon 连接失败');
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

app.whenReady().then(async () => {
  const rawRuntime = process.env.ZS_RUNTIME ?? 'fake';
  const runtime = (rawRuntime === 'codex' || rawRuntime === 'claude' ? rawRuntime : 'fake') as 'fake' | 'codex' | 'claude';
  if (runtime === 'fake' && process.env.ZS_ALLOW_FAKE !== '1') {
    process.stderr.write('[zhongshuo-ui] fake 仅限开发模式（需 ZS_ALLOW_FAKE=1）；生产用 ZS_RUNTIME=codex|claude\n');
    app.quit();
    return;
  }
  await startDaemonProcess(appDataDir, runtime);

  ipcMain.handle('zs:command', async (_event, envelope: unknown) => {
    await ensureConnection();
    return pipe!.send(envelope);
  });
  ipcMain.handle('zs:pickFolder', async () => {
    // 自动化测试钩子（仅显式 ZS_PICK_FOLDER 时替代原生对话框返回值；后续链路不变）。
    if (process.env.ZS_PICK_FOLDER != null) return process.env.ZS_PICK_FOLDER;
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
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
    },
  });
  await win.loadFile(join(__dirname, 'renderer', 'index.html'));

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
  void shutdownDaemon().finally(() => app.quit());
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
