/**
 * hifi 入口（H1 首包）：挂载 React 壳并启动真实装载（记忆路径自动打开）。
 * 失败安全兜底：任何挂载/启动期异常 → 标记 __zsHifiFailed 并回落 legacy 界面
 * （index.html 守卫会自动启动 legacy boot）。
 */
import { createRoot } from 'react-dom/client';
import App from './App';
import { bootRemembered } from './shell';

function fallbackToLegacy(err: unknown): void {
  console.error('[hifi] 换装壳启动失败，回退原界面：', err);
  const w = window as unknown as { __zsHifiFailed?: boolean; __zsLegacyStart?: () => void; __zsLegacyStarted?: boolean };
  w.__zsHifiFailed = true;
  document.body.classList.add('legacy-on');
  if (w.__zsLegacyStart != null && w.__zsLegacyStarted !== true) { w.__zsLegacyStart(); w.__zsLegacyStarted = true; }
}

/** 样式由壳**挂载时**注入（legacy 专项对照/未挂壳时不加载——原型全局样式不污染原界面）。 */
function loadHifiStyles(): void {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'hifi/app.css';
  document.head.append(link);
}

try {
  if (/[?&]nohifi=1/.test(location.search)) {
    // legacy 专项对照运行（?nohifi=1）：不挂换装壳、不启动装载——原界面独占页面。
  } else {
    const rootEl = document.getElementById('hifi-root');
    if (rootEl == null) throw new Error('#hifi-root 挂载点缺失');
    loadHifiStyles();
    document.body.classList.add('hifi-on'); // 共存 CSS 钩子：壳接管显示、legacy 隐藏
    createRoot(rootEl).render(<App />);
    void bootRemembered();
  }
} catch (e) {
  fallbackToLegacy(e);
}

window.addEventListener('error', (e) => {
  // 渲染期致命错误（资源缺失/桥异常）：一次性回退，不留在半初始化壳里。
  if ((e.message ?? '').includes('hifi')) fallbackToLegacy(e.error ?? e.message);
});
