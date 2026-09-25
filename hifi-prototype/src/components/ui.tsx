/**
 * 共享 UI 基元。
 * 关键约束集中在这里，避免各页面各自为政：
 *  - StatusTag：文字 + 图标成对，不靠颜色（§17.5）
 *  - ErrorState：19 个错误码统一渲染（§16.5）
 *  - CostText：费用未知不显示为 0（RT-17）
 *  - IntentTag：灰色意图标签，不用锁/盾（E8）
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import {
  errorCopy, formatCost, taskStatusCopy, runStatusCopy, turnStatusCopy, memberWorkCopy,
  consensusCopy, type Tone,
} from '../lib/format';
import type { Consensus, ErrorCode, RunStatus, TaskStatus, TurnStatus } from '../data/types';
import { recordLocalOnly } from '../data/store';

/* ---------------- 状态标签 ---------------- */

export function Tag({
  tone = 'neutral',
  icon,
  children,
  solid,
  plain,
  title,
}: {
  tone?: Tone;
  icon?: IconName | string;
  children: ReactNode;
  solid?: boolean;
  plain?: boolean;
  title?: string;
}) {
  const cls = ['tag', tone, solid ? 'solid' : '', plain ? 'plain' : ''].filter(Boolean).join(' ');
  return (
    <span className={cls} title={title}>
      {icon ? <Icon name={icon} size={11} strokeWidth={2.2} /> : null}
      {children}
    </span>
  );
}

export function TaskStatusTag({ status, title }: { status: TaskStatus; title?: string }) {
  const c = taskStatusCopy[status];
  return <Tag tone={c.tone} icon={c.icon} title={title}>{c.label}</Tag>;
}

export function RunStatusTag({ status }: { status: RunStatus }) {
  const c = runStatusCopy[status];
  return <Tag tone={c.tone} icon={c.icon}>{c.label}</Tag>;
}

export function TurnStatusTag({ status }: { status: TurnStatus }) {
  const c = turnStatusCopy[status];
  return <Tag tone={c.tone} icon={c.icon}>{c.label}</Tag>;
}

export function MemberWorkTag({ state }: { state: string }) {
  const c = memberWorkCopy[state] ?? memberWorkCopy.idle;
  return <Tag tone={c.tone} icon={c.icon}>{c.label}</Tag>;
}

export function ConsensusTag({ consensus, label }: { consensus: Consensus; label?: string }) {
  const c = consensusCopy[consensus];
  return <Tag tone={c.tone} icon={c.icon}>{label ?? c.label}</Tag>;
}

/* ---------------- 费用（RT-17） ---------------- */

export function CostText({
  quality,
  amount,
}: {
  quality: 'reported' | 'estimated' | 'unknown';
  amount: number | null;
}) {
  const text = formatCost(quality, amount);
  if (quality === 'unknown') {
    return (
      <span className="faint" title="该 runtime 未返回可比账单数据；未知不显示为 0">
        {text}
      </span>
    );
  }
  return <span title={quality === 'estimated' ? '按 provider 估算，非真实账单' : 'provider 上报值'}>{text}</span>;
}

/* ---------------- 错误态（§16.5） ---------------- */

