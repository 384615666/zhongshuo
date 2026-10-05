/**
 * 文件与 Git（H3 第一批，第五十三轮）：按原型入口归位——同页两标签，不再常驻挤占聊天区。
 *  - 文件标签：正式 `files.view` 只读四类分列（项目文件/托管附件/Agent 草稿/交付成果）——
 *    逐项保留来源/版本/hash 与定位（locate 深链）；附件芯片进共享预览（PreviewPane），草稿/
 *    交付定位到线程详情。私信资源标注 dm（服务端已按本人参与过滤——他人 DM 不进集合）。
 *  - Git 标签：`git.status` 真实仓库状态（分支/暂存/未暂存/未跟踪严格区分；退出码如实）+
 *    `git.diff` 只读正文（超限截断如实）。**写操作（stage/commit/push…）不经本页**——正式
 *    命令已存在，但本页首版只读（RT-24「不改工作区」口径），操作经「原界面」仓库区。
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { openPreview, closePreview } from './data/store';
import { openExternalDeepLink } from './loader';

interface FilesData {
  groups: Array<{
    projectId: string; displayName: string;
    projectFiles: Array<{ name: string; dir: boolean }>; projectFilesNote?: string;
    attachments: Array<{ attachmentId: string; filename: string; hash: string; revision: number; kind: string; conversationId: string; conversationKind: string; roomId: string | null; audience: 'dm' | 'room'; createdAt: number; locate: string | null }>;
    drafts: Array<{ changeSetId: string; taskId: string | null; taskTitle: string | null; applicationStatus: string; beforeRef: string | null; afterRef: string | null; locate: string | null }>;
    deliveries: Array<{ deliveryId: string; revision: number; manifestHash: string; taskId: string; title: string; audience: 'dm' | 'room'; reviewedAt: number | null; locate: string }>;
  }>;
  note: string;
}
interface GitStatusEntry { path: string; status?: string; label?: string }
type GitStatus = { ok: true; branch: string; worktreeRoot: string; projectRootIsWorktreeRoot: boolean; staged: GitStatusEntry[]; unstaged: GitStatusEntry[]; untracked: GitStatusEntry[]; truncated: boolean } | { ok: false; code: string; message: string };

const KIND_LABEL: Record<string, string> = { text_file: '文本', image_file: '图片', pdf_file: 'PDF', docx_file: 'Word', sheet_file: '表格', slides_file: '幻灯片' };

export function FilesPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const [tab, setTab] = useState<'files' | 'git'>('files');
  const [files, setFiles] = useState<FilesData | null>(null);
  const [filesErr, setFilesErr] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [gitBusy, setGitBusy] = useState(false);

  const reloadFiles = useCallback(async () => {
    if (projectId == null || projectId === '') return;
    try {
      setFiles(await command<FilesData>('files.view', { scope: 'project', projectId }));
      setFilesErr(null);
    } catch (e) { setFilesErr((e as Error).message); }
  }, [projectId]);
  const reloadGit = useCallback(async () => {
    if (projectId == null || projectId === '') return;
    setGitBusy(true);
    try { setGit(await command<GitStatus>('git.status', { projectId })); }
    catch (e) { setGit({ ok: false, code: 'ERR', message: (e as Error).message }); }
    finally { setGitBusy(false); }
  }, [projectId]);

  useEffect(() => { if (tab === 'files') void reloadFiles(); else void reloadGit(); }, [tab, reloadFiles, reloadGit]);
  useEffect(() => closePreview, []);

  const locate = (link: string | null) => {
    if (link == null) return;
    void openExternalDeepLink(link).catch((e: unknown) => toast(`定位失败：${(e as Error).message}`, 'error'));
  };
  const loadDiff = async (staged: boolean, path?: string) => {
    if (projectId == null || projectId === '') return;
    setGitBusy(true);
    try {
      const r = await command<{ patches: Array<{ path: string; hunks?: string; text?: string }> | Record<string, unknown> }>('git.diff', { projectId, staged, ...(path != null ? { path } : {}) });
      const pr = r as unknown as { patches?: Array<{ path?: string; text?: string }> };
      const text = (pr.patches ?? []).map((p) => `--- ${p.path ?? '?'} ---\n${p.text ?? ''}`).join('\n');
      setDiff(text.length > 0 ? text : '（无差异正文）');
    } catch (e) { toast(`diff 失败：${(e as Error).message}`, 'error'); }
    finally { setGitBusy(false); }
  };

  const group = files?.groups.find((g) => g.projectId === projectId) ?? files?.groups[0];

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }} className="page-stack" data-zs-files="hifi">
      <div className="row tight" style={{ marginBottom: 8 }}>
        <Icon name="diff" size={14} />
        <strong>文件与 Git</strong>
        <div className="row tight">
          <button className={`btn ghost sm${tab === 'files' ? '' : ''}`} style={tab === 'files' ? { fontWeight: 700 } : undefined} onClick={() => setTab('files')}>文件</button>
          <button className="btn ghost sm" style={tab === 'git' ? { fontWeight: 700 } : undefined} onClick={() => setTab('git')}>Git 诊断</button>
        </div>
        <button className="btn ghost sm" onClick={() => (tab === 'files' ? void reloadFiles() : void reloadGit())}>刷新</button>
      </div>

      {tab === 'files' ? (
        <>
          {filesErr != null ? <div className="panel warning">Files 装载失败：{filesErr}</div> : null}
          {group == null && filesErr == null ? <div className="panel info">正在装载…</div> : null}
          {group != null ? (
            <>
              <div className="panel info" style={{ marginTop: 0 }}>
                <div className="row tight"><strong>项目文件</strong><span className="faint small">（项目根一层——来源=用户项目目录本身；浏览走系统资源管理器）</span></div>
                {group.projectFilesNote != null ? <div className="panel warning" style={{ marginTop: 6 }}>{group.projectFilesNote}</div> : null}
                <div className="row tight wrap" style={{ marginTop: 6 }}>
                  {group.projectFiles.map((f) => (
                    <span key={f.name} className="chip mono" title={f.dir ? '目录' : '文件'}>{f.dir ? '📁' : '📄'} {f.name}</span>
                  ))}
                  {group.projectFiles.length === 0 ? <span className="faint small">（空目录）</span> : null}
                </div>
              </div>
              <div className="panel info">
                <div className="row tight"><strong>托管附件</strong><span className="faint small">（上传进会话的资源——点击预览；标注 dm=仅本人参与的私信）</span></div>
                <div className="row tight wrap" style={{ marginTop: 6 }}>
                  {group.attachments.map((a) => (
                    <span key={a.attachmentId} className="chip mono" title={`${a.filename} · ${KIND_LABEL[a.kind] ?? a.kind} v${a.revision} · sha256=${a.hash.slice(0, 12)}… · ${a.audience === 'dm' ? '私信（仅本人可见）' : '房间'}${a.locate != null ? ` · ${a.locate}` : ''}`}>
                      <Icon name="paperclip" size={11} />
                      {a.filename}
                      {a.audience === 'dm' ? <Tag tone="neutral">dm</Tag> : null}
                      <button onClick={() => openPreview({ attachmentId: a.attachmentId, filename: a.filename, kind: a.kind, conversationId: a.conversationId, origin: a.audience === 'dm' ? '私信附件' : '房间附件', hashHint: a.hash, revisionHint: a.revision })}>预览</button>
                    </span>
                  ))}
                  {group.attachments.length === 0 ? <span className="faint small">（暂无）</span> : null}
                </div>
              </div>
              <div className="panel info">
                <div className="row tight"><strong>Agent 草稿（变更集）</strong><span className="faint small">（点击定位到任务）</span></div>
                <div style={{ marginTop: 6 }}>
                  {group.drafts.map((d) => (
                    <button key={d.changeSetId} className="root-card" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, padding: 8 }} onClick={() => locate(d.locate)}>
                      <span className="small" style={{ fontWeight: 600 }}>{d.taskTitle ?? d.changeSetId}</span>
                      <span className="faint small"> · {d.applicationStatus}{d.beforeRef != null && d.afterRef != null ? ` · ${String(d.beforeRef).slice(0, 8)}→${String(d.afterRef).slice(0, 8)}` : ''}</span>
                    </button>
                  ))}
                  {group.drafts.length === 0 ? <span className="faint small">（暂无）</span> : null}
                </div>
              </div>
              <div className="panel info">
                <div className="row tight"><strong>交付成果</strong><span className="faint small">（点击定位到线程详情的交付验收）</span></div>
                <div style={{ marginTop: 6 }}>
                  {group.deliveries.map((d) => (
                    <button key={d.deliveryId} className="root-card" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, padding: 8 }} onClick={() => locate(d.locate)}>
                      <span className="small" style={{ fontWeight: 600 }}>{d.title}</span>
                      <span className="faint small"> · v{d.revision} · manifest {d.manifestHash.slice(0, 10)}…{d.reviewedAt != null ? ` · 已复核 ${new Date(d.reviewedAt).toLocaleString()}` : ' · 待验收'}{d.audience === 'dm' ? ' · dm' : ''}</span>
                    </button>
                  ))}
                  {group.deliveries.length === 0 ? <span className="faint small">（暂无）</span> : null}
                </div>
              </div>
              <div className="faint small">{files?.note ?? ''}</div>
            </>
          ) : null}
        </>
      ) : (
        <>
          {git == null ? <div className="panel info">{gitBusy ? '正在读取仓库状态…' : '尚未读取'}</div> : git.ok === false ? (
            <div className="panel warning">仓库状态不可用（{git.code}）：{git.message}</div>
          ) : (
            <>
              <div className="panel info" style={{ marginTop: 0 }}>
                <div className="row tight"><strong>分支 {git.branch}</strong>{git.projectRootIsWorktreeRoot ? null : <span className="faint small">（项目根是工作树子目录——仓库根：{git.worktreeRoot}）</span>}</div>
                <div className="faint small" style={{ marginTop: 4 }}>暂存 {git.staged.length} · 未暂存 {git.unstaged.length} · 未跟踪 {git.untracked.length}{git.truncated ? '（超限已截断）' : ''}</div>
                <div className="row tight" style={{ marginTop: 6 }}>
                  <button className="btn ghost sm" disabled={gitBusy} onClick={() => void loadDiff(false)}>未暂存 diff</button>
                  <button className="btn ghost sm" disabled={gitBusy} onClick={() => void loadDiff(true)}>已暂存 diff</button>
                </div>
              </div>
              {(['staged', 'unstaged', 'untracked'] as const).map((k) => {
                const list = git[k];
                if (list.length === 0) return null;
                const label = k === 'staged' ? '已暂存' : k === 'unstaged' ? '未暂存' : '未跟踪';
                return (
                  <div key={k} className="panel info">
                    <div className="row tight"><strong>{label}</strong><span className="faint small">{list.length} 项</span></div>
                    <div style={{ marginTop: 4, maxHeight: 180, overflow: 'auto' }}>
                      {list.map((e, i) => (
                        <div key={`${e.path}-${i}`} className="row tight">
                          <span className="chip mono" style={{ fontSize: 11 }}>{e.label ?? e.status ?? ''}</span>
                          <span className="mono small" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.path}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {diff != null ? (
                <div className="panel info">
                  <div className="row tight"><strong>diff 正文</strong><span className="faint small">（只读——不改索引与工作区）</span></div>
                  <pre className="attach-preview-text" style={{ whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 320, overflow: 'auto', marginTop: 6 }}>{diff.slice(0, 40_000)}</pre>
                </div>
              ) : null}
              <div className="faint small">Git 诊断只读（RT-24：不改工作区，保留未提交内容）；提交/推送等写操作经「原界面」仓库区执行。Git 提交不等同任务验收（RT-25）。</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
