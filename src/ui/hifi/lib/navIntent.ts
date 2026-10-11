/**
 * 导航意图取消（R73 二——review-r72 §P1：已取消的线程定位仍改变当前项目）。
 *
 * 定位/对齐链（locateThread → ensureProjectActive → focusProject/openProjectByPath）
 * 是多段 async；用户跳走/切项目/点新链接后，旧请求**不得**再抢焦点、写导航偏好、
 * 弹旧错误或继续重试。组件卸载标志只覆盖「最终 navigate」，盖不住链内每个 await
 * 之后的副作用——所以引入**全局意图登记簿**：
 *  - 用户级导航动作（navigate / focusProject / openProjectByPath 的非定位入口）到达时
 *    `cancelAllNavIntents()` 把所有在途意图标记取消；
 *  - 定位链在每个 await 之后、每次重试、每次提交焦点/持久化之前核 `navIntentActive`；
 *  - 链内自调用（ensureProjectActive 触发的 focus/open）带 `system/fromIntent` 标记，
 *    **不**取消自己所属的意图。
 * 不阻塞权威刷新、不禁用导航——被取消的请求只安静停下。
 */

export interface NavIntent {
  cancelled: boolean;
}

const registry = new Set<NavIntent>();
const cancelListeners = new WeakMap<NavIntent, Set<() => void>>();

/** 登记一个在途导航意图（定位器挂载时调用；卸载/完成时 release）。 */
export function registerNavIntent(): NavIntent {
  const t: NavIntent = { cancelled: false };
  registry.add(t);
  return t;
}

export function releaseNavIntent(t: NavIntent): void {
  registry.delete(t);
}

/** 用户发起了新的导航动作——所有在途意图即刻失效。 */
export function cancelNavIntent(t: NavIntent): void {
  if (t.cancelled) return;
  t.cancelled = true;
  for (const listener of cancelListeners.get(t) ?? []) listener();
}

/** 先撤销旧操作的临时投影，再让新操作捕获基线；不用等迟到回执才回滚。 */
export function onNavIntentCancel(t: NavIntent, listener: () => void): () => void {
  if (t.cancelled) { listener(); return () => {}; }
  const listeners = cancelListeners.get(t) ?? new Set<() => void>();
  listeners.add(listener);
  cancelListeners.set(t, listeners);
  return () => { listeners.delete(listener); };
}

export function cancelAllNavIntents(except?: NavIntent): void {
  for (const t of registry) if (t !== except) cancelNavIntent(t);
}

/** 用户级打开（含目录选择等待）与定位链共用取消登记簿。 */
export function beginUserNavIntent(): NavIntent {
  cancelAllNavIntents();
  return registerNavIntent();
}

/** 意图仍有效（未传=无取消约束，供用户直呼路径保持原行为）。 */
export function navIntentActive(t?: NavIntent): boolean {
  return t == null || t.cancelled !== true;
}
