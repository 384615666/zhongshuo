/**
 * Excel 阅读视图（R69 建立 / R70 修重开+切表保持）：主渲染=@extend-ai/react-xlsx 0.16.0
 * （WASM 引擎：sheet 页签/行列标/合并/列宽/填充样式真实渲染），引擎不可用回退提取网格。
 *
 * R70 F3（独立复核反例）：旧实现每次 render 都 `file={bytes.slice(0)}` 新建 ArrayBuffer——
 * 房间 5s 轮询等任何重渲染都会让引擎把**同一文件当新输入重开**，切表几秒后弹回第一张。
 * 修法=file prop 用 `useMemo(bytes, …)` 派生的**稳定引用**（FileStage 也已按装载快照稳定
 * bytes）；引擎只在新快照（真正换文件/换版本）时重开。
 * R70 F4：选中工作表按 资源+读取版本 存取；引擎就绪后恢复到上次所选表（控制器 setActiveTabIndex），
 * 回退网格同步恢复。切表/编辑草稿/开信息/调尺寸不重置；跨两个轮询周期仍保持。
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../components/Icon';
import { saveReaderState, type ReaderState } from '../readerState';

interface XlsxViewerController { activeTabIndex: number; setActiveTabIndex(i: number): void; tabs: Array<{ id: string; name: string }> }
interface XlsxViewerProps {
  file: ArrayBuffer; fileName?: string; height?: string; isDark?: boolean; readOnly?: boolean;
  rounded?: boolean; showDefaultToolbar?: boolean;
  toolbar?: (controller: XlsxViewerController) => React.ReactNode;
  loadingState?: React.ReactNode;
  errorState?: (error: Error) => React.ReactNode;
  fileTooLargeState?: () => React.ReactNode;
}

let wasmConfigured = false;
/** 引擎模块加载失败（Worker/协议问题在 import 期抛出）——记录并广播，XlsxView 切回退。 */
let engineLoadError: string | null = null;
const LazyXlsxViewer = lazy(async () => {
  try {
    const mod = await import('@extend-ai/react-xlsx');
    const setWasmSource = (mod as unknown as { setWasmSource: (u: string) => void }).setWasmSource;
    if (!wasmConfigured && typeof setWasmSource === 'function') {
      setWasmSource(new URL('duke_sheets_wasm_bg.wasm', import.meta.url).href);
      wasmConfigured = true;
    }
    return { default: (mod as unknown as { XlsxViewer: React.ComponentType<XlsxViewerProps> }).XlsxViewer };
  } catch (e) {
    engineLoadError = String((e as Error).message).slice(0, 120);
    window.dispatchEvent(new CustomEvent('zs:xlsx-engine-failed', { detail: engineLoadError }));
    return { default: () => null };
  }
});

function SheetTabs({ controller, restoreSheet, onSwitch }: {
  controller: XlsxViewerController; restoreSheet: string | null; onSwitch: (name: string) => void;
}): ReactElement {
  // R70 F4：引擎就绪后恢复到上次所选表（恰一次——恢复动作不触发保存循环）。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || restoreSheet == null) return;
    const idx = controller.tabs.findIndex((t) => t.name === restoreSheet);
    if (idx >= 0 && idx !== controller.activeTabIndex) controller.setActiveTabIndex(idx);
    restoredRef.current = true;
  }, [controller, restoreSheet]);
  if (controller.tabs.length <= 1) return <></>;
  const next = (cur: number, key: string): number | null => {
    const n = controller.tabs.length;
    if (n < 1) return null;
    if (key === 'Home') return 0;
    if (key === 'End') return n - 1;
    if (key === 'ArrowLeft') return (cur - 1 + n) % n;
    if (key === 'ArrowRight') return (cur + 1) % n;
    return null;
  };
  return (
    <div className="xlsx-sheet-tabs" role="tablist" aria-label="工作表">
      {controller.tabs.map((t, i) => {
        const on = i === controller.activeTabIndex;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={`xlsx-sheet-tab${on ? ' on' : ''}`}
            title={t.name}
            data-zs-sheet-tab={t.name}
            onClick={() => { controller.setActiveTabIndex(i); onSwitch(t.name); }}
            onKeyDown={(e) => {
              const ni = next(i, e.key);
              if (ni != null) {
                e.preventDefault();
                controller.setActiveTabIndex(ni);
                onSwitch(controller.tabs[ni]?.name ?? '');
                (e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[ni])?.focus();
              }
            }}
          >
            {t.name}
          </button>
        );
      })}
    </div>
  );
}

export interface XlsxFallbackSheet { name: string; rowCount: number; colCount: number; cells: string[][]; rowTruncated?: boolean; colTruncated?: boolean; merges?: unknown[]; formulaMissing?: boolean }

