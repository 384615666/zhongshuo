/**
 * 成员级 runtime 绑定（DEV-10；2026-09-28 生产接线）。
 *
 * 绑定链（schema 001 已有，本模块首次投入使用）：
 *   project_members.profile_id → agent_profiles.runtime_installation_id
 *   → runtime_installations(kind, executable)；模型/权限档存 agent_profiles.settings_json。
 *
 * 语义：
 * - 派发按**成员配置**选择 adapter（DispatchWorkerOptions.adapterFor）；未绑定成员回落
 *   全局默认 adapter（entry 按 ZS_RUNTIME 构建的那个）——不再由一个全局变量决定所有成员。
 * - 绑定了不可用 kind（daemon 未构建该 adapter 工厂）→ 抛错（派发如实失败），不静默换 runtime。
 * - adapter 实例按 installation+model+permissionMode 缓存（同配置成员共享，配置变更后新键新实例）。
 *
 * 能力记录纪律（用户令 2026-09-28）：runtime_installations.capabilities_json 分别记录
 * toolCapabilities（三态）/ modelAvailability / permissionAuth——真实认证结论只适用于
 * 实测组合（当前 CLI 版本 + adapter 版本 + 渠道 + 指定模型 + 实测权限档），不因成功回复
 * 或参数存在而整体升级。
 */
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import type { RuntimeAdapter } from '../contracts/runtime.ts';

export interface MemberRuntimeBinding {
  memberId: string;
  installationId: string | null;
  kind: string | null;
  executable: string | null;
  model: string | null;
  permissionMode: string | null;
}

interface BindingRow {
  installation_id: string | null;
  kind: string | null;
  executable: string | null;
  settings_json: string | null;
}

export function readMemberRuntimeBinding(db: ZhongshuoDatabase, memberId: string): MemberRuntimeBinding | null {
  const row = db
    .prepare(
      `SELECT ri.id AS installation_id, ri.kind AS kind, ri.executable AS executable, ap.settings_json AS settings_json
       FROM project_members pm
       LEFT JOIN agent_profiles ap ON ap.id = pm.profile_id
       LEFT JOIN runtime_installations ri ON ri.id = ap.runtime_installation_id
       WHERE pm.id = ?`,
    )
    .get(memberId) as BindingRow | undefined;
  if (row == null) return null;
  let settings: { model?: string; permissionMode?: string } = {};
  if (row.settings_json != null) {
    try {
      settings = JSON.parse(row.settings_json) as { model?: string; permissionMode?: string };
    } catch {
      settings = {};
    }
  }
  return {
    memberId,
    installationId: row.installation_id,
    kind: row.kind,
    executable: row.executable,
    model: settings.model ?? null,
    permissionMode: settings.permissionMode ?? null,
  };
}

export type MemberAdapterFactory = (binding: MemberRuntimeBinding) => RuntimeAdapter;

export interface MemberRuntimeRegistryOptions {
  /** 全局默认 adapter 的 runtime kind（ZS_RUNTIME 语义——防护判定用；缺省=不判定默认侧）。 */
  defaultKind?: string;
  /**
   * 真实派发防护（第十六轮四：ZS_REAL_DISPATCH_GUARD=1——模拟/验收/独立本地包环境）：
   * 派发解析出真实 runtime（claude/codex）时在 adapter 构建（即 spawn/请求）**之前**拒绝——
   * 全局 fake 默认不得被成员持久绑定绕过；**配置读写（member.setRuntime/member.runtime）不受
   * 影响**（可测试真实配置的保存与回读）。正式部署不设该变量=真实 runtime 正常可用。
   */
  realDispatchGuard?: boolean;
}

export class MemberRuntimeRegistry {
  private readonly db: ZhongshuoDatabase;
  private readonly defaultAdapter: RuntimeAdapter;
  private readonly factories: Record<string, MemberAdapterFactory>;
  private readonly options?: MemberRuntimeRegistryOptions;
  private readonly cache = new Map<string, RuntimeAdapter>();

