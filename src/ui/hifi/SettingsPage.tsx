/**
 * 设置与帮助（H3 第一批，第五十三轮）：应用/项目/远程按原型设置导航归位——首版接**真实**
 * 只读写通道：
 *  - 应用：`app.settings.get/set`（ui.autoOpenProjectPath 可编辑保存——daemon 白名单键；
 *    repoStatus.visible 如实展示）。
 *  - 远程：`remote.config.get` 实际监听事实分层呈现（running/address/指纹/LAN 自检——只读，
 *    变更经原界面远程面板：remote.config.set 在本页不接写，避免双入口口径漂移）。
 *  - 打开定位：粘贴 #task=/#delivery=/#msg=/#dm= 深链 → 正式 deepLink.resolve 定位（桌面端
 *    没有地址栏——这是「复制定位链接」的配套粘贴入口，r53 §5/T6）。
 *  未换装项（成员管理/提醒/搜索等）如实列出并给「原界面」定向入口。
 */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './components/Icon';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { openExternalDeepLink } from './loader';
import { isExternalDeepLink } from './lib/deepLink';
import { takeLegacy } from './App';

interface RemoteCfg { enabled?: boolean; allowLan: boolean; port?: number; running?: boolean; address?: string; fingerprint?: string; caFingerprint?: string; lanAddresses?: string[]; certNotAfter?: number; certSubject?: string; certIssuer?: string; lanSelfCheck?: { ok: boolean; detail?: string } | null; note: string }

export function SettingsPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const [autoOpen, setAutoOpen] = useState<string>('');
  const [repoVisible, setRepoVisible] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [remote, setRemote] = useState<RemoteCfg | null>(null);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const [deepLinkInput, setDeepLinkInput] = useState('');

  const reload = useCallback(async () => {
    try {
      const r = await command<{ values: Record<string, string | null> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath', 'repoStatus.visible'] });
      setAutoOpen(r.values['ui.autoOpenProjectPath'] ?? '');
      setRepoVisible(r.values['repoStatus.visible'] ?? '');
    } catch (e) { toast(`应用设置读取失败：${(e as Error).message}`, 'error'); }
    try {
      setRemote(await command<RemoteCfg>('remote.config.get'));
      setRemoteErr(null);
    } catch (e) { setRemoteErr((e as Error).message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const saveAutoOpen = async () => {
    const v = autoOpen.trim();
    if (v.length === 0) { toast('路径为空——如需清除自动打开请填一个有效目录（daemon 白名单不接受空值）', 'warn'); return; }
    setSaving(true);
    try {
      await command('app.settings.set', { key: 'ui.autoOpenProjectPath', value: v });
      toast('已保存（重启后生效）', 'success');
    } catch (e) { toast(`保存失败：${(e as Error).message}`, 'error'); }
    finally { setSaving(false); }
  };
  const openDeepLink = async () => {
    const raw = deepLinkInput.trim();
    if (!isExternalDeepLink(raw)) { toast('定位链接格式应为 #task=… / #delivery=… / #msg=… / #dm=…（从线程详情「复制定位链接」获得）', 'warn'); return; }
    try {
      await openExternalDeepLink(raw);
      toast('已定位', 'success');
    } catch (e) { toast(`定位失败：${(e as Error).message}`, 'error'); }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }} className="page-stack" data-zs-settings="hifi">
      <div className="row tight" style={{ marginBottom: 8 }}>
        <Icon name="settings" size={14} />
        <strong>设置与帮助</strong>
        <button className="btn ghost sm" onClick={() => void reload()}>刷新</button>
      </div>

      <div className="panel info">
        <div className="row tight"><strong>打开定位</strong><span className="faint small">（桌面端没有地址栏——粘贴「复制定位链接」产出的 #task=… 等深链）</span></div>
        <div className="row tight" style={{ marginTop: 6 }}>
          <input className="composer-input" style={{ flex: 1, minWidth: 160 }} placeholder="如 #task=task_ab12…（线程详情 →「复制定位链接」）" value={deepLinkInput} onChange={(e) => setDeepLinkInput(e.target.value)} />
          <button className="btn ghost sm" onClick={() => void openDeepLink()}>打开定位</button>
        </div>
        <div className="faint small" style={{ marginTop: 4 }}>经正式 deepLink.resolve 服务端定位（跨项目自动打开）——未知归属如实报错，不静默跳转。</div>
      </div>

      <div className="panel info">
        <div className="row tight"><strong>应用</strong></div>
        <div style={{ marginTop: 6 }}>
          <div className="faint small">启动时自动打开的项目目录（daemon 白名单键 ui.autoOpenProjectPath）</div>
          <div className="row tight" style={{ marginTop: 4 }}>
            <input className="composer-input" style={{ flex: 1, minWidth: 160 }} value={autoOpen} onChange={(e) => setAutoOpen(e.target.value)} placeholder="D:\\path\\to\\project" />
            <button className="btn ghost sm" disabled={saving} onClick={() => void saveAutoOpen()}>{saving ? '保存中…' : '保存'}</button>
          </div>
          <div className="faint small" style={{ marginTop: 4 }}>repoStatus.visible（原界面仓库条常驻开关）当前值：{repoVisible === '' ? '（未设置=默认）' : repoVisible}</div>
        </div>
      </div>

      <div className="panel info">
        <div className="row tight"><strong>远程访问</strong><span className="faint small">（实际监听事实——只读；变更经原界面远程面板）</span></div>
        {remoteErr != null ? <div className="panel warning" style={{ marginTop: 6 }}>远程配置读取失败：{remoteErr}</div> : remote == null ? <div className="faint small" style={{ marginTop: 4 }}>读取中…</div> : (
          <div className="small" style={{ marginTop: 6, lineHeight: 1.8 }}>
            <div>模式：{remote.allowLan ? '局域网' : '仅本机'} · 状态：{remote.running === true ? `运行中（${remote.address ?? '?'}）` : '未运行'}</div>
            {remote.fingerprint != null ? <div className="mono faint small">服务证书指纹 {remote.fingerprint.slice(0, 24)}…{remote.caFingerprint != null ? ` · CA ${remote.caFingerprint.slice(0, 16)}…` : ''}</div> : null}
            {remote.certNotAfter != null ? <div className="faint small">证书有效期至 {new Date(remote.certNotAfter).toLocaleDateString()}</div> : null}
            {remote.lanSelfCheck != null ? <div className={remote.lanSelfCheck.ok ? 'faint small' : 'panel warning'}>LAN 自检：{remote.lanSelfCheck.ok ? '通过' : `失败（${remote.lanSelfCheck.detail ?? '?'}）`}</div> : null}
            <div className="faint small">{remote.note}</div>
          </div>
        )}
      </div>

      <div className="panel info">
        <div className="row tight"><strong>未换装项（如实）</strong></div>
        <div className="faint small" style={{ marginTop: 4 }}>以下能力仍在原界面（定向打开，不丢失落点）：</div>
        <div className="row tight wrap" style={{ marginTop: 6 }}>
          <button className="btn ghost sm" onClick={() => takeLegacy('members')}>成员管理</button>
          <button className="btn ghost sm" onClick={() => takeLegacy('search')}>搜索与收藏</button>
          <button className="btn ghost sm" onClick={() => takeLegacy('pending')}>待我处理</button>
          <button className="btn ghost sm" onClick={() => takeLegacy('remote')}>远程访问设置（变更）</button>
        </div>
        <div className="faint small" style={{ marginTop: 6 }}>当前项目：{projectId != null && projectId !== '' ? projectId : '（未打开）'} · 数据与命令全部走正式链。</div>
      </div>
    </div>
  );
}
