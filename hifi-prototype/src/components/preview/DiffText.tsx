/**
 * 两版本固定比较的文本 diff（§8.1 diff 行）。
 *
 * 边界与文档一致：
 *  - **两侧都是固定版本**，不允许某一侧是"可变的工作区当前文件"；
 *  - 缺失基线时如实显示"不具备完整比较内容"，不用当前文件顶替（§6.2）；
 *  - 这是**一个文件标签内的视图**，不扩成更多工作区列（§8.1）。
 *
 * 实现用最小 LCS 行级算法，足以处理 fixture 规模的文本，
 * 且结果是确定性的（同一对输入总得到相同输出，便于断言）。
 */

import { useMemo } from 'react';
import { Icon } from '../Icon';

type Line = { type: 'same' | 'add' | 'del'; text: string; leftNo?: number; rightNo?: number };

/** 行级 LCS diff */
export function diffLines(left: string, right: string): Line[] {
  const a = left.replace(/\n$/, '').split('\n');
  const b = right.replace(/\n$/, '').split('\n');

  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: Line[] = [];
  let i = 0, j = 0, ln = 1, rn = 1;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], leftNo: ln++, rightNo: rn++ });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i], leftNo: ln++ });
      i++;
    } else {
      out.push({ type: 'add', text: b[j], rightNo: rn++ });
      j++;
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++], leftNo: ln++ });
  while (j < b.length) out.push({ type: 'add', text: b[j++], rightNo: rn++ });
  return out;
}

export function DiffText({
  left, right, leftLabel, rightLabel,
}: {
  left: string;
  right: string;
  leftLabel: string;
  rightLabel: string;
}) {
  const lines = useMemo(() => diffLines(left, right), [left, right]);
  const added = lines.filter((l) => l.type === 'add').length;
  const removed = lines.filter((l) => l.type === 'del').length;

  // 缺失基线：如实说明，保留可用侧（§6.2 / PV-25）
  if (!left || !right) {
    return (
      <div className="panel warning">
        <div className="panel-title"><Icon name="alert-triangle" size={13} /> 不具备完整比较内容</div>
        缺少一侧的固定基线，因此不能生成完整 diff。
        界面不会用"当前文件"顶替缺失的一侧（那会让人以为改动已经发生）。
        <div className="small faint" style={{ marginTop: 6 }}>
          已有一侧内容仍可单独阅读。
        </div>
      </div>
    );
  }

  return (
    <div className="preview-diff">
      <div className="preview-diff-head">
        <span className="pill del"><Icon name="minus" size={10} /> {leftLabel}</span>
        <Icon name="arrow-right" size={12} className="faint" />
        <span className="pill add"><Icon name="plus" size={10} /> {rightLabel}</span>
        <div className="spacer" />
        <span className="small faint">+{added} / −{removed} 行 · 两侧均为固定版本</span>
      </div>
      <div className="preview-diff-body">
        {lines.map((l, i) => (
          <div className={`preview-diff-row ${l.type}`} key={i}>
            <span className="preview-diff-no">{l.leftNo ?? ''}</span>
            <span className="preview-diff-no">{l.rightNo ?? ''}</span>
            <span className="preview-diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
            <span className="preview-diff-text">{l.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
