import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * 应用设置（单页）：启动、外观、通知、AI、数据与关于，全部在同一页自上而下排开，
 * 不再有左侧分区菜单。`?section=` 仍然可用——它现在只负责滚动到对应段落（深链兼容）。
 *
 * 已接命令的设置读写并回读核对（app.settings / 主题 / runtime 绑定 / 数据与草稿存储 / BUILD
 * 身份）；通知静音使用真实 thread_subscriptions 并回读，桌面通知总开关使用 app.settings 并回读。
 * 操作手册与项目链接交给主进程用系统浏览器打开（见 bridge.openAppLink），应用内不再嵌入手册。
 * 项目设置独立于 /project/:id/settings（原归属保持——本页只放应用级）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore, toast } from '../shell';
import { SettingsRow, ReadOnlyRow, DetailFold } from '../components/SettingsRow';
import { recordWrite, retryDraftPersistence, setTheme, setAppearanceState, clearPersistedSnapshot, importLegacySnapshot, setNotificationsEnabled } from '../data/store';
import { rescanLegacyImport } from '../loader';
import { bridge, command, dataBridge, openAppLink, type AppLinkTarget, type DataOperationStatus } from '../bridge';
import { navigate } from '../lib/router';
import { ArchiveManager } from './ArchivePage';
import { LocalDiagnostics } from '../components/LocalDiagnostics';
import { ExecutionConcurrencyPanel } from '../components/ExecutionConcurrencyPanel';
import { runtimeModelDisplayName } from '../lib/format';
import {
  CALL_BUDGET_ENABLED_SETTING_KEY,
  DEFAULT_CALL_BUDGET_LIMITS,
  parseCallBudgetEnabledSetting,
  serializeCallBudgetEnabledSetting,
} from '../../../contracts/callBudget';
import {
  TASK_NOTIFICATION_COMMANDS,
  TASK_NOTIFICATIONS_ENABLED_SETTING_KEY,
  parseTaskNotificationsEnabledSetting,
  serializeTaskNotificationsEnabledSetting,
  taskNotificationPollResultSchema,
  type TaskNotificationAttemptView,
  type TaskNotificationPollResult,
} from '../../../contracts/taskNotifications';

export type AppSettingsSection =
  | 'general' | 'appearance' | 'notifications' | 'runtime' | 'data' | 'help';

/** 旧写法 → 现分区（深链兼容；手册与连接设备已并入其它段落）。 */
const SECTION_ALIASES: Record<string, AppSettingsSection> = {
  general: 'general', appearance: 'appearance', notifications: 'notifications',
  runtime: 'runtime', data: 'data', help: 'help',
  guide: 'help', manual: 'help', diagnostics: 'help', errors: 'help',
  connections: 'general', lan: 'general', app: 'general', archive: 'data', archived: 'data',
};

export function appSectionOf(raw: string | undefined): AppSettingsSection {
  return (raw && SECTION_ALIASES[raw]) || 'general';
}

type SettingsSectionKey = AppSettingsSection;

const SECTIONS: Array<{ key: SettingsSectionKey; title: string }> = [
  { key: 'general', title: '通用' },
  { key: 'appearance', title: '外观' },
  { key: 'notifications', title: '通知' },
  { key: 'runtime', title: 'AI 设置' },
  { key: 'data', title: '数据与存储' },
  { key: 'help', title: '帮助与关于' },
];

