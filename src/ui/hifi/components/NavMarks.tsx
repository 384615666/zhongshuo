/**
 * 侧栏状态标记（2026-09-25 用户要求，取代"空心圈 / 实心点并排"的写法）。
 *
 * 分工很明确，三条都对应用户给的口径：
 *  · **任务状态**（执行中/等待/受阻/待验收）→ 名称**前面**的图标位（`NavTaskMark`）；
 *  · **未读**（项目/房间/私信）→ 行尾一枚小蓝点（`NavUnreadDot`）；
 *  · **事项数量**（文件与 Git / 待我处理）→ 行尾数字徽标（`NavCountBadge`）。
 *
 * 运行与静态状态共用同一个 13px 见方的槽位，所以状态切换、出现或消失都不会
 * 让名称左右跳动；行尾那三种提示也都在同一个宽度的 `.side-marks` 区域里，
 * 出现与消失同样不改变文字宽度。
 *
 * 颜色只用现有主题语义变量，不新增主题色：
 *  · 执行中 = 强调色（旋转）；等待/受阻/待验收 = 低饱和琥珀（静态，靠图标区分）；
 *  · 未读 = 信息色小点；徽标 = 中性（数量）/ 琥珀（待你处理）。
 * **没有用 `--danger`**：当前数据模型里 TaskStatus 没有失败态、种子也没有
 * FAILED/INTERRUPTED 运行，把 BLOCKED 一律画成红色等于把"受阻"说成"严重故障"。
 */

import { Icon } from './Icon';
import type { IconName } from './Icon';
import type { NavTaskState, NavTaskStateSummary } from '../data/selectors';

/**
 * 侧栏自己的状态措辞。
 *
 * 与看板的 `taskStatusCopy`（阻塞 / 待审阅）刻意不同：那里是任务状态机的正式
 * 叫法，这里是"这个房间现在怎么了"的一句话，用"受阻/待验收"更贴近用户视角；
 * 两者语义一一对应，不存在第二种状态。
 */
const STATE_COPY: Record<NavTaskState, { label: string; icon: IconName; hint: string }> = {
  BLOCKED: { label: '受阻', icon: 'octagon', hint: '缺少必要条件，需要你处理' },
  WAITING_USER: { label: '等你处理', icon: 'hand', hint: '在等你输入或确认' },
  REVIEW: { label: '待验收', icon: 'clipboard-check', hint: '交付等你验收' },
  ACTIVE: { label: '执行中', icon: 'spinner-rays', hint: '任务正在执行' },
};

/**
 * 悬浮说明：把**实际存在的每一类**数量都写出来。
 *
 * 为什么要列全：一个房间同时有执行中的任务和待验收的交付时，标记位置只放得下
 * 优先级最高的那一个 —— 只写它就会让人以为"没有别的在跑"。数量进 tooltip
 * 以后，优先级的取舍不再以隐藏信息为代价。
 */
function titleOf(summary: NavTaskStateSummary): string {
  const text = summary.counts.map((c) => `${STATE_COPY[c.state].label} ${c.count} 个`).join(' · ');
  if (summary.counts.length === 1 && summary.state) return `${text}（${STATE_COPY[summary.state].hint}）`;
  return text;
}

/** 名称前的任务状态位；没有未结束任务时返回 `null`（由调用方决定放归档图标还是空位） */
export function NavTaskMark({ summary, where }: { summary: NavTaskStateSummary; where: string }) {
  if (!summary.state) return null;
  const copy = STATE_COPY[summary.state];
  const spinning = summary.state === 'ACTIVE';
  const title = titleOf(summary);
  return (
    <span
      className={`side-state${spinning ? ' running' : ' alert'}`}
      title={title}
      aria-label={`${where}：${title}`}
    >
      <Icon name={copy.icon} size={13} />
    </span>
  );
}

/**
 * 行尾：未读小蓝点（有未读才出现，条数进 tooltip 与无障碍标签）。
 * `hint` 用于汇总行（折叠后的项目行）说明这枚点里各来源各有多少条。
 */
export function NavUnreadDot({ count, where, hint }: { count: number; where: string; hint?: string }) {
  if (count <= 0) return null;
  const text = hint ? `${hint}（共 ${count} 条未读）` : `${count} 条未读`;
  return <span className="side-unread-dot" title={text} aria-label={`${where}：${text}`} />;
}

/**
 * 行尾：数字徽标（只放数字，不再重复左侧已有的图标或感叹号）。
 *
 * 两位以上仍是一枚徽标，宽了就按同一套内边距撑开；超过上限写 `99+`，
 * **真实数量留在 tooltip** —— 既不撑坏导航，也不丢信息。
 */
export function NavCountBadge({
  count,
  tone,
  hint,
  where,
}: {
  count: number;
  tone: 'neutral' | 'warn';
  /** 这个数在数什么（进 tooltip，例如"未提交改动"） */
  hint: string;
  where: string;
}) {
  if (count <= 0) return null;
  const title = `${hint} ${count} 个`;
  return (
    <span className={`side-badge ${tone}`} title={title} aria-label={`${where}：${title}`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}
