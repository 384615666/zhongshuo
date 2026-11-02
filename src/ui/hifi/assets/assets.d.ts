/**
 * 图片资源以 data URL 形式导入。
 *
 * `scripts/build-ui.mjs` 的 hifi 构建给 esbuild 配了 `loader: { '.png': 'dataurl' }`，
 * 因此 `import x from './x.png'` 拿到的就是 `data:image/png;base64,...` 字符串本身，
 * 不需要运行时再读取文件，也不依赖 renderer 的静态资源路径。
 */
declare module '*.png' {
  const dataUrl: string;
  export default dataUrl;
}
