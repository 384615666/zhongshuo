import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  MessageRepairLineage,
  MessageRepairLineageState,
} from '../../src/contracts/repairLineage.ts';
import { MessageView } from '../../src/ui/hifi/components/MessageView.tsx';
import type { Message } from '../../src/ui/hifi/data/types.ts';

type RepairMessage = Message & { formalRepairLineage?: MessageRepairLineage | null };

const sourceId = 'msg_turn_f748_original';
const replacementId = 'msg_turn_7adb_repaired';

function lineage(
  state: MessageRepairLineageState,
  messageRole: MessageRepairLineage['messageRole'] = 'source',
): MessageRepairLineage {
  return {
    state,
    messageRole,
    sourceMessageId: sourceId,
    replacementMessageId: state === 'repaired' ? replacementId : null,
    workitemId: 'frw_r108',
    logicalOutputId: 'turn_f748',
    sourceResultKey: 'result_turn_f748',
    sourceTurnId: 'turn_f748',
    repairTurnId: state === 'pending' ? null : 'turn_7adb',
    sourceRunId: 'run_original',
    repairRunId: state === 'pending' ? null : 'run_repair',
    projectId: 'project_r108',
    conversationId: 'conversation_r108',
    threadId: 'thread_r108',
    taskId: 'task_r108',
    memberId: 'member_r108',
  };
}

function message(
  id: string,
  body: string,
  formalRepairLineage?: MessageRepairLineage,
): RepairMessage {
  return {
    id,
    projectId: 'project_r108',
    roomId: 'room_r108',
    threadId: 'thread_r108',
    taskId: 'task_r108',
    authorType: 'agent',
    authorId: 'member_r108',
    kind: 'text',
    body,
    createdAt: 1,
    formalRepairLineage,
  };
}

function render(value: RepairMessage): string {
  return renderToStaticMarkup(createElement(MessageView, {
    message: value,
    onQuote: () => {},
    onSave: () => {},
    onOpenAttachment: () => {},
  }));
}

describe('R108 MessageView repair lineage presentation', () => {
  it('folds only the exact replaced source by default while retaining its id, full text, attachment and actions', () => {
    const originalText = `原始失败全文 ${'保留原文。'.repeat(400)} END_OF_ORIGINAL`;
    const source = message(sourceId, originalText, lineage('repaired', 'source'));
    source.formalAttachments = [{
      artifactId: 'artifact_original',
      filename: '原答附件.md',
      kind: 'text_file',
      sizeBytes: 8192,
    }];

    const html = render(source);
    expect(html).toContain('id="msg-msg_turn_f748_original"');
    expect(html).toContain('data-zs-repair-lineage="source"');
    expect(html).toContain('msg-repaired-source');
    expect(html).toContain('<details class="msg-detail-fallback msg-repair-source-history"');
    expect(html).not.toContain('<details open');
    expect(html).toContain('原答已补交 · 查看历史原文');
    expect(html).toContain('END_OF_ORIGINAL');
    expect(html).toContain('原答附件.md');
    expect(html).toContain('复制');
    expect(html).toContain('引用');
    expect(html).toContain('收藏');
  });

  it('presents the exact successful replacement as the visible 补交 version', () => {
    const replacement = message(
      replacementId,
      `补交有效全文 ${'替换成功。'.repeat(300)} END_OF_REPLACEMENT`,
      lineage('repaired', 'replacement'),
    );
    const html = render(replacement);
    expect(html).toContain('id="msg-msg_turn_7adb_repaired"');
    expect(html).toContain('data-zs-repair-lineage="replacement"');
    expect(html).toContain('msg-repair-replacement');
    expect(html).toContain('补交版本');
    expect(html).toContain('补交</span>');
    expect(html).toContain('END_OF_REPLACEMENT');
    expect(html).not.toContain('msg-repair-source-history');
  });

  it.each(['pending', 'failed', 'unknown'] as const)(
    'does not collapse or replace an answer for the %s repair state',
    (state) => {
      const html = render(message(sourceId, '源答保持普通展示 END', lineage(state)));
      expect(html).toContain('源答保持普通展示 END');
      expect(html).not.toContain('msg-repair-source-history');
      expect(html).not.toContain('补交版本');
      expect(html).not.toContain('data-zs-repair-lineage="source"');
    },
  );

  it('never folds a similar or intermediate message without an exact lineage binding', () => {
    const similarText = `原始失败全文 ${'保留原文。'.repeat(400)} END_OF_ORIGINAL`;
    const html = render(message('msg_similar_intermediate', similarText));
    expect(html).toContain('END_OF_ORIGINAL');
    expect(html).not.toContain('msg-repair-source-history');
    expect(html).not.toContain('原答已补交');
    expect(html).not.toContain('补交版本');
  });

  it('rejects a malformed lineage whose source id does not match the rendered message', () => {
    const mismatched = message('msg_unrelated', '普通正文保持展示', lineage('repaired', 'source'));
    const html = render(mismatched);
    expect(html).toContain('普通正文保持展示');
    expect(html).not.toContain('msg-repair-source-history');
    expect(html).not.toContain('原答已补交');
  });
});
