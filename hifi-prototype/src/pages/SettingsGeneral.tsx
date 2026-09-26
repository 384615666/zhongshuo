/**
 * 应用设置 · 通用 与 外观（第二十八批：七类重排的第一个与第二个分区）。
 *
 * 版式按 §2.2 的设置行：**左名称 + 说明，右控件右对齐；一组一张卡，卡内发丝线分隔**。
 * 行基元来自 `components/SettingsRow`，与项目设置共用同一个 —— 不 fork 第三种样式。
 *
 * 通用只回答"本机的软件行为"：启动与托盘、应用级运行并发、本机账号与会话。
 * 主题搬到「外观」（§3.1）—— 它只影响观感，和启动行为不是一类事。
 */

import { useState } from 'react';
import { Icon } from '../components/Icon';
import { DetailFold, NumberField, SettingsRow, SimulatedTag, SwitchRow } from '../components/SettingsRow';
import { Avatar, Modal } from '../components/ui';
import { setAppSetting, setRuntimeLimit, setTheme, toast, useStore } from '../data/store';
import { navigate } from '../lib/router';
import type { AppState } from '../data/types';

function SectionHead({ title, sub }: { title: string; sub: React.ReactNode }) {
  return (
    <div className="settings-section-head">
      <div className="settings-section-title">{title}</div>
      <div className="settings-section-sub">{sub}</div>
    </div>
  );
}

/* ============================================================
   通用
   ============================================================ */

