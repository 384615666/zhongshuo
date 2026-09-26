/**
 * 应用设置 · 帮助与关于（§3.1 的第七类，含 §4.4）。
 *
 * 一个分区里放完：故障诊断（导出诊断包）、日志保留、最近的运行记录、
 * 错误码速查（折叠）、版本与更新 / 使用帮助 / 反馈，以及底部的**原型工具**折叠组。
 *
 * 三条边界：
 *  - 「日志保留」给的是**真实可选值**（7/14/30 天）并写入状态 ——
 *    原来是"点击只弹提示、没有任何调整入口"的假按钮（§2.4 的处理①）；
 *  - 「原型工具」默认折叠但一眼能找到：它是截图、演示、复现问题的常规动作（§2.6），
 *    不藏在隐藏 URL 参数里，也不虚构一个"开发入口"；
 *  - 版本、更新、反馈都按原型实情写：不假装检查过更新，也不假装有反馈通道。
 */

import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { CollapseGroup, DetailFold, ReadOnlyRow, SelectRow, SettingsRow, SimulatedTag } from '../components/SettingsRow';
import { Modal, Tag } from '../components/ui';
import { resetNavPrefsOnly, resetStore, setLogRetention, toast, useStore } from '../data/store';
import { exportDiagnostics } from '../data/actions';
import { errorCopy } from '../lib/format';
import { navigate } from '../lib/router';
import type { ErrorCode } from '../data/types';

function SectionHead({ title, sub }: { title: string; sub: React.ReactNode }) {
  return (
    <div className="settings-section-head">
      <div className="settings-section-title">{title}</div>
      <div className="settings-section-sub">{sub}</div>
    </div>
  );
}

/** 应用版本：原型自己报的版本号（不是产品版本承诺） */
const APP_VERSION = '1.0.0（原型）';

/** 本批次的应用设置改动，供「版本说明」查看 */
const RELEASE_NOTES: { title: string; items: string[] }[] = [
  {
    title: '应用设置 · 版式与信息架构整理',
    items: [
      '正文宽度受约束并在主内容区居中，设置行统一为「左名称 + 说明、右控件」',
      '七个一级分类：通用 / 外观 / 通知 / AI 工具 / 连接与设备 / 数据与存储 / 帮助与关于',
      '归档管理嵌入「数据与存储」，与独立页面共用同一份数据与操作',
      '通知与外部 AI 连接（MCP）进入应用设置；开发材料收进技术详情',
      '控制项如实标注：只改内存模拟值的标「原型模拟」，没有入口的不再做成假按钮',
    ],
  },
];

