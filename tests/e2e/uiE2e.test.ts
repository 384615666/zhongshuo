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
  recoveryRows: () => [...document.querySelectorAll('#recovery-panel .recovery-row')].map((r) => ({ turnId: r.dataset.turnId ?? '', text: r.textContent ?? '' })),
  recoveryPanelVisible: () => !document.getElementById('recovery-panel')?.classList.contains('hidden'),
  recoveryFacts: (turnId) => document.querySelector('#recovery-panel .recovery-row[data-turn-id="' + turnId + '"] .recovery-facts')?.textContent ?? null,
  recoveryButtons: (turnId) => [...document.querySelectorAll('#recovery-panel .recovery-row[data-turn-id="' + turnId + '"] button')].map((b) => b.textContent),
  recoverySetNote: (turnId, text) => { const i = document.querySelector('#recovery-panel .recovery-row[data-turn-id="' + turnId + '"] input.recovery-note'); if (i == null) return false; i.value = text; i.dispatchEvent(new Event('input', { bubbles: true })); return true; },
  recoveryClick: (turnId, label) => { const b = [...document.querySelectorAll('#recovery-panel .recovery-row[data-turn-id="' + turnId + '"] button')].find((x) => (x.textContent ?? '').includes(label)); if (b == null) return false; b.click(); return true; },
  recoveryProbeResult: (turnId) => document.querySelector('#recovery-panel .recovery-row[data-turn-id="' + turnId + '"] .recovery-probe-result')?.textContent ?? null,
  recoveryOrphan: () => [...document.querySelectorAll('#recovery-panel .recovery-facts')].map((e) => e.textContent ?? '').find((t) => t.includes('遗留保护')) ?? null,
  recoveryError: () => document.querySelector('#recovery-panel .recovery-error')?.textContent ?? null,
  confirmYes: () => { window.confirm = () => true; return true; },
  stopDisabled: () => document.getElementById('stop-btn')?.disabled ?? true,
  threadStatus: () => document.getElementById('thread-status')?.textContent ?? '',
  toolAudit: () => [...document.querySelectorAll('#thread-messages .tool-audit .tool-audit-row')].map((r) => ({ id: r.dataset.toolCallId ?? '', text: r.textContent ?? '' })),
  toolAuditHead: () => document.querySelector('#thread-messages .tool-audit .meta')?.textContent ?? null,
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

// ---------- 场景（app T：fake + ZS_FAKE_TOOL_EVENTS=1，线程内工具审计 UI） ----------

