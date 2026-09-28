/**
 * UI 端到端（修复轮 6）：renderer 驱动的真实用户链路——与 ZS_UI_DEMO（main 进程直连
 * pipe.send 的宿主内取证）明确区分。本文件经 CDP（--remote-debugging-port）在 renderer
 * 页面内触发真实 DOM 事件（点击/输入/键盘），链路 =
 * renderer app.js 事件处理 → preload zs.command（contextBridge）→ ipcMain →
 * 命名管道客户端 → daemon 命令面。不从 main/测试脚本发命令冒充 UI 点击。
 * 原生目录选择无法自动化：以 ZS_PICK_FOLDER 提供返回值（main 侧显式测试钩子），
 * 其后链路全部真实。
 *
 * 场景：发送→DONE→线程回复；线程跟进不新建根任务；仅记录零派发+一次性复位；
 * 双击/重复 Enter 去重；IME 组合态不发送；双视图草稿独立；页面重载后按上次项目恢复；
 * 运行中 SIGKILL daemon→断连提示→重启→恢复门禁→确认→完成（R2 显式确认语义）。
 * fake 档零额度；codex 档消耗真实 turn（ZS_G3_REAL=1 显式触发，预算受控）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'zhongshuo-uie2e-'));
const projDir = join(fixtureRoot, 'proj');
const ELECTRON_BIN = join('node_modules', 'electron', 'dist', 'electron.exe');
const DAEMON_ENTRY = join('src', 'daemon', 'entry.ts');

// 页面内测试钩子（window.__t）：只读 DOM 与真实事件派发，不含任何业务命令直调。
const PAGE_HOOKS = `
window.__t = {
  click: (id) => { document.getElementById(id).click(); return true; },
  dblClickSend: () => { const b = document.getElementById('send'); b.click(); b.click(); return true; },
  type: (id, text) => { const e = document.getElementById(id); e.value = text; e.dispatchEvent(new Event('input', { bubbles: true })); return e.value; },
  enter: (ime) => { const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: ime === true }); document.getElementById('composer-input').dispatchEvent(ev); return ev.defaultPrevented; },
  dblEnter: () => { const t = document.getElementById('composer-input'); const mk = () => new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); t.dispatchEvent(mk()); t.dispatchEvent(mk()); return true; },
  text: (id) => document.getElementById(id)?.textContent ?? null,
  hidden: (id) => document.getElementById(id)?.classList.contains('hidden') ?? true,
  inputValue: (id) => document.getElementById(id)?.value ?? null,
  cards: () => [...document.querySelectorAll('#pool .pool-card')].map((c) => ({ status: c.querySelector('.task-chip')?.dataset.taskStatus ?? '', body: c.children[1]?.textContent ?? '' })),
  openCard: (i) => { const c = document.querySelectorAll('#pool .pool-card')[i]; if (c == null) return false; c.click(); return true; },
  threadMsgs: () => [...document.querySelectorAll('#thread-messages .msg')].map((m) => ({ mine: m.classList.contains('mine'), anchor: m.dataset.anchor === '1', text: m.children[1]?.textContent ?? '' })),
  conn: () => document.getElementById('conn-state')?.textContent ?? '',
  gateVisible: () => !document.getElementById('resume-gate')?.classList.contains('hidden'),
  gateInfo: () => document.getElementById('resume-info')?.textContent ?? '',
  stopVisible: () => !document.getElementById('stop-btn')?.classList.contains('hidden'),
  stopDisabled: () => document.getElementById('stop-btn')?.disabled ?? true,
  threadStatus: () => document.getElementById('thread-status')?.textContent ?? '',
  recordOn: () => document.getElementById('record-toggle')?.classList.contains('on') ?? false,
  projectName: () => document.getElementById('project-name')?.textContent ?? '',
  reload: () => { location.reload(); return true; },
};
true;
`;

interface CdpPage {
  eval<T>(expr: string): Promise<T>;
  call(name: string, ...args: unknown[]): Promise<unknown>;
  close(): void;
}

interface UiApp {
  child: ChildProcess;
  page: CdpPage;
  pipeName: string;
  stderr: string;
  kill(): void;
}

function connectCdp(pageWsUrl: string): Promise<CdpPage> {
  const ws = new WebSocket(pageWsUrl);
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  ws.addEventListener('message', (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error != null) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  const call = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      const evalExpr = async <T,>(expr: string): Promise<T> => {
        const r = (await call('Runtime.evaluate', {
          expression: expr,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        })) as { result?: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
        if (r.exceptionDetails != null) {
          throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description ?? ''}`);
        }
        return r.result?.value as T;
      };
      const page: CdpPage = {
        eval: evalExpr,
        call(name: string, ...args: unknown[]): Promise<unknown> {
          const argList = args.map((a) => JSON.stringify(a)).join(',');
          return evalExpr(`window.__t.${name}(${argList})`);
        },
        close() {
          ws.close();
        },
      };
      resolve(page);
    });
    ws.addEventListener('error', () => reject(new Error(`CDP WebSocket 连接失败：${pageWsUrl}`)));
  });
}

async function launchUi(options: {
  appData: string;
  runtime: 'fake' | 'codex';
  extraEnv?: Record<string, string>;
}): Promise<UiApp> {
  const pipeName = `\\\\.\\pipe\\zhongshuo-uie2e-${randomUUID().slice(0, 8)}`;
  const child = spawn(ELECTRON_BIN, ['--remote-debugging-port=0', 'dist/ui/main.cjs'], {
    env: {
      ...process.env,
      ZS_APP_DATA: options.appData,
      ZS_RUNTIME: options.runtime,
      ZS_ALLOW_FAKE: '1',
      ZS_PICK_FOLDER: projDir, // 原生目录选择替代返回值；此后链路全部真实
      ZS_PIPE_NAME: pipeName,
      ZS_E2E_MODEL: process.env.ZS_E2E_MODEL ?? 'gpt-6-luna',
      ...options.extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  child.stdout.on('data', () => {});
  // DevTools 行：DevTools listening on ws://127.0.0.1:PORT/devtools/browser/...
  const wsMatch = await waitFor(async () => {
    const m = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/\S+)/);
    return m ? { browser: m[1]!, port: m[2]! } : null;
  }, 30_000, 'Electron CDP 端口就绪');
  const list = (await (await fetch(`http://127.0.0.1:${wsMatch!.port}/json/list`).then((r) => r.json())) as Array<
    { type: string; url: string; webSocketDebuggerUrl: string }
  >).filter((t) => t.type === 'page' && t.url.includes('index.html'));
  if (list.length === 0) throw new Error(`未找到页面目标：${stderr.slice(-400)}`);
  const page = await connectCdp(list[0]!.webSocketDebuggerUrl);
  await page.eval(PAGE_HOOKS); // 注入只读/事件派发钩子
  // 门时序：CDP 可在 body 末尾 app.js 执行前介入——等绑定完成再交互（否则点击会丢）。
  await waitFor(
    () => page.eval<boolean>(`document.readyState === 'complete' && typeof document.getElementById('open-folder')?.onclick === 'function'`),
    30_000, 'renderer app.js 就绪',
  );
  return {
    child,
    page,
    pipeName,
    get stderr() { return stderr; },
    kill() {
      page.close();
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* 清理尽力 */ }
    },
  };
}

