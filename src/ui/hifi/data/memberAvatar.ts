/**
 * 头像写入的唯一入口：`app.appearance.set` + 回读核对。
 *
 * daemon 侧 `writeAvatar` 只做格式与体积校验（PNG/JPEG/WebP，data URL ≤ 384 KiB），
 * 不会告诉我们写没写进去；这里沿用设置页的既有做法——写完立刻 `app.appearance.get`
 * 回读，不一致就当失败抛出，绝不"提示成功但其实没存"。
 */
import { command } from '../bridge';
import { setAppearanceState } from './store';

export interface AppearanceStateDto {
  showAvatars: boolean;
  avatars: Record<string, string>;
}

export const AI_AVATAR_SAVE_FAILED = '头像保存后回读不一致，未生效';

/** 写入某个对象的头像（`user` 或 `member:<id>`）；`null` 表示恢复默认首字母头像。 */
export async function saveAvatar(subject: string, dataUrl: string | null): Promise<string> {
  await command('app.appearance.set', { avatar: { subject, dataUrl } });
  const readBack = await command<AppearanceStateDto>('app.appearance.get', {});
  const actual = readBack.avatars[subject] ?? null;
  setAppearanceState(readBack.showAvatars === true, readBack.avatars ?? {});
  if (actual !== dataUrl) throw Error(AI_AVATAR_SAVE_FAILED);
  return actual;
}

/** 只读取当前头像表（不写）。 */
export async function readAppearance(): Promise<AppearanceStateDto> {
  const readBack = await command<AppearanceStateDto>('app.appearance.get', {});
  setAppearanceState(readBack.showAvatars === true, readBack.avatars ?? {});
  return { showAvatars: readBack.showAvatars === true, avatars: readBack.avatars ?? {} };
}
