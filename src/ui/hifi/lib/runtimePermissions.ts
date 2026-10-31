/** Display saved modes without changing their execution contract or stored values. */
export function runtimePermissionLabel(mode: string | null | undefined, kind?: string | null): string {
  if (kind === 'pi') return mode == null || mode === '' ? '默认：Pi 原生完整权限' : mode === 'bypassPermissions' ? 'Pi 原生完整权限' : `已保存：${mode}（Pi 受限模式尚未认证）`;
  if (mode == null || mode === '') return kind === 'fake' ? '默认：工程只读' : kind === 'deepseek-harness' ? '默认：Harness 原生完整权限' : kind === 'claude' || kind === 'codex' ? '默认：CLI 完整权限' : '默认：由有效渠道决定';
  if (kind === 'deepseek-harness') return mode === 'bypassPermissions' ? 'Harness 原生完整权限' : `已保存：${mode}（Harness 受限模式尚未认证）`;
  const labels: Record<string, string> = {
    bypassPermissions: '完整权限：读写电脑与执行命令',
    plan: '只读分析（plan）',
    acceptEdits: '项目内文件编辑（acceptEdits）',
    dontAsk: '项目内文件编辑（dontAsk，保留原边界）',
    manual: '旧配置 manual：实际只读',
    auto: '旧配置 auto：实际只读',
  };
  return labels[mode] ?? `未识别的权限配置：${mode}`;
}

export function runtimePermissionOptions(current: string | null | undefined, kind?: string | null) {
  const values = kind === 'deepseek-harness' || kind === 'pi' ? ['', 'bypassPermissions'] : ['', 'bypassPermissions', 'plan', 'acceptEdits', 'dontAsk'];
  if (current && !values.includes(current)) values.push(current);
  return values.map(value => ({ value, label: runtimePermissionLabel(value, kind) }));
}

export function runtimePermissionHint(kind: string): string {
  if (kind === 'pi') return '当前支持 Pi 原生完整权限；项目受限和只读模式尚未认证，不作为可用权限档提供。旧权限值保留，保存不代表受限模式已生效。';
  if (kind === 'deepseek-harness') return '当前支持 Harness 原生完整权限；项目受限和只读模式尚未认证，不作为可用权限档提供。旧权限值保留，保存不代表受限模式已生效。';
  if (kind === 'fake') return '演练渠道使用工程只读权限。';
  return '完整权限沿用 CLI 的原生机制，可读写电脑并执行命令。选择 plan 可保持只读；项目编辑模式保留明确授权边界。保存配置不等于渠道已实测。';
}
