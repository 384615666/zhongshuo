/**
 * 全局搜索（Ctrl+K，§27.11 ATTN-03/04）
 * 结果必须能跳回来源串，并高亮命中；搜索行为本身不授权给任何 agent。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Tag } from './ui';
import { useStore } from '../data/store';
import { byId, memberLabel } from '../data/selectors';
import { navigate } from '../lib/router';
import { recordLocalOnly } from '../data/store';
import type { Message } from '../data/types';

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const s = useStore((x) => x);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | 'messages' | 'tasks' | 'people'>('all');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return { messages: [], tasks: [], people: [], rooms: [] };
    const hit = (text: string) => text.toLowerCase().includes(query);
    return {
      messages: s.messages.filter((m) => hit(m.body)).slice(0, 8),
      tasks: s.tasks.filter((t) => hit(t.title) || hit(t.objective)).slice(0, 6),
      people: s.members.filter((m) => hit(m.displayName) || hit(m.model)).slice(0, 5),
      rooms: s.rooms.filter((r) => hit(r.name) || hit(r.description ?? '')).slice(0, 5),
    };
  }, [q, s]);

  const total =
    results.messages.length + results.tasks.length + results.people.length + results.rooms.length;

  const show = (k: typeof scope) => scope === 'all' || scope === k;

  const goMessage = (m: Message) => {
    // 用户在这里看过结果，不等于授权给当前 agent（§25.4）
    recordLocalOnly('search.open', `message=${m.id} → 定位到 ${m.threadId ? '线程' : '主池'}；看过结果不自动授权给 agent`);
    if (m.threadId) navigate(`/project/${m.projectId}/room/${m.roomId}?thread=${m.threadId}`);
    else navigate(`/project/${m.projectId}/room/${m.roomId}`);
    onClose();
  };

  return (
    <div className="scrim center" onClick={onClose} style={{ alignItems: 'flex-start', paddingTop: 88 }}>
      <div
        className="modal lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ maxHeight: '72vh' }}
      >
        <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', gap: 10 }}>
          <Icon name="search" size={16} className="faint" />
          <input
            ref={inputRef}
            className="input"
            style={{ border: 'none', padding: 0, minHeight: 24, fontSize: 14, boxShadow: 'none' }}
            placeholder="搜索消息、任务、成员、房间…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && results.messages[0]) goMessage(results.messages[0]);
            }}
          />
          <span className="kbd">Esc</span>
        </div>

        <div className="row" style={{ padding: '8px 14px', gap: 6, borderBottom: '1px solid var(--border-subtle)' }}>
          {([
            ['all', '全部'],
            ['messages', '消息'],
            ['tasks', '任务'],
            ['people', '成员'],
          ] as const).map(([k, label]) => (
            <button key={k} className={`btn sm${scope === k ? ' primary' : ' ghost'}`} onClick={() => setScope(k)}>
              {label}
            </button>
          ))}
          <div className="spacer" />
          <span className="small faint">
            已限定在本机可见范围；不搜索文件正文（附件内文需打开文件后查看）
          </span>
        </div>

        <div className="overlay-body" style={{ padding: 10 }}>
          {!q.trim() ? (
            <div className="panel" style={{ margin: 6 }}>
              <div className="panel-title"><Icon name="info" size={13} /> 搜索范围说明</div>
              可以搜到你可见的房间与私信中的消息、任务标题与成员名称。
              命中会高亮并跳回原消息所在上下文；这里看过的内容不会自动授权给当前任务里的 agent。
            </div>
          ) : total === 0 ? (
            <div className="empty">
              <Icon name="search" size={22} className="faint" />
              <div className="empty-title">没有匹配结果</div>
              <div className="empty-detail">换个关键词，或者到具体线程里用「在消息列中搜索」限定范围。</div>
            </div>
          ) : null}

          {show('messages') && results.messages.length > 0 ? (
            <>
              <div className="menu-label">消息 {results.messages.length}</div>
              {results.messages.map((m) => (
                <button key={m.id} className="menu-item" onClick={() => goMessage(m)} style={{ padding: '8px 10px' }}>
                  <Icon name={m.threadId ? 'message-square' : 'hash'} size={14} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="row tight">
                      <span className="small strong">
                        {m.authorType === 'human' ? '你' : m.authorType === 'system' ? '系统' : memberLabel(byId(s.members, m.authorId))}
                      </span>
                      <span className="small faint">· {s.rooms.find((r) => r.id === m.roomId)?.name}</span>
                      {m.threadId ? <Tag plain>串内</Tag> : <Tag plain>主池</Tag>}
                    </span>
                    <span className="small muted clamp-2" style={{ display: 'block', marginTop: 2, textAlign: 'left' }}>
                      {highlight(m.body, q)}
                    </span>
                  </span>
                </button>
              ))}
            </>
          ) : null}

          {show('tasks') && results.tasks.length > 0 ? (
            <>
              <div className="menu-label">任务 {results.tasks.length}</div>
              {results.tasks.map((t) => (
                <button
                  key={t.id}
                  className="menu-item"
                  onClick={() => {
                    navigate(`/project/${t.projectId}/room/${t.roomId}?thread=${t.conversationThreadId}&tab=task`);
                    onClose();
                  }}
                >
                  <Icon name="list" size={14} />
                  <span style={{ flex: 1 }}>{highlight(t.title, q)}</span>
                  <span className="hint">#{t.roomTaskNumber}</span>
                </button>
              ))}
            </>
          ) : null}

          {show('people') && results.people.length > 0 ? (
            <>
              <div className="menu-label">成员 {results.people.length}</div>
              {results.people.map((m) => (
                <button
                  key={m.id}
                  className="menu-item"
                  onClick={() => {
                    navigate(`/member/${m.id}`);
                    onClose();
                  }}
                >
                  <Icon name="user" size={14} />
                  <span style={{ flex: 1 }}>{memberLabel(m)}</span>
                  <span className="hint">{m.model}</span>
                </button>
              ))}
            </>
          ) : null}

          {show('messages') && results.rooms.length > 0 ? (
            <>
              <div className="menu-label">房间 {results.rooms.length}</div>
              {results.rooms.map((r) => (
                <button
                  key={r.id}
                  className="menu-item"
                  onClick={() => {
                    navigate(`/project/${r.projectId}/room/${r.id}`);
                    onClose();
                  }}
                >
                  <Icon name="hash" size={14} />
                  <span style={{ flex: 1 }}>{r.name}</span>
                  <span className="hint">{r.memberIds.length} 成员</span>
                </button>
              ))}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function highlight(text: string, q: string) {
  const query = q.trim();
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)', borderRadius: 3, padding: '0 2px' }}>
        {text.slice(i, i + query.length)}
      </mark>
      {text.slice(i + query.length)}
    </>
  );
}
