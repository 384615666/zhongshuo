import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { AdapterCallError } from '../../contracts/runtime.ts';
import type { ProbeResult, RuntimeCapabilities, TurnRequest } from '../../contracts/runtime.ts';
import { externalRuntimeLaunchIdentity } from '../cli/configuration.ts';
import { resolveAgentExecutable } from '../cli/executable.ts';
import { CliTurnAdapter, isRecord, type CliAdapterOptions, type CliSession, type CliTurn } from '../cli/turnAdapter.ts';

export const DSH_ADAPTER_VERSION = 'dsh-profile-adapter-2';
/** Protocol support and actual model/platform certification remain distinct. */
export function deepseekHarnessCapabilities(): RuntimeCapabilities {
  return { structuredEvents: 'unverified', taskContextIsolation: 'unverified', resumeSession: 'unverified',
    steerActiveTurn: 'unsupported', interrupt: 'unverified', interactiveApprovals: 'unsupported',
    structuredFinal: 'unverified', restrictWrites: 'unsupported', restrictShell: 'unsupported',
    disableDelegation: 'unsupported', usageTokens: 'unverified', usageCost: 'unverified' };
}
export interface ExternalModel { id: string; label: string; efforts?: string[] }
const PROFILE_ARGS = ['--profile', 'zhongshuo'];
// The official composition loads providers before announcing appReady. Use the
// same bounded startup window for execution and metadata discovery.
const STARTUP_TIMEOUT_MS = 30000;