async function waitFor<T>(probe: () => Promise<T> | T, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v != null && v !== false && !(Array.isArray(v) && v.length === 0)) return v;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function killTree(pid: number | undefined): void {
  if (pid == null) return;
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F']); } catch { /* 清理尽力 */ }
}

// ---------- fixture 与生命周期 ----------

const apps: UiApp[] = [];
let replacementDaemon: ChildProcess | null = null;

beforeAll(() => {
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, 'notes.md'), '# 备忘\n\n宇宙密码：UIE2E-CODEX-6666\n', 'utf8');
});
// 证据保全（修复轮）：真实/研讨用例失败时保留 fixture（取证优先于清理——此前三次
// 真实尝试的数据被清理，事后只能靠 WAL 字符串取证）。成功时正常清理。
let keepFixture = false;
(globalThis as unknown as { __zsKeepFixture?: (v: boolean) => void }).__zsKeepFixture = (v: boolean) => { keepFixture = v; };
afterAll(() => {
  for (const a of apps) a.kill();
  killTree(replacementDaemon?.pid);
  if (keepFixture) {
    process.stderr.write(`[uiE2e] 测试失败，保留取证目录：${fixtureRoot}
`);
    return;
  }
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(fixtureRoot, { recursive: true, force: true }); break; } catch { /* retry */ }
  }
});

