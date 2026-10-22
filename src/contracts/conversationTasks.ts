import { z } from 'zod';
import type { TaskExecutionBlocker } from './executionBlockers.ts';
export const conversationTasksParamsSchema=z.strictObject({projectId:z.string().min(1),conversationId:z.string().min(1),beforeTaskId:z.string().min(1).optional()});
export interface ConversationTaskPage { conversationId:string; items:Array<{id:string;title:string;status:string;revision:number;latestRun:{id:string;status:string}|null;executionBlocker?:TaskExecutionBlocker|null}>;nextCursor:string|null }
