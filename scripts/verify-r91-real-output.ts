/**
 * R91 独立小范围真实调用冒烟（与 UI QA 并行；不改产品/既有脚本/不打包/不 commit）。
 *
 * 严格边界：
 * - 只用**最终包 daemon**（dist/desktop/desktop-daily-win-v27-r91-20261019/ZhongshuoDual 的
 *   resources/app/daemon/daemon.cjs，startDaemon 工厂）；独立合成项目/appData/pipe；
 * - 不经 fake adapter、不注入 testAdapter、不设置 ZS_ALLOW_FAKE / ZS_REAL_DISPATCH_GUARD；
 * - 每位成员最多 **一次真实 turn**：GLM(codex ccs-new/glm-5.3-flash) 一次、DeepSeek(claude
 *   deepseek-flash) 一次；失败/UNKNOWN 不重试、不换模型；
 * - 只读既有 CLI/网关配置；任务正文是合成小任务，不读取/发送用户业务文件或凭据；
 * - 校验真实落盘文件、TaskComplete.files、artifacts/message_attachments、正式 preview/原件导出、
 *   real_calls 请求模型与状态——不以模型自述“写了”为准。
 *
 * 用法：node scripts/verify-r91-real-output.ts
 * 证据：dist/review-r91-real-20261019/result.json + run-<key>/run.json
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 证据脚本读取任意 SQLite/命令返回形状；类型收紧不改变实验语义 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPipe } from '../src/contracts/daemonIpc.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(repo, 'dist', 'review-r91-real-20261019');
const PACKAGE = join(repo, 'dist', 'desktop', 'desktop-daily-win-v27-r91-20261019');
const PACKED_ROOT = join(PACKAGE, 'ZhongshuoDual');
const PACKED_ENTRY = join(PACKED_ROOT, 'resources', 'app', 'daemon', 'daemon.cjs');
const BUILD_FILE = join(PACKED_ROOT, 'BUILD.json');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

interface CommandResult { ok: boolean; data?: unknown; error?: { code?: string; message?: string } }

interface RunSpec {
  key: string;
  displayName: string;
  kind: 'codex' | 'claude';
  model: string;
  executable: string;
  relativeFile: string;
  fileContent: string;
  preview: 'text' | 'office';
  task: string;
}

const RUNS: RunSpec[] = [
  {
    key: 'glm', displayName: 'GLM', kind: 'codex', model: 'ccs-new/glm-5.3-flash', executable: 'codex',
    relativeFile: 'results/glm-note.txt', fileContent: 'R91_REAL_GLM_OUTPUT\n', preview: 'text',
    task: [
      '请在当前项目目录创建文件 results/glm-note.txt。',
      '文件内容严格为一行：R91_REAL_GLM_OUTPUT（允许且仅允许末尾一个换行）。',
      '完成后用自然语言简短答复，并在最终结构化 TaskComplete 的 files 数组中只列真实相对路径 "results/glm-note.txt"。',
      '不要创建其他文件，不要读取项目外文件。',
    ].join('\n'),
  },
  {
    key: 'deepseek', displayName: 'DeepSeek', kind: 'claude', model: 'deepseek-flash', executable: 'claude',
    relativeFile: 'results/deepseek-note.csv', fileContent: 'marker,R91_REAL_DS_OUTPUT\n', preview: 'office',
    task: [
      '请在当前项目目录创建文件 results/deepseek-note.csv。',
      '文件内容为两行：第一行 marker；第二行 R91_REAL_DS_OUTPUT。即内容严格为 "marker,R91_REAL_DS_OUTPUT" 加末尾换行。',
      '完成后用自然语言简短答复，并在最终结构化 TaskComplete 的 files 数组中只列真实相对路径 "results/deepseek-note.csv"。',
      '不要创建其他文件，不要读取项目外文件。',
    ].join('\n'),
  },
];

const report: Record<string, unknown> = {
  format: 'r91-real-output-smoke-v1',
  status: 'running',
  startedAt: new Date().toISOString(),
  evidenceDir: EVIDENCE,
  package: PACKAGE,
  packedEntry: PACKED_ENTRY,
  build: null,
  source: null,
  preconditions: null,
  runs: [],
  realTurnsAttempted: 0,
  notes: [
    '仅合成项目/文件；未读取或发送用户业务文件、凭据或全局配置。',
    '不使用 fake adapter；不注入 testAdapter；未设置 ZS_ALLOW_FAKE/ZS_REAL_DISPATCH_GUARD。',
    '每位成员最多一次真实 turn；失败/UNKNOWN 不重试、不换模型。',
  ],
  errors: [],
};

function writeReport(): void {
  report.endedAt = new Date().toISOString();
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, 'result.json'), JSON.stringify(report, null, 2), 'utf8');
}
function writeRun(run: Record<string, unknown>): void {
  const dir = join(EVIDENCE, `run-${String(run.key)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2), 'utf8');
}

function toolVersion(command: string, args: string[]): { found: boolean; output: string } {
  const where = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (where.status !== 0) return { found: false, output: (where.stderr ?? '').trim().slice(0, 300) };
  const version = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return { found: true, output: `${(where.stdout ?? '').trim()} || ${(version.stdout ?? version.stderr ?? '').trim()}`.slice(0, 400) };
}

function walkFiles(root: string): Array<{ path: string; bytes: number; sha256: string }> {
  const out: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) visit(p);
      else out.push({ path: relative(root, p).replaceAll('\\', '/'), bytes: st.size, sha256: sha256(readFileSync(p)) });
    }
  };
  visit(root);
  return out;
}

async function runOne(spec: RunSpec): Promise<Record<string, unknown>> {
  const run: Record<string, unknown> = {
    key: spec.key, displayName: spec.displayName, kind: spec.kind, model: spec.model,
    executable: spec.executable, relativeFile: spec.relativeFile, expectedContent: spec.fileContent,
    startedAt: new Date().toISOString(), status: 'running', checks: {}, attempts: 0, errors: [],
  };
  const errors = run.errors as string[];
  const checks = run.checks as Record<string, boolean>;
  const root = join(EVIDENCE, `fixture-${spec.key}`);
  const appData = join(root, 'app-data');
  const projectPath = join(root, 'project');
  const runDir = join(EVIDENCE, `run-${spec.key}`);
  mkdirSync(appData, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const pipeName = `\\\\.\\pipe\\zs-r91-real-${spec.key}-${randomUUID().slice(0, 8)}`;
  run.fixture = { root, appData, projectPath, pipeName };
  run.projectFilesBefore = walkFiles(projectPath);

  const packed = createRequire(import.meta.url)(PACKED_ENTRY) as { startDaemon?: (options: unknown) => Promise<any> };
  if (typeof packed.startDaemon !== 'function') throw new Error('最终包 daemon 未导出 startDaemon（包形态不支持无 GUI 启动）');
  let daemon: any = null;
  let pipe: Awaited<ReturnType<typeof connectPipe>> | null = null;
  try {
    daemon = await packed.startDaemon({
      appDataDir: appData, runtime: 'claude', pipeName, tickMs: 500, localUserId: `u_r91_real_${spec.key}`,
    });
    if (daemon?.pipeName == null) throw new Error('startDaemon 未返回 pipeName');
    pipe = await connectPipe(daemon.pipeName, { token: daemon.credential.token, requestTimeoutMs: 30_000, connectTimeoutMs: 30_000 });
    const command = async (method: string, params: unknown): Promise<unknown> => {
      const response = await pipe!.send({ protocolVersion: 1, commandId: `r91-real-${randomUUID()}`, method, params }) as CommandResult;
      if (!response.ok) throw new Error(`${method}: ${response.error?.code ?? 'ERROR'} ${response.error?.message ?? ''}`);
      return response.data;
    };
    const db = daemon.db as any;
    const opened = await command('project.open', { path: projectPath, displayName: `R91 real ${spec.displayName}`, agentNames: [spec.displayName] }) as { project: { id: string } };
    const projectId = opened.project.id;
    const members = (await command('member.list', { projectId })) as { items: Array<{ id: string; displayName: string; principalType: string; enabled: boolean }> };
    const member = members.items.find((item) => item.principalType === 'agent' && item.enabled && item.displayName === spec.displayName);
    if (member == null) throw new Error(`合成项目缺少成员 ${spec.displayName}`);
    run.memberId = member.id;
    // 只读核配置：runtimeCatalog（不派发 turn）。模型名可能不在目录里（网关自定义），记录原始结论。
    try {
      const catalog = await command('member.runtimeCatalog', { projectId, kind: spec.kind, executable: spec.executable });
      const text = JSON.stringify(catalog);
      run.catalog = { modelListed: text.includes(spec.model), excerpt: text.slice(0, 4000) };
    } catch (error) {
      run.catalog = { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
    // 成员级绑定（不改账户/全局配置）：完整 CLI 权限按用户已授权；真实 runtime，无 fake。
    run.binding = await command('member.setRuntime', {
      memberId: member.id, kind: spec.kind, model: spec.model, executable: spec.executable,
      permissionMode: 'bypassPermissions', projectId,
    });
    run.memberRuntime = await command('member.runtime', { memberId: member.id });
    const rooms = (await command('room.list', { projectId })) as { items: Array<{ id: string; conversationId: string }> };
    const room = rooms.items[0];
    if (room == null) throw new Error('合成项目缺少默认房间');
    run.room = room;
    run.attempts = 1;
    report.realTurnsAttempted = Number(report.realTurnsAttempted) + 1;
    const submitted = await command('message.submit', {
      target: { kind: 'room_root', projectId, conversationId: room.conversationId, roomId: room.id },
      body: spec.task, intent: 'default', mentions: [{ kind: 'member', memberId: member.id }],
    }) as { taskId: string; threadId: string };
    run.submitted = submitted;
    const taskId = submitted.taskId;
    const threadId = submitted.threadId;

    const statusOf = () => {
      const task = db.prepare('SELECT id,status,conversation_id,conversation_thread_id,room_id FROM tasks WHERE id=?').get(taskId) as any;
      const runRow = db.prepare('SELECT id,status FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as any;
      const turn = runRow == null ? undefined : db.prepare('SELECT id,status,member_id,run_id,stage_key FROM agent_turns WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(runRow.id) as any;
      const calls = turn == null ? [] : db.prepare('SELECT id,status,runtime_kind,model,response_model FROM real_calls WHERE turn_id=? ORDER BY id').all(turn.id) as any[];
      return { task, run: runRow, turn, calls };
    };
    const deadline = Date.now() + 180_000;
    let observed: any = statusOf();
    while (Date.now() < deadline) {
      observed = statusOf();
      const terminalTask = observed.task != null && ['DONE', 'REVIEW', 'BLOCKED', 'CANCELLED', 'FAILED'].includes(observed.task.status);
      const terminalTurn = observed.turn != null && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(observed.turn.status);
      const settledCalls = (observed.calls as any[]).length > 0 && (observed.calls as any[]).every((c) => c.status !== 'inflight');
      if ((terminalTask && (terminalTurn || observed.run == null)) || (terminalTurn && settledCalls)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    run.elapsedMs = 180_000 - Math.max(0, deadline - Date.now());
    run.finalStatus = {
      task: observed.task?.status ?? null,
      run: observed.run?.status ?? null,
      turn: observed.turn?.status ?? null,
      turnId: observed.turn?.id ?? null,
    };
    run.realCalls = observed.calls;
    const timedOut = !['DONE', 'REVIEW', 'BLOCKED', 'CANCELLED', 'FAILED'].includes(String(observed.task?.status ?? ''));
    if (timedOut) errors.push(`180s 内未到任务终态（turn=${observed.turn?.status ?? 'null'}）——不重试`);

    // 证据读取：命令桥（thread.history / 附件预览/原件）+ daemon 数据库（只读事实）。
    let history: any = { items: [] };
    try { history = await command('thread.history', { threadId }); } catch (error) { errors.push(`thread.history: ${(error as Error).message}`); }
    const task = db.prepare('SELECT id,project_id,conversation_id,conversation_thread_id,status FROM tasks WHERE id=?').get(taskId) as any;
    const turn = db.prepare('SELECT id,status,member_id FROM agent_turns WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(observed.run?.id) as any;
    const attachments = db.prepare(`
      SELECT ma.message_id AS messageId, ma.display_name AS filename, ma.source_hash AS sourceHash,
             a.id AS artifactId, a.kind AS kind, a.hash AS hash, a.revision AS revision, a.blob_path AS blobPath,
             a.author_id AS authorId, a.task_id AS taskId, a.conversation_id AS conversationId, a.source_name AS sourceName
      FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE a.task_id = ? ORDER BY ma.rowid`).all(taskId) as any[];
    const messages = db.prepare("SELECT id,author_id AS authorId,author_type AS authorType,status,thread_id AS threadId,body_json AS bodyJson FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid").all(taskId) as any[];
    const delivery = db.prepare('SELECT id,revision,manifest_hash FROM task_deliveries WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(taskId) as any;
    run.delivery = delivery ?? null;
    run.messages = messages.map((m) => ({ id: m.id, authorId: m.authorId, status: m.status, threadId: m.threadId, text: (() => { try { return String((JSON.parse(m.bodyJson) as { text?: unknown }).text ?? '').slice(0, 800); } catch { return ''; } })() }));
    run.attachments = attachments.map((a) => ({ messageId: a.messageId, artifactId: a.artifactId, filename: a.filename, kind: a.kind, revision: a.revision, hash: a.hash, authorId: a.authorId }));
    run.projectFilesAfter = walkFiles(projectPath);
    // turn 失败/不确定原因：取审计事件里的真实 code/message（不从模型自述推断）。
    const failureEvents = db.prepare(
      "SELECT kind,payload_json FROM domain_events WHERE task_id=? AND kind IN ('turn.statusChanged','turn.startupFailed','turn.outputInvalid','turn.lateCompletion') ORDER BY seq DESC LIMIT 5",
    ).all(taskId) as Array<{ kind: string; payload_json: string }>;
    run.failureEvents = failureEvents.map((e) => ({ kind: e.kind, payload: e.payload_json.slice(0, 1200) }));
    if (observed.turn?.status !== 'SUCCEEDED') {
      try {
        const failed = failureEvents.find((e) => e.kind === 'turn.statusChanged' && JSON.parse(e.payload_json).status === 'FAILED');
        const payload = failed == null ? null : JSON.parse(failed.payload_json) as { code?: string; message?: string };
        run.failureReason = payload == null ? null : `${payload.code ?? ''} ${payload.message ?? ''}`.trim();
      } catch { run.failureReason = null; }
    }

    // ① 实际文件（真实落盘，不是模型自述）
    const absoluteFile = join(projectPath, spec.relativeFile);
    checks.fileExists = existsSync(absoluteFile);
    let fileBytes: Buffer | null = null;
    if (checks.fileExists) {
      fileBytes = readFileSync(absoluteFile);
      const text = fileBytes.toString('utf8');
      checks.fileContentExact = text.replace(/\r\n/g, '\n').replace(/\n$/, '') === spec.fileContent.replace(/\r\n/g, '\n').replace(/\n$/, '');
      run.file = { path: relative(projectPath, absoluteFile).replaceAll('\\', '/'), bytes: fileBytes.length, sha256: sha256(fileBytes), text: text.slice(0, 400) };
    }
    // ② 正式结果 .files 声明（取本轮最终可见消息里的 TaskComplete 控制文本）
    const finalMessage = messages.find((m) => m.id === attachments[0]?.messageId) ?? messages[messages.length - 1];
    let declaredFiles: string[] = [];
    if (finalMessage != null) {
      try {
        const body = JSON.parse(finalMessage.bodyJson) as { runtimeControlResult?: unknown };
        if (typeof body.runtimeControlResult === 'string') {
          const control = JSON.parse(body.runtimeControlResult) as { files?: unknown };
          if (Array.isArray(control.files)) declaredFiles = control.files.filter((f): f is string => typeof f === 'string');
        }
      } catch { /* 控制文本缺失：声明检查失败 */ }
    }
    run.declaredFiles = declaredFiles;
    checks.filesDeclared = declaredFiles.some((f) => f.replaceAll('\\', '/') === spec.relativeFile);
    // ③ artifact/hash/作者/绑定消息
    const artifact = attachments.find((a) => a.filename === spec.relativeFile.split('/').pop() || a.sourceName === spec.relativeFile.split('/').pop());
    checks.artifactRow = artifact != null;
    if (artifact != null && fileBytes != null) {
      checks.hashMatchesFile = artifact.hash === sha256(fileBytes);
      checks.sourceHashMatches = artifact.sourceHash === artifact.hash;
      checks.authorMatches = artifact.authorId === member.id;
      checks.taskScopeMatches = artifact.taskId === taskId && artifact.conversationId === task.conversation_id;
      checks.blobMatchesFile = existsSync(artifact.blobPath) && sha256(readFileSync(artifact.blobPath)) === artifact.hash;
      checks.attachmentMessageBound = finalMessage != null && finalMessage.id === artifact.messageId;
      checks.attachmentAuthorMessage = finalMessage != null && finalMessage.authorId === member.id && finalMessage.status === 'final';
      checks.attachmentThreadMatches = finalMessage != null && finalMessage.threadId === task.conversation_thread_id;
      try {
        const historyItem = (history.items as any[]).find((item) => item.id === finalMessage?.id);
        checks.historyAttachmentVisible = historyItem != null && (historyItem.attachments as any[]).some((a) => a.artifactId === artifact.artifactId);
      } catch { checks.historyAttachmentVisible = false; }
      // ④ 正式预览/原件导出通道
      if (spec.preview === 'text') {
        const preview = await command('attachment.previewText', { attachmentId: artifact.artifactId, conversationId: task.conversation_id }) as any;
        checks.previewOk = typeof preview?.text === 'string' && preview.text.includes(spec.fileContent.trim());
        checks.previewHashMatches = preview?.hash === artifact.hash;
      } else {
        const preview = await command('attachment.previewOffice', { attachmentId: artifact.artifactId, conversationId: task.conversation_id }) as any;
        checks.previewOk = preview?.sourceFormat === 'csv' && Array.isArray(preview?.sheets);
        checks.previewHashMatches = preview?.hash === artifact.hash;
      }
      const original = await command('attachment.originalFile', { attachmentId: artifact.artifactId, conversationId: task.conversation_id }) as any;
      const originalBytes = Buffer.from(String(original?.bytesBase64 ?? ''), 'base64');
      checks.originalFileBytes = originalBytes.length > 0 && sha256(originalBytes) === sha256(fileBytes);
    }
    // ⑤ real_calls（请求模型与终态），不把 fake 当真实
    const calls = db.prepare('SELECT runtime_kind,model,status,response_model,detail FROM real_calls WHERE turn_id=? ORDER BY id').all(turn?.id) as any[];
    run.realCalls = calls;
    checks.realCallRow = calls.length === 1;
    checks.requestedModel = calls.length === 1 && calls[0].runtime_kind === spec.kind && calls[0].model === spec.model;
    checks.ledgerSettled = calls.length === 1 && calls[0].status !== 'inflight';
    run.ledgerStatus = calls.length === 1 ? String(calls[0].status) : null;
    // 汇总
    const required = ['fileExists', 'fileContentExact', 'filesDeclared', 'artifactRow', 'hashMatchesFile', 'sourceHashMatches',
      'authorMatches', 'taskScopeMatches', 'blobMatchesFile', 'attachmentMessageBound', 'attachmentAuthorMessage',
      'attachmentThreadMatches', 'historyAttachmentVisible', 'previewOk', 'previewHashMatches', 'originalFileBytes',
      'realCallRow', 'requestedModel', 'ledgerSettled'];
    checks.turnSucceeded = observed.turn?.status === 'SUCCEEDED';
    checks.taskTerminalSuccess = observed.task?.status === 'DONE' || observed.task?.status === 'REVIEW';
    run.passed = required.every((key) => checks[key] === true) && checks.turnSucceeded === true && checks.taskTerminalSuccess === true;
    report.status = 'completed';
  } catch (error) {
    errors.push((error instanceof Error ? `${error.message}` : String(error)).slice(0, 1200));
    run.status = 'failed-setup';
  } finally {
    try { if (pipe != null) await pipe.close(); } catch { /* 管道关闭尽力而为 */ }
    try {
      if (daemon != null) {
        const stop = await daemon.stop();
        run.daemonStop = stop;
      }
    } catch (error) {
      errors.push(`daemon.stop: ${(error as Error).message}`);
    }
  }
  run.endedAt = new Date().toISOString();
  if (run.status === 'running') run.status = run.passed === true ? 'passed' : 'failed';
  writeRun(run);
  return run;
}