/** Search only real actions shown on this page. */
type SearchEntry = { section: SettingsSectionKey; label: string; keywords: string; match: string };
const SEARCH_INDEX: SearchEntry[] = [
  { section: 'general', label: '启动时打开的项目', keywords: '启动 打开 项目 自动 路径', match: '启动时打开的项目' },
  { section: 'appearance', label: '主题', keywords: '外观 主题 深色 浅色 暗色', match: 'appearance-theme' },
  { section: 'appearance', label: '显示头像', keywords: '头像 显示 图片', match: 'appearance-avatars' },
  { section: 'appearance', label: '设置我的头像', keywords: '我的头像 个人头像 上传 更换 恢复默认 图片', match: 'appearance-avatar-images' },
  { section: 'notifications', label: '桌面通知开关', keywords: '通知 桌面 弹窗 提醒 开关 关闭 开启', match: 'notification-desktop' },
  { section: 'notifications', label: '对话串通知静音', keywords: '通知 静音 对话串 完成 验收 输入', match: '线程通知静音' },
  { section: 'runtime', label: '启用调用次数预算', keywords: '调用预算 调用次数 次数预算 启用 开启 关闭 上限 callBudget budget DIRECT AUTO DELIBERATE', match: 'call-budget' },
  { section: 'runtime', label: '同时运行的 AI', keywords: '并发 并行 同时 运行 全局 每项目 同渠道 上限 concurrency', match: 'execution-concurrency' },
  { section: 'runtime', label: 'AI 成员的模型与权限', keywords: 'AI 成员 模型 权限 设置', match: 'AI 成员的模型' },
  { section: 'data', label: '备份全部数据', keywords: '备份 数据 保存', match: '备份全部数据' },
  { section: 'data', label: '使用已有数据或从备份恢复', keywords: '恢复 已有数据 旧包 备份', match: '使用已有数据' },
  { section: 'data', label: '草稿保存与重试', keywords: '草稿 保存 锁定 重试', match: '草稿保存' },
  { section: 'data', label: '清理本地草稿', keywords: '清理 删除 草稿 本地', match: '清理本地草稿' },
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

function SectionHead({ title, sub }: { title: string; sub: React.ReactNode }) {
  return (
    <div className="settings-section-head">
      <div className="settings-section-title">{title}</div>
      <div className="settings-section-sub">{sub}</div>
    </div>
  );
}

/** 单页里的一个段落：自带锚点，深链与搜索都用它定位。 */
function SectionShell({ section, title, sub, children }: {
  section: SettingsSectionKey;
  title: string;
  sub: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className="settings-section"
      id={`settings-section-${section}`}
      data-settings-section={section}
      aria-label={title}
    >
      <SectionHead title={title} sub={sub} />
      {children}
    </section>
  );
}

import { Switch, Tag } from '../components/ui';
import { AvatarPicker } from '../components/AvatarPicker';

function scrollToSection(section: SettingsSectionKey): void {
  const el = document.getElementById(`settings-section-${section}`);
  if (el == null) return;
  el.scrollIntoView({ block: 'start', behavior: 'auto' });
}

export function SettingsPage({ query }: { query?: Record<string, string> }) {
  const q = query ?? {};
  const section = appSectionOf(q.section);
  const [search, setSearch] = useState('');
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const results = useMemo(() => searchAppSettings(search), [search]);

  // 深链（侧栏「设置」、托盘「设置」、标题栏「帮助」）只负责滚到对应段落。
  useEffect(() => {
    if (search.trim() || jumpTo != null) return;
    const frame = window.requestAnimationFrame(() => scrollToSection(section));
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
          {/* 页头吸顶：滚到任何一段都还能看到标题与搜索（R158 精修）。 */}
          <header className="settings-head">
            <div className="settings-head-text">
              <div className="page-title">设置</div>
              <div className="page-sub">启动、外观、通知、AI、数据与关于都在这一页；改动会即时保存并回读确认。</div>
            </div>
            <div className="settings-search" role="search">
              <div className="row tight">
                <Icon name="search" size={13} className="faint" />
                <input
                  className="input sm"
                  placeholder="搜设置项：预算、启动、通知…"
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
          </header>
          <div className="settings-sections">
            <SectionGeneral />
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

/* ============================================================ 分区：通用 ============================================================ */

function SectionGeneral() {
  const [autoOpen, setAutoOpen] = useState('');
  const [autoOpenSaved, setAutoOpenSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const genRef = useRef(0);
  const reload = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const r = await command<{ values: Record<string, string | null> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath'] });
      if (gen !== genRef.current) return;
      setAutoOpen(r.values['ui.autoOpenProjectPath'] ?? '');
      setAutoOpenSaved(r.values['ui.autoOpenProjectPath'] ?? '');
      setReadError(null);
    } catch (e) { if (gen === genRef.current) setReadError((e as Error).message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const save = async () => {
    if (autoOpen.trim().length === 0) { toast('值不能为空（如需默认行为请保持原值）', 'warn'); return; }
    setBusy(true);
    try {
      await command('app.settings.set', { key: 'ui.autoOpenProjectPath', value: autoOpen.trim() });
      const back = await command<{ values: Record<string, string | null> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath'] });
      const readBack = back.values['ui.autoOpenProjectPath'] ?? '';
      if (readBack !== autoOpen.trim()) { toast(`保存后的值与输入不一致（当前为「${readBack}」），请刷新后重试`, 'error'); return; }
      recordWrite('app.settings.set', `启动项目 = ${readBack}（已回读核对）`);
      setAutoOpenSaved(readBack);
      toast('已保存，重启后生效', 'success');
    } catch (e) { toast(`保存失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <SectionShell section="general" title="通用" sub={<>整个软件的启动与界面行为。<span className="faint">想改某个项目：侧栏项目行 ⋯ → 项目设置。</span></>}>
      <div className="card">
        <div className="card-title">启动</div>
        <SettingsRow id="启动时打开的项目" label="启动时打开的项目" hint="选择后保存；下次打开众说时回到这个项目" wide control={
          <div className="row tight" style={{ minWidth: 260 }}>
            <input className="input sm" style={{ minWidth: 200 }} value={autoOpen} onChange={(e) => setAutoOpen(e.target.value)} placeholder="例如 D:\项目\我的项目" />
            <button className="btn sm" onClick={() => { void bridge().pickFolder().then((dir) => { if (dir != null) setAutoOpen(dir); }); }}>选择文件夹</button>
            <button className="btn sm" disabled={busy || readError != null || autoOpenSaved == null || autoOpen.trim() === autoOpenSaved} onClick={() => void save()}>保存</button>
          </div>
        } />
        {readError != null ? <div className="panel warning">启动项目设置读取失败：{userFacingSystemText(readError ?? '')}；保存已暂停，避免用未知旧值覆盖。<button className="btn sm" onClick={() => void reload()}>重试读取</button></div> : null}
      </div>
    </SectionShell>
  );
}

/* ============================================================ 分区：外观 ============================================================ */

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
    <SectionShell section="appearance" title="外观" sub={<>主题、头像显示与个人图片（只在本机生效）。</>}>
      <div className="card">
        <div className="card-title">显示</div>
        <SettingsRow id="appearance-theme" label="主题" hint="浅色 / 深色" control={
          <div className="seg" role="group" aria-label="主题">
            <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>浅色</button>
            <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>深色</button>
          </div>
        } />
        <SettingsRow id="appearance-avatars" label="显示头像" hint="默认显示个人和 AI 头像，姓名始终保留" control={
          <Switch
            checked={showAvatars}
            disabled={busy === 'visibility'}
            label={showAvatars ? '显示' : '隐藏'}
            onChange={(next) => void save('visibility', { showAvatars: next })}
          />
        } />
      </div>
      <div className="card" data-zs-avatar-settings="1" data-settings-row="appearance-avatar-images">
        <div className="card-title">我的头像</div>
        <AvatarPicker
          value={myAvatar}
          disabled={busy != null}
          hideLabel
          onChange={(dataUrl) => void save('avatar:user', { avatar: { subject: 'user', dataUrl } })}
        />
        <div className="small faint" style={{ marginTop: 6 }}>聊天里你自己那一侧显示这张；AI 成员的头像在「成员管理 → AI 设置」里选。</div>
      </div>
    </SectionShell>
  );
}

/* ============================================================ 分区：通知 ============================================================ */

export interface NotificationSubscriptionItem {
  threadId: string;
  followed: boolean;
  muted: boolean;
  projectId: string;
  taskId: string | null;
}

export function notificationMuteWrite(threadId: string, muted: boolean): {
  method: 'thread.subscribe';
  params: { threadId: string; mute: boolean };
} {
  return { method: 'thread.subscribe', params: { threadId, mute: muted } };
}

export function notificationMuteReadBackMatches(
  items: NotificationSubscriptionItem[],
  threadId: string,
  expected: boolean,
): boolean {
  return items.find((item) => item.threadId === threadId)?.muted === expected;
}

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
        hint="关闭后，任务完成、需要处理、等待输入或待验收时不再弹出系统通知；任务与未读照常保留。"
        control={(
          <Switch
            checked={enabled}
            disabled={loading || busy || readError != null}
            label={enabled ? '已开启' : '已关闭'}
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
  const [items, setItems] = useState<NotificationSubscriptionItem[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<TaskNotificationPollResult | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const genRef = useRef(0);

  const reload = useCallback(async (): Promise<NotificationSubscriptionItem[]> => {
    const gen = ++genRef.current;
    setLoading(true);
    try {
      const result = await command<{ items: NotificationSubscriptionItem[] }>('thread.subscriptions', {});
      if (gen !== genRef.current) return result.items;
      setItems(result.items);
      setError(null);
      const titled = await Promise.all(result.items
        .filter((item) => item.taskId != null)
        .map(async (item) => {
          try {
            const detail = await command<{ task?: { title?: string } }>('task.get', { taskId: item.taskId });
            return [item.taskId!, detail.task?.title?.trim() || ''] as const;
          } catch {
            return [item.taskId!, ''] as const;
          }
        }));
      if (gen === genRef.current) {
        setTitles(Object.fromEntries(titled.filter(([, title]) => title.length > 0)));
      }
      try {
        const notificationRead = await command<unknown>(TASK_NOTIFICATION_COMMANDS.poll, { limit: 1 });
        if (gen === genRef.current) {
          setDelivery(taskNotificationPollResultSchema.parse(notificationRead));
          setDeliveryError(null);
        }
      } catch (notificationError) {
        if (gen === genRef.current) {
          setDelivery(null);
          setDeliveryError((notificationError as Error).message);
        }
      }
      return result.items;
    } catch (loadError) {
      if (gen === genRef.current) setError((loadError as Error).message);
      return [];
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => { genRef.current += 1; };
  }, [reload]);

  const setMuted = async (item: NotificationSubscriptionItem, muted: boolean): Promise<void> => {
    if (busy != null) return;
    setBusy(item.threadId);
    try {
      const write = notificationMuteWrite(item.threadId, muted);
      await command(write.method, write.params);
      const readBack = await command<{ items: NotificationSubscriptionItem[] }>('thread.subscriptions', {});
      if (!notificationMuteReadBackMatches(readBack.items, item.threadId, muted)) {
        toast('通知设置尚未保存成功，请重试', 'error');
        return;
      }
      setItems(readBack.items);
      recordWrite(write.method, `${titles[item.taskId ?? ''] ?? item.threadId.slice(0, 12)} → ${muted ? '静音' : '通知'}（已回读）`);
      toast(muted ? '该对话串已静音；任务仍会保留，系统通知不再弹出' : '该对话串已恢复系统通知', 'success');
    } catch (writeError) {
      toast(`对话串通知设置保存失败：${userFacingSystemText((writeError as Error).message ?? '')}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionShell section="notifications" title="通知" sub={<>桌面通知的总开关，以及按对话串的静音设置。</>}>
      <div className="card">
        <div className="card-title">桌面通知</div>
        <DesktopNotificationsRow />
      </div>
      <div className="card" data-zs-notification-settings="1">
        <div className="card-title">对话串通知</div>
        {loading ? <div className="small faint" style={{ padding: '10px 14px' }}>正在读取对话串通知…</div> : null}
        {error != null ? (
          <div className="panel warning" style={{ margin: 12 }}>
            对话串通知读取失败：{userFacingSystemText(error ?? '')}
            <button className="btn sm" onClick={() => void reload()}>重试读取</button>
          </div>
        ) : null}
        {!loading && error == null && items.length === 0 ? (
          <div className="small faint" style={{ padding: '2px 14px 12px' }}>
            暂无单独设置的对话串。
          </div>
        ) : null}
        {items.map((item) => (
          <SettingsRow
            key={item.threadId}
            label={titles[item.taskId ?? ''] ?? `对话串 ${item.threadId.slice(0, 12)}`}
            hint={`${item.followed ? '已关注' : '未关注'} · 项目 ${item.projectId.slice(0, 12)}`}
            control={(
              <Switch
                checked={item.muted}
                disabled={busy != null}
                label={item.muted ? '已静音' : '通知'}
                onChange={(next) => void setMuted(item, next)}
              />
            )}
          />
        ))}
      </div>
      {/* 投递记录是排障信息：收进折叠区，不再占正文一屏。 */}
      <div className="card" data-zs-notification-delivery="1">
        <DetailFold summary={<>投递记录（本机排查用）</>}>
          {deliveryError != null ? (
            <div className="panel warning">投递记录读取失败：{userFacingSystemText(deliveryError ?? '')}</div>
          ) : delivery == null ? (
            <div className="small faint">正在读取桌面投递记录…</div>
          ) : (
            <>
              <div className="row tight" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
                <Tag tone="neutral">已尝试 {delivery.health.attempted}</Tag>
                <Tag tone="neutral">已请求显示 {delivery.health.showRequested}</Tag>
                <Tag tone="neutral">已显示 {delivery.health.shown}</Tag>
                <Tag tone={delivery.health.unknown > 0 ? 'warning' : 'neutral'}>未确认 {delivery.health.unknown}</Tag>
                <Tag tone={delivery.health.failed > 0 ? 'danger' : 'neutral'}>失败 {delivery.health.failed}</Tag>
                <Tag tone="neutral">已点击 {delivery.health.clicked}</Tag>
              </div>
              {delivery.recentAttempts.length === 0 ? (
                <div className="small faint">尚无桌面投递尝试。</div>
              ) : (
                delivery.recentAttempts.map((attempt: TaskNotificationAttemptView) => (
                  <SettingsRow
                    key={attempt.notificationId}
                    label={attempt.title}
                    hint={attemptStateLabel(attempt)}
                    value={<span className="small faint">{new Date(attempt.claimRequestedAt).toLocaleString()}</span>}
                  />
                ))
              )}
            </>
          )}
        </DetailFold>
      </div>
    </SectionShell>
  );
}

function attemptStateLabel(attempt: TaskNotificationAttemptView): string {
  const parts: string[] = [{
    pending: '未请求',
    claimed: '已领取',
    show_requested: '已请求显示',
    shown: '已显示',
    failed: '显示失败',
    unknown: '已请求但结果未确认',
    suppressed: '已静音抑制',
  }[attempt.state]];
  if (attempt.failureReason != null) parts.push(attempt.failureReason);
  if (attempt.clickedAt != null) parts.push('已点击');
  return parts.join(' · ');
}

/* ============================================================ 分区：AI 工具 ============================================================ */

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
      data-zs-call-budget-status={status}
    >
      <SettingsRow
        id="call-budget"
        label="启用调用次数预算"
        hint="默认关闭。开启后，AI 调用达到上限时暂停；关闭时只计数。更改对新请求生效。"
        control={(
          <Switch
            checked={enabled}
            disabled={loading || busy || readError != null}
            label={enabled ? '开启' : '关闭'}
            onChange={(next) => void save(next)}
          />
        )}
      >
        <div
          className="small faint"
          data-zs-call-budget-defaults={`DIRECT:${DEFAULT_CALL_BUDGET_LIMITS.DIRECT},AUTO:${DEFAULT_CALL_BUDGET_LIMITS.AUTO},DELIBERATE:${DEFAULT_CALL_BUDGET_LIMITS.DELIBERATE}`}
        >
          默认上限：单人执行 {DEFAULT_CALL_BUDGET_LIMITS.DIRECT} 次 · 自动协作 {DEFAULT_CALL_BUDGET_LIMITS.AUTO} 次 · 双人独立研讨 {DEFAULT_CALL_BUDGET_LIMITS.DELIBERATE} 次（随人数调整）
        </div>
      </SettingsRow>
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
  const membersAll = useStore((s) => s.members);
  const members = useMemo(() => membersAll.filter((m) => m.principalType === 'agent'), [membersAll]);
  const runtimes = useStore((s) => s.memberRuntimes);
  const projectId = useStore((s) => s.activeProjectId);
  return (
    <SectionShell section="runtime" title="AI 设置" sub={<>管理同时运行的 AI、调用预算，以及成员使用的程序、模型和权限。</>}>
      <div className="card">
        <div className="card-title">调用次数预算</div>
        <CallBudgetSettingsRow />
      </div>
      <ExecutionConcurrencyPanel />
      <div className="card">
        <div className="card-title">AI 成员</div>
        {members.map((m) => {
          const rt = runtimes[m.id];
          return (
            <SettingsRow
              key={m.id}
              label={m.displayName}
              hint={rt == null ? '读取中…' : rt.status === 'bound' ? `${rt.kind === 'codex' ? 'Codex' : rt.kind === 'claude' ? 'Claude' : '已配置'}${rt.model != null && rt.model !== '' ? <span title={`完整模型 ID：${rt.model}`}> · {runtimeModelDisplayName({id:rt.model,label:rt.model})}</span> : ''}` : rt.status === 'unbound' ? '还没有选择模型' : '配置读取失败'}
              control={(
                <button className="btn sm" onClick={() => navigate(projectId !== '' ? `/project/${projectId}/members` : '/members')}>
                  {rt?.status === 'bound' ? '查看/修改' : '配置 AI'}
                </button>
              )}
            />
          );
        })}
        {members.length === 0 ? <div className="small faint" style={{ padding: '2px 0 10px' }}>还没有 AI 成员。打开项目后，在成员页添加 AI。</div> : null}
      </div>
    </SectionShell>
  );
}

/* ============================================================ 分区：数据与存储 ============================================================ */

function SectionData() {
  const draftPersist = useStore((st) => st.draftPersist);
  const [identity, setIdentity] = useState<{ localUserId: string; appDataDir: string } | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<string | null>(null);
  const [dataOp, setDataOp] = useState<DataOperationStatus | null>(null);
  const [dataOpError, setDataOpError] = useState<string | null>(null);
  const [dataOpBusy, setDataOpBusy] = useState<'backup'|'import'|null>(null);
  const reloadDataOp = useCallback(async () => {
    try { setDataOp(await dataBridge().status()); setDataOpError(null); }
    catch (error) { setDataOpError((error as Error).message); }
  }, []);
  useEffect(() => {
    let done = false;
    void command<{ localUserId: string; appDataDir: string }>('app.identity', {}).then((r) => { if (!done) setIdentity(r); }).catch(() => { /* 不显示 */ });
    void reloadDataOp();
    return () => { done = true; };
  }, [reloadDataOp]);
  const startDataOp = async (action: 'backup'|'import') => {
    setDataOpBusy(action); setDataOpError(null);
    try {
      const result = await dataBridge().start(action);
      if (result.cancelled) { toast('已取消，没有复制或切换数据', 'info'); return; }
      setDataOp((current) => current == null ? current : {...current, active: result.jobId == null ? current.active : {id:result.jobId,running:true,at:Date.now()}});
      toast(action === 'backup' ? '已开始备份；众说会正常关闭并在完成后自动打开' : '已开始恢复；新副本验证完成后才会切换并自动打开', 'success');
    } catch (error) {
      const message=(error as Error).message;setDataOpError(message);toast(`没有开始数据操作：${message}`, 'error');
    } finally { setDataOpBusy(null); }
  };
  const clearDrafts = () => {
    const r = clearPersistedSnapshot();
    if (!r.ok) { toast(userFacingSystemText(r.error ?? '清理失败'), 'error'); return; }
    if (!r.hadKey) { setCleared('没有已保存的草稿'); toast('没有已保存的草稿', 'info'); return; }
    recordWrite('drafts.clear', `清空本地草稿（未确认发送一并清除；当前页面内容保留到关闭）`);
    setCleared(`${new Date().toLocaleTimeString()} 已清除本地草稿（之后输入会重新保存）`);
    toast('本地草稿已清除', 'success');
  };
  const legacy = draftPersist.legacyImport;
  const doImport = async (key: string, dir: string) => {
    setImportBusy(key);
    try {
      const r = importLegacySnapshot(key, dir);
      if (!r.ok) { toast(userFacingSystemText(r.error ?? '导入失败'), 'error'); return; }
      const o = r.outcome;
      const refusedCount = o?.refusedVersions.length ?? 0;
      toast(`已从 ${dir} 导入旧草稿 ${o?.mergedDrafts ?? 0} 条、待确认发送 ${o?.mergedSends ?? 0} 条${refusedCount > 0 ? `、跳过不支持的 ${refusedCount} 个来源（原文件保留）` : ''}——原文件不动`, 'success');
      recordWrite('draft.inherit', `用户确认导入旧目录 ${dir}（原文件保留）`);
    } finally { setImportBusy(null); }
  };
  return (
    <SectionShell section="data" title="数据与存储" sub={<>数据位置、草稿保存与清理。</>}>
      <div className="card" data-zs-data-guide="1">
        <div className="card-title">数据位置与备份</div>
        <ReadOnlyRow label="当前数据位置" value={identity?.appDataDir ?? '（读取中…）'} />
        <div className="small muted" style={{ lineHeight: 1.7, marginBottom: 6 }}>
          备份会完整保留对话、附件、草稿、本地账号资料和设置。请像保管自己的文件一样妥善保管备份。
        </div>
        <SettingsRow id="备份全部数据" label="备份全部数据" hint="选择保存位置；众说正常关闭后复制并逐个核对，原件不会移动或删除" control={
          <button className="btn primary sm" disabled={dataOpBusy != null} data-zs-data-backup="1" onClick={() => void startDataOp('backup')}>
            <Icon name="download" size={13} /> {dataOpBusy === 'backup' ? '正在准备…' : '备份全部数据'}
          </button>
        } />
        <SettingsRow id="使用已有数据" label="使用已有数据或从备份恢复" hint="选择旧包、数据文件夹或完整备份，再选择新副本保存位置；验证成功后才切换" control={
          <button className="btn sm" disabled={dataOpBusy != null} data-zs-data-import="1" onClick={() => void startDataOp('import')}>
            <Icon name="folder" size={13} /> {dataOpBusy === 'import' ? '正在准备…' : '选择已有数据'}
          </button>
        } />
        <SettingsRow label="最近一次数据操作" hint="结果会在这里重新读取；失败或中断不会自动重试" control={
          <div className="col settings-data-operation" style={{alignItems:'flex-end',gap:5,width:230,minWidth:0,maxWidth:'100%'}}>
            {dataOpError != null ? <Tag tone="danger" icon="alert-triangle">无法读取：{userFacingSystemText(dataOpError ?? '')}</Tag> : dataOp?.latest == null ? <span className="small faint">还没有数据操作记录</span> : (
              <Tag tone={dataOp.latest.state === 'succeeded' ? 'success' : dataOp.latest.state === 'failed' || dataOp.latest.state === 'unknown' ? 'warning' : 'info'} icon={dataOp.latest.state === 'succeeded' ? 'check-circle' : dataOp.latest.state === 'copying' || dataOp.latest.state === 'waiting-close' ? 'clock' : 'alert-triangle'}>
                {dataOp.latest.state === 'succeeded' ? (dataOp.latest.action === 'import' ? '已使用新的数据副本' : '完整备份已完成') : dataOp.latest.state === 'copying' ? '正在复制' : dataOp.latest.state === 'waiting-close' ? '等待关闭' : dataOp.latest.state === 'failed' ? '未完成，原件保留' : '上次操作中断，未切换'}
              </Tag>
            )}
            {dataOp?.active?.running ? <span className="small faint">数据操作仍在进行；完成前不会打开这份数据。</span> : null}
            {dataOp?.latest?.error != null ? <span className="small" style={{maxWidth:360,textAlign:'right',color:'var(--warning)'}}>{userFacingSystemText(dataOp.latest.error ?? '')}</span> : null}
            <button className="btn ghost sm" onClick={() => void reloadDataOp()}>刷新</button>
          </div>
        } />
      </div>
      <div className="card">
        <div className="card-title">草稿</div>
      <SettingsRow id="草稿保存" label="草稿保存" hint="草稿和未确认发送的保存状态（刷新或崩溃后仍保留；普通草稿 24 小时过期）">
        <div className="small" style={{ lineHeight: 1.7 }}>
          {draftPersist.mode === 'on' && draftPersist.error == null ? <Tag tone="success" icon="check-circle">正常</Tag> : null}
          {draftPersist.mode === 'locked' ? <Tag tone="warning" icon="alert-triangle">保全锁定（草稿已保留、不会被覆盖；发送暂不可用）</Tag> : null}
          {draftPersist.mode === 'off' ? <Tag tone="warning" icon="alert-triangle">不可用（{userFacingSystemText(draftPersist.error ?? '身份/存储未就绪')}）</Tag> : null}
          {draftPersist.mode === 'on' && draftPersist.error != null ? <Tag tone="warning" icon="alert-triangle">写入失败（{userFacingSystemText(draftPersist.error ?? '')}）</Tag> : null}
        </div>
      </SettingsRow>
      {draftPersist.recoveryNote != null ? (
        <div className="small faint" style={{ padding: '0 14px 6px' }} data-zs-draft-recovery-note="1">{draftPersist.recoveryNote}</div>
      ) : null}
      <SettingsRow id="清理本地草稿" label="重试 / 清理" hint="释放存储后可重试保存；清理会删除已保存的草稿（不可恢复）" control={
        <div className="row tight">
          <button className="btn sm" data-zs-draft-retry="1" onClick={() => { retryDraftPersistence(); toast('已重试草稿保存，状态见上方', 'info'); }}>重试保存</button>
          <button className="btn sm" onClick={clearDrafts}>清理本地草稿</button>
        </div>
      } />
      {cleared != null ? <div className="small faint" style={{ padding: '0 14px 6px' }}>{cleared}</div> : null}
      <SettingsRow
        label="从旧版本导入草稿"
        hint="首次从旧版本升级或复制数据目录后，可在这里导入旧的草稿和未确认发送记录。"
        control={(
          <button className="btn sm" data-zs-legacy-rescan="1" onClick={() => { void rescanLegacyImport().then(() => toast('已重新扫描旧目录，结果见下方', 'info')); }}>重扫旧目录</button>
        )}
      >
        <div className="small" style={{ lineHeight: 1.7, minWidth: 0, width: 'min(420px, 100%)' }}>
          {legacy == null || legacy.candidates.length === 0 ? (
            <div className="faint" style={{ marginTop: 4 }}>当前没有待确认的旧目录。</div>
          ) : (
            <div className="col" style={{ gap: 6, marginTop: 6 }} data-zs-legacy-candidates="1">
              {legacy.error != null ? <div style={{ color: 'var(--warning,#b45309)' }}>上次扫描：{userFacingSystemText(legacy.error ?? '')}</div> : null}
              {legacy.candidates.map((c) => (
                <div key={c.key} className="row tight" style={{ padding: '4px 6px', border: '1px solid var(--border,#dbe2ea)', borderRadius: 6 }} data-zs-legacy-candidate={c.dir}>
                  <Icon name="folder" size={12} />
                  <span className="mono-sm" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.key}>{c.dir}</span>
                  {c.hasStateDb === true ? <Tag tone="info">含数据</Tag> : c.hasStateDb === false ? <Tag tone="neutral">无数据文件</Tag> : null}
                  {c.importedAt != null ? (
                    <Tag tone="success" icon="check">已导入 {new Date(c.importedAt).toLocaleTimeString()}</Tag>
                  ) : (
                    <button
                      className="btn primary sm"
                      data-zs-legacy-import={c.dir}
                      disabled={importBusy === c.key}
                      title={`导入该目录的旧草稿和待确认发送记录。旧记录会保留；导入后可查看提示并决定是否重试发送。`}
                      onClick={() => void doImport(c.key, c.dir)}
                    >
                      {importBusy === c.key ? '导入中…' : '确认导入'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsRow>
      </div>
      <div className="card">
        <div className="card-title">归档与项目</div>
      {/* 归档管理（R66 P4：R65 起命令面已具备——project.lifecycle/room.archive；此前误标
          「未接入」，现按原型嵌入同一管理器，与 /archive 独立页共用状态与动作）。 */}
      <SettingsRow id="归档管理" label="归档管理" hint="查看已归档项目和房间的历史，或恢复使用；已有文件与记录会保留">
        <div style={{ marginTop: 6 }}>
          <ArchiveManager embedded />
        </div>
      </SettingsRow>
      <SettingsRow id="已移除的项目" label="已移除的项目" hint="移除=只在应用里解除关联（磁盘与历史不动）——在欢迎页「打开本地文件夹」重新打开同一目录即可恢复原来的项目" control={
        <button className="btn sm" onClick={() => navigate('/welcome')}>去欢迎页重新关联…</button>
      } />
      </div>
    </SectionShell>
  );
}

/* ============================================================ 分区：帮助与关于 ============================================================ */

const APP_LINKS: Array<{ target: AppLinkTarget; row: string; label: string; hint: string; action: string }> = [
  { target: 'manual', row: 'open-manual', label: '操作手册', hint: '用系统默认浏览器打开随程序附带的离线手册（与当前版本一致）', action: '打开手册' },
  { target: 'github', row: 'open-github', label: 'GitHub 仓库', hint: 'https://github.com/384615666/zhongshuo', action: '打开 GitHub' },
  { target: 'homepage', row: 'open-homepage', label: '产品主页', hint: 'https://zhongshuo.lsjx.xyz', action: '打开主页' },
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
    <SectionShell section="help" title="帮助与关于" sub={<>操作手册、项目链接、版本与诊断。</>}>
      <div className="card" data-zs-app-links="1">
        <div className="card-title">手册与项目链接</div>
        {APP_LINKS.map((link) => (
          <SettingsRow
            key={link.target}
            id={link.row}
            label={link.label}
            hint={link.hint}
            control={(
              <button className="btn sm" data-zs-open-link={link.target} disabled={linkBusy != null} onClick={() => void open(link.target, link.label)}>
                <Icon name="external-link" size={13} /> {linkBusy === link.target ? '正在打开…' : link.action}
              </button>
            )}
          />
        ))}
      </div>
      <div className="card">
        <div className="card-title">版本</div>
        <ReadOnlyRow id="版本与构建" label="应用" value="众说 · 本地多成员协作工作台" />
        <ReadOnlyRow label="当前文件位置" value={identity?.appDataDir ?? '（读取中…）'} />
      </div>
      {/* LocalDiagnostics 自带 .card：作为独立卡片并列，避免卡中卡的双层描边。 */}
      <LocalDiagnostics />
    </SectionShell>
  );
}
