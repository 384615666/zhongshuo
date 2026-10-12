import { z } from 'zod';
export const conversationTasksParamsSchema=z.strictObject({projectId:z.string().min(1),conversationId:z.string().min(1),beforeTaskId:z.string().min(1).optional()});
export interface ConversationTaskPage { conversationId:string; items:Array<{id:string;title:string;status:string;revision:number;latestRun:{id:string;status:string}|null}>;nextCursor:string|null }
