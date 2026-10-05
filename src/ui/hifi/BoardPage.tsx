/**
 * 任务看板（H3 第一批，第五十三轮）：正式 `board.view` 只读聚合（不建新表、不改任务状态——
 * 动作走正式命令：卡片定位到线程详情后停止/验收）。列位按服务端 column 事实（第二十七轮五
 * 状态机修正）；退出未确认（exitUnconfirmed）与受阻原因（statusReason）如实标注；待验收
 * 交付带三重身份徽标。同名房间按 roomId 分组、同号任务按 taskId——不按名称猜测。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { openExternalDeepLink } from './loader';

interface BoardCard {
  taskId: string; title: string; threadId: string | null; projectId: string; roomId: string;
  ownerMemberId: string | null; taskStatus: string; runStatus: string | null; runId: string | null;
  stopGeneration: number; column: 'running' | 'waiting' | 'review' | 'blocked' | 'stopped' | 'done';
  exitUnconfirmed: boolean; statusReason: string | null;
  pendingDelivery: { deliveryId: string; revision: number; manifestHash: string } | null;
  locate: string;
}
interface BoardData { groups: Array<{ projectId: string; displayName: string; rooms: Array<{ roomId: string; name: string; cards: BoardCard[] }> }>; note: string }

const COLUMN_LABEL: Record<BoardCard['column'], string> = {
  running: '进行中', waiting: '等待', review: '待验收', blocked: '受阻', stopped: '已停止', done: '已完成',
};
const COLUMN_ORDER: BoardCard['column'][] = ['running', 'waiting', 'review', 'blocked', 'stopped', 'done'];

export function BoardPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [data, setData] = useState<BoardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const genRef = useRef(0);

  const reload = useCallback(async () => {
    if (projectId == null || projectId === '') { setData(null); return; }
    const gen = ++genRef.current;
    setLoading(true); setErr(null);
    try {
      // scope=all ≠ 全部项目：服务端按用户可见项目集（navigation_preferences.visibleProjectIds）
      // 过滤——与合同一致；scope=project 为显式指定。
      const r = await command<BoardData>('board.view', { scope, ...(scope === 'project' ? { projectId } : {}) });
      if (gen !== genRef.current) return; // 已切换范围/页面——迟到响应不污染
      setData(r);
    } catch (e) {
      if (gen === genRef.current) setErr((e as Error).message);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [projectId, scope]);

  useEffect(() => { void reload(); }, [reload]);

  const openCard = (card: BoardCard) => {
    void openExternalDeepLink(card.locate).catch((e: unknown) => toast(`定位失败：${(e as Error).message}`, 'error'));
  };

  const group = data?.groups.find((g) => g.projectId === projectId) ?? data?.groups[0];
  const groups = scope === 'all' ? (data?.groups ?? []) : group != null ? [group] : [];

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }} className="page-stack" data-zs-board="hifi">
      <div className="row tight" style={{ marginBottom: 8 }}>
        <Icon name="list" size={14} />
        <strong>任务看板</strong>
        <select className="pdf-zoom" value={scope} onChange={(e) => setScope(e.target.value === 'all' ? 'all' : 'project')} title="范围：当前项目（显式指定）或全部可访问项目（按你的可见项目集过滤）">
          <option value="project">当前项目</option>
          <option value="all">全部可访问项目</option>
        </select>
        <span className="faint small">只读聚合（board.view）——动作在卡片定位的线程详情里（停止/验收/追加）</span>
        <button className="btn ghost sm" onClick={() => void reload()} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
      </div>
      {err != null ? <div className="panel warning">看板装载失败：{err}（可刷新重试）</div> : null}
      {group == null && err == null ? <div className="panel info">{loading ? '正在装载…' : '当前项目没有任务。'}</div> : null}
      {groups.map((group) => group.rooms.map((room) => {
        const byColumn = new Map<BoardCard['column'], BoardCard[]>(COLUMN_ORDER.map((c) => [c, []]));
        for (const c of room.cards) byColumn.get(c.column)?.push(c);
        if (room.cards.length === 0) return null;
        return (
          <div key={room.roomId} style={{ marginBottom: 14 }}>
            <div className="row tight" style={{ marginBottom: 6 }}>
              <Icon name="message-circle" size={12} />
              <span className="small" style={{ fontWeight: 600 }}>{room.name}</span>
              <span className="faint small">（{room.cards.length} 张卡）</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 8 }}>
              {COLUMN_ORDER.map((col) => {
                const cards = byColumn.get(col) ?? [];
                if (cards.length === 0) return null;
                return (
                  <div key={col} className="panel info" style={{ padding: 8, margin: 0, background: 'var(--bg-soft, #f1f5f9)' }} data-zs-board-column={col}>
                    <div className="row tight" style={{ marginBottom: 6 }}>
                      <span className="small" style={{ fontWeight: 600 }}>{COLUMN_LABEL[col]}</span>
                      <span className="faint small">{cards.length}</span>
                    </div>
                    {cards.map((card) => (
                      <button
                        key={card.taskId}
                        className="root-card"
                        style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, padding: 8 }}
                        title={`打开线程详情（${card.locate}）`}
                        onClick={() => openCard(card)}
                      >
                        <div className="row tight">
                          <span className="small" style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.title}</span>
                        </div>
                        <div className="row tight" style={{ marginTop: 4 }}>
                          <span className="faint small">{card.taskStatus}{card.runStatus != null ? ` · run ${card.runStatus}` : ''}</span>
                          {card.pendingDelivery != null ? <Tag tone="info" icon="package">交付 v{card.pendingDelivery.revision}</Tag> : null}
                          {card.exitUnconfirmed ? <Tag tone="warning" icon="alert-triangle">退出未确认</Tag> : null}
                        </div>
                        {card.statusReason != null ? <div className="faint small" style={{ marginTop: 4 }}>{card.statusReason}</div> : null}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        );
      }))}
      <div className="faint small" style={{ marginTop: 10 }}>{data?.note ?? ''} · 停止/验收等动作经卡片进入线程详情执行（绑定 run/代次/三重身份——过时会被服务端拒绝）。</div>
    </div>
  );
}
