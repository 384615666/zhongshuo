/**
 * Excel 阅读视图（R69，对照 reference-excel.png / ZCode previewPaneOfficeXlsxContent.tsx @29628c9）：
 * 主渲染=@extend-ai/react-xlsx 0.16.0（vendored MIT——ZCode 同库同用法：只读、关默认工具栏、
 * toolbar=只读 sheet 页签 + 键盘 ←→/Home/End 切表、WASM 源指随包资产）。工作表页签/行列标/
 * 合并单元格/列宽行高/填充色/双向滚动=引擎真实渲染（非提取网格冒充）。
 * 引擎不可用（宿主协议 Worker/WASM 失败等）→ 回退提取网格（如实标注「回退：字符串网格，
 * 无样式/合并」）。公式不执行（缓存值）、外部链接不加载。
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../../components/Icon';

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
      // wasm 随包资产（build-ui 从 node_modules 拷贝到 app.mjs 同目录——与 import.meta.url 同基准）。
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

function SheetTabs({ controller }: { controller: XlsxViewerController }): ReactElement {
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
            onClick={() => controller.setActiveTabIndex(i)}
            onKeyDown={(e) => {
              const ni = next(i, e.key);
              if (ni != null) {
                e.preventDefault();
                controller.setActiveTabIndex(ni);
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

export function XlsxView({ bytes, filename, revisionLabel, onDownload, fallbackSheets, fallbackNote }: {
  bytes: ArrayBuffer; filename: string; revisionLabel: string; onDownload: () => void;
  fallbackSheets: XlsxFallbackSheet[]; fallbackNote?: string;
}): ReactElement {
  const [engineFailed, setEngineFailed] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setSheetIdx(0); }, [bytes]);
  // 引擎模块加载失败广播（lazy factory catch）→ 切回退视图。
  useEffect(() => {
    if (engineLoadError != null) { setEngineError(engineLoadError); setEngineFailed(true); return; }
    const onFail = (ev: Event) => {
      setEngineError(String((ev as CustomEvent<string>).detail ?? '引擎加载失败'));
      setEngineFailed(true);
    };
    window.addEventListener('zs:xlsx-engine-failed', onFail);
    return () => window.removeEventListener('zs:xlsx-engine-failed', onFail);
  }, []);
  const renderTabs = useCallback((controller: XlsxViewerController) => <SheetTabs controller={controller} />, []);

  if (engineFailed) {
    // 回退：提取网格（字符串单元格——无样式/合并渲染；如实标注，不冒充引擎效果）。
    const sh = fallbackSheets[sheetIdx] ?? fallbackSheets[0];
    return (
      <div className="xlsx-view xlsx-fallback" data-zs-xlsx-view="fallback" data-zs-xlsx-fail={engineError?.slice(0, 40) ?? ''}>
        <div className="xlsx-fallback-note panel info">
          <div className="panel-title"><Icon name="alert-triangle" size={13} /> 高保真表格引擎不可用（{engineError ?? '未知'}）——以下为提取网格回退：字符串单元格、无样式/合并渲染。原件已保存（{revisionLabel}），可下载后用系统工具打开。</div>
          <div className="panel-actions"><button className="btn sm" onClick={onDownload}><Icon name="download" size={12} /> 下载原文件</button></div>
        </div>
        {fallbackSheets.length > 1 ? (
          <div className="xlsx-sheet-tabs" role="tablist">
            {fallbackSheets.map((s, i) => (
              <button key={s.name} type="button" role="tab" aria-selected={i === sheetIdx} className={`xlsx-sheet-tab${i === sheetIdx ? ' on' : ''}`} onClick={() => setSheetIdx(i)}>{s.name}</button>
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
          file={bytes.slice(0)}
          fileName={filename}
          height="100%"
          readOnly
          rounded={false}
          showDefaultToolbar={false}
          toolbar={renderTabs}
          loadingState={<div className="panel info" data-zs-xlsx-loading="1">正在解析表格（WASM 引擎）…</div>}
          errorState={(error: Error) => {
            // render-prop 期间不能 setState（另一组件渲染中）——延迟一拍切回退视图。
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
