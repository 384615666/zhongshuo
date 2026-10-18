/**
 * 共享 UI 基元。
 * 关键约束集中在这里，避免各页面各自为政：
 *  - StatusTag：文字 + 图标成对，不靠颜色（§17.5）
 *  - ErrorState：19 个错误码统一渲染（§16.5）
 *  - CostText：费用未知不显示为 0（RT-17）
 *  - IntentTag：灰色意图标签，不用锁/盾（E8）
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {createPortal} from 'react-dom';
import { Icon, type IconName } from './Icon';
import {
  errorCopy, formatCost, taskStatusCopy, runStatusCopy, turnStatusCopy, memberWorkCopy,
  consensusCopy, type Tone,
} from '../lib/format';
import type { Consensus, ErrorCode, RunStatus, TaskStatus, TurnStatus } from '../data/types';
import { recordLocalOnly, useStore } from '../data/store';

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
  subject,
  show,
}: {
  name: string;
  ordinal?: number;
  color?: string;
  size?: 16 | 18 | 22 | 28 | 36;
  round?: boolean;
  state?: string;
  stateTitle?: string;
  /** Durable appearance subject: "user" or "member:<memberId>". */
  subject?: string;
  /** Settings previews may force visibility; normal surfaces follow the saved preference. */
  show?: boolean;
}) {
  const showAvatars=useStore(s=>s.ui.showAvatars===true);
  const avatars=useStore(s=>s.ui.avatars??{});
  if(!(show ?? showAvatars))return null;
  // 同名成员用序号消歧（§3.2）
  const initials = (name.replace(/[^\p{L}\p{N}]/gu, '')[0] ?? '?').toUpperCase();
  const label = ordinal && ordinal > 1 ? `${initials}${ordinal}` : initials;
  const bg = color ?? 'var(--neutral)';
  const image=subject==null?undefined:avatars[subject];
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
      {image!=null?<img src={image} alt="" draggable={false}/>:label}
      {state && state !== 'unknown' ? <i className="state-dot" style={{ background: dotColor }} /> : null}
    </span>
  );
}

export function memberColor(memberId: string, ordinal?: number): string {
  if (memberId === 'you') return 'var(--m-human)';
  if (memberId.includes('claude')) return 'var(--m-claude)';
  if (ordinal && ordinal > 1) return 'var(--m-codex2)';
  if (memberId.includes('codex')) return 'var(--m-codex)';
  const palette=['var(--m-claude)','var(--m-codex)','var(--m-codex2)'];
  const hash=[...memberId].reduce((sum,char)=>(sum*31+char.codePointAt(0)!)>>>0,0);
  return palette[hash%palette.length]!;
}

/** R68 §6：实例短标识（成员 id 尾 4 位）——同名成员在卡片/名单/@/配置入口的可见区分
 *（数据库 ID 不同≠用户能辨认；稳定不随改名漂移）。全站唯一口径。 */
