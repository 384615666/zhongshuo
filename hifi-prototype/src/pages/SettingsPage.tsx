/**
 * 应用设置（第十六批 §17.8 收窄为纯应用级；第二十八批按 §3.1 重排为七类）
 *
 * 为什么这样分：项目设置与应用设置混在一页时，只能反复用分组标题和副标题去解释
 * "这项影响项目、那项影响应用"；拆开后用户的心智模型是直接的：
 * **想改某个项目，去那个项目旁边（⋯ → 项目设置）；想改整个软件，点底部设置。**
 *
 * 七个一级分类（§3.1）：通用 / 外观 / 通知 / AI 工具 / 连接与设备 / 数据与存储 / 帮助与关于。
 * 三条施工铁律（写在代码旁边，避免以后被"补整齐"补回去）：
 *  1. §3.1 的【暂缺】项**不显示**：不做占位控件、空表单或"敬请期待"空页 ——
 *     要做先补规格（用户操作 / 保存结果 / 生效时机 / 失败处理）；
 *  2. 归档管理不再独占一级分类，归入「数据与存储」，但仍与 `/archive`、
 *     项目 ⋯ 共用同一个 `ArchiveManager` 与同一份状态；
 *  3. 设备配对与 MCP 连接共用一个入口，但**权限说明与数据都分开**（两套权限模型）。
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore } from '../data/store';
import { navigate } from '../lib/router';
import { RuntimePanel } from './pages-misc';
import { SectionAppearance, SectionGeneral } from './SettingsGeneral';
import { SectionNotifications } from './SettingsNotify';
import { SectionConnections } from './SettingsMcp';
import { SectionData } from './SettingsData';
import { SectionHelp } from './SettingsHelp';

/* ============================================================
   分区定义
   ============================================================ */

export type AppSettingsSection =
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'runtime'
  | 'connections'
  | 'data'
  | 'help';

/**
 * 旧写法 → 现分区（§3.4 深链兼容：**一个都不许漏**）。
 *
 * 逐条说明为什么这么映射：
 *  - `app` → general：旧「应用」分区的名字，现在叫「通用」；
 *  - `runtime` 保留为**主键**：它同时是标签「AI 工具」的分区键，
 *    这样 `/runtimes` → `?section=runtime` 的路由规范化不用改一行；
 *  - `lan` → connections：设备与局域网并入「连接与设备」；
 *  - `archive` / `archived` → data：归档管理归入「数据与存储」，不再独占一级分类；
 *  - `diagnostics` / `errors` → help：诊断与帮助改名「帮助与关于」；
 *    `errors` 还要额外展开速查 —— 判定看 `anchor=errors`（见下面的既有踩坑注释）。
 */
const SECTION_ALIASES: Record<string, AppSettingsSection> = {
  // 现主键
  general: 'general',
  appearance: 'appearance',
  notifications: 'notifications',
  runtime: 'runtime',
  connections: 'connections',
  data: 'data',
  help: 'help',
  // 旧写法兼容（逐个点名）
  app: 'general',
  lan: 'connections',
  archive: 'data',
  archived: 'data',
  diagnostics: 'help',
  errors: 'help',
};

export function appSectionOf(raw: string | undefined): AppSettingsSection {
  return (raw && SECTION_ALIASES[raw]) || 'general';
}

type NavItem = { key: AppSettingsSection; label: string; icon: string; hint: string };

const NAV: NavItem[] = [
  { key: 'general', label: '通用', icon: 'settings', hint: '启动与托盘、应用级运行并发、本机账号与会话' },
  { key: 'appearance', label: '外观', icon: 'sun', hint: '主题：浅色 / 深色' },
  { key: 'notifications', label: '通知', icon: 'bell', hint: '哪些事件提醒你、渠道与免打扰；与房间静音/线程关注是同一套订阅' },
  { key: 'runtime', label: 'AI 工具', icon: 'cpu', hint: '工具安装与检测、认证与登录、连接配置（应用级）' },
  { key: 'connections', label: '连接与设备', icon: 'monitor', hint: '访问众说的设备（配对）与外部 AI 连接（MCP），两套权限分开' },
  { key: 'data', label: '数据与存储', icon: 'layers', hint: '数据位置与占用、备份与恢复、归档管理、已移除的项目' },
  { key: 'help', label: '帮助与关于', icon: 'help-circle', hint: '故障诊断与日志、错误码速查、版本与更新、原型工具' },
];

