import { readAvatarFile } from '../data/avatarUpload';
import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * 应用设置：既有设置导航 + 搜索，操作手册单独分区。
 *
 * 已接命令的设置读写并回读核对（app.settings /
 * 主题 / runtime 绑定 / 数据与草稿存储 / 远程监听事实 / BUILD 身份）；通知静音使用真实
 * thread_subscriptions 并回读。后端没有的能力在原型位置**禁用并说明**（托盘/自启、配对码、
 * MCP 接入），不用模拟值冒充实际值。
 * 项目设置独立于 /project/:id/settings（原归属保持——本页只放应用级）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore, toast } from '../shell';
import { SettingsRow, ReadOnlyRow, DetailFold } from '../components/SettingsRow';
import { recordWrite, retryDraftPersistence, setTheme, setAppearanceState, clearPersistedSnapshot, importLegacySnapshot } from '../data/store';
import { rescanLegacyImport } from '../loader';
import { bridge, command, dataBridge, type DataOperationStatus } from '../bridge';
import { navigate } from '../lib/router';
import { ArchiveManager } from './ArchivePage';
import { isExternalDeepLink } from '../lib/deepLink';
import { LocalDiagnostics } from '../components/LocalDiagnostics';
import { runtimeModelDisplayName } from '../lib/format';
import {
  CALL_BUDGET_ENABLED_SETTING_KEY,
  DEFAULT_CALL_BUDGET_LIMITS,
  parseCallBudgetEnabledSetting,
  serializeCallBudgetEnabledSetting,
} from '../../../contracts/callBudget';
import {
  TASK_NOTIFICATION_COMMANDS,
  taskNotificationPollResultSchema,
  type TaskNotificationAttemptView,
  type TaskNotificationPollResult,
} from '../../../contracts/taskNotifications';

export type AppSettingsSection =
  | 'general' | 'appearance' | 'notifications' | 'runtime' | 'connections' | 'data' | 'guide' | 'help';

/** 旧写法 → 现分区（§3.4 深链兼容）。 */
const SECTION_ALIASES: Record<string, AppSettingsSection> = {
  general: 'general', appearance: 'appearance', notifications: 'notifications',
  runtime: 'runtime', connections: 'connections', data: 'data', guide: 'guide', manual: 'guide', help: 'help',
  app: 'general', lan: 'connections', archive: 'data', archived: 'data', diagnostics: 'help', errors: 'help',
};

export function appSectionOf(raw: string | undefined): AppSettingsSection {
  return (raw && SECTION_ALIASES[raw]) || 'general';
}

type NavItem = { key: AppSettingsSection; label: string; icon: string; hint: string };

const NAV: NavItem[] = [
  { key: 'general', label: '通用', icon: 'settings', hint: '启动与打开位置' },
  { key: 'appearance', label: '外观', icon: 'sun', hint: '主题：浅色 / 深色' },
  { key: 'notifications', label: '通知', icon: 'bell', hint: '按真实线程订阅管理桌面通知静音' },
  { key: 'runtime', label: 'AI 设置', icon: 'cpu', hint: '调用预算、AI 成员的模型与权限' },
  { key: 'connections', label: '连接与设备', icon: 'monitor', hint: '其它设备的连接与授权' },
  { key: 'data', label: '数据与存储', icon: 'layers', hint: '备份、恢复、草稿与本地文件' },
  { key: 'guide', label: '操作手册', icon: 'file-text', hint: '完整使用说明' },
  { key: 'help', label: '帮助与关于', icon: 'help-circle', hint: '版本与诊断' },
];

