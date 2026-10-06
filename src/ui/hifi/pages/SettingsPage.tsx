/**
 * 应用设置（R64 原型还原）：**壳=已批准原型**（七项导航 + 搜索 + 分区副标题 + 设置行组件
 * §3.1/§3.4/§17.8）；**内容=真实能力**——已接命令的设置读写并回读核对（app.settings /
 * 主题 / runtime 绑定 / 数据与草稿存储 / 远程监听事实 / BUILD 身份）；后端没有的能力在
 * 原型位置**禁用并说明**（通知偏好、托盘/自启、配对码、MCP 接入），不用模拟值冒充实际值。
 * 项目设置独立于 /project/:id/settings（原归属保持——本页只放应用级）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore, toast } from '../shell';
import { SettingsRow, SwitchRow, ReadOnlyRow, DetailFold } from '../components/SettingsRow';
import { recordWrite, retryDraftPersistence, setTheme } from '../data/store';
import { command } from '../bridge';
import { navigate } from '../lib/router';
import { refreshMembers } from '../loader';

export type AppSettingsSection =
  | 'general' | 'appearance' | 'notifications' | 'runtime' | 'connections' | 'data' | 'help';

/** 旧写法 → 现分区（§3.4 深链兼容）。 */
const SECTION_ALIASES: Record<string, AppSettingsSection> = {
  general: 'general', appearance: 'appearance', notifications: 'notifications',
  runtime: 'runtime', connections: 'connections', data: 'data', help: 'help',
  app: 'general', lan: 'connections', archive: 'data', archived: 'data', diagnostics: 'help', errors: 'help',
};

export function appSectionOf(raw: string | undefined): AppSettingsSection {
  return (raw && SECTION_ALIASES[raw]) || 'general';
}

type NavItem = { key: AppSettingsSection; label: string; icon: string; hint: string };

const NAV: NavItem[] = [
  { key: 'general', label: '通用', icon: 'settings', hint: '启动、界面行为、打开定位' },
  { key: 'appearance', label: '外观', icon: 'sun', hint: '主题：浅色 / 深色' },
  { key: 'notifications', label: '通知', icon: 'bell', hint: '事件提醒与免打扰；房间静音/线程关注在各自 ⋯ 菜单' },
  { key: 'runtime', label: 'AI 工具', icon: 'cpu', hint: '成员 runtime 绑定、模型与派发防护（应用级）' },
  { key: 'connections', label: '连接与设备', icon: 'monitor', hint: '本机身份与远程访问监听事实（只读）；配对/MCP 未接' },
  { key: 'data', label: '数据与存储', icon: 'layers', hint: '数据位置、草稿快照健康、清理本地草稿' },
  { key: 'help', label: '帮助与关于', icon: 'help-circle', hint: '版本与构建身份、诊断、打开定位' },
];

/** 搜索索引：只索引**真实存在**的项（未接能力的行也如实列出并标注「未接入」）。 */
type SearchEntry = { section: AppSettingsSection; label: string; keywords: string; match: string };
const SEARCH_INDEX: SearchEntry[] = [
  { section: 'general', label: '启动时打开的项目', keywords: '启动 打开 项目 自动 路径', match: '启动时打开的项目' },
  { section: 'general', label: '打开定位（#task= 等深链）', keywords: '定位 深链 task 链接 跳转', match: '打开定位' },
  { section: 'appearance', label: '主题（深色外观）', keywords: '外观 主题 深色 浅色 暗色', match: '深色外观' },
  { section: 'notifications', label: '通知偏好（事件/渠道/免打扰）', keywords: '通知 静音 免打扰 渠道', match: '通知偏好' },
  { section: 'runtime', label: '成员 runtime 绑定与派发防护', keywords: 'runtime 工具 模型 绑定 codex claude fake 防护', match: '成员 runtime 绑定' },
  { section: 'connections', label: '本机身份与数据根', keywords: '身份 用户 数据根 appdata localuserid', match: '本机身份' },
  { section: 'connections', label: '远程访问监听事实', keywords: '远程 局域网 lan 证书 指纹 监听', match: '远程访问' },
  { section: 'data', label: '数据位置（应用数据目录）', keywords: '数据 目录 位置 路径', match: '应用数据目录' },
  { section: 'data', label: '草稿快照健康与重试', keywords: '草稿 快照 保存 锁定 重试', match: '草稿快照' },
  { section: 'data', label: '清理本地草稿', keywords: '清理 删除 草稿 本地', match: '清理本地草稿' },
  { section: 'help', label: '版本与构建身份', keywords: '版本 构建 build 关于', match: '版本与构建' },
  { section: 'help', label: '诊断信息（工程键名）', keywords: '诊断 键名 工程 排障', match: '诊断信息' },
];

