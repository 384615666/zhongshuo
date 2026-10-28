import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * 设置行基元（应用设置 §2.2 / 项目设置 §17.8 共用）。
 *
 * 为什么提到 components：项目设置先用 `.pset-row` 定型了这个行解剖 ——
 * **左侧名称 + 说明，右侧控件右对齐成一列，同一张卡内多行用发丝线分隔**。
 * 应用设置整理时（任务书 §7 明确要求）**扩这一个共享基元**，
 * 不在应用设置侧 fork 出第三种设置行样式。
 *
 * 三条口径（§2.2，逐条写在代码旁边，避免以后又被"改整齐"改回去）：
 *  1. 说明默认一到两行、**允许自然换行** —— 不为整齐截断中文长句与长路径；
 *  2. 固定控件列宽**只适用于普通开关与短选项**：路径输入、认证配置、授权范围
 *     用 `wide` 按内容占宽（§2.2 的例外条款）；
 *  3. **当前值用独立值列**（`value`），不再塞进 label 括号里。
 */

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Switch, Tag } from './ui';

/* ---------------- 原型边界标注（§2.4） ---------------- */

/** 演示标记的统一措辞：不声称已生效，也不冒充成功。 */
export const SIMULATED_TITLE =
  '演示设置不会改变系统配置';

/**
 * 「演示」标记。
 *
 * §2.4 要求每个控件都能回答"能不能改、改了影响什么"：真正改状态的控件不需要它，
 * 只改内存模拟值或只弹提示的控件必须带它，避免"点了就 toast"冒充已生效。
 */
export function SimulatedTag({ title = SIMULATED_TITLE, label = '演示' }: { title?: string; label?: string }) {
  return (
    <Tag plain title={title}>
      {label}
    </Tag>
  );
}

/* ---------------- 行 ---------------- */

