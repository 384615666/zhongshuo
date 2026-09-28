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

export class MemberRuntimeRegistry {
  private readonly db: ZhongshuoDatabase;
  private readonly defaultAdapter: RuntimeAdapter;
  private readonly factories: Record<string, MemberAdapterFactory>;
  private readonly cache = new Map<string, RuntimeAdapter>();

  constructor(db: ZhongshuoDatabase, defaultAdapter: RuntimeAdapter, factories: Record<string, MemberAdapterFactory>) {
    this.db = db;
    this.defaultAdapter = defaultAdapter;
    this.factories = factories;
  }

  adapterFor(memberId: string): RuntimeAdapter {
    const binding = readMemberRuntimeBinding(this.db, memberId);
    if (binding == null || binding.installationId == null || binding.kind == null) {
      return this.defaultAdapter; // 未绑定成员：全局默认（ZS_RUNTIME 语义保留）
    }
    const factory = this.factories[binding.kind];
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

  /** daemon 收拢：逐个关闭默认与已构建的成员 adapter（尽力而为，不抛出）。 */
  async disposeAll(): Promise<void> {
    const all = [...new Set([this.defaultAdapter, ...this.cache.values()])];
    for (const adapter of all) {
      const disposable = adapter as unknown as {
        dispose?: () => Promise<void>;
        disposeAll?: () => Promise<void>;
        closeAllSessions?: () => Promise<void>;
      };
      try {
        if (typeof disposable.dispose === 'function') await disposable.dispose();
        else if (typeof disposable.disposeAll === 'function') await disposable.disposeAll();
        else if (typeof disposable.closeAllSessions === 'function') await disposable.closeAllSessions();
      } catch {
        // 收拢尽力而为：单个 adapter 失败不阻断其余。
      }
    }
  }
}