export function memberShortId(id: string): string {
  const hex = id.replace(/-/g, '').slice(-4).toLowerCase();
  return /^[0-9a-f]{4}$/.test(hex) ? hex : id.slice(-4).toLowerCase();
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
    <button
      type="button"
      className={`switch${disabled ? ' disabled' : ''}`}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={hint}
      onClick={() => onChange(!checked)}
    >
      <span className={`switch-track${checked ? ' on' : ''}`}>
        <span className="switch-knob" />
      </span>
      {label ? <span>{label}</span> : null}
    </button>
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

function OverlayCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="icon-btn overlay-close" title="关闭" aria-label="关闭" onClick={onClose}>
      <Icon name="x" size={15} />
    </button>
  );
}

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
          <OverlayCloseButton onClose={onClose} />
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
          <OverlayCloseButton onClose={onClose} />
        </div>
        <div className="overlay-body">{children}</div>
        {footer ? <div className="overlay-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

function useEsc(onClose: () => void) {
  useEffect(()=>{window.dispatchEvent(new Event('zs:overlay-open'));},[]);
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
  trigger,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
  trigger?:HTMLElement|null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp=()=>{const r = el.getBoundingClientRect();
      const x = Math.min(anchor.x, window.innerWidth - r.width - 8);
      const y = Math.min(anchor.y, window.innerHeight - r.height - 8);
      setPos({ x: Math.max(8, x), y: Math.max(8, y) });};
    clamp();window.addEventListener('resize',clamp);
    const observer=new ResizeObserver(clamp);observer.observe(el);
    return()=>{window.removeEventListener('resize',clamp);observer.disconnect();};
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)&&!trigger?.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {onClose();trigger?.focus();}
    };
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    window.addEventListener('hashchange',onClose);
    window.addEventListener('zs:overlay-open',onClose);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
      window.removeEventListener('hashchange',onClose);
      window.removeEventListener('zs:overlay-open',onClose);
    };
  }, [onClose,trigger]);

  return (
    createPortal(<div ref={ref} className="menu" style={{ left: pos.x, top: pos.y,zIndex:2147480100,WebkitAppRegion:'no-drag' } as React.CSSProperties} role="menu">
      {children}
    </div>,document.body)
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
/**
 * R67 P4：**共享 Select**——全软件筛选/下拉统一入口（用户图 1 诉求的收口：不是各页散写
 * `<select className="select">`，而是同一组件保证 className/尺寸（sm 可选）/禁用/加载/
 * aria 语义一致；键盘/IME/Esc 行为沿用原生 select 本身——与批准原型一致的原生形态）。
 * `loading` 时显示占位项并禁点（查询失败/装载中如实，不冒充可选）。
 */
/**
 * 统一下拉（R66 抽象 → R68 §6 组件更换）：**自绘 listbox**——原生 <select> 的展开态由
 * 系统渲染，无法统一设计语言/无法截图验收（用户图 1 的诉求）。实现沿既有 Menu 的弹出
 * 模式（.select-pop / .select-option，键盘可达：↑↓ 移动、Enter/Space 选中、Esc/Home/End、
 * 点击外部关闭；focus 管理=按钮持有焦点，aria-activedescendant 指向活动项）。
 * API 与原生包装版完全一致（value/onChange/options/size/loading/disabled/title/ariaLabel）。
 */
export function Select({
  value, onChange, options, size, loading, loadingLabel = '装载中…', disabled, title, ariaLabel, searchable=false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  size?: 'sm';
  loading?: boolean;
  loadingLabel?: string;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  searchable?:boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query,setQuery]=useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const isDisabled = disabled === true || loading === true;
  const shownOptions = loading === true ? [{ value, label: loadingLabel }] : searchable&&query.trim()?options.filter(o=>(o.label+' '+o.value).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())):options;
  const selectedIdx = Math.max(0, shownOptions.findIndex((o) => o.value === value));
  const selectedLabel = options.find(o=>o.value===value)?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent): void => {
      if (rootRef.current != null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer, true);
    return () => { document.removeEventListener('pointerdown', onDocPointer, true); };
  }, [open]);

  useEffect(() => {
    if (open && listRef.current != null) {
      const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, activeIdx]);

  const pick = (v: string): void => {
    setOpen(false);
    if (v !== value) onChange(v);
  };
  const onBtnKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (isDisabled||e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) { setOpen(true); setActiveIdx(selectedIdx); return; }
      if (e.key === 'Enter' || e.key === ' ') { pick(shownOptions[activeIdx]?.value ?? value); return; }
      setActiveIdx((i) => {
        const n = shownOptions.length;
        if (n === 0) return i;
        return e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    if (e.key === 'Escape' && open) { e.preventDefault();e.stopPropagation(); setOpen(false); return; }
    if (!open) return;
    if (e.key === 'Home') { e.preventDefault(); setActiveIdx(0); return; }
    if (e.key === 'End') { e.preventDefault(); setActiveIdx(Math.max(0, shownOptions.length - 1)); return; }
    if (e.key === 'Tab') setOpen(false);
  };

  const listId = useSelectListId();
  return (
    <div className={`select-wrap${size === 'sm' ? ' sm' : ''}`} ref={rootRef} data-zs-select={loading === true ? 'loading' : 'ready'} data-zs-select-open={open ? '1' : undefined}>
      <button
        type="button"
        className={`select${size === 'sm' ? ' sm' : ''}${open ? ' open' : ''}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-activedescendant={open ? `${listId}-opt-${activeIdx}` : undefined}
        title={title}
        disabled={isDisabled}
        onClick={() => { if (!isDisabled) { setQuery('');setOpen((o) => !o); setActiveIdx(selectedIdx); } }}
        onKeyDown={onBtnKeyDown}
      >
        <span className="select-value truncate">{selectedLabel}</span>
        <Icon name="chevron-down" size={11} />
      </button>
      {open ? (
        <div className="select-pop" ref={listRef}>
          {searchable?<input className="input" autoFocus role="searchbox" aria-label={`搜索${ariaLabel??'选项'}`} placeholder="搜索名称或模型 ID" value={query} onChange={e=>{setQuery(e.target.value);setActiveIdx(0);}} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='Escape'||e.key==='Enter'||e.key==='Tab')onBtnKeyDown(e);}}/>:null}
          <div role="listbox" id={listId} aria-label={ariaLabel??title??'选项'}>
          {shownOptions.length===0?<div className="small faint" style={{padding:10}}>没有匹配项</div>:null}
          {shownOptions.map((o, i) => (
            <div
              key={o.value}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              data-idx={i}
              data-zs-option={o.value}
              className={`select-option${o.value === value ? ' selected' : ''}${i === activeIdx ? ' active' : ''}`}
              onPointerEnter={() => setActiveIdx(i)}
              onClick={() => pick(o.value)}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value ? <Icon name="check" size={11} /> : null}
            </div>
          ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

let selectSeq = 0;
function useSelectListId(): string {
  const ref = useRef<string | null>(null);
  if (ref.current == null) { selectSeq += 1; ref.current = `zs-select-list-${selectSeq}`; }
  return ref.current;
}

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
