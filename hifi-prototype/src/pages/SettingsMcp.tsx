/**
 * 应用设置 · 连接与设备（§3.1 的第六类，含 §3.3 的外部 AI 连接）。
 *
 * 一个入口，**两个独立分组**（用户 2026-09-26 评审后定案）：
 *  1. 访问众说的设备（§8.3 配对与设备管理）—— 配对设备拥有和本机一样的权限；
 *  2. 外部 AI 连接（MCP，§31.5）—— 四维受限范围，且审批/验收永远只属于用户。
 *
 * 两套权限模型不同，所以**不合并成一张"已连接客户端"列表**，权限说明也各写各的。
 * 数据也是分开的两份（`devices` / `mcpConnections`），只有展示上共用一个入口。
 */

import { useState } from 'react';
import { Icon } from '../components/Icon';
import { DetailFold, ReadOnlyRow, SimulatedTag } from '../components/SettingsRow';
import { Modal, Tag } from '../components/ui';
import { toast, useStore } from '../data/store';
import {
  createMcpConnection, deleteMcpConnection, revokeMcpConnection, rotateMcpToken, updateMcpScope,
  validateScopeDraft, MCP_NOT_GRANTABLE, MCP_OPERATION_LABELS,
} from '../data/actions-mcp';
import type { McpScopeDraft } from '../data/actions-mcp';
import { generatePairingCode, revokeDevice, rotateToken, testAdminBoundary } from '../data/actions';
import { memberLabel } from '../data/selectors';
import type { AppState, McpConnection, McpOperation } from '../data/types';

function SectionHead({ title, sub }: { title: string; sub: React.ReactNode }) {
  return (
    <div className="settings-section-head">
      <div className="settings-section-title">{title}</div>
      <div className="settings-section-sub">{sub}</div>
    </div>
  );
}

/* ============================================================
   一、访问众说的设备（原「设备与局域网」，行为不变）
   ============================================================ */

