// 换装壳开关 + 启动看门狗（第四十六轮 H1 / 第四十七轮加强）。
// flag：默认启用 hifi 壳；?nohifi=1（工程逃生口——legacy 专项验证器/对照运行）时不启用。
// 看门狗：hifi 模块加载失败（404/网络/模块错误——window.zs 不会置 __zsHifiFailed）时，
// 8 秒内未见 body.hifi-on 即视为失败：回退原界面并启动 legacy（与 app.js 守卫衔接）。
(function () {
  if (/[?&]nohifi=1/.test(location.search)) { window.__zsHifiWanted = false; return; }
  window.__zsHifiWanted = true;
  window.setTimeout(function () {
    if (document.body.classList.contains('hifi-on')) return;
    if (window.__zsHifiFailed === true) return; // main.tsx 已自行回退
    window.__zsHifiFailed = true;
    // 若 React 标题栏已挂载后随整棵 React 树失败而消失（createRoot 清空过容器）：重建最小壳——窗口控制不因换装失败丧失可达性。
    if (typeof window.__zsTitlebarMinimal === 'function') window.__zsTitlebarMinimal();
    document.body.classList.add('legacy-on');
    if (typeof window.__zsLegacyStart === 'function' && window.__zsLegacyStarted !== true) {
      window.__zsLegacyStart(); window.__zsLegacyStarted = true;
    }
  }, 8000);
  // 定向接管桥（App.takeLegacy 调用）：暂停/恢复旧端轮询。
  window.__zsLegacySetVisible = function (visible) { window.__zsLegacyPaused = !visible; };
})();
// 自绘标题栏壳（第五十四轮 H3 §3）：hifi 启用时窗口为无边框（--no-hifi 保留原生框）。
// 这里在 React 挂载之前先装好**最小可用**标题栏（拖动区+三枚窗口按钮）与常驻样式：
//  1) 即使 hifi 模块加载失败回退 legacy，窗口控制仍可达；
//  2) 样式独立于 hifi/app.css（接管期被禁用时标题栏不失样）；
//  3) React TitleBar（src/ui/hifi/components/TitleBar.tsx 经 portal 入 #zs-titlebar）
//     挂载后替换最小内容，类名与本样式共享。
(function () {
  if (window.__zsHifiWanted !== true || /[?&]nohifi=1/.test(location.search)) return; // nohifi=原生框，无自绘栏
  var TB_H = 38;
  document.body.classList.add('zs-frameless');
  var style = document.createElement('style');
  style.setAttribute('data-zs-titlebar', '1');
  style.textContent = [
    '.zs-titlebar{position:fixed;top:0;left:0;right:0;height:' + TB_H + 'px;display:flex;align-items:center;gap:8px;padding:0 0 0 10px;box-sizing:border-box;background:#fff;border-bottom:1px solid #e2e6ec;z-index:2147480000;-webkit-app-region:drag;user-select:none;font-size:12px;color:#3b4252;}',
    '.zs-titlebar .zs-tb-name{font-weight:600;flex:none;}',
    '.zs-titlebar .zs-tb-drag{flex:1;min-width:24px;height:100%;}',
    '.zs-titlebar .zs-tb-stat{flex:none;max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#69707f;}',
    '.zs-titlebar .zs-tb-stat .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:1px;background:#22a55e;}',
    '.zs-titlebar .zs-tb-stat.off .dot{background:#c9312e;}',
    '.zs-titlebar .zs-tb-note{flex:none;color:#98a0ad;}',
    '.zs-titlebar .zs-winbtn{flex:none;width:44px;height:' + TB_H + 'px;display:grid;place-items:center;border:none;background:transparent;color:#3b4252;cursor:pointer;-webkit-app-region:no-drag;}',
    '.zs-titlebar .zs-winbtn:hover{background:#eceff3;}',
    '.zs-titlebar .zs-winbtn.close:hover{background:#e81123;color:#fff;}',
    '.zs-titlebar .zs-winbtn svg{pointer-events:none;}',
    '.zs-titlebar .zs-tb-no-drag{-webkit-app-region:no-drag;}',
    // 布局偏移：两套界面根容器下移 TB_H；固定覆盖层让出标题栏高度。
    'body.zs-frameless.hifi-on #hifi-root{top:' + TB_H + 'px;}',
    'body.zs-frameless #app{height:calc(100vh - ' + TB_H + 'px);}',
    'body.zs-frameless .preview-pane{top:' + TB_H + 'px !important;}',
    'body.zs-frameless .zs-legacy-exit{top:' + (TB_H + 6) + 'px !important;}',
  ].join(String.fromCharCode(10));
  document.head.appendChild(style);
  injectMinimal();
})();
function injectMinimal() {
  var bar = document.getElementById('zs-titlebar');
  if (bar == null || bar.childElementCount > 0) return;
  var mkBtn = function (title, svg, fn) {
    var b = document.createElement('button');
    b.className = 'zs-winbtn' + (title === '关闭' ? ' close' : '');
    b.title = title;
    b.innerHTML = svg;
    b.onclick = function () { var w = window.zsWindow; if (w != null) w[fn](); };
    return b;
  };
  bar.className = 'zs-titlebar';
  var name = document.createElement('span');
  name.className = 'zs-tb-name';
  name.textContent = '众说';
  var drag = document.createElement('div');
  drag.className = 'zs-tb-drag';
  drag.title = '拖动窗口；双击最大化/还原';
  drag.ondblclick = function () { var w = window.zsWindow; if (w != null) w.toggleMaximize(); };
  var note = document.createElement('span');
  note.className = 'zs-tb-note';
  note.textContent = window.zsWindow != null ? '' : '浏览器宿主（窗口控制由桌面客户端提供）';
  bar.appendChild(name);
  bar.appendChild(drag);
  bar.appendChild(note);
  bar.appendChild(mkBtn('最小化', '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6h10" stroke="currentColor" stroke-width="1.2"/></svg>', 'minimize'));
  bar.appendChild(mkBtn('最大化/还原', '<svg width="11" height="11" viewBox="0 0 11 11"><rect x="1.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>', 'toggleMaximize'));
  bar.appendChild(mkBtn('关闭', '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.2"/></svg>', 'close'));
}
window.__zsTitlebarMinimal = injectMinimal;
