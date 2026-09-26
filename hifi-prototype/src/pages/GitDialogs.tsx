/**
 * Git 的两个对话框：新建分支 / 冲突三方内容。
 *
 * 为什么单独抽出来：合页改造后「分支」入口上移到页头操作簇（P0 状态条右侧），
 * 而 Git 页分支区自己的「新建分支」按钮仍在 —— 两处必须打开同一个对话框，
 * 各写一份就会出现两套文案与两套校验。
 *
 * 这里只搬 UI 与原有语义，不改行为：
 *  - 新建分支：基于当前 HEAD 创建并立即切换，未提交改动会一并带入（如实说明）
 *  - 冲突：不提供「全部保留我的」，只摊开 base/ours/theirs 三方内容
 */

import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Modal } from '../components/ui';
import { createBranch, resolveConflict } from '../data/actions-git';
import type { GitStatusEntry } from '../data/types';

export function NewBranchModal({
  projectId, base, onClose,
}: {
  projectId: string;
  /** 基于哪个提交创建（当前分支 HEAD；空仓库显示为"(空仓库)"） */
  base: string;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  return (
    <Modal
      size="sm"
      title="新建分支"
      subtitle="基于当前分支的 HEAD 创建并立即切换"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => {
              createBranch(projectId, name);
              onClose();
            }}
          >
            创建并切换
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">分支名</span>
        <input
          className="input"
          placeholder="例如 zs/task-15-refactor"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="small faint" style={{ marginTop: 8 }}>
        基于 <span className="mono-sm">{base}</span> 创建。工作区未提交改动会一并带入。
      </div>
    </Modal>
  );
}

export function ConflictModal({
  projectId, entry, onClose,
}: {
  projectId: string;
  entry: GitStatusEntry;
  onClose: () => void;
}) {
  const [manualText, setManualText] = useState(entry.conflict?.ours ?? '');
  return (
    <Modal
      size="md"
      title="解决冲突"
      subtitle={entry.path}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>稍后处理</button>
          <button
            className="btn primary"
            onClick={() => {
              resolveConflict(projectId, entry.path, 'manual', manualText);
              onClose();
            }}
          >
            用编辑后的内容解决
          </button>
        </>
      }
    >
      <div className="panel warning" style={{ marginBottom: 12 }}>
        <div className="panel-title"><Icon name="alert-triangle" size={13} /> 这里不提供「全部保留我的」按钮</div>
        冲突意味着归属不明确。众说停止自动应用，把三方内容摊开让你判断，
        而不是替你选一边。
      </div>

      <div className="section">
        <div className="section-title">共同祖先（base）</div>
        <pre className="conflict-pre">{entry.conflict?.base}</pre>
      </div>
      <div className="section">
        <div className="section-title">
          我的版本（ours）
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => setManualText(entry.conflict!.ours)}>用这个</button>
        </div>
        <pre className="conflict-pre">{entry.conflict?.ours}</pre>
      </div>
      <div className="section">
        <div className="section-title">
          对方版本（theirs）
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => setManualText(entry.conflict!.theirs)}>用这个</button>
        </div>
        <pre className="conflict-pre">{entry.conflict?.theirs}</pre>
      </div>

      <div className="section">
        <div className="section-title">解决后的内容</div>
        <textarea
          className="composer-input"
          rows={3}
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
        />
        <div className="small faint" style={{ marginTop: 6 }}>
          解决后进入暂存区，确认无误再提交。
        </div>
      </div>
    </Modal>
  );
}
