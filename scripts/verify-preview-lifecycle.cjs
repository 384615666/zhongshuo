'use strict';
/**
 * 第四十一轮·review-r40 §3：**产品函数级**预览生命周期确定性测试。
 * 从当前 src/ui/renderer/app.js **原样抽取** previewAttachment / closeAttachPreview /
 * releaseActivePreviewResources（vm 沙箱执行），只桩 DOM/vendor/command 传输——A 的首屏
 * goToSlide 受控延迟。不用比产品更正确的模拟页面代替（复核指出的旧支架缺陷）。
 * 场景：
 *  S1 A→B 迟到首屏：B 已上屏后放行 A 的迟到首屏——面板必须仍显示 B；A viewer 被释放
 *     （入口释放或迟到自清理）；关闭后两 viewer dispose 计数均 ≥1。
 *  S2 打开中关闭：A open 在途 → closeAttachPreview（abort）→ A 拒绝/降级不复活面板；
 *     随后 B 正常打开（无半开残留）。
 *  S3 打开失败清理：vendor open 抛错 → 降级呈现；viewer 指针空；close 幂等。
 * 运行：node scripts/verify-preview-lifecycle.cjs；产物 dist/desktop/preview-lifecycle/metrics.json。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/ui/renderer/app.js'), 'utf8');
const preview = src.slice(src.indexOf('async function previewAttachment('), src.indexOf('/** 已发消息附件芯片'));
const closeStart = src.indexOf('function releaseActivePreviewResources()');
const close = src.slice(closeStart, src.indexOf('// PDF 视觉渲染', closeStart));
if (preview.length === 0 || close.length === 0 || !close.includes('function closeAttachPreview')) {
  throw new Error('源码锚点缺失——previewAttachment/releaseActivePreviewResources/closeAttachPreview 抽取失败');
}

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.className = ''; this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  querySelectorAll() { return []; }
}
const textTree = (x) => [x.textContent, ...x.children.map(textTree)].filter(Boolean).join('|');

function makeSandbox({ failOpenFor } = {}) {
  const box = new Element('box');
  const viewers = [];
  const gates = new Map(); // name -> resolve（受控延迟首屏）
  const context = {
    AbortController, console, Uint8Array, Buffer,
    document: { createElement: (tag) => new Element(tag), querySelector: () => null },
    el: () => box,
    currentView: () => 'dm',
    showError: () => {},
    base64ToBytes: (s) => Buffer.from(s, 'base64'),
    command: async (_method, p) => ({
      attachmentId: p.attachmentId, filename: p.attachmentId + '.pptx', kind: 'slides_file',
      hash: 'a'.repeat(64), revision: 1, parser: 'probe',
      slides: [{ slide: 1, text: p.attachmentId, notes: '' }],
      visualBytesAvailable: true, bytesBase64: Buffer.from(p.attachmentId).toString('base64'),
    }),
    loadRendererPptx: async () => ({
      RECOMMENDED_ZIP_LIMITS: {},
      PptxViewer: {
        open: async (bytes) => {
          const name = Buffer.from(bytes).toString();
          if (failOpenFor === name) throw new Error('vendor-open-failed');
          const v = {
            name, slideCount: 1, zoomPercent: 100, disposed: 0, entered: false,
            dispose() { this.disposed += 1; },
            addEventListener() {},
            async goToSlide() { this.entered = true; if (gates.has(name)) await gates.get(name); },
            async setFitMode() {}, async setZoom() {},
          };
          viewers.push(v);
          return v;
        },
      },
    }),
  };
  vm.createContext(context);
  vm.runInContext(
    'let previewGeneration=0;let activePptxViewer=null;let activePreviewAbort=null;\n'
    + close + '\n' + preview + '\nglobalThis.api={previewAttachment,closeAttachPreview,releaseActivePreviewResources,state:()=>({gen:previewGeneration,viewer:activePptxViewer===null?null:activePptxViewer.name,abort:activePreviewAbort!==null})};',
    context,
  );
  return { box, viewers, gates, context };
}
const tick = async (n = 20) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };

(async () => {
  const results = {};

  // S1 A→B 迟到首屏不得覆盖 B；旧 viewer 释放。
  {
    const { box, viewers, gates, context } = makeSandbox();
    gates.set('A', new Promise((r) => { gates.set('A:resolve', r); }));
    const a = context.api.previewAttachment('A', 'A.pptx', 'slides_file');
    await tick(40); // A open+show(1) 进入受控延迟
    const b = context.api.previewAttachment('B', 'B.pptx', 'slides_file');
    await tick(40); // B 完成并上屏
    const before = textTree(box);
    const aDisposedAtRelease = viewers.find((v) => v.name === 'A')?.disposed ?? 0;
    gates.get('A:resolve')(); // 放行 A 的迟到首屏
    await a; await tick(10);
    const after = textTree(box);
    context.api.closeAttachPreview();
    const s1 = {
      bVisibleBeforeOldReturn: before.includes('B.pptx'),
      panelAfterOldReturnStillB: after.includes('B.pptx') && !after.startsWith('A.pptx'),
      headAfter: after.split('|')[0],
      aDisposedBeforeRelease: aDisposedAtRelease, // B 入口释放应已 dispose A（若 A viewer 已建）
      viewersAfterClose: viewers.map((v) => ({ name: v.name, disposed: v.disposed })),
      pass: false,
    };
    s1.pass = s1.bVisibleBeforeOldReturn === true && s1.panelAfterOldReturnStillB === true
      && viewers.filter((v) => v.name === 'A').every((v) => v.disposed >= 1)
      && viewers.filter((v) => v.name === 'B').every((v) => v.disposed >= 1);
    results.S1_lateFirstScreen = s1;
  }

  // S2 打开中关闭：A open 在途（vendor 延迟）→ close → A 不上屏不复活；B 随后正常。
  {
    const { box, viewers, context } = makeSandbox();
    // 让 A 的 vendor open 挂起（受控）：
    const origLoad = context.loadRendererPptx;
    let releaseOpen = null;
    context.loadRendererPptx = async () => {
      const lib = await origLoad();
      return {
        RECOMMENDED_ZIP_LIMITS: lib.RECOMMENDED_ZIP_LIMITS,
        PptxViewer: { open: () => new Promise((res) => { releaseOpen = res; }) },
      };
    };
    const a = context.api.previewAttachment('A', 'A.pptx', 'slides_file');
    await tick(30);
    context.api.closeAttachPreview();
    await tick(10);
    const notCommitted = !textTree(box).includes('A.pptx');
    releaseOpen?.({ name: 'A', slideCount: 1, zoomPercent: 100, disposed: 0, entered: true, dispose() { this.disposed += 1; }, addEventListener() {}, async goToSlide() {}, async setFitMode() {}, async setZoom() {} });
    await a; await tick(10);
    const stillNotCommittedAfterLateOpen = !textTree(box).includes('A.pptx');
    // B 正常重开（恢复正常 vendor）。
    context.loadRendererPptx = origLoad;
    await context.api.previewAttachment('B', 'B.pptx', 'slides_file');
    await tick(40);
    const s2 = { notCommitted, stillNotCommittedAfterLateOpen, bWorks: textTree(box).includes('B.pptx'), pass: false };
    s2.pass = notCommitted && stillNotCommittedAfterLateOpen && s2.bWorks;
    results.S2_closeDuringOpen = s2;
  }

  // S3 打开失败：vendor 抛错 → 降级呈现（提取文本卡片仍上屏）；指针空；close 幂等。
  {
    const { box, context } = makeSandbox({ failOpenFor: 'A' });
    await context.api.previewAttachment('A', 'A.pptx', 'slides_file');
    await tick(30);
    const tree = textTree(box);
    const stateAfter = context.api.state();
    context.api.closeAttachPreview();
    context.api.closeAttachPreview(); // 幂等
    const s3 = {
      degradedShown: tree.includes('视觉页预览不可用') && tree.includes('A.pptx'),
      viewerPtrNullAfterFail: stateAfter.viewer === null,
      pass: false,
    };
    s3.pass = s3.degradedShown && s3.viewerPtrNullAfterFail;
    results.S3_openFailure = s3;
  }

  const out = path.join(root, 'dist/desktop/preview-lifecycle');
  fs.mkdirSync(out, { recursive: true });
  const allPass = Object.values(results).every((r) => r.pass === true);
  fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify({ source: 'src/ui/renderer/app.js（原样抽取）', results, allPass }, null, 2));
  console.log('[preview-lifecycle] allPass=' + allPass + ' ' + JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.pass]))));
  process.exit(allPass ? 0 : 4);
})().catch((e) => { console.error('[preview-lifecycle] FAILED', e); process.exit(1); });
