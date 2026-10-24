import { describe, expect, it } from 'vitest';
import {
  messageRepairLineageSchema,
  type MessageRepairLineage,
} from '../../src/contracts/repairLineage.ts';

const base: MessageRepairLineage = {
  state: 'pending',
  messageRole: 'source',
  sourceMessageId: 'message_source',
  replacementMessageId: null,
  workitemId: 'workitem_1',
  logicalOutputId: 'turn_source',
  sourceResultKey: 'result_turn_source',
  sourceTurnId: 'turn_source',
  repairTurnId: null,
  sourceRunId: 'run_source',
  repairRunId: null,
  projectId: 'project_1',
  conversationId: 'conversation_1',
  threadId: 'thread_1',
  taskId: 'task_1',
  memberId: 'member_1',
};

describe('R108 repair-lineage contract states', () => {
  it('accepts queued pending without a turn and consumed pending with both bound ids', () => {
    expect(messageRepairLineageSchema.parse(base)).toMatchObject({
      state: 'pending',
      repairTurnId: null,
      repairRunId: null,
    });
    expect(messageRepairLineageSchema.parse({
      ...base,
      repairTurnId: 'turn_repair',
      repairRunId: 'run_repair',
    })).toMatchObject({
      state: 'pending',
      repairTurnId: 'turn_repair',
      repairRunId: 'run_repair',
    });
  });

  it('rejects a half-bound repair identity', () => {
    expect(() => messageRepairLineageSchema.parse({
      ...base,
      repairTurnId: 'turn_repair',
    })).toThrow(/both be present or both be absent/);
  });
});
