import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * 应用设置（单页，R170 整理后）：外观 → 通知 → AI 设置 → 数据与存储 → 帮助与关于，
 * 自上而下排在一页。`?section=` 仍然可用——它只负责滚动到对应段落（深链兼容）；
 * 旧写法 general / connections / lan 落到页面顶部（对应分区已删，不留空白页）。
 *
 * 版面约定（见 docs/implementation/r170-ui-feedback-plan.md §5）：
 *  · 页头吸顶：标题 + 搜索 + 分区锚点 chips；
 *  · 每个分区一张卡片：段标题 + 一句短说明 + 行列表；
 *  · 行统一「左标签 + 一行灰说明 / 右控件」，说明只留一行，不再重复解释；
 *  · 正文最大宽约 880px 居中，≤760px 时行内容上下排。
 *
 * 已接命令的设置读写并回读核对（app.settings / 主题 / runtime 绑定 / 数据存储 /
 * BUILD 身份）；桌面通知总开关使用 app.settings 并回读。
 * 操作手册与项目链接交给主进程用系统浏览器打开（见 bridge.openAppLink），应用内不再嵌入手册。
 * 项目设置独立于 /project/:id/settings（原归属保持——本页只放应用级）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore, toast } from '../shell';
import { SettingsRow, ReadOnlyRow } from '../components/SettingsRow';
import { recordWrite, setTheme, setAppearanceState, setNotificationsEnabled, setViewerName } from '../data/store';
import { command, dataBridge, openAppLink, type AppLinkTarget } from '../bridge';
import { navigate } from '../lib/router';
import { ArchiveManager } from './ArchivePage';
import { LocalDiagnostics } from '../components/LocalDiagnostics';
import { ExecutionConcurrencyPanel } from '../components/ExecutionConcurrencyPanel';
import { Switch } from '../components/ui';
import { AvatarPicker } from '../components/AvatarPicker';
import {
  CALL_BUDGET_ENABLED_SETTING_KEY,
  DEFAULT_CALL_BUDGET_LIMITS,
  parseCallBudgetEnabledSetting,
  serializeCallBudgetEnabledSetting,
} from '../../../contracts/callBudget';
import {
  TASK_NOTIFICATIONS_ENABLED_SETTING_KEY,
  parseTaskNotificationsEnabledSetting,
  serializeTaskNotificationsEnabledSetting,
} from '../../../contracts/taskNotifications';
import {
  VIEWER_DISPLAY_NAME_SETTING_KEY,
  VIEWER_DISPLAY_NAME_MAX_LENGTH,
  normalizeViewerDisplayName,
  viewerDisplayLabel,
} from '../../../contracts/viewerIdentity';

/**
 * 现分区 + 一个只用于深链兼容的 `general`：
 * `general` 不再对应任何分区（通用段已删），`appSectionOf` 把它解析到页面顶部。
 */
export type AppSettingsSection =
  | 'general' | 'appearance' | 'notifications' | 'runtime' | 'data' | 'help';

/** 旧写法 → 现分区（深链兼容；被删的段（通用/对话串通知/AI 成员）落到顶部或现分区）。 */
const SECTION_ALIASES: Record<string, AppSettingsSection> = {
  general: 'general', appearance: 'appearance', notifications: 'notifications',
  runtime: 'runtime', data: 'data', help: 'help',
  guide: 'help', manual: 'help', diagnostics: 'help', errors: 'help',
  connections: 'general', lan: 'general', app: 'general', archive: 'data', archived: 'data',
  ai: 'runtime',
};

export function appSectionOf(raw: string | undefined): AppSettingsSection {
  return (raw && SECTION_ALIASES[raw]) || 'general';
}

type SettingsSectionKey = AppSettingsSection;

/** 页面上真实存在的分区（顺序即正文顺序，也是 chips 顺序）。 */
const SECTIONS: Array<{ key: SettingsSectionKey; title: string }> = [
  { key: 'appearance', title: '外观' },
  { key: 'notifications', title: '通知' },
  { key: 'runtime', title: 'AI 设置' },
  { key: 'data', title: '数据与存储' },
  { key: 'help', title: '帮助与关于' },
];

