import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** R149：正式品牌替换与前端开发说明文字清理的回归护栏。
 *
 * 两类断言：
 *  - 欢迎页/窗口/安装器使用仓库根 logo.png（不再画旧「众」方块品牌标识）；
 *  - 用户截图里点名要删、以及同类的开发/验收口径，不得重新出现在用户可见字面量里
 *    （只扫描 TS 字面量与 JSX 文本，天然排除源码注释）。
 */
describe('R149 branding and visible-copy hygiene', () => {
  it('welcome page, window icon and installer all use the shipped logo', () => {
    const welcome = read('src/ui/hifi/pages/ProjectHome.tsx');
    expect(welcome).toContain('src="assets/logo.png"');
    expect(welcome).toContain('data-zs-welcome-logo');
    expect(welcome).toContain('alt="众说"');
    expect(welcome).not.toContain('brand-mark');

    // 构建：仓库根 logo.png 是唯一源图，构建复制进渲染器资产。
    const build = read('scripts/build-ui.mjs');
    expect(build).toContain('copyFileSync(join(root, \'logo.png\'), join(root, \'dist\', \'ui\', \'renderer\', \'assets\', \'logo.png\'))');

    // 窗口与数据操作窗口图标：应用根 PNG → 随包渲染器副本 → 原生 ICO 回退。
    const main = read('src/ui/main.ts');
    expect(main).toContain('function resolveWindowIconPath');
    expect(main).toContain("join(appRoot, 'dist', 'ui', 'renderer', 'assets', 'logo.png')");
    expect(main).toMatch(/function showDataProgressWindow[\s\S]*?icon: progressIcon/);

    // 安装器：卸载与操作手册快捷方式也使用正式 logo ICO（不再用默认文件图标）。
    const iss = read('packaging/windows/zhongshuo.iss');
    expect(iss).toMatch(/\{group\}\\众说操作手册[^\n]*IconFilename/);
    expect(iss).toMatch(/\{group\}\\卸载众说[^\n]*IconFilename/);

    // 渲染页 favicon 与数据操作页品牌位。
    expect(read('src/ui/renderer/index.html')).toContain('href="assets/logo.png"');
    expect(read('src/ui/renderer/data-progress.html')).toContain('src="assets/logo.png"');

    // 源图本身必须存在且非空（打包/ICO 转换的唯一来源）。
    expect(statSync(join(root, 'logo.png')).size).toBeGreaterThan(100_000);
  });

  it('never reintroduces development-only explanatory copy in visible literals', () => {
    const forbidden = [
      // 用户截图点名：
      '选择本机已有渠道和模型',
      '保存后显示 AI 的可用状态',
      '工作量更新于',
      '高级状态',
      '从选定成员的「保存配置模板」建立',
      '成员参与派发的实际边界',
      '正式 app-server',
      '完整权限沿用 CLI 的原生机制',
      '保存配置不等于渠道已实测',
      '配置成功≠能力已认证',
      // 同类开发/验收口径：
      '当前为验收防护环境',
      '未复制认证结论',
      '模型清单与思考等级从本机渠道读取',
      '交付校验值',
      '项目编辑档',
      '历史识图证据',
      '数据根身份',
      '在途预占',
      '决策 05',
      '决策 09',
      '决策 33',
      'M3 批次',
      'git numstat',
      '提交 ≠ 验收',
      '演示界面',
      '不污染当前项目',
      '按页显示',
      '保留上次事实',
      '读取元数据，不发送任务',
    ];
    const hits: string[] = [];
    for (const file of uiSources(join(root, 'src/ui/hifi'))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node)) return;
        const literal = ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node)
          || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
          ? node.text : null;
        if (literal != null) {
          const match = forbidden.find((term) => literal.includes(term));
          if (match != null) hits.push(`${file.slice(root.length + 1)}: ${match}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(hits).toEqual([]);
  });
});

function uiSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return uiSources(full);
    return entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') ? [full] : [];
  });
}
