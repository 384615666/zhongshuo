/**
 * 任务交付详情（v1.12 §10.5 / RT-25，第十四批）。
 *
 * 这是**可选验收的唯一主入口**。任务详情、线程成果卡、文件页与「待我处理」
 * 都指向同一个 deliveryId/revision，不各自维护决定或队列（§10.5 第 7 条）。
 *
 * 信息顺序按 §10.5 第 6 条，刻意让摘要/预览/验证/残余问题**先于** diff：
 *   任务目标 → 完成摘要 → 可用效果预览 → 实际验证与未验证原因 → 残余问题 → 文件清单与完整 diff
 * 理由：用户要判断的是"这次交付能不能接受"，看 diff 之前先要知道它声称做了什么、
 * 验证到什么程度、还剩什么问题。直接甩 diff 会让人只凭代码观感下结论。
 *
 * 三条底线在本组件里必须可见：
 *  1. 验收通过**不做**任何文件/Git 操作，也不顺带批准权限请求
 *  2. 「要求修改」必填意见，且不撤销提交、不删除文件
 *  3. 「已完成 · 无需验收」与「已验收」是不同状态，不互相冒充
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { DiffView } from '../components/DiffView';
import { Tag } from '../components/ui';
import { useStore, toast } from '../data/store';
import { deliveriesOfTask, publishRework, reviewDelivery } from '../data/actions-delivery';
import { fullTime, relTime } from '../lib/format';

export function DeliveryPanel({ taskId }: { taskId: string }) {
  const s = useStore((x) => x);
  const task = s.tasks.find((t) => t.id === taskId);
  const versions = deliveriesOfTask(taskId);
  const current = task?.currentDeliveryId
    ? versions.find((v) => v.id === task.currentDeliveryId)
    : versions[0];

  /** 查看历史版本：默认看当前版 */
  const [viewId, setViewId] = useState<string | undefined>(current?.id);
  const [note, setNote] = useState('');
  const shown = versions.find((v) => v.id === viewId) ?? current;

  /*
   * 只有在**出现更新的版本**时才自动切过去。
   * 用 ref 记住"上次已知的最新版本"：用户手动翻看旧版时不该被拉回来，
   * 但返工发布新版后必须切过去，否则会停在已被替换的旧版上，
   * 让人以为"点了返工但什么都没发生"。
   */
  const knownLatest = useRef(versions[0]?.id);
  useEffect(() => {
    const latest = versions[0]?.id;
    if (latest && latest !== knownLatest.current) {
      knownLatest.current = latest;
      setViewId(latest);
    }
  }, [versions]);

  if (!task) {
    return <div className="small faint" style={{ padding: 16 }}>找不到该任务。</div>;
  }
  if (!shown) {
    return (
      <div className="msg-list">
        <div className="panel">
          <div className="panel-title"><Icon name="info" size={13} /> 这个任务还没有交付版本</div>
          任务仍在执行中。满足交付要求后才会生成交付记录
          （关闭验收时直接标「已完成 · 无需验收」，开启时进入待验收）。
        </div>
        <div className="small faint" style={{ marginTop: 10 }}>
          当前任务状态：<Tag plain>{task.status}</Tag>，创建时的验收策略：
          <Tag plain>{task.reviewPolicy === 'user_review' ? '需人工验收' : '无需验收'}</Tag>
        </div>
      </div>
    );
  }

  const isCurrent = shown.id === current?.id;
  const canDecide = shown.status === 'pending' && isCurrent;
  const changeSets = s.changeSets.filter((c) => shown.changeSetRefs.includes(c.id));
  const artifacts = s.artifacts.filter((a) => shown.artifactRefs.includes(a.id));

  const statusTag = () => {
    switch (shown.status) {
      case 'pending':
        return <Tag tone="warning" icon="eye">待验收</Tag>;
      case 'accepted':
        return <Tag tone="success" icon="check-circle">已验收</Tag>;
      case 'changes_requested':
        return <Tag tone="danger" icon="corner-up-left">已要求修改</Tag>;
      default:
        /** 注意用词：这是"无需验收"，**不是**"已验收"（§10.5 第 2 条） */
        return <Tag tone="neutral" icon="slash">已完成 · 无需验收</Tag>;
    }
  };

  return (
    <div className="msg-list">
      {/* ---- 版本切换：返工后旧版仍可查看 ---- */}
      {versions.length > 1 ? (
        <div className="row tight wrap" style={{ marginBottom: 10 }}>
          <span className="small faint">交付版本</span>
          {versions.map((v) => (
            <button
              key={v.id}
              className={`chip${v.id === shown.id ? ' on' : ''}`}
              onClick={() => {
                setViewId(v.id);
                setNote('');
              }}
              title={`r${v.revision} · ${fullTime(v.createdAt)}`}
            >
              r{v.revision}
              {v.status === 'pending' ? ' · 待验收' : v.status === 'changes_requested' ? ' · 已退回' : ''}
            </button>
          ))}
          {!isCurrent ? (
            <Tag tone="neutral" icon="clock" title="这不是当前版本；它上面的按钮不能批准最新交付">
              历史版本
            </Tag>
          ) : null}
        </div>
      ) : null}

      {/* ---- 1. 任务目标 ---- */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row tight wrap">
          <span className="root-task-no">#{task.roomTaskNumber}</span>
          <span className="strong" style={{ fontSize: 13 }}>{task.title}</span>
          {statusTag()}
          <div className="spacer" />
          <Tag plain title="任务创建时的项目开关快照：之后改开关只影响新建的任务">
            {task.reviewPolicy === 'user_review' ? '创建时：需人工验收' : '创建时：无需验收'}
          </Tag>
        </div>
        <div className="small muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
          <span className="faint">目标 · </span>
          {task.objective}
        </div>
      </div>

      {/* ---- 2. 完成摘要（先于 diff） ---- */}
      <div className="section">
        <div className="section-title"><Icon name="file-text" size={14} /> 完成摘要</div>
        <div className="card">
          <div style={{ lineHeight: 1.75, fontSize: 12.5 }}>{shown.summary}</div>
          <div className="row tight wrap small faint" style={{ marginTop: 8 }}>
            <span>交付版本 r{shown.revision}</span>
            <span>{relTime(shown.createdAt)}</span>
            <span className="mono-sm" title="验收决定会校验这个摘要，避免批准到更新的内容">
              清单 {shown.manifestHash}
            </span>
          </div>
        </div>
      </div>

      {/* ---- 3. 可用效果预览 ---- */}
      {shown.preview?.length ? (
        <div className="section">
          <div className="section-title"><Icon name="eye" size={14} /> 效果预览</div>
          {shown.preview.map((p, i) => (
            <div key={i} className="card tight" style={{ marginBottom: 6 }}>
              <div className="strong" style={{ fontSize: 12 }}>{p.label}</div>
              <div className="small faint" style={{ marginTop: 3, lineHeight: 1.65 }}>{p.detail}</div>
            </div>
          ))}
          <div className="small faint" style={{ marginTop: 4 }}>
            预览为原型模拟数据，不代表真实运行结果。
          </div>
        </div>
      ) : null}

      {/* ---- 4. 实际验证与未验证原因 ---- */}
      <div className="section">
        <div className="section-title"><Icon name="shield-off" size={14} /> 验证结果</div>
        {shown.verification.map((v, i) => (
          <div key={i} className="card tight" style={{ marginBottom: 6 }}>
            <div className="row tight wrap">
              <Icon
                name={v.result === 'passed' ? 'check-circle' : v.result === 'failed' ? 'x-circle' : 'help-circle'}
                size={13}
                style={{ color: v.result === 'passed' ? 'var(--success)' : v.result === 'failed' ? 'var(--danger)' : 'var(--text-4)' }}
              />
              <span className="mono" style={{ fontSize: 11.5 }}>{v.label}</span>
              {/* 三态如实区分：未执行不写成通过（不伪造"真实测试通过"） */}
              <Tag
                tone={v.result === 'passed' ? 'success' : v.result === 'failed' ? 'danger' : 'neutral'}
              >
                {v.result === 'passed' ? '已执行 · 通过' : v.result === 'failed' ? '已执行 · 失败' : '未执行'}
              </Tag>
            </div>
            <div className="small faint" style={{ marginTop: 4, lineHeight: 1.65 }}>{v.detail}</div>
          </div>
        ))}
      </div>

      {/* ---- 5. 残余问题 ---- */}
      {shown.residuals.length > 0 ? (
        <div className="section">
          <div className="section-title"><Icon name="alert-triangle" size={14} /> 残余问题</div>
          <div className="panel warning">
            <div className="col" style={{ gap: 5 }}>
              {shown.residuals.map((r, i) => (
                <div key={i} className="row tight" style={{ alignItems: 'flex-start' }}>
                  <Icon name="alert-triangle" size={12} style={{ color: 'var(--warning)', marginTop: 4, flex: 'none' }} />
                  <span className="small" style={{ lineHeight: 1.65 }}>{r}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* ---- 验收决定 ---- */}
      {canDecide ? (
        <div className="section">
          <div className="review-bar">
            <div className="review-bar-title">
              <Icon name="eye" size={13} /> 这次交付等你确认
            </div>
            <div className="small faint" style={{ marginBottom: 8, lineHeight: 1.65 }}>
              验收只针对这个交付版本（r{shown.revision}）。
              <strong>不会</strong>提交或推送 Git，也<strong>不会</strong>批准任何权限请求。
              原目录模式下文件可能已经被修改 —— 验收确认的是交付结果，不是"此时才写入"。
            </div>
            <div className="panel-actions" style={{ marginTop: 0 }}>
              <button
                className="btn primary sm"
                onClick={() =>
                  reviewDelivery({
                    deliveryId: shown.id,
                    expectedRevision: shown.revision,
                    expectedManifestHash: shown.manifestHash,
                    decision: 'accept',
                  })
                }
              >
                <Icon name="check" size={12} /> 验收通过
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  if (!note.trim()) {
                    toast('要求修改必须填写意见：请在下方写明需要改什么', 'warn');
                    return;
                  }
                  reviewDelivery({
                    deliveryId: shown.id,
                    expectedRevision: shown.revision,
                    expectedManifestHash: shown.manifestHash,
                    decision: 'request_changes',
                    note,
                  });
                  setNote('');
                }}
              >
                <Icon name="corner-up-left" size={12} /> 要求修改
              </button>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label className="field-label">要求修改的意见（必填）</label>
              <textarea
                className="composer-input"
                rows={2}
                placeholder="写明需要改什么；提交与文件都会原样保留，不会撤销或删除"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* 已决定后的显示 */}
      {shown.status === 'accepted' ? (
        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="panel-title"><Icon name="check-circle" size={13} /> 已验收</div>
          {shown.reviewedBy ?? '你'} · {shown.reviewedAt ? fullTime(shown.reviewedAt) : ''} · 针对 r{shown.revision}
          （清单 {shown.manifestHash}）。
          <br />
          这次验收只覆盖上面这份冻结清单的内容；之后的<strong>新改动不继承</strong>这次验收结果。
        </div>
      ) : null}

      {shown.status === 'changes_requested' ? (
        <div className="panel danger" style={{ marginBottom: 12 }}>
          <div className="panel-title"><Icon name="corner-up-left" size={13} /> 已要求修改</div>
          <div style={{ lineHeight: 1.7 }}>
            <span className="faint">你的意见 · </span>
            {shown.reviewNote}
          </div>
          <div className="small faint" style={{ marginTop: 6 }}>
            文件与提交都原样保留（没有 reset、没有撤销提交、没有删除成果）。任务已回到执行中。
          </div>
          {/* 原型用明确的模拟按钮演示返工，不声称真实调用（交接文档 §3） */}
          {isCurrent ? (
            <div className="panel-actions">
              {/* 项目归属由任务实体推导（见 publishRework 注释）：
                  不传 activeProjectId，避免跨项目上下文里写错项目 */}
              <button className="btn sm" onClick={() => publishRework(taskId)}>
                <Icon name="refresh" size={12} /> 模拟返工并发布新版本
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---- 6. 文件清单与完整 diff（放在最后） ---- */}
      <div className="section">
        <div className="section-title">
          <Icon name="diff" size={14} /> 文件改动
          <span className="count">{changeSets.reduce((n, c) => n + c.files.length, 0)}</span>
        </div>
        {changeSets.length === 0 ? (
          <div className="small faint">这次交付没有产生文件改动。</div>
        ) : (
          changeSets.map((c) => (
            <div key={c.id} className="card" style={{ marginBottom: 10, padding: 0 }}>
              <div className="row tight wrap" style={{ padding: '9px 12px', borderBottom: '1px solid var(--border)' }}>
                <Tag
                  tone={c.applicationStatus === 'applied' ? 'success' : c.applicationStatus === 'reverted' ? 'neutral' : 'warning'}
                  icon={c.applicationStatus === 'applied' ? 'check-circle' : 'eye'}
                  title="文件应用状态（不是验收状态）"
                >
                  {c.applicationStatus === 'applied' ? '已写入原目录' : c.applicationStatus === 'reverted' ? '已还原' : c.applicationStatus === 'partial' ? '部分应用' : '未应用'}
                </Tag>
                <span className="small faint">改动集 {c.id}</span>
                <div className="spacer" />
                <span className="small faint mono-sm">{c.beforeRef.split(' ')[0]}</span>
              </div>
              {c.files.map((f) => (
                <div key={f.path}>
                  <div className="row tight wrap" style={{ padding: '7px 12px' }}>
                    <span className="mono" style={{ fontSize: 11.5 }}>{f.path}</span>
                    <Tag tone={f.change === 'added' ? 'success' : f.change === 'deleted' ? 'danger' : 'warning'}>
                      {f.change === 'added' ? '新增' : f.change === 'deleted' ? '删除' : f.change === 'renamed' ? '重命名' : '修改'}
                    </Tag>
                    {f.additions > 0 ? <span className="small" style={{ color: 'var(--success)' }}>+{f.additions}</span> : null}
                    {f.deletions > 0 ? <span className="small" style={{ color: 'var(--danger)' }}>−{f.deletions}</span> : null}
                    {f.userPreExisting ? <Tag tone="warning" icon="user">任务开始前已有改动</Tag> : null}
                    {f.cannotRevert ? <Tag tone="danger" icon="alert-triangle">超过前像上限</Tag> : null}
                  </div>
                  {f.diff.length > 0 ? (
                    <DiffView hunks={f.diff} />
                  ) : (
                    <div className="small faint" style={{ padding: '4px 12px 8px' }}>
                      该文件没有可展示的文本 diff（二进制、大文件或超过前像上限）。
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* 关联成果与提交：如实展示，不作为验收依据 */}
      {artifacts.length > 0 || (shown.commitRefs?.length ?? 0) > 0 ? (
        <div className="section">
          <div className="section-title"><Icon name="layers" size={14} /> 关联对象</div>
          <div className="small faint" style={{ lineHeight: 1.8 }}>
            {artifacts.length > 0 ? <div>成果 {artifacts.length} 份：{artifacts.map((a) => a.title).join('、')}</div> : null}
            {shown.commitRefs?.length ? (
              <div>
                提交 {shown.commitRefs.length} 个。提交只表示内容进入版本历史，
                <strong>不被用来判断交付是否通过</strong>。
              </div>
            ) : (
              <div>这次交付没有关联提交（改动仍在工作区）。提交与验收相互独立。</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
