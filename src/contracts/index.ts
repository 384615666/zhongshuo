/**
 * contracts 边界出口（§8.4：不依赖其他内部模块）。
 * 跨进程 DTO、schema、命令/事件与 adapter 接口的唯一权威入口。
 */
export * from './common.ts';
export * from './errors.ts';
export * from './project.ts';
export * from './conversation.ts';
export * from './routing.ts';
export * from './thread.ts';
export * from './message.ts';
export * from './task.ts';
export * from './run.ts';
export * from './caller.ts';
export * from './commands.ts';
export * from './budget.ts';
export * from './permission.ts';
export * from './queries.ts';
export * from './runtime.ts';
export * from './contextBundle.ts';
export * from './prompts.ts';
export * from './daemonIpc.ts';
export * from './deliberation.ts';
