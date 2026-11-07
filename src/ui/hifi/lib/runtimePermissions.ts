/** Display saved modes without changing their execution contract or stored values. */
const permissionModeCopy: Record<string, string> = {
  bypassPermissions: '完整权限：读写电脑与执行命令',
  plan: '只读分析',
  acceptEdits: '项目内文件编辑，自动接受编辑',
  dontAsk: '项目内文件编辑，不再逐次确认',
  manual: '手动模式：只读',
  auto: '自动模式：只读',
};

function permissionModeLabel(mode: string): string {
  return permissionModeCopy[mode] ?? '自定义权限';
}

export function runtimePermissionLabel(mode: string | null | undefined, kind?: string | null): string {
  if (kind === 'pi') return mode == null || mode === '' ? '默认：Pi 原生完整权限' : mode === 'bypassPermissions' ? 'Pi 原生完整权限' : `已保存：${permissionModeLabel(mode)}；Pi 受限模式尚未认证`;
  if (mode == null || mode === '') return kind === 'fake' ? '默认：只读' : kind === 'deepseek-harness' ? '默认：Harness 原生完整权限' : kind === 'claude' || kind === 'codex' ? '默认：完整权限' : '默认：由有效渠道决定';
  if (kind === 'deepseek-harness') return mode === 'bypassPermissions' ? 'Harness 原生完整权限' : `已保存：${permissionModeLabel(mode)}；Harness 受限模式尚未认证`;
  return permissionModeCopy[mode] ?? '已保存的权限设置无法识别';
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
  return '完整权限可读写电脑并执行命令；只读分析不能修改文件，项目内文件编辑模式只能创建和编辑项目内文件。';
}
