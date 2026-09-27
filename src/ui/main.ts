/**
 * Electron main（DEV-07）：窄接口 + daemon 组装。
 * - 进程内启动 daemon（startDaemon；fake 需 ZS_ALLOW_FAKE=1，见 entry 纪律）。
 * - preload 暴露的唯一能力是 invoke('zs:command', envelope)——renderer 不接触
 *   SQLite、不拉起 runtime 进程，也不在失败时回退种子数据。
 * - 连接断开时通知 renderer（'zs:disconnect'），重连由 main 负责。
 * - ZS_UI_DEMO=<json 路径> 自动化演示：开项目→发任务→轮询→截图→退出（G3 取证）。
 */
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectPipe, daemonPipeNameFor, ensureLocalCredential, localUserId } from '../contracts/daemonIpc.ts';
import type { PipeClient } from '../contracts/daemonIpc.ts';

// daemon 独立进程承载（§8.3：界面与 daemon 进程分离；native 模块只在 Node
// 进程加载，Electron 主进程仅经命名管道连接——不做 Electron ABI rebuild）。
let daemonProcess: ChildProcess | null = null;
let pipe: PipeClient | null = null;

/** 启动独立 daemon 子进程（Node 运行时；native 模块不进 Electron）。 */
async function startDaemonProcess(appDataDirToUse: string, runtime: 'fake' | 'codex'): Promise<void> {
  const entry = process.env.ZS_DAEMON_ENTRY ?? join(__dirname, '..', '..', 'src', 'daemon', 'entry.ts');
  mkdirSync(appDataDirToUse, { recursive: true }); // 凭据/数据库目录可能尚不存在
  const credential = ensureLocalCredential(appDataDirToUse);
  // 管道名默认按本机用户（单实例语义）；显式 ZS_PIPE_NAME 供多实例/端到端隔离。
  daemonPipe = process.env.ZS_PIPE_NAME ?? daemonPipeNameFor(localUserId());
  daemonToken = credential.token;
  // daemon 用系统 Node 运行（ELECTRON_RUN_AS_NODE 的 electron.exe 是 Electron ABI，
  // better-sqlite3 原生模块按 Node ABI 预编译——混用即 NODE_MODULE_VERSION 不匹配）。
  // 打包形态由 DEV-15 换绑随包 Node；开发/测试用 PATH 上的 node。
  const nodeBin = process.env.ZS_NODE_BIN ?? 'node';
  daemonProcess = spawn(nodeBin, ['--experimental-strip-types', entry], {
    env: {
      ...process.env,
      ZS_APP_DATA: appDataDirToUse,
      ZS_RUNTIME: runtime,
      ZS_ALLOW_FAKE: process.env.ZS_ALLOW_FAKE ?? '1',
      ZS_PIPE_NAME: daemonPipe,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemonProcess.stderr?.on('data', (d: Buffer) => process.stderr.write(`[daemon] ${d}`));
  daemonProcess.once('exit', (code) => {
    process.stderr.write(`[zhongshuo-ui] daemon 退出（code=${code}）\n`);
  });
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
  const runtime = (process.env.ZS_RUNTIME === 'codex' ? 'codex' : 'fake') as 'fake' | 'codex';
  if (runtime === 'fake' && process.env.ZS_ALLOW_FAKE !== '1') {
    process.stderr.write('[zhongshuo-ui] fake 仅限开发模式（需 ZS_ALLOW_FAKE=1）；生产用 ZS_RUNTIME=codex\n');
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

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
  pipe?.close();
  daemonProcess?.kill();
  app.quit();
});

/** 自动化演示（G3 取证）：open → submit → 等待 → history → screenshot → 写结果退出。 */
async function runDemo(win: BrowserWindow, resultPath: string): Promise<void> {
  const fixtureDir = process.env.ZS_DEMO_DIR;
  const demoRuntime = process.env.ZS_RUNTIME === 'codex' ? 'codex' : 'fake';
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
  daemonProcess?.kill(); // 演示结束即回收 daemon 子进程，避免残留占用管道/数据库
  app.quit();
}
