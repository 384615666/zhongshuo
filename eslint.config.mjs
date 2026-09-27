import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// 六边界依赖矩阵（主设计 §8.4 C6：单仓单包，边界靠 import 规则约束）。
// contracts 不依赖其他内部模块；domain 只依赖 contracts；daemon 是组装根。
// tests 允许引用全部内部边界；ui 仅依赖 contracts（经 daemon IPC 消费其余层）。
const BOUNDARIES = {
  contracts: [],
  domain: ['contracts'],
  persistence: ['contracts', 'domain'],
  adapter: ['contracts', 'domain'],
  daemon: ['contracts', 'domain', 'persistence', 'adapter'],
  ui: ['contracts'],
};

const boundaryRule = {
  meta: {
    type: 'problem',
    docs: { description: '众说 src/ 六边界 import 依赖规则（§8.4）' },
    schema: [],
    messages: {
      forbidden:
        '边界违规：{{from}} 不允许 import {{to}}（{{from}} 允许的内部依赖：{{allowed}}）。见主设计 §8.4 / 开工契约 §1。',
    },
  },
  create(context) {
    const file = context.filename.replace(/\\/g, '/');
    const fromMatch = file.match(/(?:^|\/)src\/([^/]+)\//);
    if (!fromMatch) return {};
    const from = fromMatch[1] ?? '';
    if (!(from in BOUNDARIES)) return {};
    const allowed = BOUNDARIES[from];
    const dir = file.slice(0, file.lastIndexOf('/'));

    const resolveRelative = (spec) => {
      if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
      const parts = dir.split('/');
      for (const seg of spec.split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      return parts.join('/');
    };

    const check = (node, spec) => {
      const abs = resolveRelative(spec);
      if (abs == null) return;
      const toMatch = abs.match(/(?:^|\/)src\/([^/]+)\//);
      if (!toMatch) return;
      const to = toMatch[1] ?? '';
      if (to === from || allowed.includes(to)) return;
      context.report({
        node,
        messageId: 'forbidden',
        data: { from, to, allowed: allowed.length > 0 ? allowed.join(', ') : '（无）' },
      });
    };

    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node, node.source.value);
      },
    };
  },
};

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'archive/', 'hifi-prototype/', 'prototype/', 'design-shootout/', 'docs/'] },
  { files: ['tests/fixtures/**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly' } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { zhongshuo: { rules: { 'six-boundaries': boundaryRule } } },
    rules: {
      'zhongshuo/six-boundaries': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
