/**
 * 应用设置 · 数据与存储（§3.1 / §4.2，依据 §12.5）。
 *
 * 这一节回答四件事：数据放在哪、占多少、怎么备份、清理和删除有什么区别。
 *
 * 两条如实标注（任务书 §0 与 §2.5）：
 *  - 占用量的数字**在原型阶段是模拟值**，界面就地标注 —— 不假装读过磁盘；
 *  - 「打开目录」是真的可操作项（桌面宿主里打开真实的应用数据目录），
 *    浏览器宿主没有原生能力时给出明确限制说明，不做替代动作。
 *
 * 归档管理与「已移除的项目」也在这里保持可达（§3.1：归档不再独占一级分类）。
 */

import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { DetailFold, ReadOnlyRow, SettingsRow, SimulatedTag } from '../components/SettingsRow';
import { Modal, Tag } from '../components/ui';
import { recordLocalOnly, toast, useStore } from '../data/store';
import { restoreRemovedProject } from '../data/actions-project';
import { appDataDir, openPath } from '../lib/desktop';
import { ArchiveManager } from './ArchivePage';
import type { AppState } from '../data/types';

function SectionHead({ title, sub }: { title: string; sub: React.ReactNode }) {
  return (
    <div className="settings-section-head">
      <div className="settings-section-title">{title}</div>
      <div className="settings-section-sub">{sub}</div>
    </div>
  );
}

/** 数据目录的文档口径（原型不落盘，所以显示的是路径约定而不是真实扫描结果） */
const DATA_DIR_LABEL = '<appData>/zhongshuo/';

/**
 * 已移除的项目 + 重新关联（第十七批 §七）。
 *
 * 放在「数据与存储」里，是为了让"移除"**不是不可逆**的：数据一直都在，
 * 只是在应用里解除了关联；这里按原目录重新关联，历史与任务记录原样保留。
 */
function RemovedProjects() {
  const s = useStore((x) => x);
  const removed = s.projects.filter((p) => p.removedAt);
  if (removed.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-title" style={{ marginBottom: 8 }}>
        已移除的项目<span className="count">{removed.length}</span>
      </div>
      <div className="small faint" style={{ lineHeight: 1.7, marginBottom: 6 }}>
        「移除」只是在应用里解除关联：磁盘文件、聊天记录、任务与成果都还在。
        重新关联后这个项目会回到侧栏，沿用原来的历史。
      </div>
      {removed.map((p) => (
        <div key={p.id} className="row tight" style={{ padding: '6px 0' }}>
          <Icon name="folder" size={13} className="faint" />
          <span>{p.displayName}</span>
          <span className="small faint truncate">{p.rootPath}</span>
          <div className="spacer" />
          <button
            className="btn sm"
            title="按原目录重新关联（不复制、不重建，历史与任务记录保持不变）"
            onClick={() => restoreRemovedProject(p.id)}
          >
            <Icon name="refresh" size={12} /> 重新关联
          </button>
        </div>
      ))}
    </div>
  );
}

