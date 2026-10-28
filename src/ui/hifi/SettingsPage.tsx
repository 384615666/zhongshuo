import { userFacingSystemText } from '../../contracts/userFacingText';
/**
 * 设置与帮助（第五十四轮 §4 重组）：按批准原型的「应用 / 项目」分区组织，**用户能理解的
 * 名称**承载操作；底层设置键/命令细节收进「诊断信息」折叠层（工程键不进操作面）。
 *  - 应用：启动时打开的项目（ui.autoOpenProjectPath——保存后**回读核对**）、显示仓库状态
 *    （repoStatus.visible——legacy 主池仓库条开关；true/false 白名单）。
 *  - 项目：当前项目事实（名称/路径）+ 任务验收策略只读（变更在原界面项目设置——实际入口
 *    按钮直达，不是一句说明）。
 *  - 远程访问：remote.config.get 实际监听事实（只读；变更给原界面直达入口）。
 *  - 打开定位：#task=… 深链粘贴（「复制定位链接」的配套入口——桌面端没有地址栏）。
 * 保存走正式 app.settings.set；失败真实上屏，不伪成功。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { useStore, toast } from './shell';
import { command } from './bridge';
import { openExternalDeepLink } from './loader';
import { isExternalDeepLink } from './lib/deepLink';
import { takeLegacy } from './App';
import { recordWrite, retryDraftPersistence } from './data/store';
import { navigate } from './lib/router';

interface RemoteCfg { allowLan: boolean; running?: boolean; address?: string; fingerprint?: string; caFingerprint?: string; certNotAfter?: number; lanSelfCheck?: { ok: boolean; detail?: string } | null; note: string }

export function SettingsPage() {
  const projectId = useStore((s) => s.activeProjectId);
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const [autoOpen, setAutoOpen] = useState<string>('');
  const [autoOpenSaved, setAutoOpenSaved] = useState<string | null>(null);
  const [repoVisible, setRepoVisible] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState<RemoteCfg | null>(null);
  /** r63：数据根/身份（app.identity——日常使用可查数据存哪）与草稿存储状态/重试。 */
  const [identity, setIdentity] = useState<{ localUserId: string; appDataDir: string } | null>(null);
  const draftPersist = useStore((st) => st.draftPersist);
  useEffect(() => {
    let done = false;
    void command<{ localUserId: string; appDataDir: string }>('app.identity', {})
      .then((r) => { if (!done) setIdentity(r); })
      .catch(() => { /* 读取失败=不显示，不冒充 */ });
    return () => { done = true; };
  }, []);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const [deepLinkInput, setDeepLinkInput] = useState('');
  const [diagOpen, setDiagOpen] = useState(false);
  const genRef = useRef(0);

  const reload = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const r = await command<{ values: Record<string, string | null> }>('app.settings.get', { keys: ['ui.autoOpenProjectPath', 'repoStatus.visible'] });
      if (gen !== genRef.current) return;
      setAutoOpen(r.values['ui.autoOpenProjectPath'] ?? '');
      setAutoOpenSaved(r.values['ui.autoOpenProjectPath'] ?? '');
      setRepoVisible(r.values['repoStatus.visible'] ?? '');
    } catch (e) { if (gen === genRef.current) toast(`应用设置读取失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); }
    try {
      const rc = await command<RemoteCfg>('remote.config.get');
      if (gen !== genRef.current) return;
      setRemote(rc); setRemoteErr(null);
    } catch (e) { if (gen === genRef.current) setRemoteErr((e as Error).message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  /** 保存+回读核对（§4：实际 UI 保存要核回读——设置成功以读回的值为准）。r55：成功后
   * **立即用回读值更新对应控件/显示**（此前 repoStatus.visible 只写库不更新页面——按钮与
   * 「当前」文字停在旧值，要手动刷新才一致，用户短测确认的缺陷）；失败保留编辑与真实错误。 */
  const saveSetting = async (key: 'ui.autoOpenProjectPath' | 'repoStatus.visible', value: string, label: string) => {
    if (value.trim().length === 0) { toast('值不能为空（此键不接受空串——如需默认行为请保持原值）', 'warn'); return; }
    setBusy(true);
    try {
      await command('app.settings.set', { key, value });
      const back = await command<{ values: Record<string, string | null> }>('app.settings.get', { keys: [key] });
      const readBack = back.values[key] ?? '';
      if (readBack !== value) { toast(`${label}：保存后的值与输入不一致（当前为「${readBack}」），请刷新后重试`, 'error'); return; }
      recordWrite('app.settings.set', `${label} = ${value}（已回读核对）`);
      // 成功即同步页面状态：显示文字与按钮可用性当场反映新值，不需要用户刷新。
      if (key === 'ui.autoOpenProjectPath') setAutoOpenSaved(readBack);
      if (key === 'repoStatus.visible') setRepoVisible(readBack);
      toast(`${label}已保存（已生效${key === 'ui.autoOpenProjectPath' ? '，重启后生效' : ''}）`, 'success');
    } catch (e) {
      toast(`${label}保存失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error');
    } finally { setBusy(false); }
  };
  const openDeepLink = async () => {
    const raw = deepLinkInput.trim();
    if (!isExternalDeepLink(raw)) { toast('定位链接格式应为 #task=… / #delivery=… / #msg=… / #dm=…（从线程详情「复制定位链接」获得）', 'warn'); return; }
    try { await openExternalDeepLink(raw); toast('已定位', 'success'); }
    catch (e) { toast(`定位失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); }
  };

  const dirty = autoOpen.trim() !== (autoOpenSaved ?? '');

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }} className="page-stack" data-zs-settings="hifi">
      <div className="row tight" style={{ marginBottom: 8 }}>
        <Icon name="settings" size={14} />
        <strong>设置与帮助</strong>
        <button className="btn ghost sm" onClick={() => void reload()}>刷新</button>
      </div>

      <div className="panel info">
        <div className="row tight"><strong>应用</strong></div>
        <div style={{ marginTop: 6 }}>
          <div className="faint small">启动时打开的项目（留空=上次状态；填写项目文件夹的完整路径）</div>
          <div className="row tight" style={{ marginTop: 4 }}>
            <input className="composer-input" style={{ flex: 1, minWidth: 160 }} value={autoOpen} onChange={(e) => setAutoOpen(e.target.value)} placeholder="例如 D:\\项目\\我的项目（保存后重启生效）" />
            <button className="btn ghost sm" disabled={busy || !dirty} title={dirty ? '保存' : '没有修改'} onClick={() => void saveSetting('ui.autoOpenProjectPath', autoOpen.trim(), '「启动时打开的项目」')}>保存</button>
          </div>
          <div className="faint small" style={{ marginTop: 4 }}>当前生效值：{autoOpenSaved != null && autoOpenSaved !== '' ? autoOpenSaved : '（未设置）'}</div>
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="faint small">主池顶部的仓库状态条（原界面「仓库状态」开关）</div>
          <div className="row tight" style={{ marginTop: 4 }}>
            <button className="btn ghost sm" disabled={busy || repoVisible === 'true'} onClick={() => void saveSetting('repoStatus.visible', 'true', '「显示仓库状态」')}>显示</button>
            <button className="btn ghost sm" disabled={busy || repoVisible === 'false'} onClick={() => void saveSetting('repoStatus.visible', 'false', '「显示仓库状态」')}>隐藏</button>
            <span className="faint small">当前：{repoVisible === 'false' ? '隐藏' : repoVisible === 'true' ? '显示' : '（未设置=默认显示）'}</span>
          </div>
        </div>
      </div>

      <div className="panel info" data-zs-settings-storage="1">
        <div className="row tight"><strong>数据与草稿存储</strong><span className="faint small">（数据根位置与草稿快照健康度——日常可查）</span></div>
        <div className="small" style={{ marginTop: 6, lineHeight: 1.8 }}>
          <div>数据根：<span className="mono small">{identity != null ? identity.appDataDir : '（读取中…）'}</span></div>
          <div className="faint small">本项目数据（消息/任务/附件/凭据）都存放在这个目录；不同安装/演练环境使用各自独立的数据根。</div>
          <div style={{ marginTop: 4 }}>草稿快照：
            {draftPersist.mode === 'on' && draftPersist.error == null ? <span className="faint small">正常（刷新/崩溃后草稿与未确认发送保留；普通草稿 24 小时过期）</span> : null}
            {draftPersist.mode === 'locked' ? <span className="panel warning" style={{ display: 'inline-block', padding: '2px 8px' }}>保全锁定——快照无法恢复且原件未能隔离：主键已保全（不覆盖），新写入仅内存态，发送暂不可用</span> : null}
            {draftPersist.mode === 'off' ? <span className="panel warning" style={{ display: 'inline-block', padding: '2px 8px' }}>不可用（{userFacingSystemText(draftPersist.error ?? '身份/存储未就绪')}）——草稿仅本次进程内有效</span> : null}
            {draftPersist.mode === 'on' && draftPersist.error != null ? <span className="panel warning" style={{ display: 'inline-block', padding: '2px 8px' }}>写入失败（{userFacingSystemText(draftPersist.error ?? '')}）——内存仍有效</span> : null}
          </div>
          {draftPersist.recoveryNote != null ? <div className="faint small" data-zs-draft-recovery-note="1">{draftPersist.recoveryNote}</div> : null}
          {draftPersist.mode !== 'on' || draftPersist.error != null || draftPersist.recoveryNote != null ? (
            <div className="row tight" style={{ marginTop: 4 }}>
              <button className="btn ghost sm" data-zs-draft-retry="1" title="重试草稿快照初始化（如已释放存储空间：原件隔离→恢复→建立新快照）" onClick={() => { retryDraftPersistence(); toast('已重试草稿快照初始化——状态按上方显示为准', 'info'); }}>重试草稿存储</button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="panel info">
        <div className="row tight"><strong>项目</strong></div>
        <div className="small" style={{ marginTop: 6, lineHeight: 1.8 }}>
          <div>当前项目：{project != null ? `${project.displayName}` : '（未打开）'}{project != null && (project.rootPath ?? '') !== '' ? <span className="faint small">（{project.rootPath}）</span> : null}</div>
          <div className="faint small">成员 runtime 绑定/模型已在新界面成员页；任务验收策略等其余项目级设置在原界面「项目设置」：</div>
          <div className="row tight" style={{ marginTop: 4 }}>
            <button className="btn ghost sm" onClick={() => navigate('/members')}>成员与 runtime 绑定（成员页）</button>
            <button className="btn ghost sm" onClick={() => takeLegacy('members')}>其余项目设置（原界面）</button>
          </div>
        </div>
      </div>

      <div className="panel info">
        <div className="row tight"><strong>远程访问</strong><span className="faint small">（实际监听事实——只读）</span></div>
        {remoteErr != null ? <div className="panel warning" style={{ marginTop: 6 }}>远程配置读取失败：{userFacingSystemText(remoteErr ?? '')}</div> : remote == null ? <div className="faint small" style={{ marginTop: 4 }}>读取中…</div> : (
          <div className="small" style={{ marginTop: 6, lineHeight: 1.8 }}>
            <div>模式：{remote.allowLan ? '局域网' : '仅本机'} · 状态：{remote.running === true ? `运行中（${remote.address ?? '?'}）` : '未运行'}</div>
            {remote.fingerprint != null ? <div className="mono faint small">服务证书指纹 {remote.fingerprint.slice(0, 24)}…{remote.caFingerprint != null ? ` · CA ${remote.caFingerprint.slice(0, 16)}…` : ''}</div> : null}
            {remote.certNotAfter != null ? <div className="faint small">证书有效期至 {new Date(remote.certNotAfter).toLocaleDateString()}</div> : null}
            {remote.lanSelfCheck != null ? <div className={remote.lanSelfCheck.ok ? 'faint small' : 'panel warning'}>LAN 自检：{remote.lanSelfCheck.ok ? '通过' : `失败（${remote.lanSelfCheck.detail ?? '?'}）`}</div> : null}
            <div className="faint small">{remote.note}</div>
            <div className="row tight" style={{ marginTop: 4 }}>
              <button className="btn ghost sm" onClick={() => takeLegacy('remote')}>变更远程设置（原界面）</button>
            </div>
          </div>
        )}
      </div>

      <div className="panel info">
        <div className="row tight"><strong>打开定位</strong><span className="faint small">（桌面端没有地址栏——粘贴「复制定位链接」产出的 #task=… 等深链）</span></div>
        <div className="row tight" style={{ marginTop: 6 }}>
          <input className="composer-input" style={{ flex: 1, minWidth: 160 }} placeholder="如 #task=task_ab12…（线程详情 →「复制定位链接」）" value={deepLinkInput} onChange={(e) => setDeepLinkInput(e.target.value)} />
          <button className="btn ghost sm" onClick={() => void openDeepLink()}>打开定位</button>
        </div>
        <div className="faint small" style={{ marginTop: 4 }}>粘贴任务链接后，可直接打开对应的项目和对话。</div>
      </div>

      <details className="panel info" open={diagOpen} onToggle={(e) => setDiagOpen((e.target as HTMLDetailsElement).open)}>
        <summary style={{ cursor: 'pointer' }}><strong>诊断信息</strong><span className="faint small">（排查问题时查看）</span></summary>
        <div className="mono faint small" style={{ marginTop: 6, lineHeight: 1.8 }}>
          <div>app.settings 键：ui.autoOpenProjectPath={autoOpenSaved ?? ''} · repoStatus.visible={repoVisible === '' ? '(未设置)' : repoVisible}</div>
          <div>projectId={projectId ?? '（未打开）'}</div>
          <div>设置、远程连接和页面读取的诊断信息</div>
        </div>
      </details>

      <div className="panel info">
        <div className="row tight"><strong>其他设置</strong></div>
        <div className="row tight wrap" style={{ marginTop: 6 }}>
          <button className="btn ghost sm" onClick={() => takeLegacy('remote')}>远程访问变更（原界面）</button>
        </div>
        <div className="faint small" style={{ marginTop: 4 }}>成员 runtime 绑定、搜索与收藏、活动流、Git 历史（只读）已在新界面；线程「成果与附件」为线程内真实标签。</div>
      </div>
    </div>
  );
}