function SectionHead({ title, sub }: { title: string; sub: React.ReactNode }) {
  return (
    <div className="settings-section-head">
      <div className="settings-section-title">{title}</div>
      <div className="settings-section-sub">{sub}</div>
    </div>
  );
}

/** 未接能力的统一说明行（原型的 SettingsRow 位置，如实禁用）。 */
function NotConnectedRow({ label, hint }: { label: string; hint: string }) {
  return (
    <SettingsRow label={label} hint={hint}>
      <Tag tone="neutral" icon="slash">未接入</Tag>
    </SettingsRow>
  );
}
import { Tag } from '../components/ui';

export function SettingsPage({ query }: { query?: Record<string, string> }) {
  const s = useStore((x) => x);
  const q = query ?? {};
  const section = appSectionOf(q.section);
  const [search, setSearch] = useState('');
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const go = (next: AppSettingsSection) => navigate(`/settings?section=${next}`, { replace: true });
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
    return SEARCH_INDEX.filter((e) => e.label.toLowerCase().includes(kw) || e.keywords.toLowerCase().includes(kw));
  }, [search]);

  return (
    <div className="main">
      <div className="page">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分区">
            <div className="settings-search">
              <div className="row tight">
                <Icon name="search" size={13} className="faint" />
                <input
                  className="input sm"
                  placeholder="搜设置项：启动、草稿、通知…"
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
                    没找到匹配的设置项。这里只索引已经做好的项——没做的不会用"即将支持"占位。
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
            {section === 'help' ? <SectionHelp /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function findByLabel(text: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('.settings-body .row, .settings-body .settings-row, .settings-body label');
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
  const [deepLinkInput, setDeepLinkInput] = useState('');
  const genRef = useRef(0);
  const reload = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const r = await command<{ values: Record<string, string | null> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath'] });
      if (gen !== genRef.current) return;
      setAutoOpen(r.values['ui.autoOpenProjectPath'] ?? '');
      setAutoOpenSaved(r.values['ui.autoOpenProjectPath'] ?? '');
    } catch { /* 读取失败保持空态 */ }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const save = async () => {
    if (autoOpen.trim().length === 0) { toast('值不能为空（如需默认行为请保持原值）', 'warn'); return; }
    setBusy(true);
    try {
      await command('app.settings.set', { key: 'ui.autoOpenProjectPath', value: autoOpen.trim() });
      const back = await command<{ values: Record<string, string | null> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath'] });
      const readBack = back.values['ui.autoOpenProjectPath'] ?? '';
      if (readBack !== autoOpen.trim()) { toast(`保存后回读不一致（读到「${readBack}」）——未伪成功`, 'error'); return; }
      recordWrite('app.settings.set', `启动项目 = ${readBack}（已回读核对）`);
      setAutoOpenSaved(readBack);
      toast('已保存（回读一致，重启后生效）', 'success');
    } catch (e) { toast(`保存失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(false); }
  };
  const openDeepLink = async () => {
    const { openExternalDeepLink } = await import('../loader');
    const raw = deepLinkInput.trim();
    if (!raw.startsWith('#')) { toast('定位链接格式应为 #task=… / #delivery=… / #msg=… / #dm=…（从线程详情「复制定位链接」获得）', 'warn'); return; }
    try { await openExternalDeepLink(raw); toast('已定位', 'success'); }
    catch (e) { toast(`定位失败：${(e as Error).message}`, 'error'); }
  };
  return (
    <div>
      <SectionHead title="通用" sub={<>整个软件的启动与界面行为。<span className="faint">想改某个项目：侧栏项目行 ⋯ → 项目设置。</span></>} />
      <SettingsRow label="启动时打开的项目" hint="留空=上次状态；填写项目文件夹完整路径（保存后回读核对，重启生效）">
        <div className="row tight" style={{ minWidth: 260 }}>
          <input className="input sm" style={{ minWidth: 200 }} value={autoOpen} onChange={(e) => setAutoOpen(e.target.value)} placeholder="例如 D:\项目\我的项目" />
          <button className="btn sm" disabled={busy || autoOpen.trim() === (autoOpenSaved ?? '')} onClick={() => void save()}>保存</button>
        </div>
      </SettingsRow>
      <SettingsRow label="打开定位" hint="桌面端没有地址栏——粘贴「复制定位链接」产出的 #task=… 等深链（deepLink.resolve 正式定位）">
        <div className="row tight" style={{ minWidth: 260 }}>
          <input className="input sm" style={{ minWidth: 200 }} placeholder="如 #task=task_ab12…" value={deepLinkInput} onChange={(e) => setDeepLinkInput(e.target.value)} />
          <button className="btn sm" onClick={() => void openDeepLink()}>打开</button>
        </div>
      </SettingsRow>
      <NotConnectedRow label="开机自动启动 / 托盘常驻" hint="系统桥（开机项/托盘）尚未接入本包——不显示可切换的假开关" />
      <NotConnectedRow label="重启后自动继续任务" hint="保持关闭（E7 不自动续跑——恢复中心需显式确认）；设置化命令未接" />
      <NotConnectedRow label="应用级运行并发上限" hint="调度器限额命令尚未接入（§10.3 决策 12 的配置面）——当前按服务端默认执行" />
    </div>
  );
}

/* ============================================================ 分区：外观 ============================================================ */

function SectionAppearance() {
  const theme = useStore((s) => s.ui.theme);
  return (
    <div>
      <SectionHead title="外观" sub={<>界面主题（本机偏好，立即生效并随数据根记忆）。</>} />
      <SettingsRow label="主题" hint="浅色 / 深色">
        <div className="seg" role="group" aria-label="主题">
          <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>浅色</button>
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>深色</button>
        </div>
      </SettingsRow>
    </div>
  );
}

/* ============================================================ 分区：通知 ============================================================ */

function SectionNotifications() {
  return (
    <div>
      <SectionHead title="通知" sub={<>应用级通知偏好。<span className="faint">房间静音与线程关注是同一套订阅——在各串 ⋯ 菜单里切换（thread.subscribe，已接真实命令）。</span></>} />
      <NotConnectedRow label="全部静音 / 免打扰时段" hint="应用级通知聚合命令尚未接入本包——不显示可切换的假开关" />
      <NotConnectedRow label="哪些事提醒我（审批/失败/完成/提及）" hint="事件订阅的写入命令尚未接入；线程级关注/静音已可用（各串 ⋯ 菜单）" />
      <NotConnectedRow label="通知渠道与提示音" hint="系统通知桥尚未接入" />
      <ReadOnlyRow label="已可用的订阅操作" value="线程关注 / 线程静音（回复串 ⋯ 菜单，真实命令）" />
    </div>
  );
}

/* ============================================================ 分区：AI 工具 ============================================================ */

function SectionRuntime() {
  const members = useStore((s) => s.members.filter((m) => m.principalType === 'agent'));
  const runtimes = useStore((s) => s.memberRuntimes);
  const guard = useStore((s) => s.dispatchGuard);
  const projectId = useStore((s) => s.activeProjectId);
  return (
    <div>
      <SectionHead title="AI 工具" sub={<>成员 runtime 绑定与模型配置（应用级安装、成员级绑定）。<span className="faint">配置成功 ≠ 能力已认证；派发防护按本环境事实显示。</span></>} />
      <SettingsRow label="派发防护（本环境事实）" hint="runtime.status dispatchGuard——fake 是否允许、真实派发守卫是否开启">
        <div className="row tight">
          <Tag tone={guard?.fakeAllowed === false ? 'neutral' : 'warning'} icon={guard?.fakeAllowed === false ? 'check-circle' : 'alert-triangle'}>
            {guard == null ? '读取中…' : guard.fakeAllowed ? 'fake 允许（演练环境）' : 'fake 禁用（日常/正式）'}
          </Tag>
          <Tag tone={guard?.realDispatchGuard ? 'success' : 'neutral'} icon={guard?.realDispatchGuard ? 'check-circle' : 'info'}>
            {guard == null ? '' : guard.realDispatchGuard ? '真实派发守卫开启' : '真实派发守卫关闭'}
          </Tag>
        </div>
      </SettingsRow>
      {members.map((m) => {
        const rt = runtimes[m.id];
        return (
          <SettingsRow
            key={m.id}
            label={`成员「${m.displayName}」的 runtime`}
            hint={rt == null ? '读取中…' : rt.status === 'bound' ? `已绑定 ${rt.kind ?? '?'}${rt.model != null && rt.model !== '' ? ` · 模型 ${rt.model}` : ''}` : rt.status === 'unbound' ? '未绑定（发送区会提示原因）' : '绑定状态读取失败（unknown）'}
          >
            <button className="btn sm" onClick={() => navigate(projectId !== '' ? `/project/${projectId}/members` : '/members')}>
              {rt?.status === 'bound' ? '查看/修改' : '去配置'}
            </button>
          </SettingsRow>
        );
      })}
      <div className="small faint" style={{ padding: '6px 14px' }}>绑定/模型/权限的保存与回读在成员页（member.setRuntime——真实命令，保存后回读核对）。</div>
    </div>
  );
}

/* ============================================================ 分区：连接与设备 ============================================================ */

interface RemoteCfg { allowLan: boolean; running?: boolean; address?: string; fingerprint?: string; caFingerprint?: string; certNotAfter?: number; lanSelfCheck?: { ok: boolean; detail?: string } | null; note: string }

function SectionConnections() {
  const [identity, setIdentity] = useState<{ localUserId: string; appDataDir: string } | null>(null);
  const [remote, setRemote] = useState<RemoteCfg | null>(null);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  useEffect(() => {
    let done = false;
    void command<{ localUserId: string; appDataDir: string }>('app.identity', {}).then((r) => { if (!done) setIdentity(r); }).catch(() => { /* 不显示 */ });
    void command<RemoteCfg>('remote.config.get').then((r) => { if (!done) setRemote(r); }).catch((e: unknown) => { if (!done) setRemoteErr((e as Error).message); });
    return () => { done = true; };
  }, []);
  return (
    <div>
      <SectionHead title="连接与设备" sub={<>本机身份与远程访问监听事实（只读）。<span className="faint">配对/吊销与 MCP 接入的命令面未接本包——如实标注。</span></>} />
      <ReadOnlyRow label="本机用户（localUserId）" value={identity?.localUserId ?? '（读取中…）'} />
      <ReadOnlyRow label="数据根（appDataDir）" value={identity?.appDataDir ?? '（读取中…）'} />
      <SettingsRow label="远程访问（监听事实）" hint="remote.config.get 只读——变更在原界面「远程访问」">
        {remoteErr != null ? <Tag tone="danger">读取失败：{remoteErr.slice(0, 60)}</Tag> : remote == null ? <span className="faint small">读取中…</span> : (
          <div className="small" style={{ lineHeight: 1.7 }}>
            <div>{remote.allowLan ? '局域网' : '仅本机'} · {remote.running === true ? `运行中（${remote.address ?? '?'}）` : '未运行'}</div>
            {remote.fingerprint != null ? <div className="mono faint small">服务证书 {remote.fingerprint.slice(0, 24)}…{remote.caFingerprint != null ? ` · CA ${remote.caFingerprint.slice(0, 16)}…` : ''}</div> : null}
            {remote.lanSelfCheck != null ? <div className={remote.lanSelfCheck.ok ? 'faint small' : 'small'} style={{ color: remote.lanSelfCheck.ok ? undefined : 'var(--danger)' }}>LAN 自检：{remote.lanSelfCheck.ok ? '通过' : `失败（${remote.lanSelfCheck.detail ?? '?'}）`}</div> : null}
          </div>
        )}
      </SettingsRow>
      <NotConnectedRow label="生成配对码 / 已连接设备吊销" hint="设备配对命令面尚未接入本包" />
      <NotConnectedRow label="外部 AI 连接（MCP 授权范围）" hint="MCP 连接管理命令面尚未接入本包" />
    </div>
  );
}

/* ============================================================ 分区：数据与存储 ============================================================ */

function SectionData() {
  const draftPersist = useStore((st) => st.draftPersist);
  const [identity, setIdentity] = useState<{ localUserId: string; appDataDir: string } | null>(null);
  const [cleared, setCleared] = useState<string | null>(null);
  useEffect(() => {
    let done = false;
    void command<{ localUserId: string; appDataDir: string }>('app.identity', {}).then((r) => { if (!done) setIdentity(r); }).catch(() => { /* 不显示 */ });
    return () => { done = true; };
  }, []);
  const clearDrafts = () => {
    if (identity == null) { toast('数据根身份未就绪——无法定位草稿存储键', 'error'); return; }
    const key = `zs.hifi.persist.${identity.appDataDir}|${identity.localUserId}`;
    let removed = 0;
    try {
      removed = localStorage.getItem(key) == null ? 0 : 1;
      localStorage.removeItem(key);
      recordWrite('drafts.clear', `清空本地草稿快照键 ${key.slice(0, 40)}…（未确认发送账本一并清除——当前页面内存态保留至关闭）`);
      setCleared(`${new Date().toLocaleTimeString()} 已清除（重新写入将建立新快照）`);
      toast('本地草稿快照已清除', 'success');
    } catch (e) { toast(`清除失败：${(e as Error).message}`, 'error'); }
    if (removed === 0) { setCleared('没有已保存的草稿快照（键不存在）'); toast('没有已保存的草稿快照', 'info'); }
  };
  return (
    <div>
      <SectionHead title="数据与存储" sub={<>数据位置、草稿快照健康与清理。</>} />
      <ReadOnlyRow label="数据位置（应用数据目录）" value={identity?.appDataDir ?? '（读取中…）'} />
      <SettingsRow label="草稿快照健康" hint="草稿/未确认发送账本的持久化状态（刷新/崩溃后保留；普通草稿 24 小时过期）">
        <div className="small" style={{ lineHeight: 1.7 }}>
          {draftPersist.mode === 'on' && draftPersist.error == null ? <Tag tone="success" icon="check-circle">正常</Tag> : null}
          {draftPersist.mode === 'locked' ? <Tag tone="warning" icon="alert-triangle">保全锁定（主键已保全不覆盖；发送暂不可用）</Tag> : null}
          {draftPersist.mode === 'off' ? <Tag tone="warning" icon="alert-triangle">不可用（{draftPersist.error ?? '身份/存储未就绪'}）</Tag> : null}
          {draftPersist.mode === 'on' && draftPersist.error != null ? <Tag tone="warning" icon="alert-triangle">写入失败（{draftPersist.error}）</Tag> : null}
        </div>
      </SettingsRow>
      {draftPersist.recoveryNote != null ? (
        <div className="small faint" style={{ padding: '0 14px 6px' }} data-zs-draft-recovery-note="1">{draftPersist.recoveryNote}</div>
      ) : null}
      <SettingsRow label="重试 / 清理" hint="锁定后释放存储可重试初始化；清理=删除本地草稿快照键（不可恢复）">
        <div className="row tight">
          <button className="btn sm" data-zs-draft-retry="1" onClick={() => { retryDraftPersistence(); toast('已重试草稿快照初始化——状态按上方显示为准', 'info'); }}>重试快照</button>
          <button className="btn sm" onClick={clearDrafts}>清理本地草稿</button>
        </div>
      </SettingsRow>
      {cleared != null ? <div className="small faint" style={{ padding: '0 14px 6px' }}>{cleared}</div> : null}
      <NotConnectedRow label="备份与恢复（SQLite 快照）" hint="备份命令面尚未接入本包（升级回退演练已验证 VACUUM INTO 路径——正式入口未接）" />
      <NotConnectedRow label="归档管理 / 已移除项目" hint="项目归档/移除命令面尚未接入本包" />
    </div>
  );
}

/* ============================================================ 分区：帮助与关于 ============================================================ */

function SectionHelp() {
  const [identity, setIdentity] = useState<{ localUserId: string; appDataDir: string } | null>(null);
  useEffect(() => {
    let done = false;
    void command<{ localUserId: string; appDataDir: string }>('app.identity', {}).then((r) => { if (!done) setIdentity(r); }).catch(() => { /* 不显示 */ });
    return () => { done = true; };
  }, []);
  return (
    <div>
      <SectionHead title="帮助与关于" sub={<>版本、构建身份与诊断。</>} />
      <ReadOnlyRow label="应用" value="众说 · 本地多成员协作工作台" />
      <ReadOnlyRow label="界面" value="已批准原型还原版（R64）——正式链路 + 原型布局" />
      <ReadOnlyRow label="数据根" value={identity?.appDataDir ?? '（读取中…）'} />
      <DetailFold summary="诊断信息（工程键名——排障用，不是操作面）">
        <div className="mono faint small" style={{ lineHeight: 1.8 }}>
          <div>localUserId={identity?.localUserId ?? '?'}</div>
          <div>persistKey=zs.hifi.persist.{identity ? `${identity.appDataDir}|${identity.localUserId}` : '?'}</div>
          <div>命令面：app.identity/app.settings.get/set · member.list/setRuntime · runtime.status · room.pool · thread.get/history/subscribe/markRead · task.get/stop/review/executeRework · message.submit/react · saved.* · attachment.upload*/preview* · export.create · project.files.list/file.read · git.status/diff/stage/stageTask/unstage/commit/commitPreview/commitUndo/branch.*/checkout/push/pull/remoteHead/commitDiff/conflict.* · deepLink.resolve</div>
        </div>
      </DetailFold>
      <div className="small faint" style={{ padding: '6px 14px' }}>遇到问题把上面诊断信息与操作步骤一起反馈即可；不自动上传任何数据。</div>
    </div>
  );
}
