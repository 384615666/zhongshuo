import {z} from 'zod';

export const threadMembersChangeParams=z.strictObject({
  projectId:z.string().min(1),threadId:z.string().min(1),
  memberId:z.string().min(1),action:z.enum(['add','remove']),
  expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),
});

export interface ThreadMembersSnapshot {
  projectId:string;
  threadId:string;
  roomId:string;
  version:string;
  /** Includes disabled historical participants, so their identity stays visible. */
  memberIds:string[];
  /** Current, enabled room members who can receive new requests in this thread. */
  eligibleMemberIds:string[];
  runningMemberIds:string[];
}
