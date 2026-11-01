/** Display saved modes without changing their execution contract or stored values. */
export function runtimePermissionLabel(mode: string | null | undefined, kind?: string | null): string {
  if (kind === 'pi') return mode == null || mode === '' ? '默认：Pi 原生完整权限' : mode === 'bypassPermissions' ? 'Pi 原生完整权限' : `已保存：${mode}（Pi 受限模式尚未认证）`;
  if (mode == null || mode === '') return kind === 'fake' ? '默认：只读' : kind === 'deepseek-harness' ? '默认：Harness 原生完整权限' : kind === 'claude' || kind === 'codex' ? '默认：CLI 完整权限' : '默认：由有效渠道决定';
  if (kind === 'deepseek-harness') return mode === 'bypassPermissions' ? 'Harness 原生完整权限' : `已保存：${mode}（Harness 受限模式尚未认证）`;
  const labels: Record<string, string> = {
    bypassPermissions: '完整权限：读写电脑与执行命令',
    plan: '只读分析（plan）',
    acceptEdits: '项目内文件编辑（acceptEdits）',
    dontAsk: '项目内文件编辑（dontAsk）',
    manual: 'manual：只读',
    auto: 'auto：只读',
  };
  return labels[mode] ?? `未知的权限设置：${mode}`;
}

export function runtimePermissionOptions(current: string | null | undefined, kind?: string | null) {
  const values = kind === 'deepseek-harness' || kind === 'pi' ? ['', 'bypassPermissions'] : ['', 'bypassPermissions', 'plan', 'acceptEdits', 'dontAsk'];
  if (current && !values.includes(current)) values.push(current);
  return values.map(value => ({ value, label: runtimePermissionLabel(value, kind) }));
}

export function runtimePermissionHint(kind: string): string {
  if (kind === 'pi') return '当前仅支持 Pi 原生完整权限，项目受限和只读模式尚未认证。';
  if (kind === 'deepseek-harness') return '当前仅支持 Harness 原生完整权限，项目受限和只读模式尚未认证。';
  if (kind === 'fake') return '演练渠道使用只读权限。';
  return '完整权限可读写电脑并执行命令；plan 为只读，项目内文件编辑模式只能创建和编辑项目内文件。';
}