/**
 * 设置搜索（§3.4 的追加项）：输入「登录」「备份」「通知」能定位到对应项。
 *
 * 只索引**真实存在**的项 —— 【暂缺】项（发送快捷键、消息密度、界面缩放）不在这里，
 * 搜不到就是搜不到，不用"即将支持"占位。
 */
type SearchEntry = { section: AppSettingsSection; label: string; keywords: string; match: string };

const SEARCH_INDEX: SearchEntry[] = [
  { section: 'general', label: '开机自动启动', keywords: '启动 开机 自启 登录系统', match: '开机自动启动' },
  { section: 'general', label: '关闭窗口时继续在托盘运行', keywords: '托盘 关闭窗口 最小化', match: '关闭窗口时继续在托盘运行' },
  { section: 'general', label: '重启后自动继续未完成的任务', keywords: '重启 续跑 恢复 启动恢复', match: '重启后自动继续未完成的任务' },
  { section: 'general', label: '运行并发（全应用 / 单成员 / provider）', keywords: '并发 同时运行 turn 上限 排队 限流 资源', match: '运行并发' },
  { section: 'general', label: '本机账号与会话', keywords: '账号 管理员 登录 退出 会话', match: '本机账号与会话' },
  { section: 'appearance', label: '主题（深色外观）', keywords: '外观 主题 深色 浅色 暗色 夜间', match: '深色外观' },
  { section: 'notifications', label: '全部静音', keywords: '通知 静音 免打扰 全静音', match: '全部静音' },
  { section: 'notifications', label: '免打扰时段', keywords: '免打扰 时段 夜间 勿扰', match: '免打扰时段' },
  { section: 'notifications', label: '通知渠道', keywords: '通知 渠道 桌面 托盘 提示', match: '通知渠道' },
  { section: 'notifications', label: '提示音', keywords: '声音 提示音 通知', match: '提示音' },
  { section: 'notifications', label: '哪些事提醒我（审批 / 失败 / 完成 / 提及）', keywords: '通知 事件 审批 失败 完成 提及 at', match: '哪些事提醒我' },
  { section: 'notifications', label: '已静音的线程 / 已关注的线程', keywords: '静音 关注 房间 线程 订阅', match: '已静音的线程' },
  { section: 'runtime', label: '工具安装与检测（重新检测）', keywords: '登录 认证 安装 runtime cli codex claude 检测 版本', match: '重新检测' },
  { section: 'runtime', label: '认证与登录方式', keywords: '登录 认证 凭据 订阅 api key token', match: '认证状态' },
  { section: 'runtime', label: '连接测试', keywords: '连接 测试 故障 失败 排查', match: '连接测试' },
  { section: 'runtime', label: '版本、协议能力与验证记录（技术详情）', keywords: '版本 协议 能力 验证 c0 c4 技术详情', match: '技术详情' },
  { section: 'connections', label: '生成配对码 / 已连接设备', keywords: '设备 配对 局域网 手机 浏览器 命令', match: '生成配对码' },
  { section: 'connections', label: '外部 AI 连接（MCP）', keywords: 'mcp 外部 ai 客户端 授权 范围 令牌 连接', match: '外部 AI 连接' },
  { section: 'connections', label: '创建连接（范围授权）', keywords: '创建连接 令牌 范围 预算 成员', match: '创建连接' },
  { section: 'data', label: '数据位置（应用数据目录）', keywords: '数据 目录 位置 路径 打开 复制 appdata', match: '应用数据目录' },
  { section: 'data', label: '占用空间', keywords: '占用 空间 大小 磁盘 清理', match: '占用空间' },
  { section: 'data', label: '备份与恢复', keywords: '备份 恢复 sqlite wal 一致性', match: '备份与恢复' },
  { section: 'data', label: '清理应用成果', keywords: '清理 删除 草稿 快照 日志 成果', match: '清理应用成果' },
  { section: 'data', label: '归档管理', keywords: '归档 恢复 只读 项目 房间', match: '归档管理' },
  { section: 'data', label: '已移除的项目', keywords: '移除 重新关联 项目', match: '已移除的项目' },
  { section: 'help', label: '导出诊断包', keywords: '诊断 导出 日志 脱敏 排查', match: '导出诊断包' },
  { section: 'help', label: '日志保留', keywords: '日志 保留 清理 14 天 7 30', match: '日志保留' },
  { section: 'help', label: '最近的运行记录', keywords: '运行记录 日志 诊断 级别 追溯', match: '最近的运行记录' },
  { section: 'help', label: '错误码速查', keywords: '错误码 报错 恢复 err 速查', match: '错误码速查' },
  { section: 'help', label: '版本与更新', keywords: '版本 更新 升级 关于 版本说明', match: '版本与更新' },
  { section: 'help', label: '使用帮助（哪项设置在哪里改）', keywords: '帮助 归属 在哪 项目设置 成员 房间', match: '使用帮助' },
  { section: 'help', label: '反馈', keywords: '反馈 建议 报告问题 提交', match: '反馈' },
  { section: 'help', label: '原型工具（重置原型数据 / 清除导航偏好）', keywords: '重置 原型 种子 导航 偏好 演示 复现', match: '原型工具' },
];

