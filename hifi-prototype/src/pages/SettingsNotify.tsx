/**
 * 应用设置 · 通知（§27.11 ATTN-05 / ATTN-06，任务书 §3.2）。
 *
 * 主设计已收录「设置 → 通知」，原型此前零实现。这里**能展示并模拟修改偏好**，
 * 不是只有一个"暂无内容"的空页。
 *
 * 三条不能违反的口径（逐条写在界面上，也写在这里）：
 *  1. **单一真相源**：应用级这一层（全静音、免打扰、事件、渠道、声音）在
 *     `appSettings.notifications`；房间静音与线程关注仍在 `s.subscriptions` ——
 *     这里**读同一份订阅状态**并在界面里给出快捷操作，绝不另存第二份。
 *  2. **覆盖关系**：应用级全静音 / 免打扰 > 房间静音 > 线程关注。
 *  3. **不得把通知开关等同于执行授权**（ATTN-06：通知、人的 Activity、
 *     Agent inbox delivery 是三种不同机制），也不得暗示四类事件就是全部。
 */

import { Icon } from '../components/Icon';
import { DetailFold, ReadOnlyRow, SelectRow, SettingsRow, SimulatedTag, SwitchRow } from '../components/SettingsRow';
import { Tag } from '../components/ui';
import { setDnd, setNotificationEvent, setNotificationPref, useStore } from '../data/store';
import { dndActiveNow } from '../lib/dnd';
import { toggleMute, toggleFollow } from '../data/actions';
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