/** Search only real actions shown on this page. */
type SearchEntry = { section: SettingsSectionKey; label: string; keywords: string; match: string };
const SEARCH_INDEX: SearchEntry[] = [
  { section: 'appearance', label: '主题', keywords: '外观 主题 深色 浅色 暗色', match: 'appearance-theme' },
  { section: 'appearance', label: '显示头像', keywords: '头像 显示 图片', match: 'appearance-avatars' },
  { section: 'appearance', label: '我的名字', keywords: '名字 名称 昵称 称呼 署名 显示名 本人 用户你', match: 'appearance-viewer-name' },
  { section: 'appearance', label: '设置我的头像', keywords: '我的头像 个人头像 上传 更换 恢复默认 图片', match: 'appearance-avatar-images' },
  { section: 'notifications', label: '桌面通知开关', keywords: '通知 桌面 弹窗 提醒 开关 关闭 开启', match: 'notification-desktop' },
  { section: 'runtime', label: '启用调用次数预算', keywords: '调用预算 调用次数 次数预算 启用 开启 关闭 上限 callBudget budget DIRECT AUTO DELIBERATE', match: 'call-budget' },
  { section: 'runtime', label: '同时运行的 AI', keywords: '并发 并行 同时 运行 全局 每项目 同渠道 上限 concurrency', match: 'execution-concurrency' },
  { section: 'data', label: '备份全部数据', keywords: '备份 数据 保存', match: '备份全部数据' },
  { section: 'data', label: '使用已有数据或从备份恢复', keywords: '恢复 已有数据 旧包 备份', match: '使用已有数据' },
  { section: 'data', label: '清理存储', keywords: '清理 存储 回收 空间 缓存 回执 变更前像', match: '清理存储' },
  { section: 'data', label: '归档管理', keywords: '归档 项目 房间 恢复历史', match: '归档管理' },
  { section: 'data', label: '已移除的项目', keywords: '移除 项目 重新关联', match: '已移除的项目' },
  { section: 'help', label: '操作手册', keywords: '帮助 文档 使用 教程 手册 浏览器 离线', match: 'open-manual' },
  { section: 'help', label: 'GitHub 仓库', keywords: 'github 源码 仓库 反馈 开源', match: 'open-github' },
  { section: 'help', label: '产品主页', keywords: '主页 官网 网站 介绍 首页', match: 'open-homepage' },
  { section: 'help', label: '版本与构建身份', keywords: '版本 构建 build 关于', match: '版本与构建' },
];

export function searchAppSettings(search: string): SearchEntry[] {
  const kw = search.trim().toLowerCase();
  if (!kw) return [];
  return SEARCH_INDEX.filter((entry) => entry.label.toLowerCase().includes(kw) || entry.keywords.toLowerCase().includes(kw));
}

/** 单页里的一个段落：一张卡片 = 段标题 + 一句说明 + 行列表；自带锚点供深链与搜索定位。 */
function SectionShell({ section, title, cardAttrs, children }: {
  section: SettingsSectionKey;
  title: string;
  /** 落在分区卡片上的既有 data-zs-* 选择器（验收脚本依赖） */
  cardAttrs?: Record<`data-${string}`, string>;
  children: React.ReactNode;
}) {
  return (
    <section
      className="card settings-section settings-card"
      id={`settings-section-${section}`}
      data-settings-section={section}
      aria-label={title}
      {...cardAttrs}
    >
      {/* 保留 settings-section-head 类名：旧验收脚本仍用它判断设置页已就绪。 */}
      <header className="settings-section-head">
        <h2 className="settings-section-title">{title}</h2>
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

/** 卡片内的小分组（数据/帮助这类一段里含多组行时用）。 */
function SettingsGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="settings-group">
      {title != null ? <div className="settings-group-title">{title}</div> : null}
      {children}
    </div>
  );
}

