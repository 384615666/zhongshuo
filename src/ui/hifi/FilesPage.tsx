/**
 * 文件与 Git（第五十四轮 §4 收口版）：同页两标签。
 *  - 文件标签：files.view 只读四类分列（项目文件/托管附件→共享预览/Agent 草稿/交付成果→
 *    深链定位）。**项目文本文件复用既有 `project.file.read` 只读快照**（≤256KB、文本白名单、
 *    fatal UTF-8——越界/二进制/超限如实拒绝；快照非托管副本、不进模型输入）。
 *  - Git 标签：git.status 真实仓库状态 + git.diff **保留 DTO 全部事实**（change/stat
 *    text|binary|unknown/renamed/truncated/source/filesOmitted/truncatedOverall——二进制空
 *    正文、截断含标记；显示区截断显式标注，不把未呈现正文当完整差异）。写操作（stage/
 *    commit/push…）本批仍留旧界面——给**实际定向入口按钮**（takeLegacy('git')），不是一句
 *    「经原界面」的说明。
 * 请求代次收口：切换项目/标签时迟到响应不污染当前页。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { openPreview, closePreview } from './data/store';
import { openExternalDeepLink } from './loader';
import { takeLegacy } from './App';

interface FilesData {
  groups: Array<{
    projectId: string; displayName: string;
    projectFiles: Array<{ name: string; dir: boolean }>; projectFilesNote?: string;
    attachments: Array<{ attachmentId: string; filename: string; hash: string; revision: number; kind: string; conversationId: string; audience: 'dm' | 'room'; locate: string | null }>;
    drafts: Array<{ changeSetId: string; taskId: string | null; taskTitle: string | null; applicationStatus: string; beforeRef: string | null; afterRef: string | null; locate: string | null }>;
    deliveries: Array<{ deliveryId: string; revision: number; manifestHash: string; taskId: string; title: string; audience: 'dm' | 'room'; reviewedAt: number | null; locate: string }>;
  }>;
  note: string;
}
interface GitStatusEntry { path: string; status?: string; label?: string; renamedFrom?: string }
type GitStatus = { ok: true; branch: string; worktreeRoot: string; projectRootIsWorktreeRoot: boolean; staged: GitStatusEntry[]; unstaged: GitStatusEntry[]; untracked: GitStatusEntry[]; truncated: boolean } | { ok: false; code: string; message: string };
interface GitDiffPatch { path: string; oldPath?: string; change: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'; stat: 'text' | 'binary' | 'unknown'; binary: boolean; truncated: boolean; source: 'diff' | 'worktree-content'; text: string; addedCount?: number | null; deletedCount?: number | null }
interface GitDiff { patches: GitDiffPatch[]; truncatedOverall: boolean; filesOmitted?: number }

const KIND_LABEL: Record<string, string> = { text_file: '文本', image_file: '图片', pdf_file: 'PDF', docx_file: 'Word', sheet_file: '表格', slides_file: '幻灯片' };
/** 与 daemon TEXT_PREVIEW_EXTENSIONS 同源核对（白名单外不显示预览按钮——点击前如实禁用）。 */
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rs', '.rb', '.php', '.swift', '.kt', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.lua', '.r', '.m', '.pl']);
const DIFF_DISPLAY_CAP = 40_000; // 显示区上限（显式标注——服务端 DTO 的截断事实另行分列）