/** 订阅条目的可读标签：线程 → 项目 · 房间 · 任务号（与房间内的叫法一致） */
function threadEntries(s: AppState, pred: (v: { followed: boolean; muted: boolean }) => boolean) {
  return Object.entries(s.subscriptions)
    .filter(([, v]) => pred(v))
    .map(([threadId]) => {
      const th = s.threads.find((t) => t.id === threadId);
      if (!th) return null;
      const room = s.rooms.find((r) => r.id === th.roomId);
      const project = s.projects.find((p) => p.id === th.projectId);
      const task = th.rootTaskId ? s.tasks.find((t) => t.id === th.rootTaskId) : undefined;
      return {
        id: threadId,
        project: project?.displayName ?? '未知项目',
        room: room?.name ?? '未知房间',
        label: task ? `任务 #${task.roomTaskNumber}` : '一条记录',
        href: `/project/${th.projectId}/room/${th.roomId}?thread=${th.id}`,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export function SectionNotifications() {
  const s = useStore((x) => x);
  const n = s.appSettings.notifications;
  const muted = threadEntries(s, (v) => v.muted);
  const followed = threadEntries(s, (v) => v.followed);

  /**
   * 覆盖关系要在界面读得出来：**应用级层压住下面所有房间**。
   *
   * 但"免打扰已启用"不等于"此刻正在免打扰"（评审复现：18:27 设 22:00—08:00 也被说成
   * "当前正在免打扰"）。这里按当前时间算，跨零点时段也算对；时段外如实说"不在时段内"。
   */
  const dndActive = dndActiveNow(n.dnd);

  return (
    <>
      <SectionHead
        title="通知"
        sub="什么情况下提醒你。通知只是提醒，不等于执行授权：成员的运行与否由任务与授权决定，不由这里决定。"
      />

      {/* ---------- 总开关 ---------- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-title row tight" style={{ marginBottom: 4 }}>
          总开关
          <SimulatedTag title="原型没有接入真实推送：这里只改内存偏好，不会真的弹出系统通知" />
        </div>

        {/* 「不得宣称已接入真实推送」写在**可见文案**里，不是只进 tooltip（§3.2）：
            ATTN-06 明确通知 / 人的 Activity / Agent inbox delivery 是三种机制，
            不能让用户在"以为开了就会响"的误解下做决定。 */}
        <div className="conn-perm">
          <Icon name="info" size={13} />
          <span>
            <strong>原型没有接入真实推送：</strong>下面的偏好只改内存里的模拟值，
            不会弹出系统通知，也不会发往任何通道；正式实现才接系统通知与托盘。
          </span>
        </div>

        <SwitchRow
          label="全部静音"
          hint="服务器级全静音：打开后不发送任何通知。任务照常运行、「待我处理」里的条目照常累积 —— 静音只是不打扰你。"
          checked={n.muteAll}
          onChange={(v) => setNotificationPref('muteAll', v)}
        />
        <SwitchRow
          label="免打扰时段"
          hint="时段内不弹通知，事件仍然记录，之后再看不丢；起止时间相同表示全天。"
          value={
            n.dnd.enabled
              ? `${n.dnd.from} → ${n.dnd.to} · ${dndActive ? '此刻生效中' : '当前不在时段内'}`
              : '未启用'
          }
          checked={n.dnd.enabled}
          onChange={(v) => setDnd({ enabled: v })}
        />
        {n.dnd.enabled ? (
          <SettingsRow
            label="时段"
            hint="跨零点也可以（例如 22:00 → 08:00）。"
            wide
            control={
              <div className="row tight">
                <input
                  className="input sm dnd-time"
                  type="time"
                  aria-label="免打扰开始时间"
                  value={n.dnd.from}
                  onChange={(e) => setDnd({ from: e.target.value })}
                />
                <span className="faint">→</span>
                <input
                  className="input sm dnd-time"
                  type="time"
                  aria-label="免打扰结束时间"
                  value={n.dnd.to}
                  onChange={(e) => setDnd({ to: e.target.value })}
                />
              </div>
            }
          />
        ) : null}
        <SelectRow
          label="通知渠道"
          hint="桌面通知是系统级提醒；托盘角标只改托盘图标上的数字；应用内提示只在众说窗口里显示。"
          value={n.channel}
          onChange={(v) => setNotificationPref('channel', v as typeof n.channel)}
          options={[
            { value: 'desktop', label: '桌面通知' },
            { value: 'tray', label: '托盘角标' },
            { value: 'in-app', label: '只在应用内提示' },
          ]}
        />
        <SwitchRow
          label="提示音"
          hint="只有桌面通知会响；渠道选「托盘角标」或「应用内提示」时这一项无效。"
          checked={n.sound}
          onChange={(v) => setNotificationPref('sound', v)}
        />
      </div>

      {/* ---------- 事件 ---------- */}
      <div className="card" style={{ marginBottom: 14 }} data-settings-block="notify-events">
        <div className="card-title row tight" style={{ marginBottom: 4 }}>
          哪些事提醒我
          <Tag plain title="原型优先覆盖的四类事件；ATTN-05 的完整清单更大，见下方说明">原型优先覆盖</Tag>
        </div>
        {/* 完整口径写在可见文案里（§3.2）：四类是优先子集，界面不得暗示"就这些" */}
        <div className="small faint" style={{ lineHeight: 1.75, marginBottom: 4 }}>
          下面四类优先做。完整清单还包括：<strong>私信</strong>、<strong>已加入频道的消息</strong>、
          <strong>关注线程的回复</strong>、<strong>未加入频道的提及</strong> —— 这些会随后续批次补齐，
          现在不摆占位开关。
        </div>

        <SwitchRow
          label="需要审批"
          hint="有成员请求授权、或任务卡在需要你处理的地方。"
          checked={n.events.approval}
          onChange={(v) => setNotificationEvent('approval', v)}
        />
        <SwitchRow
          label="任务失败"
          hint="成员运行失败、被停止，或执行中出错。"
          checked={n.events.taskFailed}
          onChange={(v) => setNotificationEvent('taskFailed', v)}
        />
        <SwitchRow
          label="任务完成"
          hint="交付已生成，等你验收（如果你开了任务验收）。"
          checked={n.events.taskDone}
          onChange={(v) => setNotificationEvent('taskDone', v)}
        />
        <SwitchRow
          label="被提及"
          hint="有人在消息里 @ 你。"
          checked={n.events.mentioned}
          onChange={(v) => setNotificationEvent('mentioned', v)}
        />

        <DetailFold summary="说明：为什么只列了四类事件">
          <div className="small faint" style={{ lineHeight: 1.8 }}>
            ATTN-05 的完整清单是：<strong>私信</strong>、<strong>已加入频道的消息</strong>、
            <strong>关注线程的回复</strong>、<strong>未加入频道的提及</strong>。
            上面的四类是这个清单里优先级最高的子集，不是全部 —— 剩下的会在后续批次补齐，
            这里不摆占位开关。
          </div>
          <div className="small faint" style={{ lineHeight: 1.8, marginTop: 8 }}>
            另外：<strong>通知</strong>、人的 <strong>Activity（待我处理）</strong>、
            <strong>Agent inbox delivery</strong> 是三种不同机制。关掉通知不会停止任务，
            也不会改变谁能执行；反过来，任务在等你处理时，「待我处理」里照样会出现。
          </div>
        </DetailFold>
      </div>

      {/* ---------- 房间与线程那一层（同一份订阅状态） ---------- */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>房间与线程这一层</div>
        <div className="small faint" style={{ lineHeight: 1.75, marginBottom: 4 }}>
          覆盖顺序：<strong>应用级全静音 / 免打扰</strong> ＞ <strong>房间静音</strong> ＞{' '}
          <strong>线程关注</strong>。上面那一层能压住下面所有房间，
          但不会修改房间与线程各自的设置。
        </div>
        <div className="small faint" style={{ lineHeight: 1.75 }}>
          下面这些就是房间 ⋯ / 线程 ⋯ 里的<strong>同一份订阅状态</strong>（关注与静音），
          不是第二份"通知订阅" —— 在这里取消静音，房间里立刻同步。
          {n.muteAll ? (
            <>
              {' '}
              <span className="row tight" style={{ display: 'inline-flex' }}>
                <Icon name="bell" size={11} />
                当前「全部静音」已打开：下面的条目即使没静音也不会响。
              </span>
            </>
          ) : n.dnd.enabled ? (
            <>
              {' '}
              <span className="row tight" style={{ display: 'inline-flex' }}>
                <Icon name="bell" size={11} />
                {dndActive
                  ? `免打扰时段（${n.dnd.from} → ${n.dnd.to}）此刻生效中：下面的条目现在不会响。`
                  : `免打扰时段（${n.dnd.from} → ${n.dnd.to}）已启用，但当前不在时段内：下面的条目照常提醒。`}
              </span>
            </>
          ) : null}
        </div>

        <SettingsRow label="已静音的线程" hint="静音只改通知偏好，不影响关注，也不影响成员是否运行。" wide />
        {muted.length === 0 ? (
          <div className="small faint" style={{ padding: '4px 0 10px' }}>
            没有静音任何线程。
          </div>
        ) : (
          muted.map((m) => (
            <SettingsRow
              key={m.id}
              label={`${m.project} · ${m.room} · ${m.label}`}
              wide
              control={
                <div className="row tight">
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      toggleMute(m.id);
                    }}
                    title="取消静音：改的是同一份订阅状态（subscriptions）"
                  >
                    取消静音
                  </button>
                  <button className="btn ghost sm" onClick={() => navigate(m.href)} title="打开这条线程">
                    打开
                  </button>
                </div>
              }
            />
          ))
        )}

        <SettingsRow label="已关注的线程" hint="关注是阅读关注：它不派发任务，也不唤醒成员。" />
        {followed.length === 0 ? (
          <div className="small faint" style={{ padding: '4px 0 10px' }}>
            没有关注任何线程：在房间或线程的 ⋯ 菜单里关注后会出现在这里。
          </div>
        ) : (
          followed.map((f) => (
            <SettingsRow
              key={f.id}
              label={`${f.project} · ${f.room} · ${f.label}`}
              value={s.subscriptions[f.id]?.muted ? <span className="small faint">已静音</span> : undefined}
              wide
              control={
                <div className="row tight">
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      toggleFollow(f.id);
                    }}
                    title="取消关注：改的是同一份订阅状态（subscriptions）"
                  >
                    取消关注
                  </button>
                  <button className="btn ghost sm" onClick={() => navigate(f.href)} title="打开这条线程">
                    打开
                  </button>
                </div>
              }
            />
          ))
        )}

        <ReadOnlyRow
          label="提醒（定时）"
          hint="定时提醒不在这里配置：它属于「待我处理」页的提醒分节。"
          value={
            <button className="pset-link" onClick={() => navigate('/activity')} style={{ marginTop: 0 }}>
              去「待我处理」 →
            </button>
          }
        />
      </div>
    </>
  );
}