// ---------- 场景（app A：fake、无停延） ----------

describe('UI 端到端（renderer 真实点击链路，fake 档零额度）', () => {
  let app: UiApp;
  const call = <T>(name: string, ...args: unknown[]) => app.page.call(name, ...args) as Promise<T>;

  beforeAll(async () => {
    app = await launchUi({ appData: join(fixtureRoot, 'appdata-a'), runtime: 'fake' });
    apps.push(app);
  });

  it('点击打开文件夹（pickFolder 替代返回值）→ 项目/房间加载，主池空态', async () => {
    expect(await call<string>('projectName')).toBe('未打开项目');
    await call('click', 'open-folder');
    await waitFor(() => call<string>('projectName').then((n) => n.includes('proj')), 30_000, '项目加载');
    expect(await call<string>('projectName')).toContain('proj');
    // M0 模式门禁：恰一名启用 agent 时预填 mention（DIRECT 可执行）；AUTO 由服务端 BLOCKED。
    expect(await call<string>('inputValue', 'mention-pick')).toBe('执行成员');
    expect(await call<string[]>('cards')).toEqual([]);
  }, 60_000);

  it('输入框填写 + Enter 发送 → 主池出现任务卡 → DONE → 打开线程见 agent 回复', async () => {
    await call('type', 'composer-input', '请读取 notes.md 并告诉我宇宙密码');
    const prevented = await call<boolean>('enter', false);
    expect(prevented).toBe(true); // Enter 被 app.js 捕获并发送
    const card = await waitFor(async () => (await call<Array<{ status: string }>>('cards'))[0], 30_000, '任务卡出现');
    // 初始 OPEN（建单未派发）→ ACTIVE → DONE 全为合法可见状态。
    expect(['OPEN', 'ACTIVE', 'DONE']).toContain(card!.status);
    await waitFor(
      async () => ((await call<Array<{ status: string }>>('cards'))[0]?.status ?? '') === 'DONE',
      30_000, '任务 DONE',
    );
    expect(await call<boolean>('openCard', 0)).toBe(true);
    await waitFor(
      async () => (await call<Array<{ mine: boolean }>>('threadMsgs')).some((m) => !m.mine),
      30_000, 'agent 回复入线程',
    );
    expect(await call<string>('threadStatus')).toContain('已完成');
    expect(await call<boolean>('stopVisible')).toBe(false); // 终态无停止入口
  }, 90_000);

  it('线程内跟进：发送绑定当前线程（不新建根任务）；消息落线程', async () => {
    await call('type', 'composer-input', '收到，补充一点：无需重跑');
    await call('click', 'send');
    // 根消息是锚点（置顶展示、data-anchor 标记）：跟进 = 锚点之外的本人消息。
    await waitFor(
      async () => {
        const msgs = await call<Array<{ mine: boolean; anchor: boolean }>>('threadMsgs');
        return msgs.some((m) => m.mine && !m.anchor) ? msgs : null;
      },
      30_000, '跟进消息入线程',
    );
    await call('click', 'thread-back-btn');
    // 主池卡片数不变：线程跟进没有新建根任务（R3 合同）。
    const cards = await call<Array<{ status: string }>>('cards');
    expect(cards.length).toBe(1);
  }, 60_000);

  it('双视图草稿独立：主池/线程各存一份，切换互不覆盖', async () => {
    await call('type', 'composer-input', '主池草稿X');
    await call('openCard', 0);
    expect(await call<string>('inputValue', 'composer-input')).toBe(''); // 线程视图草稿起始为空
    await call('type', 'composer-input', '线程草稿Y');
    await call('click', 'thread-back-btn');
    expect(await call<string>('inputValue', 'composer-input')).toBe('主池草稿X');
    await call('openCard', 0);
    expect(await call<string>('inputValue', 'composer-input')).toBe('线程草稿Y');
    await call('click', 'thread-back-btn'); // 收尾回主池，后续用例从主池视图出发
  }, 60_000);

  it('仅记录（一次性）：零派发、卡片为讨论串、发送后开关自动复位', async () => {
    await call('click', 'record-toggle');
    expect(await call<boolean>('recordOn')).toBe(true);
    await call('type', 'composer-input', '只记录这条，不要派发');
    await call('click', 'send');
    const cards = await waitFor(
      async () => (await call<Array<{ status: string }>>('cards')).find((c) => c.status === ''),
      30_000, '讨论串卡片出现（taskStatus 空）',
    );
    expect(cards).toBeDefined();
    expect(await call<boolean>('recordOn')).toBe(false); // 一次性复位
    const idx = (await call<Array<{ status: string }>>('cards')).findIndex((c) => c.status === '');
    await call('openCard', idx);
    // 线程渲染异步：等记录串内容就绪（仅本人消息；此前线程残留会因含 agent 消息继续等待）。
    await waitFor(
      async () => {
        const msgs = await call<Array<{ mine: boolean }>>('threadMsgs');
        return msgs.length >= 1 && msgs.every((m) => m.mine) ? msgs : null;
      },
      30_000, '记录串渲染（零 agent 回复）',
    );
    expect(await call<string>('threadStatus')).toContain('讨论串');
    await call('click', 'thread-back-btn');
  }, 60_000);

  it('去重：双击发送/同步双 Enter 只产生一张任务卡（同 commandId 语义）', async () => {
    const before = (await call<Array<unknown>>('cards')).length;
    await call('type', 'composer-input', '双击去重');
    await call('dblClickSend');
    await waitFor(
      async () => (await call<Array<unknown>>('cards')).length === before + 1,
      30_000, '双击后恰好 +1 卡',
    );
    await call('type', 'composer-input', '双Enter去重');
    await call('dblEnter');
    await new Promise((r) => setTimeout(r, 2_500)); // 轮询渲染窗口
    expect((await call<Array<unknown>>('cards')).length).toBe(before + 2);
  }, 60_000);

  it('IME 组合态 Enter 不发送', async () => {
    const before = (await call<Array<unknown>>('cards')).length;
    await call('type', 'composer-input', '拼音组合中');
    const prevented = await call<boolean>('enter', true); // isComposing=true
    expect(prevented).toBe(false); // handler 不拦截（不发送也不阻断默认）
    expect(await call<string>('inputValue', 'composer-input')).toBe('拼音组合中');
    await new Promise((r) => setTimeout(r, 1_800));
    expect((await call<Array<unknown>>('cards')).length).toBe(before);
    await call('type', 'composer-input', ''); // 清掉组合态残留草稿
  }, 60_000);

  it('页面重载（应用重启等价）→ 按上次项目路径恢复，主池历史完整（R5）', async () => {
    const before = (await call<Array<unknown>>('cards')).length;
    expect(before).toBeGreaterThanOrEqual(3);
    await app.page.eval('window.__t.reload()');
    await new Promise((r) => setTimeout(r, 2_000));
    await app.page.eval(PAGE_HOOKS); // 新文档需重注入
    await waitFor(
      () => app.page.eval<boolean>(`document.readyState === 'complete' && typeof document.getElementById('open-folder')?.onclick === 'function'`),
      60_000, '重载后 renderer 就绪',
    );
    await waitFor(
      async () => String(await app.page.call('projectName')).includes('proj'),
      60_000, '重载后自动恢复项目',
    );
    await waitFor(
      async () => ((await app.page.call('cards')) as unknown[]).length >= before,
      60_000, '主池历史恢复',
    );
    expect(await app.page.call('gateVisible')).toBe(false);
  }, 120_000);
});