/** 滚动到分区；返回是否找到了对应锚点（general 等旧写法没有锚点，由调用方落回顶部）。 */
function scrollToSection(section: SettingsSectionKey, behavior: ScrollBehavior = 'auto'): boolean {
  const el = document.getElementById(`settings-section-${section}`);
  if (el == null) return false;
  el.scrollIntoView({ block: 'start', behavior });
  return true;
}

function scrollToPageTop(): void {
  document.querySelector<HTMLElement>('.settings-page')?.scrollTo({ top: 0, behavior: 'auto' });
}

export function SettingsPage({ query }: { query?: Record<string, string> }) {
  const q = query ?? {};
  const section = appSectionOf(q.section);
  const [search, setSearch] = useState('');
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const results = useMemo(() => searchAppSettings(search), [search]);

  // 深链（侧栏「设置」、托盘「设置」、标题栏「帮助」）只负责滚到对应段落；
  // 被删掉的分区（general / connections / lan）没有锚点，落到页面顶部而不是停在原地。
  useEffect(() => {
    if (search.trim() || jumpTo != null) return;
    const frame = window.requestAnimationFrame(() => {
      if (!scrollToSection(section)) scrollToPageTop();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [section, search, jumpTo]);

  useEffect(() => {
    if (jumpTo == null) return;
    const el = findByLabel(jumpTo);
    if (el == null) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('settings-jump-flash');
    const t = window.setTimeout(() => el.classList.remove('settings-jump-flash'), 1800);
    return () => window.clearTimeout(t);
  }, [jumpTo]);

  return (
    <div className="main">
      <div className="page settings-page">
        <div className="settings-single">
          {/* 页头吸顶：滚到任何一段都还能看到标题、搜索与分区锚点（R158/R170 精修）。 */}
          <header className="settings-head">
            <div className="settings-head-text">
              <div className="page-title">设置</div>
            </div>
            <div className="settings-search" role="search">
              <div className="row tight">
                <Icon name="search" size={13} className="faint" />
                <input
                  className="input sm"
                  placeholder="搜设置项：预算、备份、通知…"
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
              {/* 结果做成浮层：不再把下面所有段落顶下去。 */}
              {search.trim() ? (
                <div className="settings-search-results" role="list">
                  {results.length === 0 ? (
                    <div className="small faint" style={{ padding: '4px 8px' }}>
                      没找到匹配的设置项，请换个关键词。
                    </div>
                  ) : (
                    results.map((r) => (
                      <button
                        key={`${r.section}-${r.match}`}
                        className="settings-search-hit"
                        role="listitem"
                        onClick={() => { setJumpTo(r.match); setSearch(''); }}
                      >
                        <span className="settings-search-hit-label">{r.label}</span>
                        <span className="small faint">{SECTIONS.find((s) => s.key === r.section)?.title}</span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            {/* 分区锚点 chips：点击平滑滚动到对应卡片。 */}
            <nav className="settings-chips" aria-label="设置分区">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="settings-chip"
                  data-settings-chip={s.key}
                  onClick={() => { scrollToSection(s.key, 'smooth'); }}
                >
                  {s.title}
                </button>
              ))}
            </nav>
          </header>
          <div className="settings-sections">
            <SectionAppearance />
            <SectionNotifications />
            <SectionRuntime />
            <SectionData />
            <SectionHelp />
          </div>
        </div>
      </div>
    </div>
  );
}

function findByLabel(text: string): HTMLElement | null {
  const exact = Array.from(document.querySelectorAll<HTMLElement>('[data-settings-row]')).find(el=>el.dataset.settingsRow===text);
  if(exact)return exact;
  const all = document.querySelectorAll<HTMLElement>('.settings-sections .row, .settings-sections .pset-row, .settings-sections .settings-row, .settings-sections label');
  for (const el of all) {
    if ((el.textContent ?? '').includes(text)) return el;
  }
  return null;
}

/* ============================================================ 分区：外观 ============================================================ */

/**
 * R195 第 9 项：用户自己的显示名（app.settings：ui.viewer.displayName）。
 * 写入后严格回读：读回不一致就如实报「没有保存成功」，不把本地草稿冒充成已保存。
 * 空值=恢复默认「你」——键仍保留，不删任何数据。
 */
export function ViewerNameRow() {
  const viewerName = useStore((s) => s.viewerName);
  const [draft, setDraft] = useState(viewerName);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await command<{ values: Record<string, string | null> }>('app.settings.get', {
        keys: [VIEWER_DISPLAY_NAME_SETTING_KEY],
      });
      if (current !== generation.current) return;
      const name = normalizeViewerDisplayName(result.values[VIEWER_DISPLAY_NAME_SETTING_KEY]);
      setViewerName(name);
      setDraft(name);
      setReadError(null);
    } catch (error) {
      if (current !== generation.current) return;
      setReadError((error as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); return () => { generation.current += 1; }; }, [reload]);

  const save = async (): Promise<void> => {
    const normalized = normalizeViewerDisplayName(draft);
    setBusy(true);
    try {
      await command('app.settings.set', { key: VIEWER_DISPLAY_NAME_SETTING_KEY, value: normalized });
      const result = await command<{ values: Record<string, string | null> }>('app.settings.get', {
        keys: [VIEWER_DISPLAY_NAME_SETTING_KEY],
      });
      const stored = normalizeViewerDisplayName(result.values[VIEWER_DISPLAY_NAME_SETTING_KEY]);
      if (stored !== normalized) {
        setReadError('名字没有保存成功，请重试。');
        toast('名字没有保存成功，请重试', 'error');
        return;
      }
      setViewerName(stored);
      setDraft(stored);
      setReadError(null);
      recordWrite('app.settings.set', `我的名字 = ${stored.length > 0 ? stored : '默认「你」'}（已回读核对）`);
      toast(stored.length > 0 ? `名字已保存为「${stored}」` : '已恢复默认显示「你」', 'success');
    } catch (error) {
      toast(`名字保存失败：${userFacingSystemText((error as Error).message ?? '')}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const status = loading ? '读取中…' : readError != null ? '无法确认设置' : viewerName.length > 0 ? `当前显示「${viewerName}」` : '当前显示「你」';
  return (
    <div data-zs-viewer-name={viewerName.length > 0 ? 'set' : 'default'} data-zs-viewer-name-value={viewerName} data-zs-viewer-name-status={status}>
      <SettingsRow
        id="appearance-viewer-name"
        label="我的名字"
       
        wide
        control={(
          <div className="col" style={{ gap: 4, alignItems: 'flex-end' }} data-zs-viewer-name-control="1">
            <div className="row tight">
              <input
                className="input sm"
                data-zs-viewer-name-input="1"
                value={draft}
                maxLength={VIEWER_DISPLAY_NAME_MAX_LENGTH}
                placeholder={`未设置时显示「${viewerDisplayLabel('')}」`}
                disabled={loading || busy}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  void save();
                }}
              />
              <button
                type="button"
                className="btn primary sm"
                data-zs-viewer-name-save="1"
                disabled={loading || busy || normalizeViewerDisplayName(draft) === viewerName}
                onClick={() => void save()}
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        )}
      />
      {readError != null ? (
        <div className="panel warning" data-zs-viewer-name-read-error="1">
          暂时无法确认名字设置：{userFacingSystemText(readError)}
          <button className="btn sm" onClick={() => void reload()}>重试读取</button>
        </div>
      ) : null}
    </div>
  );
}

function SectionAppearance() {
  const theme = useStore((s) => s.ui.theme);
  const showAvatars = useStore((s) => s.ui.showAvatars === true);
  const myAvatar = useStore((s) => s.ui.avatars?.['user'] ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const save = useCallback(async (key: string, patch: { showAvatars?: boolean; avatar?: { subject: string; dataUrl: string | null } }): Promise<void> => {
    setBusy(key);
    try {
      await command('app.appearance.set', patch);
      const readBack = await command<{ showAvatars: boolean; avatars: Record<string, string> }>('app.appearance.get', {});
      if (patch.showAvatars !== undefined && readBack.showAvatars !== patch.showAvatars) {
        toast('外观设置尚未保存成功，请重试', 'error');
        return;
      }
      if (patch.avatar !== undefined) {
        const expected = patch.avatar.dataUrl;
        if ((readBack.avatars[patch.avatar.subject] ?? null) !== expected) {
          toast('头像尚未保存成功，请重试', 'error');
          return;
        }
      }
      setAppearanceState(readBack.showAvatars, readBack.avatars);
      recordWrite('app.appearance.set', patch.avatar === undefined
        ? `头像显示 → ${readBack.showAvatars ? '显示' : '隐藏'}（已回读）`
        : `${patch.avatar.subject === 'user' ? '我的头像' : 'AI 头像'}${patch.avatar.dataUrl == null ? '已恢复默认' : '已更新'}（已回读）`);
      toast(patch.avatar === undefined ? `已${readBack.showAvatars ? '显示' : '隐藏'}头像` : patch.avatar.dataUrl == null ? '已恢复默认头像' : '头像已保存', 'success');
    } catch (error) {
      toast(`外观保存失败：${userFacingSystemText((error as Error).message ?? '')}`, 'error');
    } finally {
      setBusy(null);
    }
  }, []);
  return (
    <SectionShell section="appearance" title="外观">
      <SettingsRow id="appearance-theme" label="主题" control={
        <div className="seg" role="group" aria-label="主题">
          <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>浅色</button>
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>深色</button>
        </div>
      } />
      <SettingsRow id="appearance-avatars" label="显示头像" control={
        <Switch
          checked={showAvatars}
          disabled={busy === 'visibility'}
          label={<span className="visually-hidden">显示头像</span>}
          onChange={(next) => void save('visibility', { showAvatars: next })}
        />
      } />
      <SettingsRow
        id="appearance-avatar-images"
        label="我的头像"
       
        wide
        control={
          <div data-zs-avatar-settings="1">
            <AvatarPicker
              value={myAvatar}
              disabled={busy != null}
              hideLabel
              hideHint
              onChange={(dataUrl) => void save('avatar:user', { avatar: { subject: 'user', dataUrl } })}
            />
          </div>
        }
      />
      <ViewerNameRow />
    </SectionShell>
  );
}

/* ============================================================ 分区：通知 ============================================================ */

/** 桌面通知总开关：写入 app.settings 并严格回读；未设置等于开启。 */
export function desktopNotificationsWrite(enabled: boolean): {
  key: typeof TASK_NOTIFICATIONS_ENABLED_SETTING_KEY;
  value: 'true' | 'false';
} {
  return { key: TASK_NOTIFICATIONS_ENABLED_SETTING_KEY, value: serializeTaskNotificationsEnabledSetting(enabled) };
}

export function desktopNotificationsReadBackMatches(raw: string | null | undefined, expected: boolean): boolean {
  return parseTaskNotificationsEnabledSetting(raw) === expected;
}

export function DesktopNotificationsRow() {
  const enabled = useStore((s) => s.notificationsEnabled);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const gen = useRef(0);

  const reload = useCallback(async () => {
    const current = ++gen.current;
    setLoading(true);
    try {
      const result = await command<{ values: Record<string, string | null> }>('app.settings.get', {
        keys: [TASK_NOTIFICATIONS_ENABLED_SETTING_KEY],
      });
      if (current !== gen.current) return;
      setNotificationsEnabled(parseTaskNotificationsEnabledSetting(result.values[TASK_NOTIFICATIONS_ENABLED_SETTING_KEY]));
      setReadError(null);
    } catch (error) {
      if (current !== gen.current) return;
      setReadError((error as Error).message);
    } finally {
      if (current === gen.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); return () => { gen.current += 1; }; }, [reload]);

  const save = async (next: boolean) => {
    const write = desktopNotificationsWrite(next);
    setBusy(true);
    try {
      await command('app.settings.set', write);
      const result = await command<{ values: Record<string, string | null> }>('app.settings.get', { keys: [write.key] });
      const raw = result.values[write.key];
      if (!desktopNotificationsReadBackMatches(raw, next)) {
        const message = '保存后的通知开关与所选状态不一致，请重新读取后再试。';
        setReadError(message);
        toast(message, 'error');
        return;
      }
      setNotificationsEnabled(next);
      setReadError(null);
      recordWrite('app.settings.set', `桌面通知 = ${next ? '开启' : '关闭'}（已回读核对）`);
      toast(next ? '桌面通知已开启，之后的任务提醒会弹出' : '桌面通知已关闭，任务与未读仍会保留', 'success');
    } catch (error) {
      toast(`通知开关保存失败：${userFacingSystemText((error as Error).message ?? '')}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const status = loading ? '读取中…' : readError != null ? '无法确认设置' : enabled ? '已开启' : '已关闭';
  return (
    <div data-zs-notification-master="1" data-zs-notification-enabled={enabled ? 'true' : 'false'} data-zs-notification-status={status}>
      <SettingsRow
        id="notification-desktop"
        label="允许弹出系统通知"
       
        control={(
          <Switch
            checked={enabled}
            disabled={loading || busy || readError != null}
            label={<span className="visually-hidden">允许弹出系统通知</span>}
            onChange={(next) => void save(next)}
          />
        )}
      />
      {readError != null ? (
        <div className="panel warning" data-zs-notification-read-error="1">
          暂时无法确认通知设置：{userFacingSystemText(readError ?? '')}
          <button className="btn sm" onClick={() => void reload()}>重试读取</button>
        </div>
      ) : null}
    </div>
  );
}

export function SectionNotifications() {
  return (
    <SectionShell section="notifications" title="通知">
      <DesktopNotificationsRow />
    </SectionShell>
  );
}

/* ============================================================ 分区：AI 设置 ============================================================ */

/**
 * 应用级预算开关：使用 app.settings 白名单键读写并严格回读。
 */
export function callBudgetSettingWrite(enabled: boolean): {
  key: typeof CALL_BUDGET_ENABLED_SETTING_KEY;
  value: ReturnType<typeof serializeCallBudgetEnabledSetting>;
} {
  return {
    key: CALL_BUDGET_ENABLED_SETTING_KEY,
    value: serializeCallBudgetEnabledSetting(enabled),
  };
}

/** 回读必须和请求值逐字相同；未设置(null)不能被 false 默认值冒充成功。 */
export function callBudgetSettingReadBackMatches(
  raw: string | null | undefined,
  expected: boolean,
): boolean {
  return raw === serializeCallBudgetEnabledSetting(expected);
}

export function CallBudgetSettingsRow() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await command<{ values: Record<string, string | null> }>('app.settings.get', {
        keys: [CALL_BUDGET_ENABLED_SETTING_KEY],
      });
      if (current !== generation.current) return;
      const raw = result.values[CALL_BUDGET_ENABLED_SETTING_KEY];
      setEnabled(parseCallBudgetEnabledSetting(raw));
      setReadError(null);
    } catch (error) {
      if (current !== generation.current) return;
      setReadError((error as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const save = async (next: boolean) => {
    const write = callBudgetSettingWrite(next);
    setBusy(true);
    try {
      await command('app.settings.set', write);
      const result = await command<{ values: Record<string, string | null> }>('app.settings.get', {
        keys: [CALL_BUDGET_ENABLED_SETTING_KEY],
      });
      const raw = result.values[CALL_BUDGET_ENABLED_SETTING_KEY];
      if (!callBudgetSettingReadBackMatches(raw, next)) {
        const message = '保存后的设置与所选状态不一致，请重新读取后再试。';
        setReadError(message);
        toast(message ?? '', 'error');
        return;
      }
      const readBack = parseCallBudgetEnabledSetting(raw);
      setEnabled(readBack);
      setReadError(null);
      recordWrite('app.settings.set', `启用调用次数预算 = ${readBack ? '开启' : '关闭'}（已回读核对）`);
      toast(readBack ? '调用次数预算已开启，对新请求生效' : '调用次数预算已关闭，对新请求生效', 'success');
    } catch (error) {
      toast(`调用次数预算保存失败：${userFacingSystemText((error as Error).message ?? '')}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const status = loading ? '读取中…' : readError != null ? '无法确认设置' : enabled ? '已开启' : '已关闭';
  return (
    <div
      data-zs-call-budget-setting={CALL_BUDGET_ENABLED_SETTING_KEY}
      data-zs-call-budget-enabled={enabled ? 'true' : 'false'}
      data-zs-call-budget-enforcement={enabled ? 'enabled' : 'disabled'}
      data-zs-call-budget-counting="always"
      data-zs-call-budget-defaults={`DIRECT:${DEFAULT_CALL_BUDGET_LIMITS.DIRECT},AUTO:${DEFAULT_CALL_BUDGET_LIMITS.AUTO},DELIBERATE:${DEFAULT_CALL_BUDGET_LIMITS.DELIBERATE}`}
      data-zs-call-budget-status={status}
    >
      <SettingsRow
        id="call-budget"
        label="启用调用次数预算"
        control={(
          <Switch
            checked={enabled}
            disabled={loading || busy || readError != null}
            label={<span className="visually-hidden">启用调用次数预算</span>}
            onChange={(next) => void save(next)}
          />
        )}
      />
      {readError != null ? (
        <div className="panel warning" data-zs-call-budget-read-error="1">
          暂时无法确认调用预算设置：{userFacingSystemText(readError ?? '')}
          <button className="btn sm" onClick={() => void reload()}>重试读取</button>
        </div>
      ) : null}
    </div>
  );
}

function SectionRuntime() {
  return (
    <SectionShell section="runtime" title="AI 设置">
      <SettingsGroup title="调用次数预算">
        <CallBudgetSettingsRow />
      </SettingsGroup>
      {/* ExecutionConcurrencyPanel 自带一张 .card：在卡片内摊平，避免卡中卡。 */}
      <SettingsGroup>
        <div className="settings-embed-flat">
          <ExecutionConcurrencyPanel />
        </div>
      </SettingsGroup>
    </SectionShell>
  );
}

/* ============================================================ 分区：数据与存储 ============================================================ */

function SectionData() {
  const [identity, setIdentity] = useState<{ localUserId: string; appDataDir: string } | null>(null);
  const [cleanupBusy,setCleanupBusy]=useState(false);
  const [cleanupResult,setCleanupResult]=useState<string|null>(null);
  const [dataOpBusy, setDataOpBusy] = useState<'backup'|'import'|null>(null);
  useEffect(() => {
    let done = false;
    void command<{ localUserId: string; appDataDir: string }>('app.identity', {}).then((r) => { if (!done) setIdentity(r); }).catch(() => { /* 不显示 */ });
    return () => { done = true; };
  }, []);
  const startDataOp = async (action: 'backup'|'import') => {
    setDataOpBusy(action);
    try {
      const result = await dataBridge().start(action);
      if (result.cancelled) { toast('已取消，没有复制或切换数据', 'info'); return; }
      toast(action === 'backup' ? '已开始备份；众说会正常关闭并在完成后自动打开' : '已开始恢复；新副本验证完成后才会切换并自动打开', 'success');
    } catch (error) {
      toast(`没有开始数据操作：${userFacingSystemText((error as Error).message ?? '')}`, 'error');
    } finally { setDataOpBusy(null); }
  };
  return (
    <SectionShell section="data" title="数据与存储" cardAttrs={{ 'data-zs-data-guide': '1' }}>
      <SettingsGroup title="数据位置与备份">
        <ReadOnlyRow label="当前数据位置" value={identity?.appDataDir ?? '读取中…'} />
        <SettingsRow id="备份全部数据" label="备份全部数据" control={
          <button className="btn primary sm" disabled={dataOpBusy != null} data-zs-data-backup="1" onClick={() => void startDataOp('backup')}>
            <Icon name="download" size={13} /> {dataOpBusy === 'backup' ? '正在准备…' : '备份全部数据'}
          </button>
        } />
        <SettingsRow id="使用已有数据" label="使用已有数据或从备份恢复" control={
          <button className="btn sm" disabled={dataOpBusy != null} data-zs-data-import="1" onClick={() => void startDataOp('import')}>
            <Icon name="folder" size={13} /> {dataOpBusy === 'import' ? '正在准备…' : '选择已有数据'}
          </button>
        } />
        <SettingsRow label="清理存储" control={<button className="btn sm" disabled={cleanupBusy} onClick={()=>{
          setCleanupBusy(true);void command<{reclaimedBytes:number;expiredReceipts:number;skippedActive:boolean}>('app.storage.cleanup',{}).then(r=>setCleanupResult(r.skippedActive?'仍有执行或待核对占用，请结束后重试':`已释放 ${(r.reclaimedBytes/1024/1024).toFixed(1)} 兆字节，清理 ${r.expiredReceipts} 条过期回执正文`)).catch(e=>toast(userFacingSystemText(e.message),'error')).finally(()=>setCleanupBusy(false));
        }}>{cleanupBusy?'清理中…':'清理存储'}</button>}/>
        {cleanupResult?<div className="small faint settings-note">{cleanupResult}</div>:null}
      </SettingsGroup>
      <SettingsGroup title="归档与项目">
        {/* 归档管理（R66 P4：R65 起命令面已具备——project.lifecycle/room.archive；此前误标
            「未接入」，现按原型嵌入同一管理器，与 /archive 独立页共用状态与动作）。 */}
        <SettingsRow id="归档管理" label="归档管理">
          <div className="settings-embed">
            <ArchiveManager embedded />
          </div>
        </SettingsRow>
        <SettingsRow id="已移除的项目" label="已移除的项目" control={
          <button className="btn sm" onClick={() => navigate('/welcome')}>去欢迎页重新关联…</button>
        } />
      </SettingsGroup>
    </SectionShell>
  );
}

/* ============================================================ 分区：帮助与关于 ============================================================ */

const APP_LINKS: Array<{ target: AppLinkTarget; row: string; label: string; action: string }> = [
  { target: 'manual', row: 'open-manual', label: '操作手册', action: '打开手册' },
  { target: 'github', row: 'open-github', label: 'GitHub 仓库', action: '打开 GitHub' },
  { target: 'homepage', row: 'open-homepage', label: '产品主页', action: '打开主页' },
];

function SectionHelp() {
  const [identity, setIdentity] = useState<{ localUserId: string; appDataDir: string } | null>(null);
  const [linkBusy, setLinkBusy] = useState<AppLinkTarget | null>(null);
  useEffect(() => {
    let done = false;
    void command<{ localUserId: string; appDataDir: string }>('app.identity', {}).then((r) => { if (!done) setIdentity(r); }).catch(() => { /* 不显示 */ });
    return () => { done = true; };
  }, []);
  const open = async (target: AppLinkTarget, label: string) => {
    setLinkBusy(target);
    try {
      const result = await openAppLink(target);
      if (!result.ok) toast(`没能打开${label}：${userFacingSystemText(result.error ?? '系统未返回原因')}`, 'error');
    } catch (error) {
      toast(`没能打开${label}：${userFacingSystemText((error as Error).message ?? '')}`, 'error');
    } finally {
      setLinkBusy(null);
    }
  };
  return (
    <SectionShell section="help" title="帮助与关于" cardAttrs={{ 'data-zs-app-links': '1' }}>
      <SettingsGroup title="手册与项目链接">
        {APP_LINKS.map((link) => (
          <SettingsRow
            key={link.target}
            id={link.row}
            label={link.label}
            control={(
              <button className="btn sm" data-zs-open-link={link.target} disabled={linkBusy != null} onClick={() => void open(link.target, link.label)}>
                <Icon name="external-link" size={13} /> {linkBusy === link.target ? '正在打开…' : link.action}
              </button>
            )}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title="版本">
        <ReadOnlyRow id="版本与构建" label="应用" value="众说 · 本地多Agent协作工作台" />
        <ReadOnlyRow label="当前文件位置" value={identity?.appDataDir ?? '读取中…'} />
      </SettingsGroup>
      <SettingsGroup title="诊断">
        {/* LocalDiagnostics 自带 .card：在卡片内摊平，避免卡中卡。 */}
        <div className="settings-embed-flat">
          <LocalDiagnostics />
        </div>
      </SettingsGroup>
    </SectionShell>
  );
}
