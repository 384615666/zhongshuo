/**
 * 共享的 diff 渲染（「文件与改动」页与 Git 页共用）。
 * 抽出来的原因：Git 页要展示提交内 diff，与改动集 diff 是同一套渲染，
 * 复制一份必然漂移。
 */

import type { DiffHunk } from '../data/types';

export function DiffView({ hunks }: { hunks: DiffHunk[] }) {
  if (hunks.length === 0) return null;
  return (
    <div className="diff-view">
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="diff-hunk-head">{h.header}</div>
          {h.lines.map((l, li) => (
            <div key={li} className={`diff-line ${l.type}`}>
              <span className="diff-no">{l.oldNo ?? ''}</span>
              <span className="diff-no">{l.newNo ?? ''}</span>
              <span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
              <span className="diff-text">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