// ---------- 场景（app B：fake + 停延，崩溃/恢复） ----------

describe('UI 端到端（运行中 SIGKILL daemon → 重启 → 恢复门禁 → 确认续跑）', () => {
  let app: UiApp;
  const call = <T>(name: string, ...args: unknown[]) => app.page.call(name, ...args) as Promise<T>;

  beforeAll(async () => {
    app = await launchUi({
      appData: join(fixtureRoot, 'appdata-b'),
      runtime: 'fake',
      extraEnv: { ZS_FAKE_STALL_MS: '9000' },
    });
    apps.push(app);
  });

  it('UI 停止（R1）：运行中点击停止 → STOPPING → 终态；停止按钮随终态隐藏', async () => {
    await call('click', 'open-folder');
    await waitFor(() => call<string>('projectName').then((n) => n.includes('proj')), 30_000, '项目加载');
    await call('type', 'composer-input', '长任务一：将被用户停止');
    await call('click', 'send');
    await waitFor(
      async () => ((await call<Array<{ status: string }>>('cards'))[0]?.status ?? '') === 'ACTIVE',
      30_000, '任务进入运行中',
    );
    await call('openCard', 0);
    await waitFor(() => call<boolean>('stopVisible'), 30_000, '停止按钮出现');
    // 点击时绑定任务快照（taskId/runId/停止代次）——即使随后切线程也不误停他人。
    await call('click', 'stop-btn');
    await waitFor(
      async () => (await call<string>('threadStatus')).includes('已停止'),
      30_000, '任务进入停止终态',
    );
    await waitFor(() => call<boolean>('stopVisible').then((v) => !v), 30_000, '停止按钮隐藏');
    await call('click', 'thread-back-btn'); // 回主池后主池卡片才会刷新（线程视图轮询只刷线程）
    await waitFor(
      async () => ((await call<Array<{ status: string }>>('cards'))[0]?.status ?? '') === 'CANCELLED',
      30_000, '主池卡片显示已停止',
    );
  }, 120_000);

  it('长任务运行中被 SIGKILL → 断连提示；重启 daemon → 恢复门禁出现（不自动续跑）', async () => {
    try {
    await call('type', 'composer-input', '长任务二：稍后会被中断');
    await call('click', 'send');
    await waitFor(
      async () => ((await call<Array<{ status: string }>>('cards'))[0]?.status ?? '') === 'ACTIVE',
      30_000, '任务进入运行中',
    );
    // 硬杀 daemon（SIGKILL=TerminateProcess：不走优雅 stop，模拟崩溃现场）。
    const pid = Number(readFileSync(join(fixtureRoot, 'appdata-b', 'daemon.pid'), 'utf8').trim());
    process.kill(pid, 'SIGKILL');
    await waitFor(() => call<string>('conn').then((c) => c.includes('断开')), 30_000, '断连提示出现');
    // 测试侧重启 daemon（等价生产中重启后端进程；同 appData/凭据/管道，无停延→续跑快完成）。
    replacementDaemon = spawn(process.execPath, ['--experimental-strip-types', DAEMON_ENTRY], {
      env: {
        ...process.env,
        ZS_APP_DATA: join(fixtureRoot, 'appdata-b'),
        ZS_RUNTIME: 'fake',
        ZS_ALLOW_FAKE: '1',
        ZS_PIPE_NAME: app.pipeName,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let daemonErr = '';
    replacementDaemon.stderr?.on('data', (d: Buffer) => { daemonErr += d.toString(); });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(daemonErr).toContain('listening'); // 新 daemon 就绪
    // renderer 重连后只读查询恢复状态 → 门禁入口出现且不自动续跑。
    await waitFor(() => call<boolean>('gateVisible'), 60_000, '恢复门禁入口出现');
    expect(await call<string>('gateInfo')).toMatch(/中断运行|待派发/);
    } catch (e) {
      console.error('[appB daemon/ui stderr tail]\n', app.stderr.slice(-2500));
      throw e;
    }
  }, 120_000);

  it('用户点击「确认继续」→ 开闸；中断任务不自动补跑（对账挂起）；新调度恢复可用', async () => {
    await call('click', 'resume-gate');
    await waitFor(() => call<boolean>('gateVisible').then((v) => !v), 30_000, '门禁消失');
    // 决策 44/RT-03：崩溃重领的派发不重跑——中断任务保持 ACTIVE（等对账/人工继续，DEV-08/09）。
    await new Promise((r) => setTimeout(r, 4_000));
    expect(((await call<Array<{ status: string }>>('cards'))[0]?.status ?? '')).toBe('ACTIVE');
    // 开闸后新提交正常派发执行（门禁只拦遗留工作，不拦新调度）。
    await call('type', 'composer-input', '恢复后的新任务');
    await call('click', 'send');
    await waitFor(
      async () => (await call<Array<{ status: string }>>('cards')).some((c) => c.status === 'DONE'),
      60_000, '新任务 DONE',
    );
  }, 150_000);
});

// ---------- 研讨（DELIBERATE）renderer 链路（fake sim，零额度） ----------

describe('UI 研讨链路（@全体 → DELIBERATE 全阶段 → 最终报告）', () => {
  it('点击 @全体研讨发送 → 阶段进度/成员状态可见 → DONE → 逐结论共识报告', async () => {
    const app = await launchUi({
      appData: join(fixtureRoot, 'appdata-delib'),
      runtime: 'fake',
      extraEnv: { ZS_ENABLE_DELIBERATE: '1', ZS_FAKE_DELIB: '1', ZS_BOOTSTRAP_AGENTS: '研究员甲,研究员乙', ZS_ABSENCE_MS: '600000' },
    });
    apps.push(app);
    const call = <T>(name: string, ...args: unknown[]) => app.page.call(name, ...args) as Promise<T>;
    await call('click', 'open-folder');
    await waitFor(() => call<string>('projectName').then((n) => n.includes('proj')), 30_000, '项目加载');
    // @全体研讨芯片（一次性意图）→ mentions=[{kind:'all'}] → 服务端 DELIBERATE 路由。
    await call('click', 'deliberate-toggle');
    await call('type', 'composer-input', '请全员研讨当前目录的架构风险');
    await call('click', 'send');
    await waitFor(
      async () => ((await call<Array<{ status: string }>>('cards'))[0]?.status ?? '') !== '',
      30_000, '研讨任务卡出现',
    );
    await call('openCard', 0);
    // 阶段进度可见（成员状态芯片 + 阶段名）；直至任务 DONE（fake sim 秒级完成各步）。
    await waitFor(
      async () => (await call<string>('text', 'delib-progress')).includes('研讨·'),
      30_000, '研讨进度条出现',
    );
    try {
      // 线程视图轮询只刷线程（主池 DOM 陈旧）——按线程状态行等待终态，再回主池核对卡片。
      await waitFor(
        async () => (await call<string>('threadStatus')).includes('已完成'),
        120_000, '研讨完成',
      );
    } catch (e) {
      const dbg = await app.page.eval(`(async()=>{ const w=window; const ev=(m,p)=>w.zs.command({protocolVersion:1,commandId:'dbg-'+Math.random(),method:m,params:p}); const proj=await ev('project.open',{path:${JSON.stringify(projDir)}}); const pid=proj.data.project.id; const evs=await ev('events.list',{projectId:pid,limit:40}); return JSON.stringify({kinds: evs.ok && evs.data.items.map((i)=>i.kind)}); })()`).catch((x: unknown) => `eval-failed ${x}`);
      console.error('[delib-diag]', dbg, '[stderr]', app.stderr.slice(-1500));
      throw e;
    }
    // 最终报告：逐结论共识芯片 + 整体共识（程序聚合，非模型自述）。
    await waitFor(
      async () => (await call<string>('text', 'delib-report')).length > 0,
      30_000, '最终报告渲染',
    );
    await call('click', 'thread-back-btn');
    await waitFor(
      async () => ((await call<Array<{ status: string }>>('cards'))[0]?.status ?? '') === 'DONE',
      30_000, '主池卡片 DONE',
    );
    const reportText = await call<string>('text', 'delib-report');
    expect(reportText).toContain('整体共识');
    expect(reportText).toMatch(/unanimous|qualified|unconfirmed|disputed/);
    const progressText = await call<string>('text', 'delib-progress');
    expect(progressText).toMatch(/研究员甲|研究员乙/);
    expect(await call<boolean>('hidden', 'delib-progress')).toBe(false);
  }, 240_000);
});

// ---------- 真实研讨演示（显式触发，预算受控） ----------

describe('UI 真实研讨（ZS_M1_REAL=1，真实 codex 多成员研讨一轮）', () => {
  it('两成员真实研讨：独立产出→互评→（争议则讨论）→整合→逐结论确认→报告一致', async ({ skip }) => {
    if (process.env.ZS_M1_REAL !== '1') skip(); // 真实档显式触发，预算受控
    const app = await launchUi({
      appData: join(fixtureRoot, 'appdata-m1real'),
      runtime: 'codex',
      extraEnv: { ZS_BOOTSTRAP_AGENTS: '分析师甲,分析师乙', ZS_DELIB_MAX_TURNS: '7', ZS_ABSENCE_MS: '600000', ZS_TURN_DEADLINE_MS: '420000' }, // 7=IND2+CR2+SYN1+RAT2 恰满；真实轮可长至 420s
    });
    apps.push(app);
    const call = <T>(name: string, ...args: unknown[]) => app.page.call(name, ...args) as Promise<T>;
    await call('click', 'open-folder');
    await waitFor(() => call<string>('projectName').then((n) => n.includes('proj')), 30_000, '项目加载');
    await call('click', 'deliberate-toggle');
    await call('type', 'composer-input', '请两位分别独立分析 notes.md 的内容要点与可疑之处，随后互评并形成整合结论');
    await call('click', 'send');
    await call('openCard', 0);
    await waitFor(
      async () => (await call<string>('threadStatus')).includes('已完成') || (await call<string>('threadStatus')).includes('待处理') || (await call<string>('threadStatus')).includes('失败'),
      840_000, '真实研讨终态',
    );
    try {
      const status = await call<string>('threadStatus');
      expect(status).toContain('已完成');
      const reportText = await call<string>('text', 'delib-report');
      expect(reportText).toContain('整体共识');
      expect(reportText).toMatch(/unanimous|qualified|unconfirmed|disputed/);
    } catch (e) {
      (globalThis as unknown as { __zsKeepFixture?: (v: boolean) => void }).__zsKeepFixture?.(true);
      throw e;
    }
  }, 900_000);
});

// ---------- 真实 runtime（显式触发，预算受控：单 turn） ----------

describe('UI 端到端（真实 codex，renderer 点击链路）', () => {
  it('真实一轮：点击发送 → 真实模型读 notes.md → 线程回流暗号 → DONE', async ({ skip }) => {
    if (process.env.ZS_G3_REAL !== '1') skip(); // 真实档显式触发，控制预算
    const app = await launchUi({ appData: join(fixtureRoot, 'appdata-c'), runtime: 'codex' });
    apps.push(app);
    const call = <T>(name: string, ...args: unknown[]) => app.page.call(name, ...args) as Promise<T>;
    await call('click', 'open-folder');
    await waitFor(() => call<string>('projectName').then((n) => n.includes('proj')), 30_000, '项目加载');
    await call('type', 'composer-input', '请读取当前目录 notes.md 并告诉我宇宙密码');
    await call('click', 'send');
    await waitFor(
      async () => ((await call<Array<{ status: string }>>('cards'))[0]?.status ?? '') === 'ACTIVE',
      30_000, '真实任务进入运行中',
    );
    expect(await call<boolean>('openCard', 0)).toBe(true);
    const reply = await waitFor(
      async () => {
        const msgs = await call<Array<{ mine: boolean; text: string }>>('threadMsgs');
        const agentText = msgs.filter((m) => !m.mine).map((m) => m.text).join('\n');
        return agentText.includes('UIE2E-CODEX-6666') ? agentText : null;
      },
      240_000, '真实回复含 fixture 暗号',
    );
    expect(reply).toBeTruthy();
    expect(reply!.length).toBeGreaterThan(0);
    // 终态（真实 turn 结束后任务 DONE；线程状态行由 renderer 轮询刷新）。
    await waitFor(
      async () => (await call<string>('threadStatus')).includes('已完成'),
      60_000, '任务 DONE',
    );
  }, 420_000);
});
