/**
 * domain 边界出口（§8.4：只依赖 contracts；纯业务逻辑，无 IO、无 Electron/厂商 SDK）。
 */
export * from './routing/mentions.ts';
export * from './routing/topLevelRoute.ts';
export * from './routing/dmRoute.ts';
export * from './routing/replyTarget.ts';
export * from './routing/followUp.ts';
export * from './routing/messageBinding.ts';
export * from './scope/dispatchScope.ts';
export * from './scope/stopTarget.ts';
export * from './scope/sourceConnection.ts';
export * from './idempotency.ts';
export * from './budget.ts';
export * from './approval.ts';
export * from './isolation/binding.ts';
export * from './isolation/contextFilter.ts';