function DeviceGroup() {
  const s = useStore((x) => x);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [customCode, setCustomCode] = useState('');
  const [codeError, setCodeError] = useState('');

  return (
    <>
      <div className="section-title" style={{ marginTop: 4 }}>访问众说的设备</div>

      {/**
       * 配对的权限说明保留（§2.6 明确要求），但改成**简短、就地、中性容器**：
       * 原来占一整块橙色面板，会让真正的风险提示失去分量。
       */}
      <div className="conn-perm">
        <Icon name="shield-off" size={13} />
        <span>
          <strong>配对的设备拥有和本机一样的权限</strong>：能发任务、停止任务、改设置。
          所以配对码只在本机显示、限时有效、用一次就作废；连接强制加密（HTTPS/WSS），拒绝明文 HTTP。
        </span>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          {/* 原「M3 批次」内部编号标签已移除（§2.5：内部批次编号不进正文） */}
          <div className="card-title" style={{ marginBottom: 12 }}>生成配对码</div>

          <div className="row wrap" style={{ gap: 8 }}>
            <button
              className="btn primary sm"
              onClick={() => {
                setPairCode(generatePairingCode());
                setCodeError('');
              }}
            >
              <Icon name="hash" size={12} /> 随机生成
            </button>
            <input
              className="input mono"
              style={{ width: 140 }}
              placeholder="或自设 8 位以上"
              value={customCode}
              onChange={(e) => {
                setCustomCode(e.target.value);
                setCodeError('');
              }}
            />
            <button
              className="btn sm"
              onClick={() => {
                if (customCode.trim().length < 8) {
                  setCodeError('自设配对码至少 8 位');
                  return;
                }
                if (s.devices.some((d) => d.tokenPrefix.endsWith(customCode.trim()))) {
                  setCodeError('该配对码使用过，不能重复');
                  return;
                }
                setPairCode(customCode.trim());
                toast(`已使用自设配对码 ${customCode.trim()}：限时 5 分钟、一次一用`, 'info');
              }}
            >
              使用自设码
            </button>
          </div>

          {codeError ? <div className="panel danger" style={{ marginTop: 10 }}>{codeError}</div> : null}

          {pairCode ? (
            <div className="card" style={{ marginTop: 12, textAlign: 'center', background: 'var(--accent-soft)', borderColor: 'var(--accent-border)' }}>
              <div className="small faint">在局域网设备的浏览器里输入</div>
              <div className="mono" style={{ fontSize: 26, fontWeight: 700, letterSpacing: '0.14em', marginTop: 4 }}>
                {pairCode}
              </div>
              <div className="small faint" style={{ marginTop: 6 }}>
                只在本机显示 · 5 分钟内有效 · 用一次就作废
              </div>
            </div>
          ) : null}

          <div className="small faint" style={{ marginTop: 10 }}>
            监听地址：<span className="mono-sm">https://127.0.0.1:7411</span> 与
            <span className="mono-sm"> https://192.168.1.10:7411</span>（自签证书，首次连接需要信任）。
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>已连接设备</div>
          <div className="col" style={{ gap: 10 }}>
            {s.devices.map((d) => (
              <div key={d.id} className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row tight">
                    <Icon name={d.kind === 'this-machine' ? 'monitor' : 'wifi-off'} size={13} className="faint" />
                    <span className="strong" style={{ fontSize: 12 }}>{d.name}</span>
                    {d.kind === 'this-machine' ? <Tag plain>本机</Tag> : null}
                  </div>
                  <div className="mono-sm" style={{ marginTop: 2 }}>
                    {d.address} · {d.tokenPrefix}*** · 最近联机 {new Date(d.lastSeenAt).toLocaleString('zh-CN')}
                  </div>
                </div>
                {/* 每台设备旁**直接**放断开，不再在下方"高级操作"里重复列一遍设备
                    （原实现把对象和操作拆到两处，用户要来回对应 —— §17.8） */}
                {d.kind !== 'this-machine' ? (
                  <button
                    className="btn sm danger"
                    onClick={() => revokeDevice(d.id)}
                    title="断开后这台设备的连接立即失效，其他设备不受影响"
                  >
                    断开访问
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <div className="divider" />
          <div className="small faint">要再连一台设备，用左边的配对码。</div>
        </div>
      </div>

      {/* 全局动作：中性容器（原橙色分隔带），危险语义留给按钮自己 */}
      <div className="settings-actions">
        <div className="settings-actions-head">
          会话与安全检查
          <span className="small faint">影响所有已连接的设备</span>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn sm" onClick={rotateToken} title="所有已配对设备无需重新配对，吊销仍是单独动作">
            <Icon name="refresh" size={12} /> 轮换会话令牌
          </button>
          <button
            className="btn sm"
            onClick={testAdminBoundary}
            title="检查来源校验、明文 HTTP 拒绝与令牌是否走请求头（原型只记录预期结果）"
          >
            检查局域网连接是否安全
          </button>
          <SimulatedTag title="原型没有监听端口与真实令牌：这两个动作只留痕并说明预期行为" />
        </div>
        <div className="small faint" style={{ lineHeight: 1.7, marginTop: 8 }}>
          轮换令牌不会把已配对的设备踢下线；断开某台设备请用上面它自己那一行的按钮。
        </div>
      </div>
    </>
  );
}

/* ============================================================
   二、外部 AI 连接（MCP，§31.5）
   ============================================================ */

/** 目标标签：项目或房间（`room:<roomId>`） */
function targetLabel(s: AppState, id: string): string {
  if (id.startsWith('room:')) {
    const r = s.rooms.find((x) => x.id === id.slice(5));
    const p = r ? s.projects.find((x) => x.id === r.projectId) : undefined;
    return r ? `${p?.displayName ?? '未知项目'} · ${r.name}（房间）` : '（房间已不存在）';
  }
  const p = s.projects.find((x) => x.id === id);
  return p ? `${p.displayName}（整个项目）` : '（项目已不存在）';
}

function scopeDraftOf(c: McpConnection): McpScopeDraft {
  return {
    targets: [...c.scope.targets],
    operations: [...c.scope.operations],
    memberIds: [...c.scope.memberIds],
    budgetCapCalls: c.scope.budgetCapCalls,
  };
}

/**
 * 范围编辑器：四项逐一配置（§31.5）。
 * 创建与"改范围"共用它 —— 两个入口的字段名与校验只有一套。
 */
function ScopeEditor({
  s,
  draft,
  onChange,
}: {
  s: AppState;
  draft: McpScopeDraft;
  onChange: (next: McpScopeDraft) => void;
}) {
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const activeProjects = s.projects.filter((p) => !p.removedAt);
  /**
   * 预算这一项单独取错误文本做**行内**提示（其余维度的缺失在提交时整体校验）。
   * 判据与动作层同一套（`validateScopeDraft`），不在这里另写一遍规则。
   */
  const scopeError = validateScopeDraft({ ...draft, targets: ['__probe__'], operations: ['read'] });
  const budgetError = scopeError && draft.budgetCapCalls !== null ? scopeError : null;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div>
        <div className="field-label">1 · 项目 / 房间集合</div>
        <div className="scope-list">
          {activeProjects.map((p) => {
            const rooms = s.rooms.filter((r) => r.projectId === p.id && !r.archivedAt);
            return (
              <div key={p.id}>
                <label className="scope-item">
                  <input
                    type="checkbox"
                    checked={draft.targets.includes(p.id)}
                    onChange={() => onChange({ ...draft, targets: toggle(draft.targets, p.id) })}
                  />
                  <span className="strong">{p.displayName}</span>
                  <span className="small faint">整个项目（含后续新建房间）</span>
                </label>
                {rooms.map((r) => {
                  const key = `room:${r.id}`;
                  return (
                    <label key={r.id} className="scope-item scope-item-sub">
                      <input
                        type="checkbox"
                        checked={draft.targets.includes(key)}
                        onChange={() => onChange({ ...draft, targets: toggle(draft.targets, key) })}
                      />
                      <span>{r.name}</span>
                      <span className="small faint">只给这一个房间</span>
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="field-label">2 · 操作集</div>
        <div className="col" style={{ gap: 6 }}>
          {(Object.keys(MCP_OPERATION_LABELS) as McpOperation[]).map((op) => (
            <label key={op} className="scope-item">
              <input
                type="checkbox"
                checked={draft.operations.includes(op)}
                onChange={() => onChange({ ...draft, operations: toggle(draft.operations, op) })}
              />
              <span>{MCP_OPERATION_LABELS[op].label}</span>
              <span className="mono-sm faint">{MCP_OPERATION_LABELS[op].detail}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="field-label">3 · 可调度成员</div>
        <div className="small faint" style={{ marginBottom: 6 }}>
          这是硬上限：这个连接发起的子任务、交接与任务内互唤都不能超出这份名单。
          读取上下文不等于能唤醒成员，所以这里不选成员时它只能读、不能派活。
        </div>
        <div className="scope-list">
          {activeProjects.map((p) => {
            const members = s.members.filter((m) => m.projectId === p.id);
            if (members.length === 0) return null;
            return (
              <div key={p.id}>
                <div className="small faint" style={{ padding: '2px 0' }}>{p.displayName}</div>
                {members.map((m) => (
                  <label key={m.id} className="scope-item scope-item-sub">
                    <input
                      type="checkbox"
                      checked={draft.memberIds.includes(m.id)}
                      onChange={() => onChange({ ...draft, memberIds: toggle(draft.memberIds, m.id) })}
                    />
                    <span>{memberLabel(m)}</span>
                    <span className="small faint">{m.model}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="field-label">4 · 预算上限</div>
        <div className="row tight">
          <input
            className="input pset-number"
            type="number"
            min={1}
            max={9999}
            step={1}
            value={draft.budgetCapCalls ?? ''}
            placeholder="不限"
            aria-label="预算上限（次调用）"
            aria-invalid={budgetError ? true : undefined}
            onChange={(e) => {
              const v = e.target.value.trim();
              // 只改草稿：非法值留在编辑态，由下面的行内错误说明，不写入状态
              onChange({ ...draft, budgetCapCalls: v === '' ? null : Number(v) });
            }}
          />
          <span className="pset-unit">次调用</span>
          <span className="small faint" style={{ marginLeft: 6 }}>
            跨任务累计，扣减与派发同事务；耗尽后不会自动追加额度，需要你来提高。只能是 ≥ 1 的整数，留空表示不限。
          </span>
        </div>
        {budgetError ? <div className="pset-row-error" data-scope-error>{budgetError}</div> : null}
      </div>

      <DetailFold summary="首批不开放的命令（勾不上，也不会承诺）">
        <div className="col" style={{ gap: 4 }}>
          {MCP_NOT_GRANTABLE.map((t) => (
            <div key={t} className="row tight" style={{ alignItems: 'flex-start' }}>
              <Icon name="lock" size={11} className="faint" style={{ marginTop: 4, flex: 'none' }} />
              <span className="small faint" style={{ lineHeight: 1.65 }}>{t}</span>
            </div>
          ))}
        </div>
      </DetailFold>
    </div>
  );
}

function McpGroup() {
  const s = useStore((x) => x);
  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [tokenOnce, setTokenOnce] = useState<string | null>(null);
  /** 创建/保存时的整体校验错误：就地显示在弹窗里，不用 toast 冒充已处理 */
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [clientType, setClientType] = useState('stdio · zs mcp 桥接（连接令牌即凭据）');
  const [transfer, setTransfer] = useState<McpConnection['transfer']>('stdio');
  const [draft, setDraft] = useState<McpScopeDraft>({ targets: [], operations: ['read'], memberIds: [], budgetCapCalls: null });

  const openCreate = () => {
    setName('');
    setTransfer('stdio');
    setClientType('stdio · zs mcp 桥接（连接令牌即凭据）');
    setDraft({ targets: [], operations: ['read'], memberIds: [], budgetCapCalls: null });
    setTokenOnce(null);
    setCreateOpen(true);
  };

  const editing = editId ? s.mcpConnections.find((c) => c.id === editId) : undefined;
  const revoking = revokeId ? s.mcpConnections.find((c) => c.id === revokeId) : undefined;

  const active = s.mcpConnections.filter((c) => !c.revokedAt);
  const revoked = s.mcpConnections.filter((c) => c.revokedAt);

  const ConnectionCard = ({ c }: { c: McpConnection }) => {
    const used = c.scope.usedCalls;
    const cap = c.scope.budgetCapCalls;
    return (
      <div className="card" style={{ marginBottom: 12 }} data-mcp-connection={c.id}>
        <div className="row tight wrap">
          <Icon name="sparkles" size={15} className="faint" />
          <span className="strong">{c.name}</span>
          <Tag plain icon={c.transfer === 'stdio' ? 'terminal' : 'link'}>
            {c.transfer === 'stdio' ? 'stdio 桥接' : 'Streamable HTTP'}
          </Tag>
          {c.revokedAt ? <Tag tone="danger" icon="x-circle">已吊销</Tag> : <Tag tone="success" icon="check-circle">生效中</Tag>}
          <div className="spacer" />
          {!c.revokedAt ? (
            <button className="btn sm" onClick={() => setEditId(c.id)}>查看 / 改范围</button>
          ) : null}
          {!c.revokedAt ? (
            <button
              className="btn sm"
              onClick={() => {
                const r = rotateMcpToken(c.id);
                if (r) setTokenOnce(r.token);
              }}
              title="轮换后旧令牌立即失效，需要在该客户端重新配置"
            >
              <Icon name="refresh" size={12} /> 轮换令牌
            </button>
          ) : null}
          {!c.revokedAt ? (
            <button className="btn danger sm" onClick={() => setRevokeId(c.id)}>吊销</button>
          ) : (
            <button className="btn sm" onClick={() => deleteMcpConnection(c.id)} title="删除已吊销的记录（审计记录随之移除）">
              <Icon name="trash" size={12} /> 删除记录
            </button>
          )}
        </div>

        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>令牌</dt>
          <dd className="mono-sm">{c.tokenPrefix}***（创建时只显示一次明文）</dd>
          <dt>最后活跃</dt>
          <dd>{new Date(c.lastActiveAt).toLocaleString('zh-CN')}</dd>
          <dt>累计调用</dt>
          <dd>
            {c.callCount} 次
            {cap !== null ? <span className="small faint"> · 本连接已用预算 {used} / {cap} 次</span> : null}
          </dd>
          <dt>当前范围</dt>
          <dd className="small" style={{ lineHeight: 1.7 }}>
            {c.scope.targets.length === 0
              ? '（未授予任何项目或房间，这个连接用不了任何东西）'
              : c.scope.targets.map((t) => targetLabel(s, t)).join('、')}
            <br />
            操作：
            {c.scope.operations.length === 0
              ? '（无）'
              : c.scope.operations.map((op) => MCP_OPERATION_LABELS[op].label).join('、')}
            <br />
            可调度成员：
            {c.scope.memberIds.length === 0
              ? '（无：只能读，不能派活）'
              : c.scope.memberIds
                  .map((id) => {
                    const m = s.members.find((x) => x.id === id);
                    return m ? memberLabel(m) : '（成员已不在）';
                  })
                  .join('、')}
          </dd>
          <dt>客户端</dt>
          <dd className="small">{c.clientType}</dd>
        </dl>

        {c.revokedAt ? (
          <div className="small faint" style={{ marginTop: 6 }}>
            已吊销于 {new Date(c.revokedAt).toLocaleString('zh-CN')}：既有会话的后续调用立即失效，
            这条记录只用于审计与回溯。
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="section-title" style={{ marginTop: 22 }}>
        外部 AI 连接（MCP）
        <span className="count">{active.length}</span>
      </div>

      {/* 必须明确标注后台尚未接入（§3.3），否则按钮会被当成已完成的能力 */}
      <div className="conn-perm">
        <Icon name="info" size={13} />
        <span>
          <strong>原型没有 MCP 服务端：后台尚未接入。</strong>
          下面能走完创建 → 查看范围 → 吊销的完整流程，但改的都是内存状态，不会有外部客户端真的连上来。
          权限上还有一条硬边界：<strong>审批与验收永远只属于你</strong>，不因后续扩展开放给外部 AI。
        </span>
      </div>

      <div className="settings-actions">
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <button className="btn primary sm" onClick={openCreate}>
            <Icon name="plus" size={12} /> 创建连接
          </button>
          <span className="small faint">
            连接按「项目/房间 × 操作 × 可调度成员 × 预算上限」四维授权；超出范围的调用会被逐次校验拒绝。
          </span>
        </div>
      </div>

      {tokenOnce ? (
        <div className="card" style={{ marginBottom: 12, borderColor: 'var(--accent-border)', background: 'var(--accent-soft)' }}>
          <div className="card-title">连接令牌（只显示这一次）</div>
          <div
            className="mono"
            data-mcp-token
            style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.06em', margin: '6px 0' }}
          >
            {tokenOnce}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button
              className="btn sm"
              onClick={() => {
                void navigator.clipboard?.writeText(tokenOnce);
                toast('令牌已复制：把它填进外部 AI 客户端的配置里', 'success');
              }}
            >
              <Icon name="copy" size={12} /> 复制令牌
            </button>
            <button className="btn ghost sm" onClick={() => setTokenOnce(null)}>我已保存，隐藏</button>
          </div>
          <div className="small faint" style={{ marginTop: 8 }}>
            关闭后不再显示明文；需要时用「轮换令牌」生成新的（旧令牌立即失效）。
          </div>
        </div>
      ) : null}

      {active.length === 0 && revoked.length === 0 ? (
        <div className="card small faint">还没有外部 AI 连接。创建后这里会显示最后活跃时间、累计调用数与当前范围。</div>
      ) : null}
      {active.map((c) => <ConnectionCard key={c.id} c={c} />)}

      {revoked.length > 0 ? (
        <>
          <div className="small faint" style={{ margin: '10px 0 8px' }}>已吊销（保留用于审计，不再生效）</div>
          {revoked.map((c) => <ConnectionCard key={c.id} c={c} />)}
        </>
      ) : null}

      <ReadOnlyRow
        label="代发标记"
        hint="经外部连接发出的消息会带「经外部助手 X 代发」标记，不显示为你亲发；任务详情里能查到是哪个连接发起的。"
        value="开启（不可关闭）"
      />

      {/* ---------- 创建连接 ---------- */}
      {createOpen ? (
        <Modal
          size="lg"
          title="创建外部 AI 连接"
          subtitle="按四维范围授权：项目/房间 × 操作 × 可调度成员 × 预算上限"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setCreateOpen(false)}>取消</button>
              <button
                className="btn primary"
                onClick={() => {
                  const bad = validateScopeDraft(draft);
                  if (bad) {
                    setSubmitError(bad);
                    return;
                  }
                  const res = createMcpConnection({ name, clientType, transfer, scope: draft });
                  if (!res) return;
                  setSubmitError(null);
                  setCreateOpen(false);
                  setTokenOnce(res.token);
                  toast('连接已创建：令牌只显示这一次，请复制到客户端配置里', 'success');
                }}
              >
                创建并生成令牌
              </button>
            </>
          }
        >
          <div className="col" style={{ gap: 12 }}>
            <div className="row wrap" style={{ gap: 10 }}>
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label className="field-label">连接名称</label>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：Claude Desktop"
                />
              </div>
              <div className="field" style={{ flex: '0 1 240px' }}>
                <label className="field-label">传输方式</label>
                <select
                  className="select"
                  value={transfer}
                  onChange={(e) => {
                    const v = e.target.value as McpConnection['transfer'];
                    setTransfer(v);
                    setClientType(
                      v === 'stdio'
                        ? 'stdio · zs mcp 桥接（连接令牌即凭据）'
                        : 'Streamable HTTP · 私有令牌模式（不提供 OAuth 发现）',
                    );
                  }}
                >
                  <option value="stdio">stdio（客户端拉起 zs mcp 桥接）</option>
                  <option value="http">Streamable HTTP（私有令牌模式）</option>
                </select>
              </div>
            </div>
            <div className="small faint" style={{ lineHeight: 1.7 }}>
              {transfer === 'stdio'
                ? 'stdio 从环境取凭据，连接令牌就是凭据；外部客户端按 MCP 惯例以子进程方式拉起桥接进程，不复用任务凭据。'
                : '私有令牌模式复用局域网的 HTTPS、Origin/Host 校验与请求头令牌防线，只支持可手工配置令牌的客户端 —— 不提供 OAuth 发现，也不宣称与标准 MCP HTTP 授权等价。'}
            </div>

            <ScopeEditor s={s} draft={draft} onChange={setDraft} />
            {submitError ? <div className="panel danger">{submitError}</div> : null}
          </div>
        </Modal>
      ) : null}

      {/* ---------- 查看 / 改范围 ---------- */}
      {editing ? (
        <EditScopeModal
          s={s}
          conn={editing}
          onClose={() => setEditId(null)}
        />
      ) : null}

      {/* ---------- 吊销确认 ---------- */}
      {revoking ? (
        <Modal
          size="sm"
          title={`吊销连接「${revoking.name}」`}
          onClose={() => setRevokeId(null)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setRevokeId(null)}>取消</button>
              <button
                className="btn danger"
                onClick={() => {
                  revokeMcpConnection(revoking.id);
                  setRevokeId(null);
                }}
              >
                吊销连接
              </button>
            </>
          }
        >
          <dl className="kv">
            <dt>立即生效</dt>
            <dd>该连接既有会话的后续调用全部失效；其他连接不受影响。</dd>
            <dt>不影响的内容</dt>
            <dd>它已经发起并完成的记录保留：代发消息、任务与成果都在，审计可回溯。</dd>
            <dt>能不能恢复</dt>
            <dd>吊销不可撤销，需要重新创建连接并重新配置范围。</dd>
          </dl>
        </Modal>
      ) : null}
    </>
  );
}

/** 改范围：复用同一个 ScopeEditor；保存时写回四项与预算 */
function EditScopeModal({ s, conn, onClose }: { s: AppState; conn: McpConnection; onClose: () => void }) {
  const [draft, setDraft] = useState<McpScopeDraft>(scopeDraftOf(conn));
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      size="lg"
      title={`「${conn.name}」的授权范围`}
      subtitle="范围变更立即生效；按旧工具列表发起的调用会被逐次校验拒绝"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            onClick={() => {
              // 与创建共用同一套校验；非法值不写入状态，错误就地显示
              const bad = updateMcpScope(conn.id, draft);
              if (bad) {
                setError(bad);
                return;
              }
              setError(null);
              onClose();
            }}
          >
            保存范围
          </button>
        </>
      }
    >
      <ScopeEditor s={s} draft={draft} onChange={setDraft} />
      {error ? <div className="panel danger" style={{ marginTop: 10 }}>{error}</div> : null}
    </Modal>
  );
}

/* ============================================================
   分区外壳：两个分组共用一个入口
   ============================================================ */

export function SectionConnections() {
  return (
    <>
      <SectionHead
        title="连接与设备"
        sub="两个独立分组：一个管「用什么设备操作众说」，一个管「哪个外部 AI 能代你做什么」。两套权限模型不同，权限说明分开写。"
      />
      <DeviceGroup />
      <McpGroup />
    </>
  );
}
