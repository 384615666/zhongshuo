/**
 * R91 模块3：研讨阶段消息 + 生成文件卡（实际 loader 转译 × 实际 React 渲染）。
 *
 * 覆盖：
 *  - 后端 `body_json.collaborationStage`（thread.history items.body 完整对象 /
 *    DM body_json 字符串）→ Message.collaborationStage；缺省/畸形安全忽略。
 *  - 消息头只显示中文阶段标签+轮次；真实作者；原 JSON、内部枚举、turnId/runId 不渲染。
 *  - 正式附件卡在正文之后、复制/引用/收藏之前；多文件/长中文名；同 artifact 不重复；
 *    正式附件存在时不叠加原型 resources 通道。
 *  - 正文里随手写的绝对路径仍是普通文字，不产生文件卡。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageView, collaborationStageText } from '../../src/ui/hifi/components/MessageView.tsx';
import { collaborationStageOfBody, msgOfDmHistory, msgOfReply, stripStageHeading } from '../../src/ui/hifi/loader.ts';
import { getState, setState } from '../../src/ui/hifi/data/store.ts';
import type { Message, PreviewResource, ProjectMember } from '../../src/ui/hifi/data/types.ts';

const authorOf = (id: string, displayName: string, ordinal = 1): ProjectMember => ({
  id, projectId: 'p1', profileId: `profile_${id}`, displayName, ordinal,
  enabled: true, workState: 'idle', model: 'm', effort: 'medium', internalSubagents: false, isCoordinatorDefault: false,
});

const memberA = authorOf('member_a', '成员甲', 1);
const memberB = authorOf('member_b', '成员乙', 2);

const renderMessage = (message: Message, props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(createElement(MessageView, {
    message,
    author: message.authorType === 'human' ? undefined : memberA,
    onSave: () => {},
    onQuote: () => {},
    ...props,
  }));

let originalState = getState();
afterEach(() => { setState(() => originalState); originalState = getState(); });

describe('R91 loader: collaborationStage 转译（thread.history 完整 body / DM body_json）', () => {
  it('thread history item.body.collaborationStage becomes a presentation marker; backend heading is not duplicated', () => {
    const message = msgOfReply('p1', 'r1', 't1', {
      id: 'msg_stage_1', authorType: 'agent', authorId: 'member_b', seq: 7,
      body: {
        text: '【互评】\n我复核了成员甲的结论，同意其中两条，一条需要补充证据。',
        collaborationStage: { stage: 'CROSS_REVIEW', roundNo: 0, turnId: 'turn_9', runId: 'run_9' },
      },
      createdAt: 1000, attachments: [{ artifactId: 'art_a', filename: '复核.md', kind: 'text_file' }],
    });
    expect(message.collaborationStage).toEqual({ stage: 'CROSS_REVIEW', roundNo: 0, turnId: 'turn_9', runId: 'run_9' });
    expect(message.authorId).toBe('member_b');
    expect(message.threadMessageSeq).toBe(7);
    expect(message.formalAttachments).toEqual([{ artifactId: 'art_a', filename: '复核.md', kind: 'text_file' }]);
    expect(message.body).toBe('我复核了成员甲的结论，同意其中两条，一条需要补充证据。');
    expect(message.body).not.toContain('【互评】');
    expect(message.body).not.toContain('collaborationStage');
    expect(message.body).not.toContain('{');
  });

  it('DM body_json string carries the same metadata; body_json itself never becomes message text', () => {
    const message = msgOfDmHistory('p1', 'dm_1', {
      id: 'msg_dm_1', author_type: 'agent', author_id: 'member_b', conversation_seq: 3, created_at: 1000,
      body_json: JSON.stringify({
        text: '【独立分析】\n我的独立分析是：先复核数据口径。',
        collaborationStage: { stage: 'INDEPENDENT', roundNo: 0, turnId: 'turn_1', runId: 'run_1' },
      }),
    }, 0);
    expect(message.collaborationStage).toEqual({ stage: 'INDEPENDENT', roundNo: 0, turnId: 'turn_1', runId: 'run_1' });
    expect(message.authorType).toBe('agent');
    expect(message.authorId).toBe('member_b');
    expect(message.threadMessageSeq).toBe(3);
    expect(message.body).toBe('我的独立分析是：先复核数据口径。');
    expect(message.body).not.toContain('schemaVersion');
  });

  it('only a known stage heading is removed; unknown brackets and ordinary bodies are preserved', () => {
    expect(stripStageHeading('【争议讨论 · 第2轮】\n我认为需要补充证据。', { stage: 'ISSUE_DISCUSSION', roundNo: 2 })).toBe('我认为需要补充证据。');
    expect(stripStageHeading('【争议讨论 · 检查点 · 第2轮】\n继续研讨。', { stage: 'ISSUE_DISCUSSION', roundNo: 2 })).toBe('继续研讨。');
    expect(stripStageHeading('【自定义标题】\n正文', { stage: 'SYNTHESIS', roundNo: 0 })).toBe('【自定义标题】\n正文');
    expect(stripStageHeading('【整合】', { stage: 'SYNTHESIS', roundNo: 0 })).toBe('【整合】'); // 不把消息删空
    expect(stripStageHeading('【整合】\n正文', undefined)).toBe('【整合】\n正文'); // 无 metadata 不处理
    expect(stripStageHeading('普通正文', { stage: 'RATIFY', roundNo: 0 })).toBe('普通正文');
  });

  it('missing or malformed metadata is ignored (ordinary message, no crash, no JSON text)', () => {
    expect(collaborationStageOfBody(undefined)).toBeUndefined();
    expect(collaborationStageOfBody(null)).toBeUndefined();
    expect(collaborationStageOfBody({ text: '普通消息' })).toBeUndefined();
    expect(collaborationStageOfBody({ collaborationStage: { roundNo: 2 } })).toBeUndefined();
    expect(collaborationStageOfBody({ collaborationStage: { stage: '   ' } })).toBeUndefined();
    expect(collaborationStageOfBody({ collaborationStage: 'CROSS_REVIEW' })).toBeUndefined();
    expect(collaborationStageOfBody({ collaborationStage: { stage: 'SYNTHESIS', roundNo: Number.NaN, turnId: 42 } })).toEqual({ stage: 'SYNTHESIS' });
    const plain = msgOfReply('p1', 'r1', 't1', { id: 'm_plain', authorType: 'agent', authorId: 'member_a', seq: 1, body: { text: '没有阶段标记' }, createdAt: 1 });
    expect(plain.collaborationStage).toBeUndefined();
    expect(plain.body).toBe('没有阶段标记');
    const malformedJson = msgOfDmHistory('p1', 'dm_1', { id: 'm_bad', body_json: '{not json', author_type: 'agent', author_id: 'member_a' }, 0);
    expect(malformedJson.collaborationStage).toBeUndefined();
  });
});

describe('R96 delivery facts and model documents', () => {
  it('runtimeControlResult.document=null hides an older nested detailMarkdown fallback', () => {
    const message = msgOfDmHistory('p1', 'dm-null', {
      id: 'null-document',
      body_json: JSON.stringify({
        text: '短回复保持简短',
        runtimeControlResult: JSON.stringify({
          schemaVersion: 'task-complete-v1',
          detailMarkdown: '# 旧格式完整详情\n\nR96_OLD_DETAIL_MUST_NOT_RETURN',
          document: null,
        }),
      }),
      authorType: 'agent',
      authorId: 'member_a',
      createdAt: 1,
    }, 0);
    expect(message.body).toBe('短回复保持简短');
    expect(message.detailMarkdown).toBeUndefined();
    expect(renderMessage(message)).not.toContain('R96_OLD_DETAIL_MUST_NOT_RETURN');
  });

  it('maps legacy final-report disputes to an ended legacy fact, never to ready', () => {
    const message = msgOfDmHistory('p1', 'dm1', {
      id: 'legacy-final',
      body_json: JSON.stringify({
        text: '旧格式最终回复',
        runtimeControlResult: JSON.stringify({ schemaVersion: 'final-report-v1', overallConsensus: 'disputed', claimResults: [] }),
      }),
      authorType: 'agent',
      authorId: 'member_a',
      createdAt: 1,
    }, 0);
    expect(message.delivery).toEqual({ status: 'legacy', overallConsensus: 'disputed' });
    const html = renderToStaticMarkup(createElement(MessageView, { message }));
    expect(html).toContain('data-zs-delivery-state="legacy"');
    expect(html).toContain('本轮已结束 · 旧格式');
    expect(html).toContain('仍有分歧');
    expect(html).not.toContain('data-zs-delivery-state="delivered"');
  });

  it('renders a named model document and a delivered-with-questions fact separately from the text', () => {
    const message = msgOfDmHistory('p1', 'dm2', {
      id: 'new-final',
      body_json: JSON.stringify({
        text: '模型正文保持原样',
        document: { filename: '实施方案.md', purpose: '供用户执行', artifactId: 'art_doc_1' },
        delivery: { status: 'delivered_with_questions', overallConsensus: 'qualified', unresolvedIssues: [{ id: 'i1', status: 'needs_user' }] },
      }),
      authorType: 'agent',
      authorId: 'member_a',
      createdAt: 2,
      attachments: [{ artifactId: 'art_doc_1', filename: '实施方案.md', kind: 'text_file', detailMarkdown: true }],
    }, 0);
    expect(message.document).toMatchObject({ filename: '实施方案.md', purpose: '供用户执行', artifactId: 'art_doc_1' });
    expect(message.formalAttachments?.[0]).toMatchObject({ document: true, purpose: '供用户执行', detailMarkdown: false });
    const html = renderToStaticMarkup(createElement(MessageView, { message }));
    expect(html).toContain('实施方案.md');
    expect(html).toContain('data-zs-delivery-state="delivered_with_questions"');
    expect(html).toContain('已交付 · 有待确认');
    expect(html).toContain('1 项未解决');
  });

  it('shows concrete needs_user questions and needs_revision requests instead of only a count', () => {
    const base: Message = { id: 'r96-action', projectId: 'p1', roomId: 'r1', authorType: 'agent', authorId: 'member_a', kind: 'text', body: '', createdAt: 1 };
    const needsUser: Message = {
      ...base,
      body: '等待用户补充',
      delivery: {
        status: 'needs_user',
        feedback: [{ status: 'needs_user', question: '请确认生产窗口', owner: '用户' }],
      },
    };
    const needsRevision: Message = {
      ...base,
      id: 'r96-action-2',
      body: '内部 need revision',
      delivery: {
        status: 'blocked',
        feedback: [{ status: 'needs_revision', revisionRequest: '补充回滚步骤' }],
      },
    };
    const userHtml = renderMessage(needsUser);
    expect(userHtml).toContain('请确认生产窗口（责任方：用户）');
    expect(userHtml).toContain('等待你补充');
    const revisionHtml = renderMessage(needsRevision);
    expect(revisionHtml).toContain('补充回滚步骤');
    expect(revisionHtml).toContain('交付未完成');
  });
});

describe('R91 MessageView: 中文阶段标签/轮次/真实作者，不渲染内部元数据', () => {
  it('renders the existing stageLabel mapping plus round, with the real author', () => {
    const message: Message = {
      id: 'm_stage', projectId: 'p1', roomId: 'r1', threadId: 't1',
      authorType: 'agent', authorId: 'member_b', kind: 'text',
      body: '争议「数据口径」：需要补充证据 — 我建议先复核来源。',
      createdAt: 2, threadMessageSeq: 12,
      collaborationStage: { stage: 'ISSUE_DISCUSSION', roundNo: 2, turnId: 'turn_secret', runId: 'run_secret' },
    };
    const html = renderMessage(message, { author: memberB });
    expect(html).toContain('成员乙');
    expect(html).toContain('分歧讨论');
    expect(html).toContain('第2轮');
    expect(html).toContain('需要补充证据');
    expect(html).not.toContain('ISSUE_DISCUSSION');
    expect(html).not.toContain('turn_secret');
    expect(html).not.toContain('run_secret');
    expect(html).not.toContain('collaborationStage');
    expect(html).not.toContain('"stage"');
    expect(html).not.toContain('第0轮');
  });

  it('roundNo=0 (stage-level product) shows only the stage label, never 第0轮', () => {
    const html = renderMessage({
      id: 'm_stage_zero', projectId: 'p1', roomId: 'r1', threadId: 't1',
      authorType: 'agent', authorId: 'member_b', kind: 'text', body: '独立分析正文。', createdAt: 2,
      collaborationStage: { stage: 'INDEPENDENT', roundNo: 0, turnId: 't', runId: 'r' },
    }, { author: memberB });
    expect(html).toContain('独立分析');
    expect(html).not.toContain('第0轮');
    expect(html).not.toContain('INDEPENDENT');
  });

  it('uses the canonical Chinese label for each supported stage and a safe fallback for unknown ones', () => {
    const cases: Array<[string, string]> = [
      ['INDEPENDENT', '独立分析'], ['CROSS_REVIEW', '互评'], ['ISSUE_DISCUSSION', '分歧讨论'],
      ['SYNTHESIS', '整合'], ['RATIFY', '确认'], ['PUBLISH', '发布'],
    ];
    for (const [stage, label] of cases) {
      expect(collaborationStageText({ stage, roundNo: 2 })).toBe(`${label} · 第2轮`);
    }
    expect(collaborationStageText({ stage: 'INTERNAL_STAGE_X' })).toBe('研讨发言');
    expect(collaborationStageText({ stage: 'CROSS_REVIEW' })).toBe('互评');
    expect(collaborationStageText({ stage: 'cross_review' })).toBe('互评');
  });
});

describe('R91 MessageView: 生成文件卡在正文之后、操作之前且不重复', () => {
  const generated = {
    artifactId: 'art_xlsx', filename: '季度分析总表-华东大区-2026年第三季度-最终版.xlsx', kind: 'sheet_file', sizeBytes: 24576,
  };
  const reply: Message = {
    id: 'm_final', projectId: 'p1', roomId: 'r1', threadId: 't1',
    authorType: 'agent', authorId: 'member_a', kind: 'text',
    body: '汇总如下。\n\n参考路径 D:\\zhongshuo\\secret\\report.xlsx 只是正文文字，不是文件。',
    createdAt: 3, threadMessageSeq: 20,
    collaborationStage: { stage: 'SYNTHESIS', roundNo: 3 },
    formalAttachments: [
      generated,
      { artifactId: 'art_csv', filename: '逐条明细.csv', kind: 'sheet_file' },
      { artifactId: 'art_docx', filename: '评审纪要.docx', kind: 'docx_file' },
      { artifactId: 'art_pdf', filename: '对账单.pdf', kind: 'pdf_file' },
      { artifactId: 'art_txt', filename: '验收说明.txt', kind: 'text_file' },
      { artifactId: 'art_xlsx', filename: '重复登记的同一文件.xlsx', kind: 'sheet_file' },
      { artifactId: 'art_bin', filename: '历史导出.bin', kind: 'unsupported_file' },
      { artifactId: '', filename: '无身份.txt', kind: 'text_file' },
    ],
  };

  it('keeps body → attachment cards → copy/quote/favorite order, with every file clickable once', () => {
    const html = renderMessage(reply, { author: memberA });
    const bodyIndex = html.indexOf('msg-text');
    const attachIndex = html.indexOf('msg-inline-attachments');
    const actionIndex = html.indexOf('msg-actions');
    expect(bodyIndex).toBeGreaterThanOrEqual(0);
    expect(attachIndex).toBeGreaterThan(bodyIndex);
    expect(actionIndex).toBeGreaterThan(attachIndex);
    expect(html).toContain('汇总如下');
    expect(html).toContain('季度分析总表-华东大区-2026年第三季度-最终版.xlsx');
    expect(html).toContain('逐条明细.csv');
    expect(html).toContain('评审纪要.docx');
    expect(html).toContain('对账单.pdf');
    expect(html).toContain('验收说明.txt');
    expect(html).toContain('24 KB');
    expect(html).toContain('表格');
    expect(html).toContain('Word');
    expect(html).toContain('PDF');
    expect(html).toContain('文本');
    expect(html).toContain('文件'); // unknown kind fallback, not the raw enum
    expect(html).not.toContain('unsupported_file');
    // 同一 artifactId 重复登记只渲染一张卡（6 个唯一有效正式附件）
    expect((html.match(/data-zs-artifact-id=/g) ?? []).length).toBe(6);
    expect(html).not.toContain('重复登记的同一文件.xlsx');
    // 正文里的绝对路径不是文件卡：只有正式附件按钮，没有把路径变成可点入口
    expect(html).toContain('D:\\zhongshuo\\secret\\report.xlsx');
    expect(html).not.toContain('data-zs-artifact-id="secret');
    // 仍只保留复制/引用/收藏三个动作
    expect(html).toContain('复制');
    expect(html).toContain('引用');
    expect(html).toContain('收藏');
    expect(html).not.toContain('更多');
  });

  it('keeps distinct prototype resources alongside formal cards and still renders resource-only legacy messages', () => {
    const resource: PreviewResource = {
      id: 'res_legacy', projectId: 'p1', kind: 'attachment', title: '旧原型附件.txt', mimeType: 'text/plain',
      origin: { kind: 'message', messageId: 'm_final', roomId: 'r1' },
      audience: { kind: 'room', roomId: 'r1' },
      revisions: [{ revision: 1, hash: 'h1', sizeBytes: 8, createdAt: 1, content: { kind: 'text', text: 'old text' } }],
      createdAt: 1,
    };
    originalState = getState();
    setState((s) => ({
      ...s,
      resources: [...s.resources, resource],
      messageAttachments: [...s.messageAttachments, { id: 'ma_legacy', messageId: 'm_final', resourceId: 'res_legacy', revision: 1, ordinal: 0 }],
    }));
    const withFormal = renderMessage({ ...reply, attachmentIds: ['res_legacy'] });
    expect(withFormal).toContain('旧原型附件.txt');
    expect(withFormal).toContain('msg-attach-row');
    expect(withFormal.indexOf('季度分析总表')).toBeLessThan(withFormal.indexOf('旧原型附件.txt'));

    const oldMessage = renderMessage({ ...reply, formalAttachments: undefined, body: '旧消息正文', collaborationStage: undefined });
    expect(oldMessage).toContain('旧消息正文');
    expect(oldMessage).toContain('旧原型附件.txt');
    expect(oldMessage).toContain('msg-attach-row');
  });

  it('keeps progress-message body above the attachment cards too (no card at body top)', () => {
    const html = renderMessage({
      ...reply, id: 'm_progress', kind: 'progress', collaborationStage: undefined,
      formalAttachments: [generated],
    });
    const bodyIndex = html.indexOf('msg-text');
    const attachIndex = html.indexOf('msg-inline-attachments');
    expect(bodyIndex).toBeGreaterThanOrEqual(0);
    expect(attachIndex).toBeGreaterThan(bodyIndex);
  });

  it('renders nothing extra when a message has no formal attachments (old/reopened message)', () => {
    const html = renderMessage({ ...reply, formalAttachments: undefined, body: '早期普通回复', collaborationStage: undefined });
    expect(html).toContain('早期普通回复');
    expect(html).not.toContain('msg-inline-attachments');
    expect(html).not.toContain('data-zs-artifact-id');
    expect(html).toContain('msg-actions');
  });
});
