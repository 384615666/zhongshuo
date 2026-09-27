/**
 * persistence 边界出口：SQLite 打开/迁移、事务网关、outbox、事件与写入路径。
 * 依赖：contracts + domain（§8.4）；由 daemon 组装。
 */
export { openDatabase, migrate } from './db.ts';
export type { ZhongshuoDatabase, Migration, MigrateResult, OpenOptions } from './db.ts';
export { runCommand, getReceipt } from './commandGateway.ts';
export type { CommandGatewayInput, CommandOutcome } from './commandGateway.ts';
export { enqueueOutbox, claimNextOutbox, completeOutbox, failOutbox, listOutbox } from './outbox.ts';
export type { OutboxRow, OutboxStatus } from './outbox.ts';
export { appendDomainEvent, listEvents } from './events.ts';
export { createRoomRootTask } from './stores/roomRootTask.ts';
export type { CreateRoomRootTaskInput, CreateRoomRootTaskResult } from './stores/roomRootTask.ts';