function SectionHead({ title, sub }: { title: string; sub: React.ReactNode }) {
  return (
    <div className="settings-section-head">
      <div className="settings-section-title">{title}</div>
      <div className="settings-section-sub">{sub}</div>
    </div>
  );
}

/* ============================================================
   应用设置外壳
   ============================================================ */

export function SettingsPage({ query }: { query?: Record<string, string> }) {
  const s = useStore((x) => x);
  const q = query ?? {};
  const raw = q.section ?? '';
  const section = appSectionOf(raw);
  /**
   * 旧 `section=errors` 深链要**直接展开**速查表（§17.8 兼容表：保留速查定位）。
   *
   * 注意：路由层会先把 `section=errors` 规范化成
   * `section=help&anchor=errors`，所以这里不能只看 section ——
   * 必须认 **anchor=errors**，否则重定向后判定为 false，表格不展开（实测踩过）。
   */
  const errorsExpanded = raw === 'errors' || q.anchor === 'errors';

  const [search, setSearch] = useState('');
  /** 搜索结果点击后要滚到的目标（按标签文本匹配，避免给每一行都加 id） */
  const [jumpTo, setJumpTo] = useState<string | null>(null);

  const go = (next: AppSettingsSection) => {
    // 应用链接**不带 projectId**：切换项目不应改变应用配置（§17.8）
    navigate(`/settings?section=${next}`, { replace: true });
  };

  /**
   * 结果点击：先切分区，再在渲染完成后滚到那一项并短暂高亮。
   * 依赖里带 section 是必须的 —— 目标项可能不在当前分区，要等它渲染出来。
   */
  useEffect(() => {
    if (!jumpTo) return;
    const el = findByLabel(jumpTo);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('settings-jump-flash');
    const t = window.setTimeout(() => el.classList.remove('settings-jump-flash'), 1800);
    return () => window.clearTimeout(t);
  }, [jumpTo, section]);

  const results = useMemo(() => {
    const kw = search.trim().toLowerCase();
    if (!kw) return [];
    return SEARCH_INDEX.filter(
      (e) => e.label.toLowerCase().includes(kw) || e.keywords.toLowerCase().includes(kw),
    );
  }, [search]);

  return (
    <div className="main">
      <div className="page">
        {/**
         * 页头（「应用设置」大标题 + "这里只放整个软件的配置…"那一段）已按用户要求删除
         * （2026-09-26）：左边就是分类导航、当前分区还高亮着，页头那份说明属于重复叙述。
         * 归属边界（应用级 vs 项目级）改由每个分区的副标题各说一次，信息没丢。
         */}

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分区">
            {/* 设置搜索（§3.4）：七类之后，翻分类比翻长页慢，用关键词直接定位 */}
            <div className="settings-search">
              <div className="row tight">
                <Icon name="search" size={13} className="faint" />
                <input
                  className="input sm"
                  placeholder="搜设置项：登录、备份、通知…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="搜索设置项"
                />
                {search ? (
                  <button className="settings-search-clear" onClick={() => setSearch('')} aria-label="清除搜索">
                    <Icon name="x" size={12} />
                  </button>
                ) : null}
              </div>
            </div>

            {search.trim() ? (
              <div className="settings-search-results" role="list">
                {results.length === 0 ? (
                  <div className="small faint" style={{ padding: '4px 8px' }}>
                    没找到匹配的设置项。这里只索引已经做好的项 —— 没做的不会用"即将支持"占位。
                  </div>
                ) : (
                  results.map((r) => (
                    <button
                      key={`${r.section}-${r.match}`}
                      className="settings-search-hit"
                      role="listitem"
                      onClick={() => {
                        setJumpTo(r.match);
                        go(r.section);
                        setSearch('');
                      }}
                    >
                      <span className="settings-search-hit-label">{r.label}</span>
                      <span className="small faint">{NAV.find((n) => n.key === r.section)?.label}</span>
                    </button>
                  ))
                )}
              </div>
            ) : (
              <div className="settings-nav-group">
                <div className="settings-nav-label">应用</div>
                {NAV.map((it) => (
                  <button
                    key={it.key}
                    className={`settings-nav-item${section === it.key ? ' on' : ''}`}
                    onClick={() => go(it.key)}
                    title={it.hint}
                    aria-current={section === it.key ? 'page' : undefined}
                  >
                    <Icon name={it.icon} size={14} />
                    <span className="settings-nav-text">{it.label}</span>
                  </button>
                ))}
              </div>
            )}

            {/* 原「项目设置已独立：在侧栏项目行点 ⋯ 进入。提醒在「待我处理」。」脚注已删除（§2.5）：
                同类信息在页头 page-sub 说一次就够，不在界面里重复文档语气。 */}
          </nav>

          <div className="settings-body">
            {section === 'general' ? <SectionGeneral /> : null}

            {section === 'appearance' ? <SectionAppearance /> : null}

            {section === 'notifications' ? <SectionNotifications /> : null}

            {section === 'runtime' ? (
              <>
                <SectionHead
                  title="AI 工具"
                  sub="接入哪些工具、现在登录的是谁、用订阅还是 API 配置。这是应用级配置：切换项目不会换出另一套。"
                />
                <RuntimePanel embedded />
              </>
            ) : null}

            {section === 'connections' ? <SectionConnections /> : null}

            {section === 'data' ? <SectionData s={s} /> : null}

            {section === 'help' ? <SectionHelp expanded={errorsExpanded} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 按标签文本找目标元素。
 *
 * 为什么不给每个设置行加 id：行基元是共享的（项目设置也用），给应用设置的每一行
 * 挂 id 会把基元污染成"两处都要维护的清单"。这里按**渲染后的文本**匹配：
 * 先找设置行名（`.pset-row-name` 精确匹配），再退到卡片标题、折叠头、分节标题。
 */
function findByLabel(text: string): HTMLElement | null {
  const roots = Array.from(document.querySelectorAll<HTMLElement>('.settings-body *'));
  const nameHit = roots.find((el) => el.classList.contains('pset-row-name') && el.textContent?.trim() === text);
  if (nameHit) return nameHit.closest('.pset-row') ?? nameHit;
  const blockHit = roots.find(
    (el) =>
      (el.classList.contains('card-title') ||
        el.classList.contains('settings-collapse-head') ||
        el.classList.contains('section-title') ||
        el.classList.contains('settings-section-title')) &&
      (el.textContent ?? '').includes(text),
  );
  return blockHit ?? null;
}