export class DeepSeekHarnessAdapter extends CliTurnAdapter {
  constructor(options: CliAdapterOptions = {}) { super('deepseek-harness', DSH_ADAPTER_VERSION, options); }
  capabilities(): RuntimeCapabilities { return deepseekHarnessCapabilities(); }
  protected arguments(): string[] { return [...PROFILE_ARGS, '--zs-stdio']; }
  protected validate(session: CliSession, input: TurnRequest): void {
    const planning = input.stage === 'coordination.planning';
    if (input.images?.length) throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'DeepSeek Harness 图片输入尚未认证，请换用已支持图片的成员', true);
    if (!input.repairOnly && !planning && (!session.input.writeAccess?.fullAccess || session.input.writeAccess.analysisOnly ||
      ![undefined, 'bypassPermissions'].includes(this.options.permissionMode)))
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'DeepSeek Harness 当前支持原生完整权限；只读分析和项目受限编辑尚未认证', true);
    if (input.repairOnly && !isRecord(input.outputSchema))
      throw new AdapterCallError('VALIDATION_INVALID', 'Harness 格式补交缺少结果结构，未启动执行', true);
    if (input.repairOnly && session.requestedSessionId)
      throw new AdapterCallError('VALIDATION_INVALID', 'Harness 格式补交需要独立的新会话，不能续接原执行', true);
    if (planning && (input.repairOnly || !isRecord(input.outputSchema) || session.requestedSessionId))
      throw new AdapterCallError('VALIDATION_INVALID', 'Harness 协作规划需要独立的新会话与成果结构', true);
    if (this.options.model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(this.options.model))
      throw new AdapterCallError('VALIDATION_INVALID', 'DeepSeek Harness 模型编号无效', true);
    const expected = session.input.writeAccess?.launchConfigurationKey;
    if (expected && externalRuntimeLaunchIdentity('deepseek-harness', this.options, session.ref.cwd).identityKey !== expected)
      throw new AdapterCallError('STALE_EXECUTION', 'DeepSeek Harness 程序或配置已变化，请重新发送', true);
  }
  protected begin(session: CliSession, turn: CliTurn): void {
    this.timer(turn, () => {
      if (turn.ready || turn.terminal) return;
      this.fail(session, turn, 'CAPABILITY_UNSUPPORTED', 'Harness 启动等待超时，尚未收到连接组件就绪确认；请检查官方 dsh 的启动和渠道连接后重试');
      this.stopProcess(turn);
    }, this.options.requestTimeoutMs ?? STARTUP_TIMEOUT_MS);
  }
  protected cancel(_session: CliSession, turn: CliTurn): void { this.send(turn, { v: 1, type: 'cancel', requestId: turn.requestId }); }
  protected onFrame(session: CliSession, turn: CliTurn, frame: Record<string, unknown>): void {
    if (frame.v !== 1 || typeof frame.type !== 'string') throw Error('Harness 消息版本无效');
    if (frame.type === 'ready') {
      if (turn.ready || frame.runtime !== 'zhongshuo-dsh' || frame.protocol !== 1 || !isRecord(frame.capabilities) ||
        frame.capabilities.structuredEvents !== true || frame.capabilities.sessionResume !== true || frame.capabilities.sessionCancel !== true)
        throw Error('Harness 连接组件不兼容，请重新安装众说连接组件');
      turn.ready = true;
      if (turn.stopRequested) { this.cancel(session, turn); return; }
      if ((turn.input.outputSchema && frame.capabilities.outputSchema !== true) ||
        (turn.input.repairOnly && frame.capabilities.formatRepair !== true) ||
        (turn.input.stage === 'coordination.planning' && frame.capabilities.planningOnly !== true)) {
        this.fail(session, turn, 'CAPABILITY_UNSUPPORTED', 'Harness 连接组件需要升级；请运行当前安装目录 runtime-tools/deepseek-harness/setup.cmd 后再继续任务', true);
        return;
      }
      this.send(turn, { v: 1, type: 'execute', requestId: turn.requestId, cwd: session.ref.cwd, prompt: turn.input.text,
        mode: turn.input.stage === 'coordination.planning' ? 'planning' : turn.input.repairOnly ? 'format-repair' : 'full', ...(session.requestedSessionId ? { sessionId: session.requestedSessionId } : {}),
        ...(this.options.model ? { model: this.options.model } : {}), ...(this.options.effort ? { effort: this.options.effort } : {}),
        ...(session.input.developerInstructions ? { developerInstructions: session.input.developerInstructions } : {}),
        ...(turn.input.outputSchema ? { outputSchema: turn.input.outputSchema } : {}) });
      return;
    }
    if (!turn.ready || frame.requestId !== turn.requestId) throw Error('Harness 消息不属于当前执行请求');
    if (frame.type === 'session') {
      if (frame.resumed !== Boolean(session.requestedSessionId)) throw Error('Harness 续接状态不匹配');
      this.sessionReady(session, turn, frame.sessionId); return;
    }
    if (frame.type === 'event') {
      if (!isRecord(frame.event)) throw Error('Harness 事件格式无效');
      const event = frame.event;
      switch (event.kind) {
        case 'text': this.text(session, turn, event.text); break;
        case 'thinking': this.text(session, turn, event.text, true); break;
        case 'tool-start':
          if (turn.input.repairOnly || turn.input.stage === 'coordination.planning') throw Error('Harness 当前阶段不允许执行工具');
          this.toolStart(session, turn, event.id, event.name, event.input); break;
        case 'tool-end':
          if (turn.input.repairOnly || turn.input.stage === 'coordination.planning') throw Error('Harness 当前阶段不允许执行工具');
          this.toolEnd(session, turn, event.id, event.isError, event.output); break;
        case 'usage': this.usage(session, turn, event); break;
        default: throw Error('Harness 返回了未知事件类型');
      }
      return;
    }
    if (frame.type === 'result') {
      if (frame.sessionId != null && frame.sessionId !== '') this.sessionReady(session, turn, frame.sessionId);
      if (frame.status === 'completed') {
        if (frame.stopReason && frame.stopReason !== 'completed') { this.fail(session, turn, 'OUTPUT_INVALID', 'Harness 在未正常完成时结束了输出', true); return; }
        this.complete(session, turn, frame.text); return;
      }
      if (frame.status !== 'failed' && frame.status !== 'cancelled') throw Error('Harness 终态无效');
      const error = isRecord(frame.error) ? frame.error : {};
      this.fail(session, turn, frame.status === 'cancelled' ? 'INTERRUPTED' : typeof error.code === 'string' ? error.code : 'PROVIDER_ERROR',
        typeof error.message === 'string' ? error.message : frame.status === 'cancelled' ? 'Harness 已取消本轮执行' : 'Harness 执行失败', true);
      return;
    }
    throw Error('Harness 返回了未知消息类型');
  }
  private async query(flag: '--zs-probe' | '--zs-models'): Promise<Record<string, unknown>> {
    if (this.options.cwd) {
      let available = false;
      try { available = statSync(this.options.cwd).isDirectory(); } catch { /* A missing project is not a missing connector. */ }
      if (!available) throw new AdapterCallError('RESOURCE_NOT_FOUND', '当前项目目录不存在或不可访问，无法读取该目录下的 Harness 配置；请先选择有效项目目录', true);
    }
    const entry = resolveAgentExecutable('deepseek-harness', this.options.executable);
    const output = await new Promise<string>((resolve, reject) => execFile(entry.command, [...entry.prefixArgs, ...PROFILE_ARGS, flag],
      // Provider catalogs can refresh at startup. A metadata timeout must not
      // misdiagnose a healthy connector as missing or erase configured providers.
      { cwd: this.options.cwd, env: entry.env ? { ...process.env, ...entry.env } : undefined, windowsHide: true, timeout: this.options.requestTimeoutMs ?? STARTUP_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (!error) { resolve(stdout); return; }
        const issue = error as Error & { killed?: boolean; code?: string | number };
        const message = issue.killed ? 'Harness 模型配置读取超时，请检查当前渠道的连接后重试；没有修改配置或发起模型推理'
          : issue.code === 'ENOENT' ? 'Harness 程序或项目目录不可访问，请重新选择已安装的官方 dsh 并检查项目目录'
          : 'Harness 配置或众说连接组件启动失败；请先检查官方 dsh 能否正常启动，组件需要修复时运行当前安装包 runtime-tools/deepseek-harness/setup.cmd（保留已有渠道和 MCP 配置）';
        reject(new AdapterCallError('CAPABILITY_UNSUPPORTED', message, true));
      }));
    let result: unknown;
    try { result = JSON.parse(output.trim()); } catch { throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'Harness 连接组件返回了无效信息，请重新安装连接组件', true); }
    if (!isRecord(result) || result.v !== 1 || result.runtime !== 'zhongshuo-dsh') throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'Harness 连接组件版本不兼容', true);
    return result;
  }
  async probe(): Promise<ProbeResult> {
    const result = await this.query('--zs-probe');
    if (result.type !== 'probe' || result.protocol !== 1 || !isRecord(result.capabilities) || result.capabilities.structuredEvents !== true)
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'Harness 连接组件未声明所需协议', true);
    return { executable: this.options.executable ?? 'dsh', version: typeof result.pluginVersion === 'string' ? result.pluginVersion : 'unknown', capabilities: this.capabilities() };
  }
  async listModels(): Promise<ExternalModel[]> {
    const result = await this.query('--zs-models');
    if (result.type !== 'models' || !Array.isArray(result.models)) throw new AdapterCallError('OUTPUT_INVALID', 'Harness 模型列表格式无效', true);
    return result.models.slice(0, 500).flatMap((model: unknown) => {
      if (!isRecord(model) || typeof model.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(model.id) || model.id.startsWith('sk-')) return [];
      return [{ id: model.id, label: typeof model.label === 'string' && !/[\r\n\0]/.test(model.label) ? model.label.slice(0, 120) : model.id,
        ...(Array.isArray(model.efforts) ? { efforts: model.efforts.filter((effort): effort is string => typeof effort === 'string' && /^[a-z]{1,16}$/.test(effort)).map(effort=>effort==='off'?'none':effort) } : {}) }];
    });
  }
}
