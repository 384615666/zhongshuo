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
    document.body.classList.add('legacy-on');
    if (typeof window.__zsLegacyStart === 'function' && window.__zsLegacyStarted !== true) {
      window.__zsLegacyStart(); window.__zsLegacyStarted = true;
    }
  }, 8000);
  // 定向接管桥（App.takeLegacy 调用）：暂停/恢复旧端轮询。
  window.__zsLegacySetVisible = function (visible) { window.__zsLegacyPaused = !visible; };
})();
