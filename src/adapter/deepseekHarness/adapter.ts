import { execFile } from 'node:child_process';
import { AdapterCallError } from '../../contracts/runtime.ts';
import type { ProbeResult, RuntimeCapabilities, TurnRequest } from '../../contracts/runtime.ts';
import { externalRuntimeLaunchIdentity } from '../cli/configuration.ts';
import { resolveAgentExecutable } from '../cli/executable.ts';
import { CliTurnAdapter, isRecord, type CliAdapterOptions, type CliSession, type CliTurn } from '../cli/turnAdapter.ts';

export const DSH_ADAPTER_VERSION = 'dsh-profile-adapter-1';
/** Protocol support and actual model/platform certification remain distinct. */
export function deepseekHarnessCapabilities(): RuntimeCapabilities {
  return { structuredEvents: 'unverified', taskContextIsolation: 'unverified', resumeSession: 'unverified',
    steerActiveTurn: 'unsupported', interrupt: 'unverified', interactiveApprovals: 'unsupported',
    structuredFinal: 'unverified', restrictWrites: 'unsupported', restrictShell: 'unsupported',
    disableDelegation: 'unsupported', usageTokens: 'unverified', usageCost: 'unverified' };
}
export interface ExternalModel { id: string; label: string; efforts?: string[] }
const PROFILE_ARGS = ['--profile', 'zhongshuo'];

export class DeepSeekHarnessAdapter extends CliTurnAdapter {
  constructor(options: CliAdapterOptions = {}) { super('deepseek-harness', DSH_ADAPTER_VERSION, options); }
  capabilities(): RuntimeCapabilities { return deepseekHarnessCapabilities(); }
  protected arguments(): string[] { return [...PROFILE_ARGS, '--zs-stdio']; }
  protected validate(session: CliSession, input: TurnRequest): void {
    if (input.images?.length) throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'DeepSeek Harness 图片输入尚未认证，请换用已支持图片的成员', true);
    if (input.repairOnly || !session.input.writeAccess?.fullAccess || session.input.writeAccess.analysisOnly ||
      ![undefined, 'bypassPermissions'].includes(this.options.permissionMode))
      throw new AdapterCallError('CAPABILITY_UNSUPPORTED', 'DeepSeek Harness 当前支持原生完整权限；只读分析、项目受限编辑和格式修复尚未认证', true);
    if (this.options.model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(this.options.model))
      throw new AdapterCallError('VALIDATION_INVALID', 'DeepSeek Harness 模型编号无效', true);
    const expected = session.input.writeAccess.launchConfigurationKey;
    if (expected && externalRuntimeLaunchIdentity('deepseek-harness', this.options, session.ref.cwd).identityKey !== expected)
      throw new AdapterCallError('STALE_EXECUTION', 'DeepSeek Harness 程序或配置已变化，请重新发送', true);
  }
  protected begin(session: CliSession, turn: CliTurn): void {
    this.timer(turn, () => { if (!turn.ready && !turn.terminal) this.protocolFailure(session, turn, 'Harness 连接组件没有完成握手，请检查安装'); }, this.options.requestTimeoutMs ?? 10000);
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
      this.send(turn, { v: 1, type: 'execute', requestId: turn.requestId, cwd: session.ref.cwd, prompt: turn.input.text,
        mode: 'full', ...(session.requestedSessionId ? { sessionId: session.requestedSessionId } : {}),
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
        case 'tool-start': this.toolStart(session, turn, event.id, event.name, event.input); break;
        case 'tool-end': this.toolEnd(session, turn, event.id, event.isError, event.output); break;
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
    const entry = resolveAgentExecutable('deepseek-harness', this.options.executable);
    const output = await new Promise<string>((resolve, reject) => execFile(entry.command, [...entry.prefixArgs, ...PROFILE_ARGS, flag],
      { cwd: this.options.cwd, env: entry.env ? { ...process.env, ...entry.env } : undefined, windowsHide: true, timeout: this.options.requestTimeoutMs ?? 10000, maxBuffer: 1024 * 1024 },
      (error, stdout) => error ? reject(new AdapterCallError('CAPABILITY_UNSUPPORTED', '无法读取 Harness 连接组件，请先安装官方 dsh 并运行众说连接组件安装入口', true)) : resolve(stdout)));
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