export function SectionHelp({ expanded }: { expanded: boolean }) {
  const s = useStore((x) => x);
  // 旧 section=errors 深链要"精确定位到速查"，所以默认展开并滚到那里
  const [showErrors, setShowErrors] = useState(expanded);
  const [notesOpen, setNotesOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    setShowErrors(true);
    const el = document.getElementById('settings-errors');
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [expanded]);

  return (
    <>
      <SectionHead
        title="帮助与关于"
        sub="出问题时把这份记录导出来，能定位到是哪一步断的；版本与更新状态也在这里。"
      />

      {/* ---------- 故障诊断 ---------- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title" style={{ marginBottom: 4 }}>故障诊断</div>

        <SettingsRow
          label="导出诊断包"
          hint="导出时默认脱敏凭据、环境变量值和敏感路径；是否包含源码或报告正文由你决定。"
          wide
          control={
            <button className="btn sm" onClick={() => exportDiagnostics(s.activeProjectId)}>
              <Icon name="download" size={12} /> 导出诊断包
            </button>
          }
        />

        {/* 日志保留：真实可选值 + 写入状态（§2.4 的处理①），不再是点击后没有入口的假按钮 */}
        <SelectRow
          label="日志保留"
          hint="超期的诊断记录会被清理；不包含成果、任务与消息正文 —— 日志只是诊断线索。"
          value={String(s.appSettings.logRetentionDays)}
          onChange={(v) => {
            setLogRetention(Number(v) as 7 | 14 | 30);
            toast(`日志保留已设为 ${v} 天：原型只改模拟值，不会真的删除记录`, 'info');
          }}
          options={[
            { value: '7', label: '7 天' },
            { value: '14', label: '14 天' },
            { value: '30', label: '30 天' },
          ]}
        />
        <div className="pset-note">
          当前设置：保留 <strong>{s.appSettings.logRetentionDays}</strong> 天。
          原型只改内存里的模拟值，不会真的删除任何记录（真正的清理由一致性清理流程执行，§12.5）。
        </div>
      </div>

      {/* ---------- 最近的运行记录 ---------- */}
      <div className="section-title">最近的运行记录<span className="count">{s.diagnostics.length}</span></div>
      <div className="card settings-wide" style={{ padding: 0, marginBottom: 18 }}>
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

      {/* ---------- 错误码速查（折叠；旧 section=errors 仍精确展开） ---------- */}
      <div className="card settings-wide" style={{ padding: 0, marginBottom: 14 }}>
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

      {/* ---------- 版本与更新 / 使用帮助 / 反馈 ---------- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title" style={{ marginBottom: 4 }}>版本与更新</div>

        <ReadOnlyRow label="应用版本" hint="原型自己报的版本号，不是产品版本承诺。" value={APP_VERSION} />
        <ReadOnlyRow
          label="更新状态"
          hint="原型不检查更新，也不下载安装包 —— 所以这里不会出现「有新版本」这类没发生过的提示。"
          value={<span className="row tight">未接入自动更新 <Tag plain>原型</Tag></span>}
        />
        <SettingsRow
          label="版本说明"
          hint="这一批改了什么、以及有哪些是明确标注的原型边界。"
          wide
          control={
            <button className="btn sm" onClick={() => setNotesOpen(true)}>
              <Icon name="file-text" size={12} /> 查看版本说明
            </button>
          }
        />
        <SettingsRow
          label="使用帮助"
          hint="哪项设置在哪里改：应用设置 / 项目设置 / 成员管理 / 房间设置 / 任务详情。"
          wide
          control={
            <button className="btn sm" onClick={() => setHelpOpen(true)}>
              <Icon name="help-circle" size={12} /> 打开使用帮助
            </button>
          }
        />
        <SettingsRow
          label="反馈"
          hint="正式实现里会带上诊断包一起提交（脱敏后由你确认）；原型没有反馈通道，也不会假装已收到。"
          wide
          control={
            <div className="row tight">
              <button
                className="btn sm"
                onClick={() =>
                  toast('原型没有接入反馈通道：真实实现会在此打开反馈表单，并附上你确认过的诊断包', 'info')
                }
              >
                <Icon name="send" size={12} /> 提交反馈
              </button>
              <SimulatedTag title="原型没有反馈后端，按钮只说明真实流程" />
            </div>
          }
        />
      </div>

      {/* ---------- 原型工具（默认折叠，但一眼能找到） ---------- */}
      <CollapseGroup
        id="settings-proto-tools"
        title="原型工具"
        collapsedNote="重置原型数据、清除导航偏好 —— 演示与复现问题时用"
        note="只影响原型内存状态，不动磁盘、不动项目目录"
      >
        <SettingsRow
          label="重置原型数据"
          hint="回到初始种子状态：本轮新增的成员、改过的设置、留痕与导航偏好都被丢弃。不会动你的项目目录、不卸载 CLI、不清除真实 Git 改动。"
          wide
          control={
            <button
              className="btn danger sm"
              onClick={() => {
                resetStore();
                toast('已回到初始种子状态：本轮新增的成员、改过的设置与留痕都被丢弃', 'info');
              }}
            >
              <Icon name="refresh" size={12} /> 重置原型数据
            </button>
          }
        />
        <SettingsRow
          label="清除导航偏好"
          hint="只把侧栏摆回初始形态（可见项目、展开、置顶、文件/Git 标签、当前项目），保留刚改过的设置与留痕。"
          wide
          control={
            <button
              className="btn sm"
              onClick={() => {
                resetNavPrefsOnly();
                toast('导航偏好已清除：侧栏与当前项目回到初始种子', 'info');
              }}
            >
              <Icon name="panel-left" size={12} /> 清除导航偏好
            </button>
          }
        />
        <DetailFold summary="技术详情：这两个动作分别清了什么">
          <div className="small faint" style={{ lineHeight: 1.8 }}>
            导航偏好存在 <span className="mono-sm">localStorage</span> 的独立键里（
            <span className="mono-sm">zhongshuo.nav.prefs.v1</span>），所以「重置原型数据」
            必须显式清它 —— 否则重置后侧栏还按上次的可见项目显示，看起来像没生效。
            草稿存在 <span className="mono-sm">zhongshuo.drafts.v2</span>，按 24 小时过期，
            不在重置范围内。
          </div>
        </DetailFold>
      </CollapseGroup>

      {/* ---------- 版本说明弹窗 ---------- */}
      {notesOpen ? (
        <Modal
          size="md"
          title="版本说明"
          subtitle={APP_VERSION}
          onClose={() => setNotesOpen(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setNotesOpen(false)}>关闭</button>
            </>
          }
        >
          <div className="col" style={{ gap: 14 }}>
            {RELEASE_NOTES.map((g) => (
              <div key={g.title}>
                <div className="strong" style={{ fontSize: 12.5, marginBottom: 6 }}>{g.title}</div>
                <div className="col" style={{ gap: 5 }}>
                  {g.items.map((t) => (
                    <div key={t} className="row tight" style={{ alignItems: 'flex-start' }}>
                      <Icon name="check" size={12} style={{ color: 'var(--success)', marginTop: 4, flex: 'none' }} />
                      <span className="small" style={{ lineHeight: 1.65 }}>{t}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="panel">
              未包含：自动更新、反馈后端、真实日志清理。这些在原型里都不存在，
              界面里也不会出现"已检查更新""已收到反馈"这类没发生的回执。
            </div>
          </div>
        </Modal>
      ) : null}

      {/* ---------- 使用帮助弹窗：回答"这项设置在哪里改" ---------- */}
      {helpOpen ? (
        <Modal
          size="md"
          title="这项设置在哪里改"
          subtitle="按归属找，比在设置里翻更快"
          onClose={() => setHelpOpen(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setHelpOpen(false)}>关闭</button>
            </>
          }
        >
          <table className="tbl">
            <thead>
              <tr><th style={{ width: 130 }}>想改什么</th><th style={{ width: 130 }}>去哪</th><th>说明</th></tr>
            </thead>
            <tbody>
              {[
                ['整个软件的行为', '应用设置（这里）', '开机启动、通知、工具接入、数据与外部连接'],
                ['这个项目怎么交付', '项目设置', '任务验收、协作时限、文件修改规则；从侧栏项目行的 ⋯ 进入'],
                ['某个成员用什么模型', '成员管理', '成员身份、职责、提示词、模型与工作空间'],
                ['这个房间谁能发言', '房间设置', '参与成员、房间规则、协调者、该房间的通知偏好'],
                ['这一次任务的额度与授权', '任务详情', '预算、授权范围、运行状态与临时调整'],
              ].map(([a, b, c]) => (
                <tr key={a}>
                  <td className="small strong">{a}</td>
                  <td className="small">{b}</td>
                  <td className="small">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn sm" onClick={() => { setHelpOpen(false); navigate(`/project/${s.activeProjectId}/settings`); }}>
              打开当前项目的设置
            </button>
            <button className="btn ghost sm" onClick={() => { setHelpOpen(false); navigate('/activity'); }}>
              去「待我处理」
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
