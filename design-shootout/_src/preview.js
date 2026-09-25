/* 文件预览状态交互 v2
   - 入口统一在 kimi.html（本脚本随方案 B 主页面一起构建）
   - 窄窗切换条高亮由 CSS 状态类派生（.show-doc），JS 不写 is-active
   - 预览时侧栏保留；对话列是原 .thread DOM，预览绝不替换对话历史 */
(function () {
  var body = document.querySelector('.body');
  var thread = document.querySelector('.thread');
  var mq = window.matchMedia('(max-width: 980px)');

  function applyMq() { body.classList.toggle('narrow', mq.matches); }
  if (mq.addEventListener) mq.addEventListener('change', applyMq); else mq.addListener(applyMq);
  applyMq();

  function openPreview() {
    body.classList.add('preview-on');
    if (mq.matches) body.classList.add('show-doc');
    try { localStorage.setItem('zs.fp', '1'); } catch (e) {}
  }
  function closePreview() {
    body.classList.remove('preview-on');
    body.classList.remove('show-doc');
    try { localStorage.removeItem('zs.fp'); } catch (e) {}
  }

  var openBtn = document.getElementById('fpOpen');
  if (openBtn) openBtn.addEventListener('click', openPreview);
  var closeBtn = document.getElementById('fpClose');
  if (closeBtn) closeBtn.addEventListener('click', closePreview);
  var backBtn = document.getElementById('fpBack');
  if (backBtn) backBtn.addEventListener('click', closePreview);

  /* 窄窗切换条：只切 show-doc，高亮交给 CSS */
  var switchTabs = document.querySelectorAll('.fp-switch .fp-tab');
  Array.prototype.forEach.call(switchTabs, function (tab) {
    tab.addEventListener('click', function () {
      body.classList.toggle('show-doc', tab.getAttribute('data-pane') === 'doc');
    });
  });

  /* 文件标签页 */
  var fileTabs = document.querySelectorAll('.fp-head .fp-tab');
  var docs = document.querySelectorAll('.fp-doc');
  Array.prototype.forEach.call(fileTabs, function (tab) {
    tab.addEventListener('click', function () {
      var name = tab.getAttribute('data-doc');
      Array.prototype.forEach.call(fileTabs, function (t) { t.classList.toggle('is-active', t === tab); });
      Array.prototype.forEach.call(docs, function (d) { d.hidden = d.getAttribute('data-doc') !== name; });
    });
  });

  /* 拖拽调宽：以对话列左缘为基准（侧栏保留时也不错位） */
  var sp = document.getElementById('fpSplitter');
  if (sp) {
    sp.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      sp.classList.add('dragging');
      if (sp.setPointerCapture) sp.setPointerCapture(e.pointerId);
      function mv(ev) {
        var left = thread.getBoundingClientRect().left;
        var total = body.getBoundingClientRect().width;
        var w = Math.min(Math.max(ev.clientX - left, 320), total * 0.7);
        body.style.setProperty('--conv-w', w + 'px');
      }
      function up() {
        sp.classList.remove('dragging');
        sp.removeEventListener('pointermove', mv);
        sp.removeEventListener('pointerup', up);
      }
      sp.addEventListener('pointermove', mv);
      sp.addEventListener('pointerup', up);
    });
  }

  /* 状态恢复 + URL 参数（?fp=open / &pane=doc 供截图与分享） */
  var q = new URLSearchParams(location.search);
  var saved = null;
  try { saved = localStorage.getItem('zs.fp'); } catch (e) {}
  if (q.get('fp') === 'open' || (!q.has('fp') && saved)) body.classList.add('preview-on');
  if (q.get('pane') === 'doc') body.classList.add('show-doc');
})();