export function XlsxView({ bytes, filename, revisionLabel, onDownload, fallbackSheets, fallbackNote, resourceId, revision, initialState }: {
  bytes: ArrayBuffer; filename: string; revisionLabel: string; onDownload: () => void;
  fallbackSheets: XlsxFallbackSheet[]; fallbackNote?: string;
  resourceId?: string; revision?: number; initialState?: ReaderState;
}): ReactElement {
  const restoredSheet = initialState?.kind === 'xlsx' ? initialState.sheetName : null;
  const [engineFailed, setEngineFailed] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [sheetIdx, setSheetIdx] = useState(() => {
    if (restoredSheet == null) return 0;
    const i = fallbackSheets.findIndex((s) => s.name === restoredSheet);
    return i >= 0 ? i : 0;
  });
  // R70 F3：file 身份稳定——同一 bytes 引用只派生一次（引擎不因父级重渲染而重开）。
  const stableFile = useMemo(() => bytes.slice(0), [bytes]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setSheetIdx((cur) => { if (restoredSheet == null) return 0; const i = fallbackSheets.findIndex((s) => s.name === restoredSheet); return i >= 0 ? i : cur; }); }, [bytes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (engineLoadError != null) { setEngineError(engineLoadError); setEngineFailed(true); return; }
    const onFail = (ev: Event) => {
      setEngineError(String((ev as CustomEvent<string>).detail ?? '引擎加载失败'));
      setEngineFailed(true);
    };
    window.addEventListener('zs:xlsx-engine-failed', onFail);
    return () => window.removeEventListener('zs:xlsx-engine-failed', onFail);
  }, []);
  const saveSheet = useCallback((name: string) => {
    if (resourceId != null && revision != null && name.length > 0) {
      saveReaderState(resourceId, revision, { kind: 'xlsx', sheetName: name });
    }
  }, [resourceId, revision]);
  const renderTabs = useCallback((controller: XlsxViewerController) => (
    <SheetTabs controller={controller} restoreSheet={restoredSheet} onSwitch={saveSheet} />
  ), [restoredSheet, saveSheet]);

  if (engineFailed) {
    // 回退：提取网格（字符串单元格——无样式/合并渲染；如实标注，不冒充引擎效果）。
    const sh = fallbackSheets[sheetIdx] ?? fallbackSheets[0];
    return (
      <div className="xlsx-view xlsx-fallback" data-zs-xlsx-view="fallback" data-zs-xlsx-fail={engineError?.slice(0, 40) ?? ''} data-zs-xlsx-sheet={sh?.name ?? ''}>
        <div className="xlsx-fallback-note panel info">
          <div className="panel-title"><Icon name="alert-triangle" size={13} /> 高保真表格引擎不可用（{engineError ?? '未知'}）——以下为提取网格回退：字符串单元格、无样式/合并渲染。原件已保存（{revisionLabel}），可下载后用系统工具打开。</div>
          <div className="panel-actions"><button className="btn sm" onClick={onDownload}><Icon name="download" size={12} /> 下载原文件</button></div>
        </div>
        {fallbackSheets.length > 1 ? (
          <div className="xlsx-sheet-tabs" role="tablist">
            {fallbackSheets.map((s, i) => (
              <button key={s.name} type="button" role="tab" aria-selected={i === sheetIdx} className={`xlsx-sheet-tab${i === sheetIdx ? ' on' : ''}`} onClick={() => { setSheetIdx(i); saveSheet(s.name); }}>{s.name}</button>
            ))}
          </div>
        ) : null}
        {sh == null ? <div className="panel info">无工作表数据（提取不可用）。</div> : (
          <div className="xlsx-fallback-meta small faint">
            工作表「{sh.name}」· 实际 {sh.rowCount}×{sh.colCount} · 窗口 {sh.cells.length}×{sh.cells[0]?.length ?? 0}{sh.rowTruncated || sh.colTruncated ? '（窗口外未呈现）' : ''}{(sh.merges?.length ?? 0) > 0 ? ` · 合并 ${sh.merges?.length} 处（回退视图未渲染）` : ''}{sh.formulaMissing ? ' · ⚠ 存在无缓存值公式格（公式不执行）' : ''}{fallbackNote ? ` · ${fallbackNote}` : ''}
          </div>
        )}
        {sh != null ? (
          <div className="xlsx-fallback-grid" data-zs-xlsx-grid="1">
            <table className="sheet-grid">
              <tbody>
                {sh.cells.map((row, r) => (
                  <tr key={r}>
                    <th className="row-no">{r + 1}</th>
                    {row.map((cell, c) => <td key={c}>{String(cell ?? '')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="xlsx-view" ref={hostRef} data-zs-xlsx-view="engine">
      <Suspense fallback={<div className="panel info">正在打开表格（{filename}）…</div>}>
        <LazyXlsxViewer
          file={stableFile}
          fileName={filename}
          height="100%"
          readOnly
          rounded={false}
          showDefaultToolbar={false}
          toolbar={renderTabs}
          loadingState={<div className="panel info" data-zs-xlsx-loading="1">正在解析表格（WASM 引擎）…</div>}
          errorState={(error: Error) => {
            window.setTimeout(() => { setEngineError(error.message.slice(0, 120)); setEngineFailed(true); }, 0);
            return <div className="panel info">表格引擎错误：{error.message.slice(0, 120)}——切换回退视图…</div>;
          }}
          fileTooLargeState={() => {
            window.setTimeout(() => { setEngineError('文件超出引擎上限'); setEngineFailed(true); }, 0);
            return <div className="panel info">文件超出表格引擎上限——切换提取网格…</div>;
          }}
        />
      </Suspense>
    </div>
  );
}