void (async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  try {
    const build = JSON.parse(readFileSync(BUILD_FILE, 'utf8')) as { buildId: string; commit: string; dirty: boolean; dirtyDiffHash: string | null };
    const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    report.build = { ...build, packedEntrySha256: sha256(readFileSync(PACKED_ENTRY)), manifestEntry: JSON.parse(readFileSync(join(PACKED_ROOT, 'MANIFEST-SHA256.json'), 'utf8')).files.some((f: any) => f.path === 'resources/app/daemon/daemon.cjs') };
    report.source = { head, commitMatchesHead: head === build.commit };
    report.preconditions = {
      packageExists: existsSync(PACKED_ENTRY),
      codex: toolVersion('codex', ['--version']),
      claude: toolVersion('claude', ['--version']),
      envReal: { allowFake: process.env.ZS_ALLOW_FAKE ?? null, realDispatchGuard: process.env.ZS_REAL_DISPATCH_GUARD ?? null, batchId: process.env.ZS_REAL_BATCH_ID ?? null },
    };
    // 彻底清掉可能从外部继承的 fake/验收/批次覆盖；startDaemon options 决定 runtime。
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ZS_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
    }
    process.env.ZS_DEFAULT_MEMBER_DISCOVERY = '0';
    for (const spec of RUNS) {
      const run = await runOne(spec);
      (report.runs as unknown[]).push(run);
      writeReport();
    }
    const runs = report.runs as Array<{ passed?: boolean; status?: string; key?: string }>;
    report.status = runs.every((r) => r.passed === true) ? 'passed' : 'failed';
    report.summary = {
      attempted: report.realTurnsAttempted,
      passed: runs.filter((r) => r.passed === true).map((r) => r.key),
      failed: runs.filter((r) => r.passed !== true).map((r) => r.key),
      realCalls: runs.map((r) => ({ key: r.key, ledgerStatus: (r as any).ledgerStatus ?? null })),
    };
  } catch (error) {
    report.status = 'failed';
    (report.errors as string[]).push((error instanceof Error ? error.message : String(error)).slice(0, 1200));
  }
  writeReport();
  process.stdout.write(`${JSON.stringify({ status: report.status, summary: report.summary, evidence: join(EVIDENCE, 'result.json') }, null, 2)}\n`);
  process.exit(report.status === 'passed' ? 0 : 1);
})();
