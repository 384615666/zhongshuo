/** Display saved modes without changing their execution contract or stored values. */
export function runtimePermissionLabel(mode: string | null | undefined, kind?: string | null): string {
  if (mode == null || mode === '') return kind === 'fake' ? '默认：工程只读' : kind === 'claude' || kind === 'codex' ? '默认：CLI 完整权限' : '默认：由有效渠道决定';
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
  const values = ['', 'bypassPermissions', 'plan', 'acceptEdits', 'dontAsk'];
  if (current && !values.includes(current)) values.push(current);
  return values.map(value => ({ value, label: runtimePermissionLabel(value, kind) }));
}