export function SettingsRow({
  label,
  hint,
  value,
  valueWrap,
  control,
  wide,
  id,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** 当前值列（§2.2：独立值列，不写进 label 括号） */
  value?: React.ReactNode;
  /** 值可能很长（成员名单、路径）：允许换行不要截断（§2.1 不允许截到不可读） */
  valueWrap?: boolean;
  /** 控件：普通开关与短选项走固定列宽，长表单用 wide */
  control?: React.ReactNode;
  /** 控件按内容占宽（路径输入 / 认证配置 / 授权范围表单的例外） */
  wide?: boolean;
  /** 供设置搜索定位（data-settings-row）与深链锚点使用 */
  id?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const hasControl = value !== undefined || control !== undefined;
  return (
    <div className={`pset-row${className ? ` ${className}` : ''}`} id={id} data-settings-row={id}>
      <div className="pset-row-label">
        <div className="pset-row-name">{label}</div>
        {hint ? <div className="pset-row-hint">{hint}</div> : null}
        {children}
      </div>
      {hasControl ? (
        <div className={`pset-row-control${wide ? ' wide' : ''}`}>
          {value !== undefined ? (
            <span className={`pset-value${valueWrap ? ' pset-value-wrap' : ''}`}>{value}</span>
          ) : null}
          {control}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 开关行：名称 + 说明在左，开关在右。
 *
 * `simulated` 用于"只改内存模拟值"的开关（原型边界，§2.4/§17.8 第 7 条）；
 * `disabledReason` 用于原型没有真实能力、只能禁用的项 —— 禁用必须**说明原因**，
 * 不能只是变灰。
 */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  simulated,
  simulatedTitle,
  disabledReason,
  value,
  tag,
  id,
  children,
}: {
  label: string;
  hint: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  simulated?: boolean;
  simulatedTitle?: string;
  disabledReason?: string;
  value?: React.ReactNode;
  /** 额外的行内标记（如「已停用」） */
  tag?: React.ReactNode;
  id?: string;
  children?: React.ReactNode;
}) {
  return (
    <SettingsRow
      label={
        <span className="row tight">
          {label}
          {simulated ? <SimulatedTag title={simulatedTitle} /> : null}
          {tag}
        </span>
      }
      hint={hint}
      value={value}
      id={id}
      control={
        disabledReason ? (
          <span className="pset-disabled" title={userFacingSystemText(disabledReason ?? '')}>
            <Switch checked={checked} onChange={() => {}} disabled label={<span className="visually-hidden">{label}</span>} />
          </span>
        ) : (
          <Switch checked={checked} onChange={onChange} label={<span className="visually-hidden">{label}</span>} />
        )
      }
    >
      {disabledReason ? (
        <div className="pset-row-hint pset-row-blocked">
          <Icon name="lock" size={11} /> {userFacingSystemText(disabledReason ?? '')}
        </div>
      ) : null}
      {children}
    </SettingsRow>
  );
}

/**
 * 只读值行：回答"现在是什么"，不提供改法（§2.4 的降级选项②）。
 * 与按钮的区别必须一眼能看出 —— 它是文本，不是控件。
 */
export function ReadOnlyRow({
  label,
  hint,
  value,
  id,
}: {
  label: string;
  hint?: React.ReactNode;
  value: React.ReactNode;
  id?: string;
}) {
  return <SettingsRow label={label} hint={hint} value={value} id={id} />;
}

/** 短选项行（下拉：日志保留、通知渠道这类"短选项"） */
export function SelectRow({
  label,
  hint,
  value,
  onChange,
  options,
  id,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  id?: string;
  children?: React.ReactNode;
}) {
  return (
    <SettingsRow
      label={label}
      hint={hint}
      id={id}
      control={
        <select className="select sm" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      }
    >
      {children}
    </SettingsRow>
  );
}

/**
 * 数字输入行：**保留编辑态**。
 *
 * 为什么不能直接受控于 store：原实现把 value 绑到 store 并在 onChange 里
 * `Math.max(1, Math.min(240, Number(v) || 20))` —— 用户一清空就立刻变回 20，
 * 于是没法把「20」改成「45」（得先选中再输，或慢慢删）。实测确认过。
 *
 * 现在：本地草稿字符串 → 失焦或 Enter 时才校验提交；Escape 恢复已保存值；
 * 无效值不写入并显示行内提示。
 */
export function NumberField({
  label,
  hint,
  value,
  min,
  max,
  unit,
  onCommit,
  integer,
  simulated,
  id,
  children,
}: {
  label: string;
  hint: React.ReactNode;
  value: number;
  min: number;
  max: number;
  unit: string;
  onCommit: (v: number) => void;
  /**
   * 必须是整数（数量、分钟、并发数这类）。**按字段选择**，默认不要求 ——
   * 允许小数的字段（如果以后有）不要传它，避免被顺手改成整数校验（评审意见）。
   */
  integer?: boolean;
  simulated?: boolean;
  id?: string;
  children?: React.ReactNode;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  // store 里的值被别处改动（如切项目）时同步过来，但不要在编辑中被覆盖
  useEffect(() => {
    setDraft(String(value));
    setError(null);
  }, [value]);

  const commit = () => {
    const raw = draft.trim();
    const 范围 = `${min}–${max} 之间的${integer ? '整数' : '数字'}`;
    if (raw === '') {
      setError(`请填 ${范围}`);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      setError(`只能是 ${范围}`);
      return;
    }
    // 整数校验不可省：1.5 个并发、-2 次预算这类值能被 9 接受，但业务上不成立（评审复现）
    if (integer && !Number.isInteger(n)) {
      setError(`只能是 ${范围}（不接受小数）`);
      return;
    }
    setError(null);
    if (n !== value) onCommit(n);
  };

  return (
    <SettingsRow
      label={
        <span className="row tight">
          {label}
          {simulated ? <SimulatedTag /> : null}
        </span>
      }
      hint={hint}
      id={id}
      control={
        <>
          <input
            className="input pset-number"
            type="number"
            min={min}
            max={max}
            step={integer ? 1 : 'any'}
            value={draft}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              // 只改草稿，不钳制、不提交 —— 让用户能把数字敲完
              setDraft(e.target.value);
              if (error) setError(null);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(String(value));
                setError(null);
              }
            }}
          />
          <span className="pset-unit">{unit}</span>
        </>
      }
    >
      {children}
      {error ? <div className="pset-row-error">{userFacingSystemText(error ?? '')}</div> : null}
    </SettingsRow>
  );
}

/* ---------------- 折叠区 ---------------- */

/**
 * 正文里的「了解更多 / 技术详情」折叠（`<details>`，原生可达、可键盘操作）。
 * 开发材料（C0—C4、目录树、内部编号说明）一律收进这里，正文只留用户要判断的东西（§2.5）。
 */
export function DetailFold({
  summary,
  children,
  id,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <details className="settings-why" id={id}>
      <summary>{summary}</summary>
      <div className="settings-why-body">{children}</div>
    </details>
  );
}

/**
 * 卡片级折叠组（带 aria-expanded 的按钮头，样式与「错误码速查」一致）。
 * 「原型工具」用它（§2.6）：默认折叠但要一眼能找到 —— 不是隐藏 URL 参数、也不是虚构的"开发入口"。
 */
export function CollapseGroup({
  title,
  note,
  collapsedNote,
  children,
  id,
  defaultOpen = false,
}: {
  title: string;
  /** 展开后的说明 */
  note?: React.ReactNode;
  /** 折叠时显示在标题右侧的一句（让标题本身能回答"这里面是什么"） */
  collapsedNote?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card" style={{ padding: 0 }} data-collapse-group={id}>
      <button
        className="settings-collapse-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        id={id}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        {title}
        <span className="small faint">{open ? note : (collapsedNote ?? note)}</span>
      </button>
      {open ? <div className="settings-collapse-body">{children}</div> : null}
    </div>
  );
}
