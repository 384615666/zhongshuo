/**
 * 价值对比 DIRECT 侧用户可见交付导出（统一规则：线程最后一条 agent 消息全文；
 * 正式交付成功时=TaskComplete 消息原文，失败时=最后一次自然输出原文——两种都如实）。
 * 用法：node scripts/value-export-direct.mjs <group>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const group = process.argv[2];
if (!['A', 'B', 'C'].includes(group)) { console.error('用法：node scripts/value-export-direct.mjs A|B|C'); process.exit(64); }
const root = join(process.env.TEMP ?? '.', 'zhongshuo-value', group, 'direct');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const Database = nodeRequire('better-sqlite3');
const db = new Database(join(root, 'appdata', 'state.sqlite'), { readonly: true });
const rows = db.prepare("SELECT body_json FROM messages WHERE task_id = ? AND author_type = 'agent' ORDER BY rowid").all(manifest.taskId);
db.close();
if (rows.length === 0) { console.error('无 agent 消息'); process.exit(7); }
const last = JSON.parse(rows[rows.length - 1].body_json);
// TaskComplete JSON 原文对用户不可读——展开为正文（含 changeSummary；其余字段列出）。
let text = last.text ?? '';
try {
  const tc = JSON.parse(text);
  if (tc.schemaVersion === 'task-complete-v1') {
    text = [tc.changeSummary ?? '', tc.files?.length ? `\n涉及文件：${tc.files.join('、')}` : '', tc.executedVerifications?.length ? `\n已执行核查：\n${tc.executedVerifications.map((e) => `- ${typeof e === 'string' ? e : JSON.stringify(e)}`).join('\n')}` : '', tc.unexecutedVerifications?.length ? `\n未执行核查：\n${tc.unexecutedVerifications.map((e) => `- ${typeof e === 'string' ? e : JSON.stringify(e)}`).join('\n')}` : '', tc.remainingIssues?.length ? `\n遗留问题：\n${tc.remainingIssues.map((e) => `- ${typeof e === 'string' ? e : JSON.stringify(e)}`).join('\n')}` : ''].filter((s) => s != null && s.length > 0).join('\n');
  }
} catch { /* 自然文本原样 */ }
const out = join(root, 'deliverable.txt');
writeFileSync(out, text, 'utf8');
console.log(JSON.stringify({ ok: true, group, out, chars: text.length, agentMessages: rows.length, formalDeliveryFailedNote: rows.length > 0 ? null : null }));
