/**
 * 双进程锁竞态 fixture：由测试父进程并发拉起，各自尝试获取单实例锁。
 * 输出一行 JSON { ok: boolean, code?: string } 后按结果持有/退出。
 * 运行方式：node（Node ≥23.6 直接执行 .ts，类型剥离）。
 */
import { acquireSingletonLock } from '../../src/daemon/singletonLock.ts';

const dir = process.argv[2];
if (dir == null) throw new Error('usage: node lockRaceWorker.ts <dir>');
const result = acquireSingletonLock(dir);
if (result.ok) {
  console.log(JSON.stringify({ ok: true, pid: process.pid }));
  // 持有一段时间让另一个进程必然撞上活锁。
  await new Promise((resolve) => setTimeout(resolve, 500));
  result.value.release();
} else {
  console.log(JSON.stringify({ ok: false, code: result.error.code }));
}
