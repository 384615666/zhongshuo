/**
 * 头像选择器：预置头像九宫格 + 上传自定义图片 + 恢复默认。
 *
 * 用在「成员管理 → AI 设置」「添加 AI」以及三个模板弹窗里。选中值就是 data URL
 * （`app.appearance.set` 的 `avatar.dataUrl`），`null` 表示回到默认头像。
 *
 * 预置图走 esbuild 的 dataurl loader，`AVATAR_PRESETS[].dataUrl` 本身就是可直接落库的
 * data URL，所以"选预置"和"传自定义"在下游是同一条路径。
 *
 * 版式（用户 2026-11-02 反馈）：**只保留下面一排预置图**。原先上面还有一行
 * 「大预览 + 预置 · XX娘 + 顶栏、成员卡与消息里都用这张」的说明，属于重复信息——
 * 当前选中哪张，看下面那排的高亮框就够了，所以那行去掉。
 */
import { useRef, useState } from 'react';
import { Icon } from './Icon';
import { toast } from '../shell';
import { readAvatarFile } from '../data/avatarUpload';
import { AVATAR_PRESETS, presetForDataUrl } from '../data/avatarPresets';

export function AvatarPicker({
  value,
  disabled,
  allowCustom = true,
  onChange,
}: {
  value: string | null;
  disabled?: boolean;
  /** 模板只存预设标识、不存图片，所以模板表单要关掉自定义上传。 */
  allowCustom?: boolean;
  onChange: (dataUrl: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [reading, setReading] = useState(false);
  const current = presetForDataUrl(value);
  const isCustom = value != null && current == null;
  const busy = disabled === true || reading;

  const pickFile = (file: File | undefined): void => {
    if (file == null) return;
    setReading(true);
    void readAvatarFile(file)
      .then((dataUrl) => onChange(dataUrl))
      .catch((error: unknown) => toast((error as Error).message, 'error'))
      .finally(() => setReading(false));
  };

  const thumb = (selected: boolean) => ({
    width: 40,
    height: 40,
    padding: 0,
    borderRadius: '50%',
    overflow: 'hidden',
    cursor: busy ? 'not-allowed' : 'pointer',
    border: selected ? '2px solid var(--accent, #3b6ef6)' : '1px solid var(--border-subtle)',
    boxShadow: selected ? '0 0 0 2px var(--accent-soft, rgba(59,110,246,.18))' : 'none',
    background: 'transparent',
    display: 'grid',
    placeItems: 'center',
    lineHeight: 0,
    flex: 'none',
  }) as const;

  return (
    <div className="field" data-zs-avatar-picker="1">
      <span className="field-label">头像</span>

      <div className="row tight wrap" role="group" aria-label="预置头像" style={{ gap: 8 }}>
        {AVATAR_PRESETS.map((preset) => {
          const selected = value === preset.dataUrl;
          return (
            <button
              key={preset.id}
              type="button"
              className="btn"
              disabled={busy}
              aria-pressed={selected}
              aria-label={`使用预置头像：${preset.label}`}
              title={preset.label}
              data-zs-avatar-preset={preset.id}
              style={thumb(selected)}
              onClick={() => onChange(selected ? null : preset.dataUrl)}
            >
              <img src={preset.dataUrl} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </button>
          );
        })}
        {isCustom ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            aria-pressed
            aria-label="当前上传的图片"
            title="当前上传的图片"
            style={thumb(true)}
          >
            <img src={value ?? ''} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </button>
        ) : null}
      </div>

      <div className="row tight wrap" style={{ marginTop: 8, gap: 8 }}>
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="上传自定义头像"
          onChange={(event) => {
            pickFile(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
        />
        <button type="button" className="btn sm" disabled={busy} onClick={() => inputRef.current?.click()}
          style={allowCustom ? undefined : { display: 'none' }}>
          <Icon name="upload" size={12} /> {reading ? '读取中…' : '上传自定义'}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={busy || value == null}
          onClick={() => onChange(null)}
          title={value == null ? '当前已是默认头像' : '恢复默认头像'}
        >
          <Icon name="trash" size={12} /> 恢复默认
        </button>
      </div>
      <div className="field-hint">
        {allowCustom
          ? 'PNG、JPEG 或 WebP，≤ 384 KiB。点已选中的预置图可取消选择。'
          : '模板只保存预设头像；上传的图片属于具体成员，不会写进模板。点已选中的预置图可取消选择。'}
      </div>
    </div>
  );
}