export function ErrorState({
  code,
  detail,
  actions,
}: {
  code: ErrorCode;
  detail?: string;
  actions?: ReactNode;
}) {
  const copy = errorCopy[code];
  return (
    <div className="error-state">
      <Icon name="alert-triangle" size={15} className="muted" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row tight baseline">
          <span className="code">{code}</span>
          <span className="strong">{copy.title}</span>
        </div>
        <div className="action">{detail ?? copy.action}</div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/* ---------------- 空状态 ---------------- */

export function EmptyState({
  icon = 'inbox',
  title,
  detail,
  action,
}: {
  icon?: IconName | string;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={26} className="faint" strokeWidth={1.4} />
      <div className="empty-title">{title}</div>
      {detail ? <div className="empty-detail">{detail}</div> : null}
      {action ? <div style={{ marginTop: 4 }}>{action}</div> : null}
    </div>
  );
}

/* ---------------- 灰色意图标签（E8） ---------------- */

export function IntentTag({ intent }: { intent: 'analyze' | 'modify' }) {
  const text = intent === 'analyze' ? '分析项目 · 只读意图' : '修改项目 · 写入意图';
  const title =
    '这里显示的是本次任务的预期能力，不是安全保证。当前 CLI 拥有你的完整本机权限，v0.1 无法保证阻止它写文件；真正的写入拦截归 DEV-20（ADR-14）。';
  return (
    <span className="intent-tag" title={title}>
      <Icon name="info" size={11} />
      {text}
    </span>
  );
}

/* ---------------- 头像 ---------------- */

export function Avatar({
  name,
  ordinal,
  color,
  size = 22,
  round,
  state,
  stateTitle,
}: {
  name: string;
  ordinal?: number;
  color?: string;
  size?: 16 | 18 | 22 | 28 | 36;
  round?: boolean;
  state?: string;
  stateTitle?: string;
}) {
  // 同名成员用序号消歧（§3.2）
  const initials = (name.replace(/[^\p{L}\p{N}]/gu, '')[0] ?? '?').toUpperCase();
  const label = ordinal && ordinal > 1 ? `${initials}${ordinal}` : initials;
  const bg = color ?? 'var(--neutral)';
  const dotColor =
    state === 'running' ? 'var(--info)'
      : state === 'idle' ? 'var(--success)'
        : state === 'waiting' ? 'var(--warning)'
          : state === 'error' ? 'var(--danger)'
            : 'var(--text-4)';
  return (
    <span
      className={`avatar avatar-${size}${round ? ' round' : ''}`}
      style={{ background: bg }}
      title={stateTitle ? `${name}${ordinal && ordinal > 1 ? `#${ordinal}` : ''} · ${stateTitle}` : undefined}
    >
      {label}
      {state ? <i className="state-dot" style={{ background: dotColor }} /> : null}
    </span>
  );
}

export function memberColor(memberId: string, ordinal?: number): string {
  if (memberId === 'you') return 'var(--m-human)';
  if (memberId.includes('claude')) return 'var(--m-claude)';
  if (ordinal && ordinal > 1) return 'var(--m-codex2)';
  if (memberId.includes('codex')) return 'var(--m-codex)';
  return 'var(--neutral)';
}

/* ---------------- 开关 ---------------- */

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`switch${disabled ? ' disabled' : ''}`}
      title={hint}
      onClick={(e) => {
        e.preventDefault();
        if (!disabled) onChange(!checked);
      }}
    >
      <span className={`switch-track${checked ? ' on' : ''}`}>
        <span className="switch-knob" />
      </span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}

/* ---------------- 分段控件 ---------------- */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'on' : ''}
          title={o.title}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- 浮层 ---------------- */

