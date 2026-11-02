/**
 * 自动创建的默认成员补头像。
 *
 * 新建项目/房间时，daemon 会按本机默认配置自动建好 Claude / Codex / DeepSeek Harness / Pi
 * 这些成员（id 形如 `m_default_<kind>_<projectId>`）。daemon 不持有图片数据，
 * 所以这些成员出生时没有头像，界面只能显示首字母色块。
 *
 * 这里在成员装载后补一次：按渠道补齐 `m_default_*` 成员，并纠正旧版统一写入的 DeepSeek 预设；
 * 显式选择由后台标记保护；并发手动修改通过原图比较保护。
 * 每个成员每次会话最多尝试一次，失败也不重试，避免每次装载都打一遍命令。
 */
import { command } from '../bridge';
import { setAppearanceState } from './store';
import { defaultAiAvatarPreset, defaultMemberAvatarPreset } from './avatarPresets';

interface AppearanceDto {
  showAvatars: boolean;
  avatars: Record<string, string>;
}

/** 本会话已经尝试过的成员 id（成功或失败都不再重复尝试）。 */
const attempted = new Set<string>();

export function resetDefaultAvatarBackfill(): void {
  attempted.clear();
}

export async function backfillDefaultMemberAvatars(
  members: Array<{ id: string; principalType: string; enabled?: boolean }>,
  avatars: Record<string, string>,
): Promise<void> {
  const legacyPreset = defaultAiAvatarPreset();
  const targets = members.filter((member) =>
    member.principalType === 'agent'
    && member.id.startsWith('m_default_')
    // 占位成员（「待添加 AI」）不要头像
    && !member.id.endsWith('_0')
    && member.enabled !== false
    && defaultMemberAvatarPreset(member.id) != null
    && (avatars[`member:${member.id}`] == null || (avatars[`member:${member.id}`] === legacyPreset.dataUrl && defaultMemberAvatarPreset(member.id)!.id !== legacyPreset.id))
    && !attempted.has(member.id));
  if (targets.length === 0) return;
  for (const member of targets) attempted.add(member.id);
  try {
    for (const member of targets) {
      await command('app.appearance.set', { avatar: { subject: `member:${member.id}`, dataUrl: defaultMemberAvatarPreset(member.id)!.dataUrl, defaultIfUnchanged: { dataUrl: avatars[`member:${member.id}`] ?? null } } });
    }
    const readBack = await command<AppearanceDto>('app.appearance.get', {});
    setAppearanceState(readBack.showAvatars === true, readBack.avatars ?? {});
  } catch {
    // 补头像不是关键路径：失败就保留首字母色块，下次新成员出现时再补。
  }
}
