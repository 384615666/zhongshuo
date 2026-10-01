/**
 * 解析依赖来源与版本核对（第三十轮二）：SheetJS 从 npm 旧端点（0.18.5——官方已声明过时）
 * 升级到官方 CDN 发行物（0.20.3，固定 URL+sha256 留档）——版本常量与实际安装一致、锁文件
 * 指向官方来源、来源与校验留档在合同注释（升级须同步改常量并复验 office 用例）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_PARSER_VERSIONS } from '../../src/daemon/parseContracts.ts';

describe('SheetJS 官方发行版来源与版本', () => {
  it('安装版本=合同常量=0.20.3（xlsx/package.json 实读）', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'node_modules', 'xlsx', 'package.json'), 'utf8')) as { version: string; name: string };
    expect(pkg.name).toBe('xlsx');
    expect(pkg.version).toBe('0.20.3');
    expect(CURRENT_PARSER_VERSIONS.sheet.version).toBe(pkg.version); // 缓存校验口径与安装一致
    expect(CURRENT_PARSER_VERSIONS.sheet.name).toBe('xlsx');
  });
  it('锁文件指向官方 CDN 发行物（非 npm 旧端点）', () => {
    const lock = readFileSync(join(process.cwd(), 'pnpm-lock.yaml'), 'utf8');
    expect(lock).toContain('cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz');
  });
  it('来源 URL 与 sha256 留档在合同注释（升级须同步复验）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'daemon', 'parseContracts.ts'), 'utf8');
    expect(src).toContain('https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz');
    expect(src).toContain('8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8');
  });
});
