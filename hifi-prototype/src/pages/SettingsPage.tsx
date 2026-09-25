/**
 * 应用设置（第十六批 §17.8：只保留整个软件的配置）
 *
 * 第十六批把它**收窄为纯应用级**：
 *  - 删掉「当前项目」分组、项目选择器、以及任务验收/协作限制/文件写入等项目分区
 *    —— 那些移到了 `/project/:projectId/settings`（见 ProjectSettingsPage）。
 *
 * 为什么这样更清楚：项目设置与应用设置混在一页时，只能反复用分组标题和副标题
 * 去解释"这项影响项目、那项影响应用"；拆开后用户的心智模型是直接的：
 * **想改某个项目，去那个项目旁边（⋯ → 项目设置）；想改整个软件，点底部设置。**
 *
 * 保留原有左侧分类导航（用户已认可该形态），但只剩四个应用级分区：
 * 通用 / 执行工具 / 设备与局域网 / 诊断与帮助。
 * 「错误码速查」并入「诊断与帮助」作为可展开内容，旧 `section=errors` 深链仍精确定位。
 */

import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Avatar, Switch, Tag } from '../components/ui';
import { useStore, toast, setAppSetting, setTheme, resetStore } from '../data/store';
import {
  exportDiagnostics, generatePairingCode, revokeDevice, rotateToken, testAdminBoundary,
} from '../data/actions';
import { errorCopy } from '../lib/format';
import { navigate } from '../lib/router';
import { RuntimePanel } from './pages-misc';
import type { AppState, ErrorCode } from '../data/types';

/* ============================================================
   分区定义（只有应用级）
   ============================================================ */

export type AppSettingsSection = 'general' | 'runtime' | 'lan' | 'diagnostics';

/** 旧写法 → 新分区。第十六批把 errors 并入 diagnostics，其余保持应用分区。 */
const SECTION_ALIASES: Record<string, AppSettingsSection> = {
  general: 'general',
  runtime: 'runtime',
  lan: 'lan',
  diagnostics: 'diagnostics',
  // 旧写法兼容
  app: 'general',
  // errors 不再独占分区，落到 diagnostics 并展开速查（§17.8 兼容表）
  errors: 'diagnostics',
};

export function appSectionOf(raw: string | undefined): AppSettingsSection {
  return (raw && SECTION_ALIASES[raw]) || 'general';
}

