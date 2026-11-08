/**
 * 消息附件缩略图（R192）。
 *
 * 用户反馈「发送的消息应该支持预览图查看」：图片附件此前和普通文件一样只显示一个
 * 文件图标（而且 Icon 没有 `image` 字形，实际渲染成一个黑色圆点），看不出内容。
 *
 * 口径：
 *  - 只对**图片附件**取缩略图；其它类型永远走文件图标，不请求图片命令。
 *  - 读取复用正式 `attachment.previewImage`（audience + sha256 原件核对都在 daemon），
 *    不在 renderer 里读路径、不新增文件系统入口。
 *  - 缩略图按需加载：进入视口附近才请求（IntersectionObserver），并在模块内做小型
 *    LRU 缓存（最多 8 张），避免长对话来回滚动重复取原图。
 *  - 加载失败只退回图标，不冒充有图；点击行为仍由外层按钮（打开共享预览）负责。
 *  - R195 第 1 项：在消息图片网格里使用时（`messageImage`），宿主额外输出
 *    `data-zs-message-image=loading|ready|failed`，截图脚本据此断言是否真的
 *    渲染了 <img>、是否已加载、失败时是否退回图标；尺寸完全交给网格 CSS。
 */
import { useEffect, useRef, useState } from 'react';
import { command } from '../bridge';
import { Icon } from './Icon';

/** 与 fileSource.formatKindOf 的图片判定同口径（扩展名/附件 kind 任一命中即可）。 */
export function isImageAttachment(filename: string, kind?: string): boolean {
  return kind === 'image_file' || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filename);
}

const CACHE_LIMIT = 8;
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

function remember(attachmentId: string, dataUrl: string): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest != null) cache.delete(oldest);
  }
  cache.set(attachmentId, dataUrl);
}

function loadThumb(attachmentId: string): Promise<string | null> {
  const cached = cache.get(attachmentId);
  if (cached != null) return Promise.resolve(cached);
  const inFlight = pending.get(attachmentId);
  if (inFlight != null) return inFlight;
  const request = command<{ dataUrl?: string }>('attachment.previewImage', { attachmentId })
    .then((result) => {
      const dataUrl = typeof result?.dataUrl === 'string' && result.dataUrl.length > 0 ? result.dataUrl : null;
      if (dataUrl != null) remember(attachmentId, dataUrl);
      return dataUrl;
    })
    .catch(() => null)
    .finally(() => { pending.delete(attachmentId); });
  pending.set(attachmentId, request);
  return request;
}

export function AttachmentThumb({
  attachmentId,
  filename,
  kind,
  size = 'md',
  title,
  messageImage = false,
}: {
  attachmentId: string;
  filename: string;
  kind?: string;
  /** md=消息文件卡左侧缩略图；sm=行内附件芯片的小图；lg=图片消息卡的大预览。 */
  size?: 'sm' | 'md' | 'lg';
  title?: string;
  /** 消息图片网格内使用：额外输出 data-zs-message-image 状态钩子。 */
  messageImage?: boolean;
}) {
  const image = isImageAttachment(filename, kind);
  const [src, setSrc] = useState<string | null>(() => (image ? cache.get(attachmentId) ?? null : null));
  const [failed, setFailed] = useState(false);
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!image) return;
    const cached = cache.get(attachmentId);
    if (cached != null) {
      setSrc(cached);
      setFailed(false);
      return;
    }
    let alive = true;
    setSrc(null);
    setFailed(false);
    const start = (): void => {
      void loadThumb(attachmentId).then((dataUrl) => {
        if (!alive) return;
        if (dataUrl == null) setFailed(true);
        else setSrc(dataUrl);
      });
    };
    const host = hostRef.current;
    if (host == null || typeof IntersectionObserver === 'undefined') {
      start();
      return () => { alive = false; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        start();
      }
    }, { rootMargin: '240px' });
    observer.observe(host);
    return () => { alive = false; observer.disconnect(); };
  }, [attachmentId, image]);

  const state = !image ? 'file' : src != null ? 'ready' : failed ? 'failed' : 'loading';
  return (
    <span
      ref={hostRef}
      className={`attachment-thumb attachment-thumb-${size}${image ? '' : ' is-file'}${src == null ? ' is-placeholder' : ''}`}
      data-zs-attachment-thumb={state}
      data-zs-message-image={messageImage ? state : undefined}
      title={title}
      aria-hidden={image ? undefined : 'true'}
    >
      {src != null ? <img src={src} alt="" draggable={false} onError={() => { setSrc(null); setFailed(true); }} /> : <Icon name="image" size={size === 'sm' ? 12 : size === 'lg' ? 28 : 20} />}
    </span>
  );
}
