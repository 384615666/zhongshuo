/**
 * 真实调用预算护栏（第八轮：机械硬上限，替代「按用例数估上限」的口径——用例数≠
 * startTurn 次数）。真实认证测试（tests/e2e/real*.test.ts）在**发出任何 startTurn 前**
 * 必须经此闸门计数；超限在请求前拒绝（不发网络请求）。
 *
 * 语义：
 * - 显式配置全必填（runtime/model/maxStartTurns/budgetLabel/storeDir）——缺任何一项
 *   = 本次执行配置不全，open 即拒绝（未提供配置时在请求前拒绝，不静默降级）；
 * - 额度存**文件账本**（storeDir/real-call-budget.json）+ 目录锁互斥：同批多个测试文件/
 *   多个进程共享同一账本——谁都不能各自重新获得完整额度；
 * - acquireStartTurn：acquired ≥ maxStartTurns → 抛 RealCallLimitError（拒绝不占额度，
 *   记 rejected 次数）；否则 acquired+1 并登记 ticket（outcome 起始 pending）；
 * - recordOutcome：sent / failed / timeout / uncertain（请求是否发出不确定）如实记录——
 *   不把不确定当零消耗；已 acquire 的票无论结果如何都占额度（保守口径）；
 * - 环境变量门禁（ZS_REAL_E2E）≠ 预算硬上限：前者只是跳过开关，本闸门才是机械约束。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface RealCallGateConfig {
  runtime: 'codex' | 'claude';
  model: string;
  maxStartTurns: number;
  /** 本次批准的预算标签（报告对账用）。 */
  budgetLabel: string;
  /** 账本目录（同批执行必须同目录）。 */
  storeDir: string;
}

export interface RealCallTicketInfo {
  ticketId: string;
  at: number;
  runtime: string;
  model: string;
  outcome: 'pending' | 'sent' | 'failed' | 'timeout' | 'uncertain';
  detail?: string;
}

export interface RealCallLedger {
  config: RealCallGateConfig;
  acquired: number;
  rejected: number;
  tickets: RealCallTicketInfo[];
}

export class RealCallConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealCallConfigError';
  }
}

export class RealCallLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealCallLimitError';
  }
}

const LOCK_RETRY_MS = 20;
const LOCK_RETRY_MAX = 300; // ~6s

function withLock<T>(storeDir: string, fn: () => T): T {
  mkdirSync(storeDir, { recursive: true });
  const lockDir = join(storeDir, '.lock');
  for (let i = 0; ; i += 1) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      if (i >= LOCK_RETRY_MAX) throw new RealCallConfigError('预算账本锁等待超时（同批执行卡死？）');
      const waitUntil = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < waitUntil) { /* 自旋等待（子进程互斥，无异步上下文） */ }
    }
  }
  try {
    return fn();
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* 锁残留由下次 retry 覆盖 */ }
  }
}

export class RealCallGate {
  readonly config: RealCallGateConfig;
  private readonly ledgerFile: string;

  private constructor(config: RealCallGateConfig) {
    this.config = config;
    this.ledgerFile = join(config.storeDir, 'real-call-budget.json');
  }

  /** 打开闸门：配置全必填；首次打开写账本（已存在则校验配置一致性——不同批次标签混用是配置错误）。 */
  static open(input: Partial<RealCallGateConfig>): RealCallGate {
    const missing = (['runtime', 'model', 'maxStartTurns', 'budgetLabel', 'storeDir'] as const).filter((k) => input[k] == null || input[k] === '');
    if (missing.length > 0) {
      throw new RealCallConfigError(`真实调用预算配置不全（缺 ${missing.join(', ')}）——未提供完整配置时在请求前拒绝，不静默执行`);
    }
    if (input.maxStartTurns! <= 0) throw new RealCallConfigError('maxStartTurns 必须为正（零额度批次不应运行真实测试）');
    const config = input as RealCallGateConfig;
    return withLock(config.storeDir, () => {
      if (existsSync(join(config.storeDir, 'real-call-budget.json'))) {
        const ledger = JSON.parse(readFileSync(join(config.storeDir, 'real-call-budget.json'), 'utf8')) as RealCallLedger;
        if (ledger.config.runtime !== config.runtime || ledger.config.model !== config.model) {
          throw new RealCallConfigError(`账本属另一 runtime/model（${ledger.config.runtime}/${ledger.config.model}）——同批混用不同真实渠道必须分账本目录`);
        }
        // 账本既定额度为准：后开的进程/文件不得改限（否则各自重新获得完整额度）。
        return new RealCallGate(ledger.config);
      }
      const gate = new RealCallGate(config);
      const ledger: RealCallLedger = { config, acquired: 0, rejected: 0, tickets: [] };
      writeFileSync(gate.ledgerFile, JSON.stringify(ledger, null, 2));
      return gate;
    });
  }

