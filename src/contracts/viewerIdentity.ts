/**
 * 用户自己的显示名（R195 第 9 项）。
 *
 * 此前对话里本人消息一律署名「你」：用户要求能在设置里指定自己的名字。
 * 口径：
 *  - 真值在 daemon 的 app.settings（稳定键 `ui.viewer.displayName`），跨重开生效；
 *  - 空值/未设置 = 保持原来的「你」——不因为没设置就改默认观感；
 *  - 只影响**显示**（消息署名、引用来源标签、设置页预览），不改任何命令参数、
 *    不写消息正文、不改变 audience；
 *  - 首尾空白与连续空白归一、控制字符剔除；超长按上限截断（不是拒绝——用户输入
 *    不该因为多打几个字就整条失败）。
 */
export const VIEWER_DISPLAY_NAME_SETTING_KEY = 'ui.viewer.displayName' as const;

/** 名字上限：够长到能写「张三（产品）」这类短标注，又不至于把消息头挤乱。 */
export const VIEWER_DISPLAY_NAME_MAX_LENGTH = 24;

/** 归一化用户输入；null/空串 = 未设置。 */
export function normalizeViewerDisplayName(raw: string | null | undefined): string {
  if (raw == null) return '';
  const text = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > VIEWER_DISPLAY_NAME_MAX_LENGTH ? text.slice(0, VIEWER_DISPLAY_NAME_MAX_LENGTH) : text;
}

/** 显示用标签：未设置依然显示「你」。 */
export function viewerDisplayLabel(raw: string | null | undefined): string {
  const name = normalizeViewerDisplayName(raw);
  return name.length > 0 ? name : '你';
}
