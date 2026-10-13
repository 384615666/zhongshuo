/**
 * 阅读状态持久（R70 F4）：按 **资源+读取版本** 保存各格式阅读器的页码/缩放/工作表/内部
 * 滚动位置。切标签（FileStage 重挂）、收起重开、布局切换、后台周期刷新都不丢；同名文件
 * 与不同版本互不污染（键含资源 ID 与 revision）。迟到渲染只释放自身资源（各视图 effect
 * cleanup），不写他人状态。
 *
 * R80：数据根命名空间中的有界阅读元数据；恢复仍重新读取原件与权限。显式关闭标签清位置。
 * 未初始化的独立宿主保留最多64项会话内存，不保存图片或正文。
 */
export type ReaderState =
  | { kind: 'image'; zoom: number; x: number; y: number }
  | { kind: 'pptx'; page: number; zoomPercent: number }
  | { kind: 'pdf'; page: number; zoomMode: 'fit' | number }
  | { kind: 'xlsx'; sheetName: string | null }
  | { kind: 'docx'; scrollTop: number };
import { readingPosition, saveReadingPosition, readingNamespace, forgetReadingPositions } from '../data/readingPositions';

const states = new Map<string, ReaderState>();

export function readerStateOf(resourceId: string, revision: number): ReaderState | undefined {
  return readingNamespace()?readingPosition<ReaderState>(`reader:${resourceId}:${revision}`):states.get(`${resourceId}:${revision}`);
}

export function saveReaderState(resourceId: string, revision: number, state: ReaderState): void {
  states.set(`${resourceId}:${revision}`, state);
  if(states.size>64)states.delete(states.keys().next().value!);
  saveReadingPosition(`reader:${resourceId}:${revision}`,state);
  // 工程验证观测（只读镜像——不参与逻辑）：门/探针可直读保存事实。
  try {
    const w = window as unknown as { __zsReaderStates?: Record<string, unknown> };
    w.__zsReaderStates = w.__zsReaderStates ?? {};
    w.__zsReaderStates[`${resourceId}:${revision}`] = state;
  } catch { /* 非浏览器宿主 */ }
}

/** 显式关闭标签/全部关闭时清理对应状态（重开=按既有合同从首页开始）。 */
export function clearReaderState(resourceId: string): void {
  forgetReadingPositions(`reader:${resourceId}:`);
  for (const k of [...states.keys()]) {
    if (k.startsWith(`${resourceId}:`)) states.delete(k);
  }
}
