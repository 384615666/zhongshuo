/**
 * 命令面板（r56 H4 §4——Ctrl+K，沿批准原型 CommandPalette 的布局/交互，**正式数据接线**）：
 *  - 列表来自真实事实：页面动作 + 已装载房间/私信/成员（store）+ 任务（board.view 只读聚合）
 *    + 消息/线程检索（search.query 正式命令——不做内存假列表）。
 *  - 键盘：↑/↓ 选择、Enter 打开、Esc 关闭；IME 组合态不触发（Enter 同判）；输入焦点入面板。
 *  - 约束：面板动作只做**导航/定位**（locate）——不承担确认执行、验收、解除保护或新派发
 *    （那些在各自页面按正式合同分列执行）；legacy 接管期间由 App 层全局键守卫挡下。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Tag } from './ui';
import { useStore } from '../data/store';
import { command } from '../bridge';
import { navigate } from '../lib/router';
import { openExternalDeepLink } from '../loader';

interface PaletteItem {
  key: string;
  section: '动作' | '房间' | '私信' | '成员' | '任务' | '消息' | '线程';
  label: string;
  hint?: string;
  icon: string;
  go: () => void;
}

const PAGES: PaletteItem[] = [
  { key: 'page-board', section: '动作', label: '任务看板', icon: 'list', hint: '页面', go: () => navigate('/board') },
  { key: 'page-library', section: '动作', label: '搜索与收藏', icon: 'bookmark', hint: '页面', go: () => navigate('/library') },
  { key: 'page-activity', section: '动作', label: '活动流', icon: 'activity', hint: '页面', go: () => navigate('/activity') },
  { key: 'page-files', section: '动作', label: '文件与 Git', icon: 'diff', hint: '页面', go: () => navigate('/files') },
  { key: 'page-members', section: '动作', label: '成员管理', icon: 'users', hint: '页面', go: () => navigate('/members') },
  { key: 'page-pending', section: '动作', label: '待我处理', icon: 'inbox', hint: '页面', go: () => navigate('/pending') },
  { key: 'page-dm', section: '动作', label: '私信', icon: 'message-square', hint: '页面', go: () => navigate('/dm') },
  { key: 'page-settings', section: '动作', label: '设置与帮助', icon: 'settings', hint: '页面', go: () => navigate('/settings') },
];

const locateGo = (link: string) => () => { void openExternalDeepLink(link).catch(() => { /* 失败如实由全局 toast 呈现 */ }); };

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const s = useStore((x) => x);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [tasks, setTasks] = useState<Array<{ taskId: string; title: string; status: string; locate: string }>>([]);
  const [searchRows, setSearchRows] = useState<Array<{ kind: 'message' | 'thread'; snippet: string; locate: string; projectName: string }>>([]);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // 任务事实（board.view scope=all——只读聚合；失败如实，不冒充空态为零任务）。
  useEffect(() => {
    let done = false;
    void command<{ groups: Array<{ rooms: Array<{ cards: Array<{ taskId: string; title: string; status: string; locate: string }> }> }> }>('board.view', { scope: 'all' })
      .then((r) => {
        if (done) return;
        setTasks(r.groups.flatMap((g) => g.rooms.flatMap((room) => room.cards)));
      })
      .catch(() => { /* 任务面失败=面板仍有房间/私信/动作可用；不伪零 */ });
    return () => { done = true; };
  }, []);

  // 消息/线程检索（search.query 正式命令；清空即作废在途——迟到结果不倒灌，同 LibraryPage）。
  useEffect(() => {
    const text = q.trim();
    if (text.length === 0) { setSearchRows([]); setSearchErr(null); return; }
    let gen = 0;
    const t = window.setTimeout(() => {
      gen += 1;
      void command<{ messages: Array<{ snippet: string; locate: string; projectName: string }>; threads: Array<{ snippet: string; locate: string; projectName: string }> }>('search.query', { text, scope: 'all', kind: 'all', page: 1, pageSize: 4 })
        .then((r) => { if (gen === 1) { setSearchRows([...r.messages.map((m) => ({ kind: 'message' as const, ...m })), ...r.threads.map((th) => ({ kind: 'thread' as const, ...th }))].slice(0, 8)); setSearchErr(null); } })
        .catch((e: unknown) => { if (gen === 1) { setSearchRows([]); setSearchErr((e as Error).message); } });
    }, 260);
    return () => { window.clearTimeout(t); gen += 1; };
  }, [q]);

  const query = q.trim().toLowerCase();
  const hit = (text: string) => text.toLowerCase().includes(query);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    for (const p of PAGES) if (query.length === 0 || hit(p.label)) out.push(p);
    for (const r of s.rooms) if (query.length === 0 || hit(r.name)) out.push({ key: `room-${r.id}`, section: '房间', label: r.name, icon: 'message-circle', hint: `房间 · ${s.projects.find((p) => p.id === r.projectId)?.displayName ?? ''}`, go: () => navigate(`/room/${r.id}`) });
    for (const d of s.dms) if (query.length === 0 || hit(`${d.peerDisplayName ?? ''} ${d.title ?? ''}`)) out.push({ key: `dm-${d.id}`, section: '私信', label: `${d.peerDisplayName ?? '成员'}${d.title != null && d.title.length > 0 ? ` · ${d.title}` : ''}`, icon: 'message-square', hint: d.archivedAt != null ? '私信 · 已归档' : '私信', go: () => navigate(`/dm/${d.id}`) });
    for (const m of s.members) if (query.length === 0 || hit(m.displayName)) out.push({ key: `member-${m.id}`, section: '成员', label: m.displayName, icon: 'sparkles', hint: `成员 · ${m.enabled ? '启用' : '停用'}`, go: () => navigate('/members') });
    for (const t of tasks) if (query.length === 0 || hit(t.title)) out.push({ key: `task-${t.taskId}`, section: '任务', label: t.title, icon: 'list', hint: `任务 · ${t.status}`, go: locateGo(t.locate) });
    for (const [i, r] of searchRows.entries()) out.push({ key: `sr-${i}`, section: r.kind === 'message' ? '消息' : '线程', label: r.snippet.slice(0, 60), icon: r.kind === 'message' ? 'message-square' : 'message-circle', hint: `${r.projectName} · 检索命中`, go: locateGo(r.locate) });
    return out.slice(0, 24);
  }, [query, s.rooms, s.dms, s.members, s.projects, tasks, searchRows]);

  useEffect(() => { setSel(0); }, [q]);

  const open = (it: PaletteItem) => { it.go(); onClose(); };

  return (
    <div className="scrim center" onClick={onClose} style={{ alignItems: 'flex-start', paddingTop: 88, zIndex: 90 }} data-zs-palette="hifi">
      <div
        className="modal lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板（Ctrl+K）"
        style={{ maxHeight: '72vh', display: 'flex', flexDirection: 'column', minWidth: 'min(620px, 92vw)' }}
      >
        <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', gap: 10 }}>
          <Icon name="search" size={16} className="faint" />
          <input
            ref={inputRef}
            className="input"
            style={{ border: 'none', padding: 0, minHeight: 24, fontSize: 14, boxShadow: 'none' }}
            placeholder="搜索页面、房间、私信、成员、任务、消息…（↑↓ 选择 · Enter 打开 · Esc 关闭）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(e) => {
              // IME 组合态的按键不作为面板命令（组合结束再判）。
              if (composingRef.current || e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, items.length - 1)); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); return; }
              if (e.key === 'Enter') { e.preventDefault(); const it = items[sel] ?? items[0]; if (it != null) open(it); }
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="overlay-body" style={{ padding: 8, overflow: 'auto', minHeight: 120 }}>
          {searchErr != null ? <div className="panel warning" style={{ margin: 4, padding: 8 }}>检索失败：{searchErr}（房间/私信/任务/动作仍可用）</div> : null}
          {items.length === 0 && query.length > 0 ? <div className="panel info" style={{ margin: 4, padding: 8 }}>没有匹配结果（消息/线程走服务端检索，其余按已装载事实过滤）。</div> : null}
          {items.map((it, i) => (
            <button
              key={it.key}
              className={`menu-item${i === sel ? ' on' : ''}`}
              style={{ padding: '8px 10px', background: i === sel ? 'var(--accent-soft, #eef2ff)' : undefined }}
              onMouseEnter={() => setSel(i)}
              onClick={() => open(it)}
              data-zs-palette-item={it.section}
            >
              <Icon name={it.icon} size={14} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{it.label}</span>
              {it.hint != null ? <span className="hint">{it.hint}</span> : null}
              {i === sel ? <Tag plain icon="corner-down-left">Enter</Tag> : null}
            </button>
          ))}
        </div>
        <div className="row tight" style={{ padding: '6px 14px', borderTop: '1px solid var(--border-subtle,#e6eaf0)' }}>
          <span className="small faint">定位类动作只导航/定位——确认执行、验收、解除保护在各自页面按正式合同执行；不搜索文件正文。</span>
        </div>
      </div>
    </div>
  );
}