export function SectionData({ s }: { s: AppState }) {
  const [opening, setOpening] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  /**
   * 已解析的数据目录。
   *
   * 显示、打开、复制**必须共用这一个值**：原来行里显示 `<appData>/zhongshuo/`
   * （文档约定）、打开用的是真实 `userData`、复制却复制出
   * `<appData>/zhongshuo/state.sqlite` —— 三处各说各话（评审复现）。
   * 现在解析一次存下来：桌面宿主拿到真实路径，浏览器宿主保持 null，
   * 界面退化为"约定路径 + 未解析"的如实标注。
   */
  const [dir, setDir] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const real = await appDataDir();
      if (!alive) return;
      setDir(real);
      setResolving(false);
    })();
    return () => { alive = false; };
  }, []);
  /** 三处共用：显示什么、打开什么、就复制什么 */
  const shownDir = dir ?? DATA_DIR_LABEL;

  /**
   * 打开数据目录：桌面宿主里打开**真实存在**的应用数据目录；
   * 浏览器宿主没有原生能力 → 明确说明，不假装打开成功（与 §七 打开项目目录同一口径）。
   */
  const openDataDir = async () => {
    setOpening(true);
    try {
      if (!dir) {
        toast('浏览器宿主没有系统文件管理器能力：请在桌面客户端里打开数据目录', 'warn');
        return;
      }
      const res = await openPath(dir);
      if (!res) {
        toast('当前宿主没有提供"打开目录"能力，未做替代操作', 'warn');
        return;
      }
      if (res.ok) {
        recordLocalOnly('app.dataDir.open', `path=${dir}（真实的应用数据目录）`);
        toast(`已在文件管理器中打开：${dir}`, 'success');
      } else {
        toast(`无法打开目录：${dir}（${res.reason ?? '宿主返回失败'}）`, 'error');
      }
    } finally {
      setOpening(false);
    }
  };

  /**
   * 复制路径：**必须等剪贴板写入完成**再报成功。
   *
   * 原实现是 `void navigator.clipboard?.writeText(...)` 然后无条件 toast「已复制」——
   * 接口不存在或写入被拒（无焦点、无权限）时同样会提示成功，等于给假回执。
   */
  const copyPath = async () => {
    const text = shownDir;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('此宿主没有剪贴板接口');
      await navigator.clipboard.writeText(text);
      recordLocalOnly('app.dataDir.copy', `复制路径 ${text}`);
      toast(`已复制：${text}`, 'success');
    } catch (e) {
      const reason = e instanceof Error ? e.message : '未知原因';
      toast(`复制失败（${reason}）。可以手动选中复制：${text}`, 'error');
    }
  };

  return (
    <>
      <SectionHead
        title="数据与存储"
        sub="数据放在哪、占多少、怎么备份，以及归档与已移除项目的去处。"
      />

      {/* ---------- 数据位置 ---------- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title" style={{ marginBottom: 4 }}>数据位置</div>

        <SettingsRow
          label="应用数据目录"
          hint={
            <>
              数据只存在本机的应用数据目录，不放在网络盘或同步盘上；众说不会往你的项目目录里插配置文件，
              也不会自动 <span className="mono-sm">git init</span>。
              {!resolving && !dir ? '（当前是浏览器宿主，拿不到真实路径，下面显示的是文档约定）' : null}
            </>
          }
          value={
            <span className="row tight">
              <span className="mono-sm" style={{ overflowWrap: 'anywhere' }}>{shownDir}</span>
              {resolving ? <Tag plain>解析中</Tag> : dir ? null : <Tag plain title="浏览器宿主没有原生能力，无法解析出真实的应用数据目录">约定值</Tag>}
            </span>
          }
          valueWrap
          wide
          control={
            <div className="row tight">
              <button className="btn sm" onClick={() => void openDataDir()} disabled={opening || !dir}>
                <Icon name="folder" size={12} /> 打开目录
              </button>
              <button className="btn ghost sm" onClick={() => void copyPath()}>
                <Icon name="copy" size={12} /> 复制路径
              </button>
            </div>
          }
        />

        <ReadOnlyRow
          label="占用空间"
          hint="原型不落盘，这里显示的是示例数字 —— 正式实现必须来自真实统计，没有来源就不显示。"
          value={
            <span className="row tight">
              <span className="mono-sm">1.2 GB</span>
              <Tag plain title="原型阶段没有真实数据来源，这个数字是明确标注的模拟值">模拟值</Tag>
            </span>
          }
        />

        <DetailFold summary="技术详情：目录结构与清理边界">
          <div className="mono-sm data-tree">
            &lt;appData&gt;/zhongshuo/<br />
            {'  '}state.sqlite<br />
            {'  '}artifacts/&lt;projectId&gt;/<br />
            {'  '}contexts/&lt;projectId&gt;/<br />
            {'  '}drafts/&lt;projectId&gt;/　← 托管草稿，绝不放项目根<br />
            {'  '}snapshots/&lt;projectId&gt;/<br />
            {'  '}diagnostics/<br />
            {'  '}backups/
          </div>
          <div className="small faint" style={{ lineHeight: 1.75, marginTop: 8 }}>
            这些都是<strong>应用自己</strong>的目录：清理它们不会动你在项目目录里的源文件。
            反过来，众说也不会把草稿、快照、诊断包写进项目根目录。
          </div>
        </DetailFold>
      </div>

      {/* ---------- 备份与恢复（§12.5） ---------- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title row tight" style={{ marginBottom: 4 }}>
          备份与恢复
          <SimulatedTag title="原型不写磁盘：这两个按钮只留痕并说明真实行为，不会真的生成或读取备份文件" />
        </div>

        <ReadOnlyRow
          label="备份方式"
          hint="使用 SQLite 备份接口或等价的一致性备份方案，不能只复制活跃 WAL 主文件 —— 那样拿到的可能是残缺状态。"
          value="一致性备份（非文件复制）"
        />
        <ReadOnlyRow
          label="备份内容"
          hint="不含你的项目目录：项目源文件始终由你自己的版本控制与备份负责。"
          value="state.sqlite · artifacts · contexts · drafts · snapshots"
        />

        <SettingsRow
          label="创建备份"
          hint="保存到 <appData>/zhongshuo/backups/，文件名带时间戳；创建立即完成，不打断正在运行的任务。"
          wide
          control={
            <div className="row tight">
              <button
                className="btn sm"
                onClick={() => {
                  recordLocalOnly('backup.create', '一致性备份 → <appData>/zhongshuo/backups/（原型不落盘，只留痕）');
                  toast('原型不生成真实备份文件：这里只记录这次操作与真实实现的落点', 'info');
                }}
              >
                <Icon name="download" size={12} /> 创建备份
              </button>
              <SimulatedTag title="原型不写磁盘，按钮只留痕" />
            </div>
          }
        />

        <SettingsRow
          label="从备份恢复"
          hint="恢复会在下次启动时应用，并替换当前状态；有任务正在运行时先停止或等待结束再恢复。"
          wide
          control={
            <div className="row tight">
              <button className="btn danger sm" onClick={() => setRestoreOpen(true)}>
                <Icon name="upload" size={12} /> 从备份恢复
              </button>
              <SimulatedTag title="原型不读磁盘，按钮只说明真实流程" />
            </div>
          }
        />

        <div className="pset-note">
          失败处理：备份文件损坏或磁盘空间不足时会明确报错并<strong>保留当前数据</strong>，不会做半途替换 ——
          「恢复了一半」比「恢复失败」更难收拾。
        </div>
      </div>

      {/* ---------- 清理 vs 删除 ---------- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title" style={{ marginBottom: 4 }}>清理与删除的区别</div>

        <SettingsRow
          label="清理应用成果"
          hint="清理对象是应用自己的中间产物：草稿、快照、日志、托管工作空间。它不会删除你在项目目录里的任何文件 —— 两个动作永远是分开的两件事（§12.5）。"
          wide
          control={
            <div className="row tight">
              <button className="btn danger sm" onClick={() => setCleanupOpen(true)}>
                <Icon name="trash" size={12} /> 清理应用成果
              </button>
              <SimulatedTag title="原型不删除任何东西，按钮只说明清理对象与影响" />
            </div>
          }
        />
        <ReadOnlyRow
          label="你的项目目录"
          hint="众说不会删除、移动或重命名项目目录里的文件；清理应用成果也不涉及它。"
          value={s.projects[0] ? <span className="mono-sm truncate">{s.projects[0].rootPath}</span> : '（还没有项目）'}
        />
      </div>

      {/* ---------- 归档管理（嵌入同一份状态，不复制第二套） ---------- */}
      <div className="section-title" style={{ marginTop: 4 }}>归档管理</div>
      <div className="small faint" style={{ lineHeight: 1.7, marginBottom: 10 }}>
        已归档的项目与房间都保留只读历史，随时可以恢复。这里与侧栏「项目 ⋯ → 归档管理」、
        独立页面 <span className="mono-sm">/archive</span> 是同一份数据、同一套操作。
      </div>
      <ArchiveManager query={{}} embedded />

      {/* ---------- 已移除的项目 ---------- */}
      <RemovedProjects />

      {restoreOpen ? (
        <ConsequenceModal
          title="从备份恢复"
          onClose={() => setRestoreOpen(false)}
          rows={[
            ['替换范围', '状态库 + 成果、上下文、草稿、快照；你的项目目录不在其中'],
            ['生效时机', '在下次启动时应用；有任务运行时先停止或等它结束'],
            ['失败处理', '校验失败或空间不足时明确报错并保留当前数据，不做半途替换'],
          ]}
          note="原型不读磁盘：这里只说明真实流程，不会替换任何状态。"
        />
      ) : null}

      {cleanupOpen ? (
        <ConsequenceModal
          title="清理应用成果"
          onClose={() => setCleanupOpen(false)}
          rows={[
            ['清理对象', '草稿、快照、诊断包、成员托管工作空间（都在应用数据目录里）'],
            ['不包含', '你的项目目录、项目里的文件、Git 提交与已交付成果'],
            ['失败处理', '被引用的成果不清理并列出引用位置；不提供"全量清空"这类模糊动作'],
          ]}
          note="原型不删除任何文件：这里只说明清理对象与影响范围。"
        />
      ) : null}
    </>
  );
}

/**
 * 「说清楚再确认」弹窗：逐条列出对象与影响，而不是一句"确定吗？"。
 * 危险动作的确认入口统一用它，避免同一类弹窗在不同分区写出三套措辞。
 */
function ConsequenceModal({
  title,
  rows,
  note,
  onClose,
}: {
  title: string;
  rows: [string, string][];
  note: string;
  onClose: () => void;
}) {
  return (
    <Modal
      size="sm"
      title={title}
      subtitle="原型不执行真实动作，这里只说明真实行为"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>关闭</button>
        </>
      }
    >
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="panel" style={{ marginTop: 12 }}>{note}</div>
    </Modal>
  );
}
