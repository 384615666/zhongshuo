import { test } from 'node:test';
import assert from 'node:assert';
import { greet } from './greeting.mjs';

test("greet('小明') 返回「你好，小明」", () => {
  assert.strictEqual(greet('小明'), '你好，小明');
});

test("greet('  小明  ') 去除两侧空白，返回「你好，小明」", () => {
  assert.strictEqual(greet('  小明  '), '你好，小明');
});

test("greet('') 返回「你好，朋友」", () => {
  assert.strictEqual(greet(''), '你好，朋友');
});

test("greet('   ') 纯空格返回「你好，朋友」", () => {
  assert.strictEqual(greet('   '), '你好，朋友');
});

test("greet('\\t\\n') 制表符/换行组合返回「你好，朋友」", () => {
  assert.strictEqual(greet('\t\n'), '你好，朋友');
});

test("greet('\\u00A0小明\\u3000') 不换行空格/全角空格被去除", () => {
  assert.strictEqual(greet(' 小明　'), '你好，小明');
});