describe('UI 线程工具审计（CDP 断言：显示/去重/进行中/失败/unknown/切线程/刷新）', () => {
  let app: UiApp;
  const call = <T>(name: string, ...args: unknown[]) => app.page.call(name, ...args) as Promise<T>;

  beforeAll(async () => {
    // 独立实例：工具事件脚本只影响本实例首个 turn（后续回落默认——切线程隔离对照）。
    app = await launchUi({ appData: join(fixtureRoot, 'appdata-tools'), runtime: 'fake', extraEnv: { ZS_FAKE_TOOL_EVENTS: '1' } });
    apps.push(app);
  });

  it('工具审计卡：服务端去重后 3 张（重复 completed 不重卡）；结果/进行中如实显示', async () => {
    await call('click', 'open-folder');
    await waitFor(() => call<string>('projectName').then((n) => n.includes('proj')), 30_000, '项目加载');
    await call('type', 'composer-input', '带工具事件的审计任务');
    await call('click', 'send');
    await waitFor(
      async () => ((await call<Array<{ status: string }>>('cards'))[0]?.status ?? '') === 'DONE',
      30_000, '任务 DONE',
    );
    expect(await call<boolean>('openCard', 0)).toBe(true);
    const rows = await waitFor(
      async () => {
        const r = await call<Array<{ id: string; text: string }>>('toolAudit');
        return r.length === 3 ? r : null;
      },
      30_000, '工具审计 3 张卡（重复事件去重）',
    );
    expect(rows!.map((r) => r.id)).toEqual(['tc_read_1', 'tc_grep_2', 'tc_bash_3']);
    // 迟到重复 completed 取末值（unknown，如实）+ 进行中 + 失败：三条各自正确。
    expect(rows![0]!.text).toContain('unknown');
    expect(rows![1]!.text).toContain('进行中');
    expect(rows![2]!.text).toContain('failure');
    expect(rows![0]!.text).toContain('Read'); // 工具名来自首条 started
    expect(await call<string>('toolAuditHead')).toContain('3 条'); // 头部计数与去重一致
  }, 90_000);

  it('切线程不串记录：无工具事件的线程不渲染审计区块；重载后记录仍完整', async () => {
    // 回主池发第二个任务（本实例脚本已耗尽 → 默认脚本、无工具事件）。
    await call('click', 'thread-back-btn');
    await call('type', 'composer-input', '无工具事件的对照任务');
    await call('click', 'send');
    let dbg = '';
    await waitFor(
      async () => {
        const cards = await call<Array<{ status: string }>>('cards');
        dbg = JSON.stringify(cards);
        return (cards[1]?.status ?? '') === 'DONE';
      },
      30_000, '对照任务 DONE',
    ).catch((e) => { throw new Error(`${(e as Error).message}——现场 cards=${dbg}`); });
    // 最新在前（room.pool 按 created_at DESC）：cards[0]=对照任务（新）、cards[1]=工具任务。
    expect(await call<boolean>('openCard', 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(await call<Array<unknown>>('toolAudit')).toEqual([]); // 线程隔离：对照线程无记录
    // 刷新（等价应用重启视图）：回到工具线程，审计卡仍完整（服务端真源）。
    await call('click', 'thread-back-btn');
    await app.page.eval('window.__t.reload()');
    await new Promise((r) => setTimeout(r, 2_000));
    await app.page.eval(PAGE_HOOKS);
    await waitFor(
      () => app.page.eval<boolean>(`document.readyState === 'complete' && typeof document.getElementById('open-folder')?.onclick === 'function'`),
      60_000, '重载后 renderer 就绪',
    );
    await waitFor(() => call<string>('projectName').then((n) => n.includes('proj')), 60_000, '重载后自动恢复项目');
    await waitFor(async () => ((await call<Array<unknown>>('cards'))).length >= 2, 30_000, '主池恢复');
    expect(await call<boolean>('openCard', 1)).toBe(true); // cards[1]=工具任务（旧）
    const rows = await waitFor(
      async () => {
        const r = await call<Array<{ id: string; text: string }>>('toolAudit');
        return r.length === 3 ? r : null;
      },
      30_000, '重载后审计卡仍 3 张',
    );
    expect(rows!.map((r) => r.id)).toEqual(['tc_read_1', 'tc_grep_2', 'tc_bash_3']);
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
    // 等 startTurn 完成后进程身份登记落库（registerProcessIdentity 在 startTurn 成功后写）——
    // 再硬杀，崩溃遗留的 UNKNOWN 才带有可对账的登记身份。
    await new Promise((r) => setTimeout(r, 2000));
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
    // DEV-13·下：恢复面列出待对账 UNKNOWN（受影响任务/阶段+需人工判断动作）。
    const rows = await waitFor(async () => {
      const r = await call<Array<{ turnId: string; text: string }>>('recoveryRows');
      return r.length > 0 ? r : null;
    }, 30_000, '恢复面列待对账 UNKNOWN');
    expect(rows).not.toBeNull();
    expect(rows![0]!.text).toContain('状态未知（需对账）');
    } catch (e) {
      console.error('[appB daemon/ui stderr tail]\n', app.stderr.slice(-2500));
      throw e;
    }
  }, 120_000);

  it('恢复面对账反例：无登记 turn 服务端无法确认→人工声明后保护仍在（界面如实说明）；有登记（none）服务端核对后按条件收口', async () => {
    try {
      // 造第二个无登记 UNKNOWN 现场（身份缺失——崩溃发生在登记前的等价形态）+ 该 turn 持有租约：
      // 直接写 fixture DB（测试准备，模拟崩溃遗留——不绕过被测对账链路）。
      const { openDatabase } = await import('../../src/persistence/db.ts');
      const dbFile = join(fixtureRoot, 'appdata-b', 'state.sqlite');
      const db = openDatabase(dbFile);
      const crashed = db.prepare(`SELECT t.id AS turnId, t.run_id AS runId FROM agent_turns t WHERE t.status = 'UNKNOWN' LIMIT 1`).get() as { turnId: string; runId: string } | undefined;
      expect(crashed).toBeDefined(); // 崩溃用例遗留的 UNKNOWN（fake=none 登记）
      const ghostRunId = 'run_e2e_ghost';
      const ghostTurnId = 'turn_e2e_ghost_unknown';
      const taskRow = db.prepare(`SELECT r.task_id, r.conversation_id, t.conversation_thread_id AS thread_id, ct.member_id FROM workflow_runs r JOIN tasks t ON t.id = r.task_id JOIN agent_turns ct ON ct.run_id = r.id WHERE r.id = ? LIMIT 1`).get(crashed!.runId) as { task_id: string; conversation_id: string; thread_id: string | null; member_id: string };
      const e2eMemberId = taskRow.member_id;
      const ghostConv = taskRow.conversation_id;
      const ghostThread = taskRow.thread_id ?? 'th_ghost';
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES (?, ?, ?, ?, 'DIRECT', 0, 'INTERRUPTED', ?)`)
        .run(ghostRunId, taskRow.task_id, ghostConv, ghostThread, JSON.stringify({ runMaxTurns: 6, usedTurns: 0, inFlightReservedTurns: 1 }));
      db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, ?, ?, ?, 'direct.work', 'UNKNOWN', 'task:ghost:initial', 1, 1)`)
        .run(ghostTurnId, ghostRunId, ghostConv, ghostThread, e2eMemberId);
      db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES ('d:/e2e-ghost', ?, 1, 0, 'active')`).run(ghostTurnId);
      db.close();
      // 恢复面列出两个 UNKNOWN：崩溃 turn（none 登记）+ ghost（无登记）——等待 ghost 行实际渲染。
      const rows = await waitFor(async () => {
        const r = await call<Array<{ turnId: string; text: string }>>('recoveryRows');
        return r.some((x) => x.turnId === ghostTurnId) ? r : null;
      }, 30_000, '恢复面列出 ghost 待对账行');
      expect(rows).not.toBeNull();
      const ghostFacts = await waitFor(async () => {
        const t = await call<string>('recoveryFacts', ghostTurnId);
        return t != null ? t : null;
      }, 30_000, 'ghost 行的事实分层渲染');
      expect(ghostFacts).toContain('无进程身份登记'); // 程序观测如实：身份缺失
      expect(ghostFacts).toContain('写入租约 1 条'); // 保留保护可见
      // 服务端取证（只读）：无法确认+原因如实。
      await call('recoveryClick', ghostTurnId, '服务端取证');
      await waitFor(async () => ((await call<string>('recoveryProbeResult', ghostTurnId)) ?? '').includes('identity-missing'), 30_000, '取证结果显示身份缺失');
      // 人工声明未启动（风险确认）：confirm 桩 + note 必填。
      await call('confirmYes');
      expect(await call<boolean>('recoverySetNote', ghostTurnId, '任务管理器核对：无相关进程（e2e 人工声明）')).toBe(true);
      await call('recoveryClick', ghostTurnId, '人工声明未启动');
      // 对账收口：ghost 行消失（turn FAILED）；但**保护仍在**——遗留租约行如实说明原因。
      await waitFor(async () => {
        const r = await call<Array<{ turnId: string }>>('recoveryRows');
        return !r.some((x) => x.turnId === ghostTurnId) ? ['gone'] : null;
      }, 30_000, '人工声明后该 turn 收口（不再待对账）');
      const orphan = await waitFor(async () => {
        const t = await call<string>('recoveryOrphan');
        return t != null ? t : null;
      }, 30_000, '遗留保护行出现（人工声明不解除物理保护）');
      expect(orphan).toContain(ghostTurnId);
      expect(orphan).toContain('人工声明不解除');
      // 服务端核对完成才按条件收口：崩溃 turn（fake=none 登记）→ 先取证（no-os-process
      // 程序事实）→「对账：已执行」→ 该行按条件解除（消失）。
      const crashedId = crashed!.turnId;
      const crashedFacts = await call<string>('recoveryFacts', crashedId);
      expect(crashedFacts).toContain('无子进程模型'); // 进程身份登记存活（startTurn 后、SIGKILL 前落库）
      await call('recoveryClick', crashedId, '服务端取证');
      await waitFor(async () => ((await call<string>('recoveryProbeResult', crashedId)) ?? '').includes('no-os-process'), 30_000, '取证结果显示 no-os-process');
      await waitFor(async () => { const f = await call<string>('recoveryFacts', crashedId); return (f ?? '').includes('最近取证') ? f : null; }, 30_000, 'facts 含最近取证');
      expect(await call<boolean>('recoverySetNote', crashedId, '渠道账单核对：请求已执行（e2e）')).toBe(true);
      await call('recoveryClick', crashedId, '对账：已执行');
      try {
        await waitFor(async () => {
          const r = await call<Array<{ turnId: string }>>('recoveryRows');
          return !r.some((x) => x.turnId === crashedId) ? ['gone'] : null; // 非空数组（waitFor 视空数组为未就绪）
        }, 30_000, '服务端核对（none 程序事实）后该 turn 收口');
      } catch (e) {
        const errText = await call<string>('recoveryError').catch(() => null);
        throw new Error(`收口等待失败；恢复面错误行：${errText ?? '（无）'}；${(e as Error).message}`, { cause: e });
      }
      // 已执行但服务端无法确认（identity-missing）的反例：再造一个无登记 UNKNOWN 并选
      // 「对账：已执行」→ 结算但保留保护——行**仍在**（不提前收口），界面说明保留原因。
      const db2 = openDatabase(dbFile);
      db2.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES ('turn_e2e_exec_unknown', ?, ?, ?, ?, 'direct.work', 'UNKNOWN', 'task:ghost2:initial', 2, 2)`)
        .run(ghostRunId, ghostConv, ghostThread, e2eMemberId);
      db2.close();
      const row2 = await waitFor(async () => {
        const r = await call<Array<{ turnId: string }>>('recoveryRows');
        return r.some((x) => x.turnId === 'turn_e2e_exec_unknown') ? r : null;
      }, 30_000, '第三个 UNKNOWN 出现');
      expect(row2).not.toBeNull();
      await call('recoverySetNote', 'turn_e2e_exec_unknown', '渠道账单：已执行但无进程身份（e2e）');
      await call('recoveryClick', 'turn_e2e_exec_unknown', '对账：已执行');
      await new Promise((r) => setTimeout(r, 2_000));
      const rowsAfter = await call<Array<{ turnId: string }>>('recoveryRows');
      expect(rowsAfter.some((x) => x.turnId === 'turn_e2e_exec_unknown')).toBe(true); // 保护保留：不提前收口
      const factsAfter = await call<string>('recoveryFacts', 'turn_e2e_exec_unknown');
      expect(factsAfter).toContain('保留保护'); // 界面如实说明原因
    } catch (e) {
      console.error('[appB daemon/ui stderr tail]\n', app.stderr.slice(-2500));
      throw e;
    }
  }, 150_000);

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

// ---------- 建房与跨房间 renderer 链路（fake sim，零额度） ----------

describe('UI 建房与跨房间链路', () => {
  it('建房→成员子集→切换房间→发送→回复；草稿/主池/异步回复不跨房间串线', async () => {
    const app = await launchUi({ appData: join(fixtureRoot, 'appdata-rooms'), runtime: 'fake', extraEnv: { ZS_ENABLE_DELIBERATE: '1', ZS_FAKE_DELIB: '1', ZS_BOOTSTRAP_AGENTS: '分析甲,分析乙' } });
    apps.push(app);
    const call = <T>(name: string, ...args: unknown[]) => app.page.call(name, ...args) as Promise<T>;
    await call('click', 'open-folder');
    await waitFor(() => call<string>('projectName').then((n) => n.includes('proj')), 30_000, '项目加载');
    // 房 1：发一条 DELIB 任务（@全体；fake sim 全链契约合法）。
    await call('click', 'deliberate-toggle');
    await call('type', 'composer-input', '房间一的任务');
    await call('click', 'send');
    await waitFor(async () => (await call<Array<{ status: string }>>('cards')).length > 0, 30_000, '房1卡出现');
    await call('openCard', 0);
    try {
      await waitFor(() => call<string>('threadStatus').then((t) => t.includes('已完成')), 150_000, '房1任务 DONE');
    } catch (e) {
      const st = await call<string>('threadStatus').catch(() => 'ERR');
      const prog = await call<string>('text', 'delib-progress').catch(() => 'ERR');
      console.error('[room-diag] threadStatus:', st, '| progress:', prog.slice(0, 200));
      throw e;
    }
    await call('click', 'thread-back-btn');
    await new Promise((r) => setTimeout(r, 1_500));
    const pool1Count = (await call<Array<unknown>>('cards')).length;
    // 建房（成员子集=乙；prompt 由 CDP 模拟返回值）。
    await app.page.eval(`window.prompt = () => '作战室'; true`);
    await call('click', 'room-create');
    await waitFor(() => call<string>('text', 'room-list').then((t) => t.includes('作战室')), 30_000, '新房出现');
    // 新房自动重进（loadProject）→ 切到新房（第二个房间项）并核对主池为空（不混房1线程）。
    const roomItems = async () => (await app.page.eval(`[...document.querySelectorAll('.room-item')].map((e) => e.textContent)`)) as string[];
    await waitFor(async () => (await roomItems()).length >= 2, 15_000, '两房间');
    await app.page.eval(`[...document.querySelectorAll('.room-item')].find((e) => e.textContent.includes('作战室')).click(), true`);
    await waitFor(
      async () => (await app.page.eval(`[...document.querySelectorAll('.room-item')].find((e) => e.textContent.includes('作战室'))?.classList.contains('active')`)) === true,
      15_000, '新房激活',
    );
    await new Promise((r) => setTimeout(r, 2_500));
    expect((await call<Array<unknown>>('cards')).length).toBe(0); // 房1 的任务不混入新房
    // 在新房发送 DELIB 任务并等终态。
    await call('click', 'deliberate-toggle');
    await call('type', 'composer-input', '作战室的任务');
    await call('click', 'send');
    await call('openCard', 0);
    await waitFor(() => call<string>('threadStatus').then((t) => t.includes('已完成')), 120_000, '房2任务 DONE');
    await call('click', 'thread-back-btn');
    await new Promise((r) => setTimeout(r, 1_500));
    // 切回房 1：主池数量不变（房 2 的新任务不串入房 1）。
    await app.page.eval(`[...document.querySelectorAll('.room-item')].find((e) => e.textContent.includes('默认房间')).click(), true`);
    await waitFor(
      async () => (await app.page.eval(`[...document.querySelectorAll('.room-item')].find((e) => e.textContent.includes('默认房间'))?.classList.contains('active')`)) === true,
      15_000, '房1重新激活',
    );
    await new Promise((r) => setTimeout(r, 2_500));
    expect((await call<Array<unknown>>('cards')).length).toBe(pool1Count);
    // 草稿独立：在房 1 输入草稿→切房 2→草稿区为空→切回→草稿保留。
    await call('type', 'composer-input', '房1草稿');
    await app.page.eval(`[...document.querySelectorAll('.room-item')].find((e) => e.textContent.includes('作战室')).click(), true`);
    await waitFor(async () => (await call<string>('inputValue', 'composer-input')) === '', 10_000, '切房后草稿清空');
    await app.page.eval(`[...document.querySelectorAll('.room-item')].find((e) => e.textContent.includes('默认房间')).click(), true`);
    await waitFor(async () => (await call<string>('inputValue', 'composer-input')) === '房1草稿', 10_000, '切回后草稿保留');
  }, 240_000);
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
