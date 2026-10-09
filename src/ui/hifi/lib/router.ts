/**
 * 极简 hash 路由。
 * 路由形态对齐 §15.5 建议的 /projects/:projectId/rooms/:roomId?thread=:threadId
 * 原型只做定位，不执行 prompt、命令或权限变更。
 */

import { useEffect, useState } from 'react';
import { cancelAllNavIntents } from './navIntent';

/**
 * URL 代次（R75）：每次 hashchange +1。openProjectByPath 在入口记录 currentNavSeq()，
 * 打开窗口内若 URL 未再变（代次未前进），旧路由视为**打开前的陈旧 URL** 让位——
 * 不由它对齐抢回焦点；用户在打开发起后主动导航（代次前进）则路由照常工作。
 */
let navSeqCounter = 0;
export function currentNavSeq(): number { return navSeqCounter; }

export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash.replace(/^#/, '') || '/welcome');
  useEffect(() => {
    const onChange = () => { navSeqCounter += 1; setHash(window.location.hash.replace(/^#/, '') || '/welcome'); };
    window.addEventListener('hashchange', onChange);
    /**
     * 挂上监听后立刻补读一次。
     *
     * 必要性：`navigate(to, {replace:true})` 走 `history.replaceState`，
     * replaceState **不会**触发原生 hashchange，所以那里是手工 dispatch 一个事件。
     * 而 React 的 effect 是**子先父后**执行 —— 声明式重定向（RedirectTo）是子组件，
     * 它的 effect 先跑并完成 replace，此时 App 里 useHashRoute 的监听还没挂上，
     * 那个手工事件就被丢掉了：地址栏已经是新路径，界面却仍按旧路径渲染
     * （实测表现为 `/task/:id` 重定向后房间与线程面板都不出现）。
     * 在订阅处补读一次即可覆盖这段窗口，不依赖事件是否被收到。
     */
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function navigate(to: string, opts?: { replace?: boolean }) {
  const next = to.startsWith('/') ? to : `/${to}`;
  if (window.location.hash.replace(/^#/, '') === next) return;
  // R73：用户级导航即刻失效所有在途定位/对齐意图（旧请求不得再抢焦点/写偏好/弹旧错）。
  cancelAllNavIntents();
  if (opts?.replace) {
    // 切 tab 这类动作不该堆历史记录（否则"返回"要按很多次）
    const url = `${window.location.pathname}${window.location.search}#${next}`;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = next;
}

/**
 * 解析 `?a=b&c=d` 查询段。
 *
 * **已换为 URLSearchParams**（UX-PREVIEW-01 / 施工说明 §5.C.1）。
 *
 * 旧实现是 `pair.split('=')` 只取前两段，这在本轮新增文件参数后会**截断真实的
 * 文件路径与查询值** —— 例如 `?file=docs%2Fa%3Db.md` 解码后含 `=`，
 * 或未编码路径里带 `=`，都会被切掉后半段，导致"打开的文件不是那个文件"。
 * URLSearchParams 按标准处理分隔与百分号解码，不再有这类问题。
 *
 * 注意：hash 里的查询段只取第一个 `#` 之后的内容，由调用方传入；
 * 这里不做二次解码（URLSearchParams 已解码一次），避免 `%252F` 被解码两次。
 */
export function parseQuery(path: string): Record<string, string> {
  const qIndex = path.indexOf('?');
  if (qIndex < 0) return {};
  const raw = path.slice(qIndex + 1);
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

export function pathOf(path: string): string {
  const qIndex = path.indexOf('?');
  return qIndex < 0 ? path : path.slice(0, qIndex);
}

/** 路由匹配：'/project/:pid/room/:rid' → { pid, rid } */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pathOf(path).split('/').filter(Boolean);
  const t = pattern.split('/').filter(Boolean);
  if (p.length !== t.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith(':')) params[t[i].slice(1)] = decodeURIComponent(p[i]);
    else if (t[i] !== p[i]) return null;
  }
  return params;
}