/** Search only real actions shown on this page. */
type SearchEntry = { section: AppSettingsSection; label: string; keywords: string; match: string };
const SEARCH_INDEX: SearchEntry[] = [
  { section: 'general', label: '启动时打开的项目', keywords: '启动 打开 项目 自动 路径', match: '启动时打开的项目' },
  { section: 'appearance', label: '主题', keywords: '外观 主题 深色 浅色 暗色', match: 'appearance-theme' },
  { section: 'appearance', label: '显示头像', keywords: '头像 显示 图片', match: 'appearance-avatars' },
  { section: 'appearance', label: '设置个人与 AI 头像', keywords: '我的头像 个人头像 AI头像 上传 更换 恢复默认 图片', match: 'appearance-avatar-images' },
  { section: 'notifications', label: '线程通知静音', keywords: '通知 静音 桌面 完成 验收 输入', match: '线程通知静音' },
  { section: 'runtime', label: '启用调用次数预算', keywords: '调用预算 调用次数 次数预算 启用 开启 关闭 上限 callBudget budget DIRECT AUTO DELIBERATE', match: 'call-budget' },
  { section: 'runtime', label: 'AI 成员的模型与权限', keywords: 'AI 成员 模型 权限 设置', match: 'AI 成员的模型' },
  { section: 'connections', label: '远程访问监听事实', keywords: '远程 局域网 lan 证书 指纹 监听', match: '远程访问' },
  { section: 'data', label: '备份全部数据', keywords: '备份 数据 保存', match: '备份全部数据' },
  { section: 'data', label: '使用已有数据或从备份恢复', keywords: '恢复 已有数据 旧包 备份', match: '使用已有数据' },
  { section: 'data', label: '草稿快照健康与重试', keywords: '草稿 快照 保存 锁定 重试', match: '草稿快照' },
  { section: 'data', label: '清理本地草稿', keywords: '清理 删除 草稿 本地', match: '清理本地草稿' },
  { section: 'data', label: '归档管理', keywords: '归档 项目 房间 恢复历史', match: '归档管理' },
  { section: 'data', label: '已移除的项目', keywords: '移除 项目 重新关联', match: '已移除的项目' },
  { section: 'guide', label: '操作手册', keywords: '帮助 文档 使用 教程 手册', match: 'user-guide' },
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

import { Avatar, Modal, Select, Switch, Tag, memberColor } from '../components/ui';

export function SettingsPage({ query }: { query?: Record<string, string> }) {
  const q = query ?? {};
  const section = appSectionOf(q.section);
  const [search, setSearch] = useState('');
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const go = (next: AppSettingsSection) => navigate(`/settings?section=${next}`, { replace: true });
  useEffect(() => {
    if (section !== 'guide' || search.trim()) return;
    const reveal = () => navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    window.addEventListener('resize', reveal);
    return () => window.removeEventListener('resize', reveal);
  }, [section, search]);
  useEffect(() => {
    if (!jumpTo || section === 'guide') return;
    const el = findByLabel(jumpTo);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('settings-jump-flash');
    const t = window.setTimeout(() => el.classList.remove('settings-jump-flash'), 1800);
    return () => window.clearTimeout(t);
  }, [jumpTo, section]);
  const results = useMemo(() => searchAppSettings(search), [search]);

  return (
    <div className="main">
      <div className={`page${section === 'guide' ? ' settings-guide-page' : ''}`}>
        <div className={`settings-layout${section === 'guide' ? ' settings-guide-layout' : ''}`}>
          <nav ref={navRef} className="settings-nav" aria-label="设置分区">
            <div className="settings-search">
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
            </div>
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
                      onClick={() => { setJumpTo(r.match); go(r.section); setSearch(''); }}
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
          </nav>
          <div className="settings-body">
            {section === 'general' ? <SectionGeneral /> : null}
            {section === 'appearance' ? <SectionAppearance /> : null}
            {section === 'notifications' ? <SectionNotifications /> : null}
            {section === 'runtime' ? <SectionRuntime /> : null}
            {section === 'connections' ? <SectionConnections /> : null}
            {section === 'data' ? <SectionData /> : null}
            {section === 'guide' ? <SectionGuide /> : null}
            {section === 'help' ? <SectionHelp /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function findByLabel(text: string): HTMLElement | null {
  const exact = Array.from(document.querySelectorAll<HTMLElement>('[data-settings-row]')).find(el=>el.dataset.settingsRow===text);
  if(exact)return exact;
  const all = document.querySelectorAll<HTMLElement>('.settings-body .row, .settings-body .pset-row, .settings-body .settings-row, .settings-body label');
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
  const [deepLinkInput, setDeepLinkInput] = useState('');
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
  const openDeepLink = async () => {
    const { openExternalDeepLink } = await import('../loader');
    const raw = deepLinkInput.trim();
    if (!isExternalDeepLink(raw)) { toast('定位链接格式应为 #task=… / #delivery=… / #msg=… / #dm=…（从线程详情「复制定位链接」获得）', 'warn'); return; }
    try { await openExternalDeepLink(raw); toast('已定位', 'success'); }
    catch (e) { toast(`定位失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); }
  };
  return (
    <div>
      <SectionHead title="通用" sub={<>整个软件的启动与界面行为。<span className="faint">想改某个项目：侧栏项目行 ⋯ → 项目设置。</span></>} />
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title">启动</div>
        <SettingsRow label="启动时打开的项目" hint="选择后保存；下次打开众说时回到这个项目" wide control={
          <div className="row tight" style={{ minWidth: 260 }}>
            <input className="input sm" style={{ minWidth: 200 }} value={autoOpen} onChange={(e) => setAutoOpen(e.target.value)} placeholder="例如 D:\项目\我的项目" />
            <button className="btn sm" onClick={() => { void bridge().pickFolder().then((dir) => { if (dir != null) setAutoOpen(dir); }); }}>选择文件夹</button>
            <button className="btn sm" disabled={busy || readError != null || autoOpenSaved == null || autoOpen.trim() === autoOpenSaved} onClick={() => void save()}>保存</button>
          </div>
        } />
        {readError != null ? <div className="panel warning">启动项目设置读取失败：{userFacingSystemText(readError ?? '')}；保存已暂停，避免用未知旧值覆盖。<button className="btn sm" onClick={() => void reload()}>重试读取</button></div> : null}
      </div>
      <div className="card">
        <div className="card-title">打开一个定位链接</div>
        <DetailFold summary="需要从链接打开任务或消息时">
          <SettingsRow label="定位链接" hint="粘贴复制来的定位链接，打开对应任务或消息" wide control={
            <div className="row tight" style={{ minWidth: 260 }}>
              <input className="input sm" style={{ minWidth: 200 }} placeholder="粘贴定位链接" value={deepLinkInput} onChange={(e) => setDeepLinkInput(e.target.value)} />
              <button className="btn sm" onClick={() => void openDeepLink()}>打开</button>
            </div>
          } />
        </DetailFold>
      </div>
    </div>
  );
}

/* ============================================================ 分区：外观 ============================================================ */

function SectionAppearance() {
  const theme = useStore((s) => s.ui.theme);
  const showAvatars = useStore((s) => s.ui.showAvatars === true);
  const membersAll = useStore((s) => s.members);
  const members = useMemo(() => membersAll.filter((member) => member.principalType === 'agent'), [membersAll]);
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
    <div>
      <SectionHead title="外观" sub={<>主题、头像显示与个人图片（本机偏好，随数据根保存）。</>} />
      <SettingsRow id="appearance-theme" label="主题" hint="浅色 / 深色">
        <div className="seg" role="group" aria-label="主题">
          <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>浅色</button>
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>深色</button>
        </div>
      </SettingsRow>
      <SettingsRow id="appearance-avatars" label="显示头像" hint="默认显示个人和 AI 头像，姓名始终保留">
        <Switch
          checked={showAvatars}
          disabled={busy === 'visibility'}
          label={showAvatars ? '显示' : '隐藏'}
          onChange={(next) => void save('visibility', { showAvatars: next })}
        />
      </SettingsRow>
      <div className="card" style={{ marginTop: 14 }} data-zs-avatar-settings="1" data-settings-row="appearance-avatar-images">
        <div className="card-title">头像</div>
        <div className="small faint" style={{ padding: '0 14px 8px' }}>PNG、JPEG 或 WebP。预览始终可见，聊天中的头像遵循上方开关。</div>
        <AppearanceAvatarRow subject="user" name="我" color="var(--m-human)" busy={busy} onSave={save} />
        {members.map((member) => (
          <AppearanceAvatarRow
            key={member.id}
            subject={`member:${member.id}`}
            name={member.displayName}
            color={memberColor(member.id, member.ordinal)}
            busy={busy}
            onSave={save}
          />
        ))}
        {members.length === 0 ? <div className="small faint" style={{ padding: '8px 14px 12px' }}>当前项目还没有 AI 成员。</div> : null}
      </div>
    </div>
  );
}

function AppearanceAvatarRow({
  subject,
  name,
  color,
  busy,
  onSave,
}: {
  subject: string;
  name: string;
  color: string;
  busy: string | null;
  onSave: (key: string, patch: { avatar: { subject: string; dataUrl: string | null } }) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasImage = useStore((state) => state.ui.avatars?.[subject] != null);
  const key = `avatar:${subject}`;
  const pick = (file: File | undefined): void => {
    if (file == null) return;
    void readAvatarFile(file)
      .then((dataUrl) => onSave(key, { avatar: { subject, dataUrl } }))
      .catch((error: unknown) => toast((error as Error).message, 'error'));
  };
  return (
    <div className="row" style={{ justifyContent: 'space-between', padding: '9px 14px', borderTop: '1px solid var(--border-subtle)' }} data-zs-avatar-subject={subject}>
      <div className="row tight" style={{ minWidth: 0 }}>
        <Avatar name={name} color={color} size={36} round subject={subject} show />
        <div style={{ minWidth: 0 }}>
          <div className="strong truncate">{name}</div>
          <div className="small faint">{subject === 'user' ? '本地用户' : 'AI 成员'}</div>
        </div>
      </div>
      <div className="row tight">
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={`选择${name}的头像`}
          onChange={(event) => { pick(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }}
        />
        <button type="button" className="btn sm" disabled={busy != null} onClick={() => inputRef.current?.click()} title={`上传${name}的头像`}>
          <Icon name="upload" size={12} /> 选择图片
        </button>
        <button type="button" className="btn ghost sm" disabled={busy != null || !hasImage} onClick={() => void onSave(key, { avatar: { subject, dataUrl: null } })} title={hasImage ? `恢复${name}的默认头像` : '当前已是默认头像'}>
          <Icon name="trash" size={12} /> 恢复默认
        </button>
      </div>
    </div>
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
      toast(muted ? '该线程已静音；任务仍会保留，系统通知不再弹出' : '该线程已恢复系统通知', 'success');
    } catch (writeError) {
      toast(`线程通知设置保存失败：${userFacingSystemText((writeError as Error).message ?? '')}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <SectionHead title="通知" sub={<>按对话串管理桌面通知与静音，投递记录可在下方查看。</>} />
      <div className="panel info">
        任务完成、需要处理、等待输入或待验收时会发送系统通知。静音某个线程后，它的任务和未读仍保留，只是不再弹出桌面通知。
      </div>
      <div className="card" data-zs-notification-settings="1">
        <div className="card-title">对话串通知</div>
        {loading ? <div className="small faint" style={{ padding: '10px 14px' }}>正在读取真实线程静音状态…</div> : null}
        {error != null ? (
          <div className="panel warning" style={{ margin: 12 }}>
            线程通知设置读取失败：{userFacingSystemText(error ?? '')}
            <button className="btn sm" onClick={() => void reload()}>重试读取</button>
          </div>
        ) : null}
        {!loading && error == null && items.length === 0 ? (
          <div className="small faint" style={{ padding: '10px 14px' }}>
            还没有设置过对话串通知。可在对话串右上角菜单中设置静音，再到这里统一管理。
          </div>
        ) : null}
        {items.map((item) => (
          <SettingsRow
            key={item.threadId}
            label={titles[item.taskId ?? ''] ?? `线程 ${item.threadId.slice(0, 12)}`}
            hint={`${item.followed ? '已关注' : '未关注'} · 项目 ${item.projectId.slice(0, 12)}`}
          >
            <Switch
              checked={item.muted}
              disabled={busy != null}
              label={item.muted ? '已静音' : '通知'}
              onChange={(next) => void setMuted(item, next)}
            />
          </SettingsRow>
        ))}
      </div>
      <div className="card" style={{ marginTop: 14 }} data-zs-notification-delivery="1">
        <div className="card-title">桌面投递状态</div>
        {deliveryError != null ? (
          <div className="panel warning" style={{ margin: 12 }}>投递状态读取失败：{userFacingSystemText(deliveryError ?? '')}</div>
        ) : delivery == null ? (
          <div className="small faint" style={{ padding: '10px 14px' }}>正在读取桌面投递记录…</div>
        ) : (
          <>
            <div className="row tight" style={{ padding: '8px 14px', flexWrap: 'wrap' }}>
              <Tag tone="neutral">已尝试 {delivery.health.attempted}</Tag>
              <Tag tone="neutral">已请求显示 {delivery.health.showRequested}</Tag>
              <Tag tone="neutral">已显示 {delivery.health.shown}</Tag>
              <Tag tone={delivery.health.unknown > 0 ? 'warning' : 'neutral'}>未确认 {delivery.health.unknown}</Tag>
              <Tag tone={delivery.health.failed > 0 ? 'danger' : 'neutral'}>失败 {delivery.health.failed}</Tag>
              <Tag tone="neutral">已点击 {delivery.health.clicked}</Tag>
            </div>
            {delivery.recentAttempts.length === 0 ? (
              <div className="small faint" style={{ padding: '2px 14px 12px' }}>尚无桌面投递尝试。</div>
            ) : (
              <DetailFold summary="查看最近投递记录">
                {delivery.recentAttempts.map((attempt: TaskNotificationAttemptView) => (
                  <SettingsRow
                    key={attempt.notificationId}
                    label={attempt.title}
                    hint={attemptStateLabel(attempt)}
                  >
                    <span className="small faint">{new Date(attempt.claimRequestedAt).toLocaleString()}</span>
                  </SettingsRow>
                ))}
              </DetailFold>
            )}
          </>
        )}
      </div>
    </div>
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
    >
      <SettingsRow
        id="call-budget"
        label="启用调用次数预算"
        hint="默认关闭。开启后，AI 调用达到上限时暂停；关闭时只计数。更改对新请求生效。"
        control={(
          <div className="col" style={{ alignItems: 'flex-end', gap: 5 }}>
            <Switch
              checked={enabled}
              disabled={loading || busy || readError != null}
              label={enabled ? '开启' : '关闭'}
              onChange={(next) => void save(next)}
            />
            <span className="small faint" data-zs-call-budget-status={status}>{status}</span>
          </div>
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
  const guard = useStore((s) => s.dispatchGuard);
  const projectId = useStore((s) => s.activeProjectId);
  return (
    <div>
      <SectionHead title="AI 设置" sub={<>管理调用预算，以及每位 AI 成员使用的程序、模型和权限。</>} />
      <CallBudgetSettingsRow />
      {members.map((m) => {
        const rt = runtimes[m.id];
        return (
          <SettingsRow
            key={m.id}
            label={m.displayName}
            hint={rt == null ? '读取中…' : rt.status === 'bound' ? `${rt.kind === 'codex' ? 'Codex' : rt.kind === 'claude' ? 'Claude' : '已配置'}${rt.model != null && rt.model !== '' ? <span title={`完整模型 ID：${rt.model}`}> · {runtimeModelDisplayName({id:rt.model,label:rt.model})}</span> : ''}` : rt.status === 'unbound' ? '还没有选择模型' : '配置读取失败'}
          >
            <button className="btn sm" onClick={() => navigate(projectId !== '' ? `/project/${projectId}/members` : '/members')}>
              {rt?.status === 'bound' ? '查看/修改' : '配置 AI'}
            </button>
          </SettingsRow>
        );
      })}
      {members.length === 0 ? <div className="panel info">还没有 AI 成员。打开项目后，在成员页添加 AI。</div> : null}
      <DetailFold summary="运行环境详情">
        <SettingsRow label="本机运行状态" hint="用于排查为什么这里不能发送真实任务">
          <div className="row tight">
            <Tag tone={guard?.fakeAllowed === false ? 'neutral' : 'warning'} icon={guard?.fakeAllowed === false ? 'check-circle' : 'alert-triangle'}>
              {guard == null ? '读取中…' : guard.fakeAllowed ? '当前为演练环境' : '日常运行'}
            </Tag>
            <Tag tone={guard?.realDispatchGuard ? 'success' : 'neutral'} icon={guard?.realDispatchGuard ? 'check-circle' : 'info'}>
              {guard == null ? '' : guard.realDispatchGuard ? '真实任务发送检查已开启' : '真实任务发送检查未开启'}
            </Tag>
          </div>
        </SettingsRow>
      </DetailFold>
    </div>
  );
}

/* ============================================================ 分区：连接与设备 ============================================================ */

interface RemoteCfg {
  enabled: boolean; listenHost: string; port: number; allowLan: boolean;
  running?: boolean; address?: string; fingerprint?: string; caFingerprint?: string;
  certNotAfter?: number; lanSelfCheck?: { ok: boolean; detail?: string; error?: string } | null;
  note: string;
}
interface RemoteDevice { deviceId: string; deviceName: string; createdAt: number; lastSeenAt: number | null; revokedAt: number | null }
interface PairCode { pairingId: string; code: string; expiresAt: number; address: string | null; fingerprint: string | null }

function SectionConnections() {
  const [identity, setIdentity] = useState<{ localUserId: string; appDataDir: string } | null>(null);
  const [identityErr, setIdentityErr] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteCfg | null>(null);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('0');
  const [configDirty, setConfigDirty] = useState(false);
  const configDirtyRef = useRef(false);
  const [devices, setDevices] = useState<RemoteDevice[] | null>(null);
  const [devicesErr, setDevicesErr] = useState<string | null>(null);
  const [pair, setPair] = useState<PairCode | null>(null);
  const [revoke, setRevoke] = useState<RemoteDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const readSeq = useRef(0);
  const readRemote = useCallback(async (syncDraft = false): Promise<RemoteCfg | null> => {
    const seq = ++readSeq.current;
    const [cfgResult, devicesResult] = await Promise.allSettled([
      command<RemoteCfg>('remote.config.get', {}),
      command<{ devices: RemoteDevice[] }>('remote.devices.list', {}),
    ]);
    if (seq !== readSeq.current) return null;
    if (cfgResult.status === 'fulfilled') {
      setRemote(cfgResult.value); setRemoteErr(null);
      if (syncDraft && !configDirtyRef.current) { setHost(cfgResult.value.listenHost); setPort(String(cfgResult.value.port)); setConfigDirty(false); }
    } else setRemoteErr((cfgResult.reason as Error).message);
    if (devicesResult.status === 'fulfilled') { setDevices(devicesResult.value.devices); setDevicesErr(null); }
    else setDevicesErr((devicesResult.reason as Error).message);
    return cfgResult.status === 'fulfilled' ? cfgResult.value : null;
  }, []);
  useEffect(() => {
    let done = false;
    void command<{ localUserId: string; appDataDir: string }>('app.identity', {}).then((r) => { if (!done) setIdentity(r); }).catch((e: unknown) => { if (!done) setIdentityErr((e as Error).message); });
    void readRemote(true);
    return () => { done = true; readSeq.current += 1; };
  }, [readRemote]);
  const applyRemote = async (enabled: boolean) => {
    const requestedPort = Number(port);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) { toast('端口须为 0–65535 整数（0=自动选择）', 'warn'); return; }
    setBusy(true);
    try {
      await command('remote.config.set', { enabled, listenHost: enabled ? host : '127.0.0.1', port: requestedPort, allowLan: enabled && host === '0.0.0.0' });
      configDirtyRef.current = false;
      setConfigDirty(false);
      const applied = await readRemote(true);
      setPair(null);
      if (applied == null || applied.enabled !== enabled || applied.listenHost !== (enabled ? host : '127.0.0.1') || applied.port !== requestedPort || applied.running !== enabled) {
        toast('远程访问状态尚未确认，请刷新后再操作', 'warn');
      } else toast(enabled ? '远程访问已启用' : '远程访问已停用', 'success');
    } catch (e) { toast(`远程配置失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); void readRemote(); }
    finally { setBusy(false); }
  };
  const createPair = async () => {
    setBusy(true); setPair(null);
    try { setPair(await command<PairCode>('remote.pairing.create', {})); }
    catch (e) { toast(`配对码创建失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); }
    finally { setBusy(false); }
  };
  const revokeDevice = async () => {
    if (revoke == null) return;
    setBusy(true);
    try {
      await command('remote.device.revoke', { deviceId: revoke.deviceId });
      setRevoke(null);
      await readRemote();
      toast('设备已吊销（该设备的凭据与连接立即失效）', 'success');
    } catch (e) { toast(`吊销失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div>
      <SectionHead title="连接与设备" sub={<>允许你在自己的其它设备上继续使用众说。默认关闭。</>} />
      <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-title">本机与远程访问</div>
      <SettingsRow label="远程访问" hint="保存后会重新读取实际状态" valueWrap>
        {remoteErr != null ? <Tag tone="danger">读取失败：{remoteErr.slice(0, 60)}</Tag> : remote == null ? <span className="faint small">读取中…</span> : (
          <div className="small" style={{ lineHeight: 1.7 }}>
            <div>配置：{remote.enabled ? '启用' : '停用'} · {remote.listenHost}:{remote.port} · {remote.allowLan ? '局域网' : '仅本机'}</div>
            <div>实际：{remote.running === true ? `运行中（${remote.address ?? '?'}）` : '未运行'}</div>
            {remote.lanSelfCheck != null ? <div className={remote.lanSelfCheck.ok ? 'faint small' : 'small'} style={{ color: remote.lanSelfCheck.ok ? undefined : 'var(--danger)' }}>LAN 自检：{remote.lanSelfCheck.ok ? '通过' : `失败（${userFacingSystemText(remote.lanSelfCheck.error ?? remote.lanSelfCheck.detail ?? '?')}）`}</div> : null}
            {configDirty ? <div className="small faint">下方有未应用的编辑</div> : null}
          </div>
        )}
      </SettingsRow>
      <SettingsRow label="连接范围" hint="仅本机最安全；同一局域网可在手机或平板上打开" wide control={
        <div className="row tight wrap">
          <Select size="sm" ariaLabel="远程监听范围" value={host} disabled={busy} onChange={(v) => { setHost(v); setConfigDirty(true); configDirtyRef.current = true; }} options={[{ value: '127.0.0.1', label: '仅本机' }, { value: '0.0.0.0', label: '局域网' }]} />
          <input className="input sm" type="number" min={0} max={65535} step={1} value={port} disabled={busy} aria-label="远程监听端口" style={{ width: 110 }} onChange={(e) => { setPort(e.target.value); setConfigDirty(true); configDirtyRef.current = true; }} />
          <button className="btn sm" disabled={busy || remote == null} onClick={() => void applyRemote(true)}>启用/应用</button>
          <button className="btn sm" disabled={busy || remote == null || !remote.enabled} onClick={() => void applyRemote(false)}>停用</button>
          <button className="btn sm" disabled={busy} onClick={() => void readRemote(!configDirty)}>刷新事实</button>
        </div>
      } />
      </div>
      <DetailFold summary="本机身份与证书详情">
        <ReadOnlyRow label="本机用户" value={identityErr != null ? `读取失败：${userFacingSystemText(identityErr ?? '')}` : identity?.localUserId ?? '（读取中…）'} />
        <ReadOnlyRow label="当前文件位置" value={identityErr != null ? `读取失败：${userFacingSystemText(identityErr ?? '')}` : identity?.appDataDir ?? '（读取中…）'} />
        {remote?.fingerprint != null ? <ReadOnlyRow label="服务证书 SHA-256" value={remote.fingerprint} /> : null}
        {remote?.caFingerprint != null ? <ReadOnlyRow label="信任根 SHA-256" value={remote.caFingerprint} /> : null}
      </DetailFold>
      <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-title">配对与设备</div>
      <SettingsRow label="生成配对码" hint="仅本机可信入口；一次有效、5 分钟过期。码只在本次回执显示，不进入诊断或日志。" wide control={
        <div>
          <button className="btn sm" disabled={busy || remote?.running !== true} onClick={() => void createPair()}>生成配对码</button>
          {pair != null ? <div className="panel warning" style={{ marginTop: 6 }}>
            <div>配对 ID：<span className="mono">{pair.pairingId}</span> · 配对码：<strong className="mono">{pair.code}</strong></div>
            <div>有效至 {new Date(pair.expiresAt).toLocaleTimeString()} · 地址 {pair.address ?? '监听已停止'}</div>
            {pair.fingerprint != null ? <div className="mono small" style={{ overflowWrap: 'anywhere' }}>服务证书 SHA-256：{pair.fingerprint}</div> : null}
          </div> : null}
        </div>
      } />
      <SettingsRow label="已配对设备" hint="吊销后设备凭据、会话和事件流立即失效（remote.devices.list / remote.device.revoke）" wide control={
        <div className="col" style={{ gap: 6 }}>
          {devicesErr != null ? <div className="panel warning">读取失败：{userFacingSystemText(devicesErr ?? '')}</div> : devices == null ? <span className="small faint">读取中…</span> : devices.length === 0 ? <span className="small faint">暂无设备</span> : devices.map((d) => (
            <div key={d.deviceId} className="row tight wrap small">
              <span>{d.deviceName} · <span className="mono">{d.deviceId.slice(0, 12)}…</span> · {d.revokedAt != null ? '已吊销' : `最近 ${d.lastSeenAt != null ? new Date(d.lastSeenAt).toLocaleString() : '未见'}`}</span>
              {d.revokedAt == null ? <button className="btn sm" disabled={busy} onClick={() => setRevoke(d)}>吊销</button> : null}
            </div>
          ))}
        </div>
      } />
      </div>
      {revoke != null ? <Modal size="sm" title={`吊销设备「${revoke.deviceName}」`} onClose={() => setRevoke(null)} footer={<><div className="spacer" /><button className="btn" onClick={() => setRevoke(null)}>取消</button><button className="btn danger" disabled={busy} onClick={() => void revokeDevice()}>确认吊销</button></>}>
        吊销会让这台设备当前连接立即失效；需要再次访问时须重新配对。
      </Modal> : null}
    </div>
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
    if (!r.hadKey) { setCleared('没有已保存的草稿快照（活动键不存在）'); toast('没有已保存的草稿快照', 'info'); return; }
    recordWrite('drafts.clear', `清空本地草稿快照键 ${r.key?.slice(0, 40)}…（未确认发送账本一并清除——当前页面内存态保留至关闭）`);
    setCleared(`${new Date().toLocaleTimeString()} 已清除活动命名空间键（重新写入将建立新快照）`);
    toast('本地草稿快照已清除', 'success');
  };
  const legacy = draftPersist.legacyImport;
  const doImport = async (key: string, dir: string) => {
    setImportBusy(key);
    try {
      const r = importLegacySnapshot(key, dir);
      if (!r.ok) { toast(userFacingSystemText(r.error ?? '导入失败'), 'error'); return; }
      const o = r.outcome;
      const refusedCount = o?.refusedVersions.length ?? 0;
      toast(`已导入 ${dir} 的旧键：草稿 ${o?.mergedDrafts ?? 0} 条、待确认发送 ${o?.mergedSends ?? 0} 条${refusedCount > 0 ? `、拒收不支持版本来源 ${refusedCount} 个（原件保持）` : ''}——旧键原样保留`, 'success');
      recordWrite('draft.inherit', `用户确认导入旧目录 ${dir}（结果见恢复说明；原件保留）`);
    } finally { setImportBusy(null); }
  };
  return (
    <div>
      <SectionHead title="数据与存储" sub={<>数据位置、草稿快照健康与清理。</>} />
      <ReadOnlyRow label="当前数据位置" value={identity?.appDataDir ?? '（读取中…）'} />
      <div className="card" style={{ marginBottom: 14 }} data-zs-data-guide="1">
        <div className="card-title">备份全部数据与使用已有数据</div>
        <div className="small muted" style={{padding:'0 14px 8px',lineHeight:1.7}}>
          备份会完整保留对话、附件、草稿、本地账号资料和设置。请像保管自己的文件一样妥善保管备份。
        </div>
        <SettingsRow label="备份全部数据" hint="选择保存位置；众说正常关闭后复制并逐个核对，原件不会移动或删除" control={
          <button className="btn primary sm" disabled={dataOpBusy != null} data-zs-data-backup="1" onClick={() => void startDataOp('backup')}>
            <Icon name="download" size={13} /> {dataOpBusy === 'backup' ? '正在准备…' : '备份全部数据'}
          </button>
        } />
        <SettingsRow label="使用已有数据或从备份恢复" hint="选择旧包、数据文件夹或完整备份，再选择新副本保存位置；验证成功后才切换" control={
          <button className="btn sm" disabled={dataOpBusy != null} data-zs-data-import="1" onClick={() => void startDataOp('import')}>
            <Icon name="folder" size={13} /> {dataOpBusy === 'import' ? '正在准备…' : '选择已有数据'}
          </button>
        } />
        <SettingsRow label="最近一次数据操作" hint="完成事实会在这里重新读取；失败或中断不会自动重试" control={
          <div className="col" style={{alignItems:'flex-end',gap:5,minWidth:230}}>
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
      <SettingsRow label="草稿快照健康" hint="草稿/未确认发送账本的持久化状态（刷新/崩溃后保留；普通草稿 24 小时过期）">
        <div className="small" style={{ lineHeight: 1.7 }}>
          {draftPersist.mode === 'on' && draftPersist.error == null ? <Tag tone="success" icon="check-circle">正常</Tag> : null}
          {draftPersist.mode === 'locked' ? <Tag tone="warning" icon="alert-triangle">保全锁定（主键已保全不覆盖；发送暂不可用）</Tag> : null}
          {draftPersist.mode === 'off' ? <Tag tone="warning" icon="alert-triangle">不可用（{userFacingSystemText(draftPersist.error ?? '身份/存储未就绪')}）</Tag> : null}
          {draftPersist.mode === 'on' && draftPersist.error != null ? <Tag tone="warning" icon="alert-triangle">写入失败（{userFacingSystemText(draftPersist.error ?? '')}）</Tag> : null}
        </div>
      </SettingsRow>
      {draftPersist.recoveryNote != null ? (
        <div className="small faint" style={{ padding: '0 14px 6px' }} data-zs-draft-recovery-note="1">{draftPersist.recoveryNote}</div>
      ) : null}
      <SettingsRow label="重试 / 清理" hint="锁定后释放存储可重试初始化；清理=删除当前活动命名空间的草稿快照键（不可恢复）">
        <div className="row tight">
          <button className="btn sm" data-zs-draft-retry="1" onClick={() => { retryDraftPersistence(); toast('已重试草稿快照初始化——状态按上方显示为准', 'info'); }}>重试快照</button>
          <button className="btn sm" onClick={clearDrafts}>清理本地草稿</button>
        </div>
      </SettingsRow>
      {cleared != null ? <div className="small faint" style={{ padding: '0 14px 6px' }}>{cleared}</div> : null}
      <SettingsRow
        label="旧数据目录继承"
        hint="首次从 v3/v4 升级或整目录复制后，旧草稿/未确认发送账本的导入入口（旧数据根没有身份标记——不能自动确认同根，由你逐键确认）"
      >
        <div className="small" style={{ lineHeight: 1.7, minWidth: 320 }}>
          <div className="row tight">
            <button className="btn sm" data-zs-legacy-rescan="1" onClick={() => { void rescanLegacyImport().then(() => toast('已重扫旧命名空间键——结果按下方候选为准', 'info')); }}>重扫旧目录</button>
          </div>
          {legacy == null || legacy.candidates.length === 0 ? (
            <div className="faint" style={{ marginTop: 4 }}>当前没有待确认的旧目录候选（自动继承通道：同目录升级/逻辑身份同根——无需人工确认）。</div>
          ) : (
            <div className="col" style={{ gap: 6, marginTop: 6 }} data-zs-legacy-candidates="1">
              {legacy.error != null ? <div style={{ color: 'var(--warning,#b45309)' }}>上次扫描：{userFacingSystemText(legacy.error ?? '')}</div> : null}
              {legacy.candidates.map((c) => (
                <div key={c.key} className="row tight" style={{ padding: '4px 6px', border: '1px solid var(--border,#dbe2ea)', borderRadius: 6 }} data-zs-legacy-candidate={c.dir}>
                  <Icon name="folder" size={12} />
                  <span className="mono-sm" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.key}>{c.dir}</span>
                  {c.hasStateDb === true ? <Tag tone="info">含数据根</Tag> : c.hasStateDb === false ? <Tag tone="neutral">目录无 state.sqlite</Tag> : null}
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
      {/* 归档管理（R66 P4：R65 起命令面已具备——project.lifecycle/room.archive；此前误标
          「未接入」，现按原型嵌入同一管理器，与 /archive 独立页共用状态与动作）。 */}
      <SettingsRow id="归档管理" label="归档管理" hint="查看已归档项目和房间的历史，或恢复使用；已有文件与记录会保留">
        <div style={{ marginTop: 6 }}>
          <ArchiveManager embedded />
        </div>
      </SettingsRow>
      <SettingsRow id="已移除的项目" label="已移除的项目" hint="移除=只在应用里解除关联（磁盘与历史不动）——在欢迎页「打开本地文件夹」重新打开同目录即恢复原 projectId">
        <button className="btn sm" onClick={() => navigate('/welcome')}>去欢迎页重新关联…</button>
      </SettingsRow>
    </div>
  );
}

/* ============================================================ 分区：帮助与关于 ============================================================ */

function SectionGuide() {
  const theme = useStore(s => s.ui.theme);
  const frame = useRef<HTMLIFrameElement>(null);
  const syncTheme = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (doc) doc.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(syncTheme, [syncTheme]);
  return (
    <section className="settings-guide" data-settings-row="user-guide" aria-label="操作手册">
      <iframe ref={frame} title="众说操作手册" src="user-guide/index.html" sandbox="allow-same-origin" onLoad={syncTheme} />
    </section>
  );
}

function SectionHelp() {
  const [identity, setIdentity] = useState<{ localUserId: string; appDataDir: string } | null>(null);
  useEffect(() => {
    let done = false;
    void command<{ localUserId: string; appDataDir: string }>('app.identity', {}).then((r) => { if (!done) setIdentity(r); }).catch(() => { /* 不显示 */ });
    return () => { done = true; };
  }, []);
  return (
    <div>
      <SectionHead title="帮助与关于" sub={<>版本与诊断。</>} />
      <LocalDiagnostics />
      <ReadOnlyRow label="应用" value="众说 · 本地多成员协作工作台" />
      <ReadOnlyRow label="当前文件位置" value={identity?.appDataDir ?? '（读取中…）'} />
      <DetailFold summary="本机诊断详情">
        <div className="mono faint small" style={{ lineHeight: 1.8 }}>
          <div>本机用户 ID：{identity?.localUserId ?? '?'}</div>
          <div>本地偏好键：zs.hifi.persist.{identity ? `${identity.appDataDir}|${identity.localUserId}` : '?'}</div>
        </div>
      </DetailFold>
      <div className="small faint" style={{ padding: '6px 14px' }}>遇到问题把上面诊断信息与操作步骤一起反馈即可；不自动上传任何数据。</div>
    </div>
  );
}