const NAV = [
  { key: 'general' as const, label: '通用', icon: 'settings', hint: '启动、托盘、数据存放位置' },
  { key: 'runtime' as const, label: '执行工具', icon: 'cpu', hint: 'Codex / Claude CLI 的检测、登录与认证状态' },
  { key: 'lan' as const, label: '设备与局域网', icon: 'monitor', hint: '配对局域网设备、吊销设备、轮换令牌' },
  { key: 'diagnostics' as const, label: '诊断与帮助', icon: 'activity', hint: '导出诊断包、最近的运行记录、错误码速查' },
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
   通用（应用级）
   ============================================================ */

function SectionGeneral({ s }: { s: AppState }) {
  const app = s.appSettings;
  return (
    <>
      <SectionHead title="通用" sub="这些设置作用于本机，和打开哪个项目无关。" />

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title row tight" style={{ marginBottom: 12 }}>
          启动与托盘
          {/* 如实标注原型边界：没有系统桥接，不能声称真的改了开机项（§17.8 第 7 条） */}
          <Tag plain title="原型只改内存里的模拟值，未接入系统开机项或托盘行为">原型模拟</Tag>
        </div>
        <div className="col" style={{ gap: 12 }}>
          <Switch
            checked={app.launchAtLogin}
            onChange={(v) => setAppSetting('launchAtLogin', v)}
            label="开机自动启动"
          />
          <Switch
            checked={app.keepInTray}
            onChange={(v) => setAppSetting('keepInTray', v)}
            label="关闭窗口时继续在托盘运行"
          />
          <Switch
            checked={app.autoResumeTasks}
            onChange={(v) => setAppSetting('autoResumeTasks', v)}
            label="重启后自动继续未完成的任务"
          />
        </div>
        <div className="panel" style={{ marginTop: 12 }}>
          「开机自启」和「重启后自动继续」是两件事：前者默认开启、可以关；
          后者默认关闭 —— 重启后先把可继续的任务列给你，你点了才继续。
          <div className="small faint" style={{ marginTop: 6 }}>
            原型里这三个开关只改变模拟状态（点击会真实变化并留痕），不代表已修改你的系统设置。
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 12 }}>数据存放位置</div>
        <div className="panel" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.9 }}>
          &lt;appData&gt;/zhongshuo/<br />
          {'  '}state.sqlite<br />
          {'  '}artifacts/&lt;projectId&gt;/<br />
          {'  '}contexts/&lt;projectId&gt;/<br />
          {'  '}drafts/&lt;projectId&gt;/　← 托管草稿，绝不放项目根<br />
          {'  '}snapshots/&lt;projectId&gt;/<br />
          {'  '}diagnostics/<br />
          {'  '}backups/
        </div>
        <div className="small faint" style={{ marginTop: 10 }}>
          数据只存在本机的应用数据目录，不放在网络盘或同步盘上。
          众说不会往你的项目目录里插配置文件，也不会自动 git init。
        </div>
      </div>

      {/* ============================================================
          外观与账号（第二十六批从应用内顶栏收进来的）
          ============================================================
          顶栏整条去掉后，主题切换、账号、退出、重置原型数据都落到这里。
          它们的共同点是"低频、配置性质" —— 不需要一直占着一条常驻工具栏，
          放进设置不会拖慢任何日常操作。
          但**「项目全停」没有收进来**：那是紧急停止，埋在设置里出事故时找不到，
          它留在侧栏底部固定区。 */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-title" style={{ marginBottom: 12 }}>外观与账号</div>

        <div className="col" style={{ gap: 12 }}>
          {/* 主题在标题栏里也有快捷键（太阳/月亮），这里给的是可读的当前值 */}
          <Switch
            checked={s.ui.theme === 'dark'}
            onChange={(v) => setTheme(v ? 'dark' : 'light')}
            label={`深色外观（当前：${s.ui.theme === 'dark' ? '深色' : '浅色'}）`}
          />

          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div className="strong" style={{ fontSize: 12 }}>本机账号</div>
              <div className="small faint" style={{ marginTop: 2 }}>
                你（管理员）· 本机模式。原型没有登录体系，也没有云端账号。
              </div>
            </div>
            <Avatar name="我" color="var(--m-human)" size={28} round />
          </div>
        </div>

        {/* 危险/破坏性动作就地降权，避免和上面的普通开关混在一起 */}
        <div className="settings-advanced" style={{ marginTop: 14 }}>
          <div className="settings-advanced-head">
            <Icon name="alert-triangle" size={13} />
            高级操作
            <span className="small faint">下面这些会丢弃当前内存状态或结束会话</span>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button
              className="btn sm"
              onClick={() => {
                resetStore();
                toast('已回到初始种子状态：本轮新增的成员、改过的设置与留痕都被丢弃', 'info');
              }}
            >
              <Icon name="refresh" size={12} /> 重置原型数据
            </button>
            <button
              className="btn ghost sm"
              onClick={() => toast('显式退出会先展示正在终止的任务数量；关闭窗口只是缩到托盘继续运行', 'warn')}
            >
              <Icon name="log-out" size={12} /> 退出
            </button>
          </div>
          <div className="small faint" style={{ marginTop: 10, lineHeight: 1.7 }}>
            重置只影响原型的内存状态，不会动你的项目目录、不会卸载 CLI、也不会清除真实的 Git 改动。
            关闭窗口是缩到托盘继续运行；要真正退出请用托盘菜单里的退出。
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================================================
   设备与局域网（应用级）
   ============================================================ */

function SectionLan() {
  const s = useStore((x) => x);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [customCode, setCustomCode] = useState('');
  const [codeError, setCodeError] = useState('');

  return (
    <>
      <SectionHead title="设备与局域网" sub="让手机或另一台电脑通过浏览器使用同一个众说。" />

      <div className="panel warning" style={{ marginBottom: 14 }}>
        <div className="panel-title"><Icon name="shield-off" size={13} /> 配对的设备拥有和本机一样的权限</div>
        被配对的设备能发任务、停止任务、改设置。所以配对码只在本机显示、限时有效、用一次就作废；
        连接强制加密（HTTPS/WSS），拒绝明文 HTTP。
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-title row tight" style={{ marginBottom: 12 }}>
            生成配对码
            <Tag plain>M3 批次</Tag>
          </div>

          <div className="row wrap" style={{ gap: 8 }}>
            <button
              className="btn primary sm"
              onClick={() => {
                setPairCode(generatePairingCode());
                setCodeError('');
              }}
            >
              <Icon name="hash" size={12} /> 随机生成
            </button>
            <input
              className="input mono"
              style={{ width: 140 }}
              placeholder="或自设 8 位以上"
              value={customCode}
              onChange={(e) => {
                setCustomCode(e.target.value);
                setCodeError('');
              }}
            />
            <button
              className="btn sm"
              onClick={() => {
                if (customCode.trim().length < 8) {
                  setCodeError('自设配对码至少 8 位');
                  return;
                }
                if (s.devices.some((d) => d.tokenPrefix.endsWith(customCode.trim()))) {
                  setCodeError('该配对码使用过，不能重复');
                  return;
                }
                setPairCode(customCode.trim());
                toast(`已使用自设配对码 ${customCode.trim()}：限时 5 分钟、一次一用`, 'info');
              }}
            >
              使用自设码
            </button>
          </div>

          {codeError ? <div className="panel danger" style={{ marginTop: 10 }}>{codeError}</div> : null}

          {pairCode ? (
            <div className="card" style={{ marginTop: 12, textAlign: 'center', background: 'var(--accent-soft)', borderColor: 'var(--accent-border)' }}>
              <div className="small faint">在局域网设备的浏览器里输入</div>
              <div className="mono" style={{ fontSize: 26, fontWeight: 700, letterSpacing: '0.14em', marginTop: 4 }}>
                {pairCode}
              </div>
              <div className="small faint" style={{ marginTop: 6 }}>
                只在本机显示 · 5 分钟内有效 · 用一次就作废
              </div>
            </div>
          ) : null}

          <div className="small faint" style={{ marginTop: 10 }}>
            监听地址：<span className="mono-sm">https://127.0.0.1:7411</span> 与
            <span className="mono-sm"> https://192.168.1.10:7411</span>（自签证书，首次连接需要信任）。
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>已连接设备</div>
          <div className="col" style={{ gap: 10 }}>
            {s.devices.map((d) => (
              <div key={d.id} className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row tight">
                    <Icon name={d.kind === 'this-machine' ? 'monitor' : 'wifi-off'} size={13} className="faint" />
                    <span className="strong" style={{ fontSize: 12 }}>{d.name}</span>
                    {d.kind === 'this-machine' ? <Tag plain>本机</Tag> : null}
                  </div>
                  <div className="mono-sm" style={{ marginTop: 2 }}>
                    {d.address} · {d.tokenPrefix}*** · 最近联机 {new Date(d.lastSeenAt).toLocaleString('zh-CN')}
                  </div>
                </div>
                {/* 每台设备旁**直接**放断开，不再在下方"高级操作"里重复列一遍设备
                    （原实现把对象和操作拆到两处，用户要来回对应 —— §17.8） */}
                {d.kind !== 'this-machine' ? (
                  <button
                    className="btn sm danger"
                    onClick={() => revokeDevice(d.id)}
                    title="断开后这台设备的连接立即失效，其他设备不受影响"
                  >
                    断开访问
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <div className="divider" />
          <div className="small faint">要再连一台设备，用左边的配对码。</div>
        </div>
      </div>

      {/* 高级操作：只留下真正"影响全局"的危险动作 */}
      <div className="settings-advanced">
        <div className="settings-advanced-head">
          <Icon name="alert-triangle" size={13} />
          高级操作
          <span className="small faint">下面这些会影响所有已连接的设备</span>
        </div>

        <div className="col" style={{ gap: 10 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn sm" onClick={rotateToken} title="所有已配对设备无需重新配对，吊销仍是单独动作">
              <Icon name="refresh" size={12} /> 轮换会话令牌
            </button>
            <button
              className="btn ghost sm"
              onClick={testAdminBoundary}
              title="检查来源校验、明文 HTTP 拒绝与令牌是否走请求头"
            >
              检查局域网连接是否安全
            </button>
          </div>
          <div className="small faint" style={{ lineHeight: 1.7 }}>
            轮换令牌不会把已配对的设备踢下线；断开某台设备请用上面它自己那一行的按钮。
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================================================
   诊断与帮助（含错误码速查）
   ============================================================ */

function SectionDiagnostics({ expanded }: { expanded: boolean }) {
  const s = useStore((x) => x);
  // 旧 section=errors 深链要"精确定位到速查"，所以默认展开并滚到那里
  const [showErrors, setShowErrors] = useState(expanded);

  useEffect(() => {
    if (!expanded) return;
    setShowErrors(true);
    const el = document.getElementById('settings-errors');
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [expanded]);

  return (
    <>
      <SectionHead title="诊断与帮助" sub="出问题时把这份记录导出来，能定位到是哪一步断的。" />

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <button className="btn sm" onClick={() => exportDiagnostics(s.activeProjectId)}>
            <Icon name="download" size={12} /> 导出诊断包
          </button>
          <button className="btn ghost sm" onClick={() => toast('日志保留默认 14 天，可在此调整', 'info')}>
            <Icon name="clock" size={12} /> 日志保留：14 天
          </button>
        </div>
        <div className="panel" style={{ marginTop: 10 }}>
          导出时默认脱敏凭据、环境变量值和敏感路径；是否包含源码或报告正文由你决定。
        </div>
      </div>

      <div className="section-title">最近的运行记录<span className="count">{s.diagnostics.length}</span></div>
      <div className="card" style={{ padding: 0, marginBottom: 18 }}>
        <table className="tbl">
          <thead>
            <tr><th style={{ width: 90 }}>时间</th><th style={{ width: 70 }}>级别</th><th>内容</th><th style={{ width: 300 }}>追溯键</th></tr>
          </thead>
          <tbody>
            {s.diagnostics.map((d) => (
              <tr key={d.id}>
                <td className="small">{new Date(d.at).toLocaleTimeString('zh-CN')}</td>
                <td>
                  <Tag
                    tone={d.level === 'error' ? 'danger' : d.level === 'warn' ? 'warning' : 'neutral'}
                    icon={d.level === 'error' ? 'x-circle' : d.level === 'warn' ? 'alert-triangle' : 'info'}
                  >
                    {d.level}
                  </Tag>
                </td>
                <td className="small">{d.message}</td>
                <td className="mono-sm" style={{ overflowWrap: 'anywhere' }}>
                  {Object.entries(d.trace).map(([k, v]) => `${k}=${v}`).join(' ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 错误码速查并入这里，作为可展开内容（不再独占一个导航项） */}
      <div className="card" style={{ padding: 0 }}>
        <button
          className="settings-collapse-head"
          onClick={() => setShowErrors((v) => !v)}
          aria-expanded={showErrors}
          id="settings-errors"
        >
          <Icon name={showErrors ? 'chevron-down' : 'chevron-right'} size={13} />
          错误码速查
          <span className="small faint">
            出现问题时界面会怎么告诉你、你能做什么（{Object.keys(errorCopy).length} 条）
          </span>
        </button>
        {showErrors ? (
          <div style={{ borderTop: '1px solid var(--border)' }}>
            <div className="small faint" style={{ padding: '10px 12px' }}>
              界面统一用「一句话说明 + 一个可点的恢复动作」呈现，不会把错误码直接甩给你。
            </div>
            <table className="tbl">
              <thead>
                <tr><th style={{ width: 220 }}>错误码</th><th style={{ width: 220 }}>用户看到什么</th><th>恢复方式</th></tr>
              </thead>
              <tbody>
                {(Object.keys(errorCopy) as ErrorCode[]).map((code) => (
                  <tr key={code}>
                    <td className="mono-sm" style={{ color: 'var(--danger)' }}>{code}</td>
                    <td className="small strong">{errorCopy[code].title}</td>
                    <td className="small">{errorCopy[code].action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
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
   * `section=diagnostics&anchor=errors`，所以这里不能只看 section ——
   * 必须认 **anchor=errors**，否则重定向后判定为 false，表格不展开（实测踩过）。
   */
  const errorsExpanded = raw === 'errors' || q.anchor === 'errors';

  const go = (next: AppSettingsSection) => {
    // 应用链接**不带 projectId**：切换项目不应改变应用配置（§17.8）
    navigate(`/settings?section=${next}`, { replace: true });
  };

  return (
    <div className="main">
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-title">应用设置</div>
            <div className="page-sub">
              这里只放整个软件的配置，和打开哪个项目无关。
              要改某个项目（任务验收、协作限制、文件修改），用侧栏该项目旁的 <strong>⋯ → 项目设置</strong>。
            </div>
          </div>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分区">
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

            <div className="settings-nav-foot">
              项目设置已独立：在侧栏项目行点 ⋯ 进入。提醒在「待我处理」。
            </div>
          </nav>

          <div className="settings-body">
            {section === 'general' ? <SectionGeneral s={s} /> : null}

            {section === 'runtime' ? (
              <>
                <SectionHead
                  title="执行工具（Runtime）"
                  sub="安装检测、版本、登录与能力认证。应用级配置：切换项目不会换出另一套。"
                />
                <RuntimePanel embedded />
              </>
            ) : null}

            {section === 'lan' ? <SectionLan /> : null}
            {section === 'diagnostics' ? <SectionDiagnostics expanded={errorsExpanded} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
