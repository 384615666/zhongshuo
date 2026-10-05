/**
 * 目录身份与锁域判定（主设计 §3.3、RT-09）。
 * - projectId 用随机稳定 ID；identityKey 由 realpath（解析 junction/符号链接/短名）+ 平台大小写规则构成。
 * - 不做无条件转小写：仅 win32 在「比较键」上做大小写折叠；存储的 rootPath/canonicalPath 保留原样。
 * - 不用简单字符串前缀判断包含：一律走「真实路径 + 路径边界」的祖先判定。
 */
import { realpathSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import type { DirectoryIdentity } from '../contracts/project.ts';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';

const IS_WINDOWS = process.platform === 'win32';

/** 比较键：win32 大小写不敏感文件系统折叠大小写；其他平台保留。 */
export function comparisonKey(path: string): string {
  return IS_WINDOWS ? path.toLowerCase() : path;
}

/**
 * 解析目录身份。目录必须存在且**是目录**（PROJECT_MISSING 由调用方处理为重定位流程，§16.5；
 * r60 P4：文件路径此前被 realpath 通过并当成项目打开——文件 discovery/写入后续才坏，入口即拒）。
 */
export function resolveDirectoryIdentity(rootPath: string): DomainResult<DirectoryIdentity> {
  if (!existsSync(rootPath)) {
    return domainErr('PROJECT_MISSING', `目录不存在：${rootPath}`, {
      details: { rootPath },
    });
  }
  try {
    const st = statSync(rootPath);
    if (!st.isDirectory()) {
      return domainErr('PROJECT_MISSING', `路径不是目录（不能作为项目打开）：${rootPath}`, {
        details: { rootPath },
      });
    }
    const canonicalPath = realpathSync(rootPath);
    return domainOk({
      rootPath,
      canonicalPath,
      identityKey: comparisonKey(canonicalPath),
    });
  } catch (error) {
    return domainErr('PROJECT_MISSING', `目录无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** a 是否为 b 的同一路径或祖先（路径边界判定，禁止裸前缀）。 */
export function isSameOrAncestorPath(a: string, b: string): boolean {
  const ka = comparisonKey(a).replaceAll('/', sep).replaceAll('\\', sep).replace(/[/\\]+$/, '');
  const kb = comparisonKey(b).replaceAll('/', sep).replaceAll('\\', sep).replace(/[/\\]+$/, '');
  if (ka === kb) return true;
  return kb.startsWith(ka + sep);
}

/**
 * 锁域重叠（RT-09）：同一物理目录、junction 复合路径、父子项目都视为重叠——
 * single_writer 下不能并发绕开；parallel_writers 下锁域判定不变（§14.1）。
 */
export function lockDomainsOverlap(identityKeyA: string, identityKeyB: string): boolean {
  return isSameOrAncestorPath(identityKeyA, identityKeyB) || isSameOrAncestorPath(identityKeyB, identityKeyA);
}