export function SectionGeneral() {
  const app = useStore((x) => x.appSettings);
  const limits = app.runtimeLimits;
  const activeProjectId = useStore((x) => x.activeProjectId);
  const [quitOpen, setQuitOpen] = useState(false);

  return (
    <>
      <SectionHead
        title="通用"
        sub="这些设置作用于本机，和打开哪个项目无关 —— 切换项目不会换出另一套。"
      />

      {/* ---------- 启动与托盘 ---------- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title row tight" style={{ marginBottom: 4 }}>
          启动与托盘
          <SimulatedTag title="原型没有系统桥接：这三个开关只改内存里的模拟值，未接入系统开机项或托盘行为" />
        </div>

        <SwitchRow
          label="开机自动启动"
          hint="登录系统后自动运行。默认开启，可以关掉。"
          checked={app.launchAtLogin}
          onChange={(v) => setAppSetting('launchAtLogin', v)}
        />
        <SwitchRow
          label="关闭窗口时继续在托盘运行"
          hint="关掉窗口不结束任务，可从托盘重新打开。"
          checked={app.keepInTray}
          onChange={(v) => setAppSetting('keepInTray', v)}
        />
        <SwitchRow
          label="重启后自动继续未完成的任务"
          hint="关闭时，重启后先列出可继续的任务让你确认，你点了才继续。默认关闭（不自动续跑）。"
          checked={app.autoResumeTasks}
          onChange={(v) => setAppSetting('autoResumeTasks', v)}
        />

        <div className="pset-note">
          「开机自启」和「重启后自动继续」是两件事：前者管软件起不起来，后者管任务要不要接着跑。
          原型里这三个开关会真实改变内存状态并留痕，但<strong>不代表已修改你的系统设置</strong>。
        </div>
      </div>

      {/* ---------- 应用级运行并发（§4.3，决策 12） ---------- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title row tight" style={{ marginBottom: 4 }}>
          运行并发
          <SimulatedTag title="原型没有调度器：这里的数字只改内存模拟值，不会改变真实的成员调度" />
        </div>
        <div className="pset-row" style={{ paddingTop: 4 }}>
          <div className="pset-row-label">
            <div className="pset-row-hint" style={{ marginTop: 0 }}>
              整个软件同时执行多少个模型调用。默认值 3 / 1 是<strong>建议起始值</strong>，不是硬上限 ——
              机器够快、额度够用就可以调高。
            </div>
          </div>
        </div>

        <NumberField
          label="全应用同时运行的模型调用"
          hint="所有项目加在一起的上限；超出上限的成员排队等待。"
          value={limits.maxActiveTurns}
          min={1}
          max={12}
          unit="个"
          onCommit={(v) => setRuntimeLimit('maxActiveTurns', v)}
          integer
        />
        <NumberField
          label="单个成员同时运行"
          hint="防止一个成员同时开很多轮，把额度吃光。默认 1。"
          value={limits.maxTurnsPerMember}
          min={1}
          max={6}
          unit="个"
          onCommit={(v) => setRuntimeLimit('maxTurnsPerMember', v)}
          integer
        />
        <SwitchRow
          label="给单个 provider 单独限额"
          hint="同一个 provider（如某个中转或账号）被多个成员共用时，用它再收紧一层。"
          checked={limits.providerCapEnabled}
          onChange={(v) => setRuntimeLimit('providerCapEnabled', v)}
        />
        {limits.providerCapEnabled ? (
          <NumberField
            label="单 provider 同时运行"
            hint="只对同一个 provider 生效，不影响其他 provider 的成员。"
            value={limits.providerCapTurns}
            min={1}
            max={12}
            unit="个"
            onCommit={(v) => setRuntimeLimit('providerCapTurns', v)}
            integer
            />
        ) : null}

        <DetailFold summary="了解更多：这三种「限制」分别管什么（别和项目设置里的重复）">
          <div className="small faint" style={{ lineHeight: 1.75 }}>
            都叫「限制」，但回答的是三个不同问题，改动位置也不同：
          </div>
          <table className="tbl" style={{ marginTop: 8 }}>
            <thead>
              <tr><th style={{ width: 150 }}>配置</th><th style={{ width: 150 }}>在哪改</th><th>回答的问题</th></tr>
            </thead>
            <tbody>
              <tr>
                <td className="strong">应用级运行并发</td>
                <td className="small">这里（应用设置）</td>
                <td className="small">整个软件同时执行多少个模型调用？</td>
              </tr>
              <tr>
                <td className="strong">项目写入并发</td>
                <td className="small">
                  项目设置
                  <button
                    className="pset-link"
                    onClick={() => navigate(`/project/${activeProjectId}/settings?anchor=write`)}
                    title="去当前项目的设置页看这一项"
                  >
                    → 打开
                  </button>
                </td>
                <td className="small">这个项目同时允许多少个受管理任务修改文件？</td>
              </tr>
              <tr>
                <td className="strong">任务预算</td>
                <td className="small">任务详情 / 输入区</td>
                <td className="small">这一次任务累计最多使用多少调用额度？</td>
              </tr>
            </tbody>
          </table>
        </DetailFold>
      </div>

      {/* ---------- 本机账号与会话 ---------- */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>本机账号与会话</div>

        <SettingsRow
          label="本机账号"
          hint="原型没有登录体系，也没有云端账号：这里就是这台机器上的你（管理员）。"
          value="你（管理员）· 本机模式"
          control={<Avatar name="我" color="var(--m-human)" size={28} round />}
        />

        <SettingsRow
          label="退出众说"
          hint="关闭窗口是缩到托盘继续运行（任务不受影响）；要真正退出请用托盘菜单里的退出，它会先告诉你正在终止多少个任务。"
          control={
            <button className="btn danger sm" onClick={() => setQuitOpen(true)}>
              <Icon name="log-out" size={12} /> 退出
            </button>
          }
        />

        <div className="pset-note">
          退出不会删除任何数据；正在运行的任务会先停止并记录终止结果，然后才退出。
        </div>
      </div>

      {quitOpen ? (
        <Modal
          size="sm"
          title="退出众说"
          subtitle="原型不结束任何真实进程，这里只说明真实行为"
          onClose={() => setQuitOpen(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setQuitOpen(false)}>取消</button>
              <button
                className="btn danger"
                onClick={() => {
                  setQuitOpen(false);
                  toast(
                    '原型不结束此窗口：请在桌面客户端用托盘菜单退出 —— 它会先展示正在终止的任务数量',
                    'info',
                  );
                }}
              >
                我知道了
              </button>
            </>
          }
        >
          <div className="small muted" style={{ lineHeight: 1.8 }}>
            真正退出会先展示正在终止的任务数量，并让运行中的 turn 走既有停止流程（§16.3）。
            关闭窗口只是缩到托盘继续运行，任务不受影响。
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/* ============================================================
   外观
   ============================================================ */

export function SectionAppearance() {
  const theme = useStore((x: AppState) => x.ui.theme);
  return (
    <>
      <SectionHead title="外观" sub="只影响界面观感，不改变任务、执行或通知行为。" />

      <div className="card">
        <SwitchRow
          label="深色外观"
          hint="标题栏右上的太阳 / 月亮是同一个开关，两边改的是同一件事。"
          value={`当前：${theme === 'dark' ? '深色' : '浅色'}`}
          checked={theme === 'dark'}
          onChange={(v) => setTheme(v ? 'dark' : 'light')}
        />
        {/* 跟随系统 / 字号 / 消息密度在 §3.1 里是【暂缺】—— 本批不做占位控件（施工铁律） */}
      </div>
    </>
  );
}