  /**
   * 在发出 startTurn 前计数并拦截超限：acquired ≥ max → RealCallLimitError（不登记 ticket、
   * 不占额度、rejected+1）；否则登记 pending ticket 并返回其 ID（recordOutcome 回填结果）。
   */
  acquireStartTurn(): string {
    return withLock(this.config.storeDir, () => {
      const ledger = this.readLedger();
      if (ledger.acquired >= this.config.maxStartTurns) {
        ledger.rejected += 1;
        this.writeLedger(ledger);
        throw new RealCallLimitError(
          `真实调用额度已用尽（${ledger.acquired}/${this.config.maxStartTurns}，批次「${this.config.budgetLabel}」）——请求前拦截，未发出网络请求`,
        );
      }
      const ticket: RealCallTicketInfo = {
        ticketId: `t_${randomUUID().slice(0, 8)}`,
        at: Date.now(),
        runtime: this.config.runtime,
        model: this.config.model,
        outcome: 'pending',
      };
      ledger.acquired += 1;
      ledger.tickets.push(ticket);
      this.writeLedger(ledger);
      return ticket.ticketId;
    });
  }

  /** 回填结果：sent/failed/timeout/uncertain 如实记录（uncertain=请求是否发出不可判定）。 */
  recordOutcome(ticketId: string, outcome: 'sent' | 'failed' | 'timeout' | 'uncertain', detail?: string): void {
    withLock(this.config.storeDir, () => {
      const ledger = this.readLedger();
      const ticket = ledger.tickets.find((t) => t.ticketId === ticketId);
      if (ticket == null) throw new RealCallConfigError(`回填未知 ticket：${ticketId}`);
      ticket.outcome = outcome;
      if (detail != null) ticket.detail = detail.slice(0, 300);
      this.writeLedger(ledger);
    });
  }

  summary(): { acquired: number; rejected: number; sent: number; failed: number; timeout: number; uncertain: number; pending: number; maxStartTurns: number } {
    const ledger = this.readLedger();
    const by = (o: RealCallTicketInfo['outcome']): number => ledger.tickets.filter((t) => t.outcome === o).length;
    return {
      acquired: ledger.acquired, rejected: ledger.rejected,
      sent: by('sent'), failed: by('failed'), timeout: by('timeout'), uncertain: by('uncertain'), pending: by('pending'),
      maxStartTurns: this.config.maxStartTurns,
    };
  }

  private readLedger(): RealCallLedger {
    return JSON.parse(readFileSync(this.ledgerFile, 'utf8')) as RealCallLedger;
  }

  private writeLedger(ledger: RealCallLedger): void {
    writeFileSync(this.ledgerFile, JSON.stringify(ledger, null, 2));
  }
}

/**
 * 计数的 startTurn 包装（真实测试统一入口）：acquire → startTurn → 回填；
 * 异常按 failed 回填后上抛（额度已被占用——保守口径，不因失败返还）。
 */
export async function gatedStartTurn(
  gate: RealCallGate,
  startTurn: () => Promise<void>,
  timeoutMs = 240_000,
): Promise<void> {
  const ticketId = gate.acquireStartTurn();
  try {
    await Promise.race([
      startTurn(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`gated-start-turn-timeout:${timeoutMs}`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    gate.recordOutcome(ticketId, 'sent');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = message.includes('gated-start-turn-timeout') ? 'timeout' : 'failed';
    gate.recordOutcome(ticketId, outcome, message.slice(0, 200));
    throw error;
  }
}