  constructor(db: ZhongshuoDatabase, defaultAdapter: RuntimeAdapter, factories: Record<string, MemberAdapterFactory>, options?: MemberRuntimeRegistryOptions) {
    this.db = db;
    this.defaultAdapter = defaultAdapter;
    this.factories = factories;
    this.options = options;
  }

  adapterFor(memberId: string): RuntimeAdapter {
    const binding = readMemberRuntimeBinding(this.db, memberId);
    const unbound = binding == null || binding.installationId == null || binding.kind == null;
    const resolvedKind = unbound ? this.options?.defaultKind ?? null : binding.kind;
    if (this.options?.realDispatchGuard === true && (resolvedKind === 'claude' || resolvedKind === 'codex')) {
      throw new Error(`[验收防护] ZS_REAL_DISPATCH_GUARD=1：真实 runtime（${resolvedKind}）派发被拒绝（${unbound ? '全局默认' : `成员 ${memberId} 持久绑定`}）——模拟/验收环境不得发出真实模型请求；runtime 配置的保存与读取不受影响`);
    }
    if (unbound) {
      return this.defaultAdapter; // 未绑定成员：全局默认（ZS_RUNTIME 语义保留）
    }
    const factory = this.factories[binding.kind!];
    if (factory == null) {
      throw new Error(`成员 ${memberId} 绑定的 runtime kind=${binding.kind} 在当前 daemon 不可用（未注册 adapter 工厂）`);
    }
    const key = `${binding.installationId}|${binding.model ?? ''}|${binding.permissionMode ?? ''}`;
    let adapter = this.cache.get(key);
    if (adapter == null) {
      adapter = factory(binding);
      this.cache.set(key, adapter);
    }
    return adapter;
  }

  /**
   * daemon 收拢：逐个关闭默认与已构建的成员 adapter；**不静默吞失败**——
   * 继续清理其余，但汇总每个 adapter 的结果（成功/失败/退出未确认），上层据此上报。
   */
  async disposeAll(): Promise<MemberDisposeReport> {
    const all = [...new Set([this.defaultAdapter, ...this.cache.values()])];
    const report: MemberDisposeReport = { entries: [], failed: [], unconfirmed: [] };
    for (const adapter of all) {
      const label = adapter.constructor.name;
      const disposable = adapter as unknown as {
        dispose?: () => Promise<void>;
        disposeAll?: () => Promise<Array<{ turnId: string; exitConfirmed: boolean }>>;
        closeAllSessions?: () => Promise<void>;
      };
      try {
        if (typeof disposable.dispose === 'function') {
          await disposable.dispose();
          report.entries.push({ adapter: label, outcome: 'disposed' });
        } else if (typeof disposable.disposeAll === 'function') {
          const exits = await disposable.disposeAll();
          for (const e of exits) {
            report.entries.push({ adapter: label, outcome: 'disposed', turnId: e.turnId, exitConfirmed: e.exitConfirmed });
            if (!e.exitConfirmed) report.unconfirmed.push({ adapter: label, turnId: e.turnId });
          }
        } else if (typeof disposable.closeAllSessions === 'function') {
          await disposable.closeAllSessions();
          report.entries.push({ adapter: label, outcome: 'disposed' });
        } else {
          report.entries.push({ adapter: label, outcome: 'no-dispose-needed' });
        }
      } catch (error) {
        report.failed.push({ adapter: label, error: String(error).slice(0, 200) });
      }
    }
    return report;
  }
}

export interface MemberDisposeReport {
  entries: Array<{ adapter: string; outcome: 'disposed' | 'no-dispose-needed'; turnId?: string; exitConfirmed?: boolean }>;
  failed: Array<{ adapter: string; error: string }>;
  /** 停止请求已发但退出未确认的 turn（不确定，不假装已停止）。 */
  unconfirmed: Array<{ adapter: string; turnId: string }>;
}