export function Modal({
  title,
  subtitle,
  size = 'md',
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEsc(onClose);
  return (
    <div className="scrim center" onClick={onClose}>
      <div className={`modal ${size}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="overlay-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="overlay-title">{title}</div>
            {subtitle ? <div className="small muted" style={{ marginTop: 2 }}>{subtitle}</div> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="overlay-body">{children}</div>
        {footer ? <div className="overlay-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEsc(onClose);
  return (
    <div className="scrim right" onClick={onClose}>
      <div className={`drawer${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="overlay-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="overlay-title">{title}</div>
            {subtitle ? <div className="small muted" style={{ marginTop: 2 }}>{subtitle}</div> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="overlay-body">{children}</div>
        {footer ? <div className="overlay-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

function useEsc(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

/* ---------------- 区域级「收起 / 返回」按钮 ---------------- */

/**
 * 区域级「收起 / 返回」按钮（界面信息减负后续统一：回复串与文件预览共用）。
 *
 * 为什么统一到**左边、同一个组件**：
 *  · 两者是同一族动作（"退出当前区域、回到上一层"）：回复串→回主池；预览→回对话；
 *  · 左上角是"离开/返回"的通用位置，本项目其它地方已经遵循（窄窗全屏线程返回、
 *    单区域预览返回都在左上）。若统一到右边，全屏页的返回就得跟着挪到右上，
 *    与 ⋯ 挤在一端，违背惯例；
 *  · 右边留给"本区域内的次级操作"（⋯ 更多、已打开列表、还原），语义分区更干净。
 *
 * 文案与可访问名称必须各自准确：`label` 是按钮上的短文案，`title`/`ariaLabel`
 * 说明这一步到底做什么（"收起预览" ≠ "返回主池" ≠ "关闭"）。
 */
export function PanelNavButton({
  icon,
  label,
  title,
  ariaLabel,
  onClick,
  className,
}: {
  icon: IconName | string;
  label: string;
  title: string;
  ariaLabel?: string;
  onClick: () => void;
  /** 调用方追加的钩子类名（例如 `.thread-nav-back` / `.preview-nav-back`） */
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`panel-nav-btn${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={ariaLabel ?? label}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
      <span className="panel-nav-label">{label}</span>
    </button>
  );
}

/* ---------------- 下拉菜单（点击外部关闭） ---------------- */

/**
 * 由**触发元素**算出菜单锚点。
 *
 * 为什么不能直接用 `e.clientX/clientY`：键盘触发（Enter/Space）时浏览器给出的
 * 坐标是 0,0，菜单会飞到窗口左上角。用元素矩形算锚点，鼠标与键盘打开落在同一处，
 * 也顺手满足了"菜单必须键盘可达"（减负 §2.3/§6.2）。
 */
export function anchorFromElement(el: HTMLElement | null): { x: number; y: number } {
  if (!el) return { x: 16, y: 16 };
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.bottom + 4) };
}

export function Menu({
  anchor,
  onClose,
  children,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(anchor.x, window.innerWidth - r.width - 8);
    const y = Math.min(anchor.y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  hint,
  title,
  onClick,
  danger,
  disabled,
}: {
  icon?: IconName | string;
  children: ReactNode;
  /** 行尾的**短状态**（如"当前：已静音"），不是解释 */
  hint?: ReactNode;
  /**
   * 操作的**解释**，走原生 tooltip（菜单文字保持简短，解释进入辅助说明）。
   * 与 `hint` 分工：hint 说"现在是什么状态"，title 说"点了会发生什么"。
   */
  title?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`menu-item${danger ? ' danger' : ''}`}
      disabled={disabled}
      onClick={onClick}
      role="menuitem"
      title={title}
    >
      {icon ? <Icon name={icon} size={14} /> : <span style={{ width: 14 }} />}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {hint ? <span className="hint">{hint}</span> : null}
    </button>
  );
}

/* ---------------- 详情视图的两种宿主 ----------------
   同一个详情视图要能在两种场合渲染：
   - 独立页面：深链直接打开，或找不到归属时的退化显示
   - 覆盖式面板（§17.1）：覆盖在当前房间之上，关闭后原样回到原处
   视图内容完全一致，只由外层的 host 决定外壳，避免维护两套代码。

   实现方式：视图把外层容器标上 `as-panel`，由 CSS 去掉"独立页面"的
   背景/边框/滚动，交给覆盖面板容器负责。
*/

export type DetailHost = 'page' | 'panel';

/** 生成详情视图的外层 className */
export function hostClass(host: DetailHost | undefined, base: 'main' | 'page') {
  if (base === 'main') return host === 'panel' ? 'main as-panel' : 'main';
  return host === 'panel' ? 'page as-panel-page' : 'page';
}

/* ---------------- 原型标记 ---------------- */

export function ProtoFlag({ note = '原型 · 内存数据' }: { note?: string }) {
  return (
    <span
      className="proto-flag"
      title="这是高保真原型：没有 daemon、SQLite 与 runtime 适配器，写操作只改内存，刷新即回seed。"
      onClick={() => recordLocalOnly('proto.flag.open', '查看了原型边界说明')}
    >
      <Icon name="sparkles" size={10} />
      {note}
    </span>
  );
}

/* ---------------- 进度条 ---------------- */

export function Meter({
  segments,
  legend,
}: {
  segments: { value: number; color: string; label: string }[];
  legend?: boolean;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <>
      <div className="bar">
        {segments.map((s, i) => (
          <span key={i} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}：${s.value}`} />
        ))}
      </div>
      {legend ? (
        <div className="bar-legend">
          {segments.map((s, i) => (
            <span key={i}>
              <i style={{ background: s.color }} />
              {s.label} {s.value}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}
