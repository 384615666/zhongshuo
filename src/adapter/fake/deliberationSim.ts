/**
 * 协作型 fake 研讨序列器（仅 ZS_ALLOW_FAKE 显式开发/测试模式）：
 * 按输入文本中的输出契约 schemaVersion 产出**合同合法**的对应载荷——
 * CR/RAT 从输入正文解析冻结的三元组/结论清单，不凭空编引用。
 * 供 UI e2e 与真实演示前的全链路演练；不是真实模型能力声明。
 */
import type { FakeTurnScript } from './script.ts';

interface ListedClaim {
  artifactId?: string;
  revision?: number;
  claims?: Array<{ claimId: string }>;
}

function extractJsonBlocks(text: string): unknown[] {
  const out: unknown[] = [];
  const lines = text.split('\n');
  let buf: string[] = [];
  let depth = 0;
  for (const line of lines) {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (depth === 0 && opens > 0) buf = [line];
    else if (depth > 0) buf.push(line);
    depth += opens - closes;
    if (depth === 0 && buf.length > 0) {
      const candidate = buf.join('\n').slice(buf[0]!.indexOf('{'));
      try {
        out.push(JSON.parse(candidate));
      } catch { /* 非完整 JSON 块跳过 */ }
      buf = [];
    }
  }
  return out;
}

/** 生成一个研讨步骤的合法载荷（按输入文本判定阶段）。 */
export function simulateDeliberationTurn(text: string): FakeTurnScript {
  const done = (payload: unknown): FakeTurnScript => [{ kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify(payload) } }];
  if (text.includes('analysis-draft-v1')) {
    return done({
      schemaVersion: 'analysis-draft-v1',
      summary: '模拟独立分析：基于基线给出两条结论',
      claims: [
        { claimId: 'c1', statement: '关键风险在依赖版本', kind: 'inferred', evidenceIds: ['ev1'], uncertainty: '未实测' },
        { claimId: 'c2', statement: '建议先补集成测试', kind: 'proposal', evidenceIds: ['ev1'] },
      ],
      recommendations: ['补测试'],
      openQuestions: ['预算是否允许'],
    });
  }
  if (text.includes('cross-review-v1')) {
    // 从输入正文的冻结初稿清单解析三元组，逐 claim 给评审（一 agree 一 needs_evidence 制造最小争议）。
    const reviews: Array<Record<string, unknown>> = [];
    for (const block of extractJsonBlocks(text)) {
      const b = block as ListedClaim;
      if (b?.artifactId == null || b?.revision == null || !Array.isArray(b.claims)) continue;
      for (const [i, c] of b.claims.entries()) {
        reviews.push({
          targetArtifactId: b.artifactId,
          targetRevision: b.revision,
          targetClaimId: c.claimId,
          stance: i === 0 ? 'agree' : 'needs_evidence',
          reason: i === 0 ? '论证成立' : '需要数据佐证',
          evidenceIds: ['ev2'],
        });
      }
    }
    if (reviews.length === 0) return done({ schemaVersion: 'cross-review-v1', reviews: [] });
    return done({ schemaVersion: 'cross-review-v1', reviews });
  }
  if (text.includes('issue-position-v1')) {
    // 对输入中列出的每个 issueId 给立场。
    const issueIds = [...text.matchAll(/"iss_[a-f0-9]{24}"/g)].map((m) => m[0]!.slice(1, -1));
    const unique = [...new Set(issueIds)];
    return done({
      schemaVersion: 'issue-position-v1',
      positions: unique.map((issueId) => ({ issueId, stance: 'needs_evidence', reason: '维持需要证据', newEvidence: [] })),
    });
  }
  if (text.includes('checkpoint-verdict-v1')) {
    return done({ schemaVersion: 'checkpoint-verdict-v1', verdict: 'stop', reason: '无新证据，转入整合' });
  }
  if (text.includes('synthesis-v1')) {
    return done({
      schemaVersion: 'synthesis-v1',
      summary: '整合：共识与分歧如下',
      claims: [{ statement: '风险需要更多证据支撑（各方认可的方向）', sourceRefs: ['c1'] }],
      disputedClaims: [{ statement: '是否先补测试', disagreementSummary: '一方认为先补测试，另一方认为先验证风险', sourceRefs: ['c2'] }],
      recommendations: ['按证据优先排序'],
    });
  }
  if (text.includes('ratify-v1')) {
    const claimIds = [...text.matchAll(/"clm_\d+"/g)].map((m) => m[0]!.slice(1, -1));
    const unique = [...new Set(claimIds)];
    return done({
      schemaVersion: 'ratify-v1',
      responses: unique.map((claimId) => ({ claimId, stance: 'confirm' })),
    });
  }
  // 非研讨输入（含 DIRECT TaskComplete 契约）：通用成功。
  return [{ kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: 'task-complete-v1' }) } }];
}