export function FilesPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const [tab, setTab] = useState<'files' | 'git'>('files');
  const [files, setFiles] = useState<FilesData | null>(null);
  const [filesErr, setFilesErr] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<{ name: string; bytes: number; truncated: boolean; content: string } | null>(null);
  const [snapshotErr, setSnapshotErr] = useState<string | null>(null);
  const genRef = useRef(0);

  const reloadFiles = useCallback(async () => {
    if (projectId == null || projectId === '') return;
    const gen = ++genRef.current;
    try {
      const r = await command<FilesData>('files.view', { scope: 'project', projectId });
      if (gen !== genRef.current) return;
      setFiles(r); setFilesErr(null);
    } catch (e) { if (gen === genRef.current) setFilesErr((e as Error).message); }
  }, [projectId]);
  const reloadGit = useCallback(async () => {
    if (projectId == null || projectId === '') return;
    const gen = ++genRef.current;
    setBusy(true);
    try {
      const r = await command<GitStatus>('git.status', { projectId });
      if (gen !== genRef.current) return;
      setGit(r);
    } catch (e) { if (gen === genRef.current) setGit({ ok: false, code: 'ERR', message: (e as Error).message }); }
    finally { if (gen === genRef.current) setBusy(false); }
  }, [projectId]);

  useEffect(() => { setSnapshot(null); setSnapshotErr(null); setDiff(null); if (tab === 'files') void reloadFiles(); else void reloadGit(); }, [tab, reloadFiles, reloadGit]);
  useEffect(() => closePreview, []);

  const locate = (link: string | null) => {
    if (link == null) return;
    void openExternalDeepLink(link).catch((e: unknown) => toast(`定位失败：${(e as Error).message}`, 'error'));
  };
  const openProjectFile = async (name: string) => {
    if (projectId == null || projectId === '') return;
    setBusy(true); setSnapshotErr(null);
    try {
      const r = await command<{ bytes: number; truncated: boolean; content: string }>('project.file.read', { projectId, path: name });
      setSnapshot({ name, bytes: r.bytes, truncated: r.truncated, content: r.content });
    } catch (e) {
      setSnapshot(null);
      setSnapshotErr(`${name}：${(e as Error).message}`); // 越界/二进制/超限/非 UTF-8 如实
    } finally { setBusy(false); }
  };
  const loadDiff = async (staged: boolean) => {
    if (projectId == null || projectId === '') return;
    const gen = genRef.current;
    setBusy(true);
    try {
      const r = await command<GitDiff>('git.diff', { projectId, staged });
      if (gen !== genRef.current) return;
      setDiff(r);
    } catch (e) { toast(`diff 失败：${(e as Error).message}`, 'error'); }
    finally { if (gen === genRef.current) setBusy(false); }
  };

  const group = files?.groups.find((g) => g.projectId === projectId) ?? files?.groups[0];
  const diffTextLen = diff != null ? diff.patches.reduce((n, p) => n + p.text.length, 0) : 0;
  const diffCapped = diffTextLen > DIFF_DISPLAY_CAP;

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }} className="page-stack" data-zs-files="hifi">
      <div className="row tight" style={{ marginBottom: 8 }}>
        <Icon name="diff" size={14} />
        <strong>文件与 Git</strong>
        <div className="row tight">
          <button className="btn ghost sm" style={tab === 'files' ? { fontWeight: 700 } : undefined} onClick={() => setTab('files')}>文件</button>
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
                <div className="row tight"><strong>项目文件</strong><span className="faint small">（项目根一层；文本文件可只读快照预览——快照≠托管副本，不进模型输入）</span></div>
                {group.projectFilesNote != null ? <div className="panel warning" style={{ marginTop: 6 }}>{group.projectFilesNote}</div> : null}
                <div className="row tight wrap" style={{ marginTop: 6 }}>
                  {group.projectFiles.map((f) => {
                    const isText = !f.dir && TEXT_EXTS.has((f.name.slice(f.name.lastIndexOf('.')).toLowerCase()));
                    return (
                      <span key={f.name} className="chip mono" title={f.dir ? '目录（浏览走系统资源管理器）' : isText ? '文本文件——点击只读快照预览' : '非白名单类型——预览走 Git/系统工具'}>
                        {f.dir ? '📁' : '📄'} {f.name}
                        {isText ? <button disabled={busy} onClick={() => void openProjectFile(f.name)}>预览</button> : null}
                      </span>
                    );
                  })}
                  {group.projectFiles.length === 0 ? <span className="faint small">（空目录）</span> : null}
                </div>
                {snapshotErr != null ? <div className="panel warning" style={{ marginTop: 6 }}>快照不可用：{snapshotErr}（只读预览拒绝——二进制/越界/超限不转码不执行）</div> : null}
                {snapshot != null ? (
                  <div style={{ marginTop: 8 }}>
                    <div className="row tight"><strong>{snapshot.name}</strong><span className="faint small">{snapshot.bytes}B{snapshot.truncated ? ' · 超预览预算已截断（完整内容看原文件）' : ''} · 只读快照</span></div>
                    <pre className="attach-preview-text" style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 320, overflow: 'auto', marginTop: 6, border: '1px solid var(--border,#dbe2ea)', padding: 8, background: '#fff' }}>{snapshot.content}</pre>
                  </div>
                ) : null}
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
          {git == null ? <div className="panel info">{busy ? '正在读取仓库状态…' : '尚未读取'}</div> : git.ok === false ? (
            <div className="panel warning">仓库状态不可用（{git.code}）：{git.message}</div>
          ) : (
            <>
              <div className="panel info" style={{ marginTop: 0 }}>
                <div className="row tight"><strong>分支 {git.branch}</strong>{git.projectRootIsWorktreeRoot ? null : <span className="faint small">（项目根是工作树子目录——仓库根：{git.worktreeRoot}）</span>}</div>
                <div className="faint small" style={{ marginTop: 4 }}>暂存 {git.staged.length} · 未暂存 {git.unstaged.length} · 未跟踪 {git.untracked.length}{git.truncated ? '（状态条目超限已截断）' : ''}</div>
                <div className="row tight" style={{ marginTop: 6 }}>
                  <button className="btn ghost sm" disabled={busy} onClick={() => void loadDiff(false)}>未暂存 diff</button>
                  <button className="btn ghost sm" disabled={busy} onClick={() => void loadDiff(true)}>已暂存 diff</button>
                  <button className="btn ghost sm" title="暂存/提交/推送等写操作在原界面仓库区（定向打开并定位）" onClick={() => takeLegacy('git')}>在原界面执行 Git 操作</button>
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
                          <span className="mono small" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.renamedFrom != null ? `${e.renamedFrom} → ${e.path}` : e.path}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {diff != null ? (
                <div className="panel info">
                  <div className="row tight">
                    <strong>diff 正文</strong>
                    {diff.truncatedOverall ? <Tag tone="warning" icon="alert-triangle">部分截断/省略</Tag> : null}
                    {diff.filesOmitted != null && diff.filesOmitted > 0 ? <span className="faint small">因文件数上限未生成正文 {diff.filesOmitted} 项（身份仍列出）</span> : null}
                    {diffCapped ? <span className="faint small">显示区截断至 {DIFF_DISPLAY_CAP} 字符（完整差异走 git 客户端）</span> : null}
                  </div>
                  {diff.patches.map((p) => (
                    <div key={p.path + p.change} style={{ marginTop: 8 }}>
                      <div className="row tight">
                        <Tag tone="neutral">{p.change}</Tag>
                        <span className="mono small" style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.oldPath != null ? `${p.oldPath} → ${p.path}` : p.path}</span>
                        {p.stat === 'binary' ? <Tag tone="info">二进制（无文本差异）</Tag> : p.stat === 'unknown' ? <Tag tone="neutral">统计不可用</Tag> : p.addedCount != null || p.deletedCount != null ? <span className="faint small">+{p.addedCount ?? 0}/-{p.deletedCount ?? 0}</span> : null}
                        {p.truncated ? <Tag tone="warning">单文件截断</Tag> : null}
                        {p.source === 'worktree-content' ? <span className="faint small">未跟踪内容</span> : null}
                      </div>
                      {p.stat !== 'binary' && p.text.length > 0 ? (
                        <pre className="attach-preview-text" style={{ whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 260, overflow: 'auto', marginTop: 4, border: '1px solid var(--border,#dbe2ea)', padding: 6, background: '#fff' }}>{p.text.slice(0, DIFF_DISPLAY_CAP)}</pre>
                      ) : null}
                    </div>
                  ))}
                  {diff.patches.length === 0 ? <div className="faint small" style={{ marginTop: 6 }}>（无差异条目）</div> : null}
                </div>
              ) : null}
              <div className="faint small">Git 诊断只读（RT-24：不改工作区，保留未提交内容）；提交/推送在原界面仓库区执行（上方直达按钮）。Git 提交不等同任务验收（RT-25）。</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
