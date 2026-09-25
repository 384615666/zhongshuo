/**
 * 预览资源种子数据（UX-PREVIEW-01 / §17.9，A 阶段）。
 *
 * 覆盖施工说明 §5.A 与 §11.5 要求的场景：
 *  1. **无任务归属的主池附件**（PV-01）—— 旧 Artifact 模型做不到的那条；
 *  2. 线程成果 + 固定多版本（PV-08、PV-16 的原版本对照）；
 *  3. 工作区文件（可变、可"磁盘已更新"）；
 *  4. **DM 私信附件**（PV-31/32）—— 独立 audience，不能与群聊共享；
 *  5. 不可渲染类型（PDF/Office/视频）如实标注未接通（§8.1 范围核对）。

 * 关键边界：这些都是**原型内嵌的 mock 资源**。内容本身真实可渲染
 * （真 PNG、真 Markdown/代码/CSV），但**不代表读取了用户磁盘文件**。
 * 界面必须标注模拟来源，不得宣称真实解析通过。
 */

import type { MessageAttachment, PreviewResource, ResourceRevision } from './types';
import * as I from './ids';
import {
  FIXTURE_CSV, FIXTURE_CODE_TS, FIXTURE_DIFF_LEFT, FIXTURE_DIFF_RIGHT,
  FIXTURE_MARKDOWN_V1, FIXTURE_MARKDOWN_V2, FIXTURE_NOTES_TXT,
} from './fixture-content';
import { FIXTURE_PNG_DATA_URL, FIXTURE_PNG_HEIGHT, FIXTURE_PNG_WIDTH } from './fixture-png';

const NOW = Date.now();
const min = (n: number) => n * 60_000;

/* ---------- 资源 ID ---------- */

export const RES = {
  /** 主池普通消息附件：无 taskId（PV-01） */
  POOL_MD: 'res_pool_design_md',
  /**
   * 讨论串里的消息附件（界面信息减负验收用）。
   *
   * 讨论串没有 taskId，`artifactsOfThread` 恒为空 —— 但**消息附件是独立聚合的**，
   * 所以讨论串确实可能有附件。没有这条 fixture，"讨论串的附件入口可达"
   * 就只能靠读代码相信，无法实测（减负 §2、§10.1）。
   */
  DISC_NOTE_MD: 'res_disc_note_md',
  /** 线程 #14 的成果：两个固定版本（PV-08 版本对照） */
  ART_DESIGN_MD: 'res_art_design_md',
  /** 线程成果：代码文件 */
  ART_RESOLVER_TS: 'res_art_resolver_ts',
  /** 房间附件：真实 PNG（图片预览） */
  ROOM_IMAGE: 'res_room_image_png',
  /** 工作区当前文件（可变，PV-09） */
  WORKTREE_RESOURCE_TS: 'res_worktree_resource_ts',
  /** 工作区 CSV（表格 + 锚点） */
  WORKTREE_TASKS_CSV: 'res_worktree_tasks_csv',
  /** 工作区 diff 两侧固定版本 */
  WORKTREE_DIFF: 'res_worktree_diff',
  /** 非 Git 项目笔记 */
  NOTES_TXT: 'res_notes_txt',
  /** DM 私信附件（独立 audience，PV-31/32） */
  DM_IMAGE: 'res_dm_image_png',
  /** 未接通格式：PDF（如实标注） */
  UNSUPPORTED_PDF: 'res_unsupported_pdf',
} as const;

/* ---------- 版本构造助手 ---------- */

const hashOf = (s: string) => {
  // 原型用简单确定性 hash 模拟内容校验值；真实实现是后端返回的 sha256。
  // 必须确定性：同一快照重复读取要得到相同 hash（§6.2 第 1 条）。
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a_${h.toString(16).padStart(8, '0')}`;
};

function mdRev(revision: number, text: string, createdAt: number): ResourceRevision {
  return {
    revision,
    hash: hashOf(text),
    sizeBytes: new TextEncoder().encode(text).length,
    createdAt,
    content: { kind: 'markdown', text },
  };
}

/* ============================================================
   资源清单
   ============================================================ */

export const resources: PreviewResource[] = [
  /* ---- 1. 主池普通附件：无 taskId（§17.9 第 1 条 / PV-01） ----
     这条是本轮新增资源层的**核心证据**：旧 Artifact 模型要求 taskId/threadId
     必填，因此"主池里一条普通消息带的文档"根本无法表示。
     origin.kind = 'message' 且没有 taskId，是合法的。 */
  {
    id: RES.POOL_MD,
    projectId: I.P_ZS,
    kind: 'attachment',
    title: '架构评审要点.md',
    mimeType: 'text/markdown',
    origin: { kind: 'message', messageId: 'msg_pool_attach_1', roomId: I.R_DEV },
    audience: { kind: 'room', roomId: I.R_DEV },
    revisions: [mdRev(1, FIXTURE_MARKDOWN_V1, NOW - min(95))],
    createdAt: NOW - min(95),
    authorId: I.M_HUMAN,
  },

  /* ---- 2. 线程成果：三个固定版本，验证版本对照与"不混称最新版" ---- */
  {
    id: RES.ART_DESIGN_MD,
    projectId: I.P_ZS,
    kind: 'artifact',
    title: '预览交互设计说明.md',
    mimeType: 'text/markdown',
    origin: { kind: 'task', taskId: I.TASK_14, threadId: I.T_14, roomId: I.R_DEV },
    audience: { kind: 'room', roomId: I.R_DEV },
    revisions: [
      mdRev(1, FIXTURE_MARKDOWN_V1, NOW - min(180)),
      mdRev(2, FIXTURE_MARKDOWN_V2, NOW - min(120)),
      mdRev(3, FIXTURE_MARKDOWN_V2 + '\n\n## 4. 变更记录\n\n- v3：补齐 1280px 实测证据与竞态用例\n', NOW - min(45)),
    ],
    createdAt: NOW - min(180),
    authorId: I.M_CODEX,
  },

  /* ---- 2b. 讨论串的消息附件（无 taskId；讨论串也要能浏览与引用） ---- */
  {
    id: RES.DISC_NOTE_MD,
    projectId: I.P_ZS,
    kind: 'attachment',
    title: '排期原则便签.md',
    mimeType: 'text/markdown',
    origin: { kind: 'message', messageId: 'msg_d1_attach', roomId: I.R_DEV, threadId: I.T_D1 },
    audience: { kind: 'room', roomId: I.R_DEV },
    revisions: [mdRev(1, FIXTURE_NOTES_TXT, NOW - min(140))],
    createdAt: NOW - min(140),
    authorId: I.M_HUMAN,
  },

  /* ---- 3. 线程成果：代码文件 ---- */
  {
    id: RES.ART_RESOLVER_TS,
    projectId: I.P_ZS,
    kind: 'artifact',
    title: 'resource-resolver.ts',
    mimeType: 'text/typescript',
    origin: { kind: 'task', taskId: I.TASK_14, threadId: I.T_14, roomId: I.R_DEV },
    audience: { kind: 'room', roomId: I.R_DEV },
    revisions: [
      {
        revision: 1,
        hash: hashOf(FIXTURE_CODE_TS),
        sizeBytes: new TextEncoder().encode(FIXTURE_CODE_TS).length,
        createdAt: NOW - min(70),
        content: { kind: 'code', language: 'typescript', text: FIXTURE_CODE_TS },
      },
    ],
    createdAt: NOW - min(70),
    authorId: I.M_CLAUDE,
  },

  /* ---- 4. 房间附件：真实 PNG，验证图片预览 ---- */
  {
    id: RES.ROOM_IMAGE,
    projectId: I.P_ZS,
    kind: 'attachment',
    title: '预览布局草图.png',
    mimeType: 'image/png',
    origin: { kind: 'message', messageId: 'msg_pool_attach_2', roomId: I.R_DEV },
    audience: { kind: 'room', roomId: I.R_DEV },
    revisions: [
      {
        revision: 1,
        hash: FIXTURE_PNG_DATA_URL.slice(-64),
        sizeBytes: 11264,
        createdAt: NOW - min(88),
        content: {
          kind: 'image',
          mimeType: 'image/png',
          dataUrl: FIXTURE_PNG_DATA_URL,
          width: FIXTURE_PNG_WIDTH,
          height: FIXTURE_PNG_HEIGHT,
        },
      },
    ],
    createdAt: NOW - min(88),
    authorId: I.M_HUMAN,
  },

  /* ---- 5. 工作区当前文件（可变） ----
     mutable=true：文件会随磁盘变化，"重新读取"更新同一标签而不是新增（§6.2） */
  {
    id: RES.WORKTREE_RESOURCE_TS,
    projectId: I.P_ZS,
    kind: 'worktree',
    title: 'resource.ts',
    relativePath: 'src/lib/resource.ts',
    mimeType: 'text/typescript',
    origin: { kind: 'workspace' },
    audience: { kind: 'project' },
    mutable: true,
    revisions: [
      {
        revision: 1,
        hash: hashOf(FIXTURE_CODE_TS),
        sizeBytes: new TextEncoder().encode(FIXTURE_CODE_TS).length,
        createdAt: NOW - min(30),
        content: { kind: 'code', language: 'typescript', text: FIXTURE_CODE_TS },
      },
    ],
    createdAt: NOW - min(30),
  },

  /* ---- 6. 工作区 CSV ---- */
  {
    id: RES.WORKTREE_TASKS_CSV,
    projectId: I.P_ZS,
    kind: 'worktree',
    title: 'tasks.csv',
    relativePath: 'docs/tasks.csv',
    mimeType: 'text/csv',
    origin: { kind: 'workspace' },
    audience: { kind: 'project' },
    mutable: true,
    revisions: [
      {
        revision: 1,
        hash: hashOf(FIXTURE_CSV),
        sizeBytes: new TextEncoder().encode(FIXTURE_CSV).length,
        createdAt: NOW - min(20),
        content: { kind: 'csv', text: FIXTURE_CSV },
      },
    ],
    createdAt: NOW - min(20),
  },

  /* ---- 7. 工作区 diff：两侧固定版本 ---- */
  {
    id: RES.WORKTREE_DIFF,
    projectId: I.P_ZS,
    kind: 'worktree',
    title: 'resource.ts（改动对比）',
    relativePath: 'src/lib/resource.ts',
    mimeType: 'text/x-diff',
    origin: { kind: 'workspace' },
    audience: { kind: 'project' },
    revisions: [
      {
        revision: 1,
        hash: hashOf(FIXTURE_DIFF_LEFT + FIXTURE_DIFF_RIGHT),
        sizeBytes: FIXTURE_DIFF_LEFT.length + FIXTURE_DIFF_RIGHT.length,
        createdAt: NOW - min(15),
        content: {
          kind: 'diff',
          left: FIXTURE_DIFF_LEFT,
          right: FIXTURE_DIFF_RIGHT,
          leftLabel: 'before · 工作区快照',
          rightLabel: 'after · 任务 #13 改动',
        },
      },
    ],
    createdAt: NOW - min(15),
  },

  /* ---- 8. 非 Git 项目的笔记（验证非 Git 项目也能预览） ---- */
  {
    id: RES.NOTES_TXT,
    projectId: I.P_NOTGIT,
    kind: 'worktree',
    title: 'README.txt',
    relativePath: 'README.txt',
    mimeType: 'text/plain',
    origin: { kind: 'workspace' },
    audience: { kind: 'project' },
    mutable: true,
    revisions: [
      {
        revision: 1,
        hash: hashOf(FIXTURE_NOTES_TXT),
        sizeBytes: new TextEncoder().encode(FIXTURE_NOTES_TXT).length,
        createdAt: NOW - min(60 * 5),
        content: { kind: 'text', text: FIXTURE_NOTES_TXT },
      },
    ],
    createdAt: NOW - min(60 * 5),
  },

  /* ---- 9. DM 私信附件：独立 audience（§17.9 第 7 条 / PV-31/32） ----
     这条用来验证"切到群聊后受限标签必须暂藏，连文件名都不能露"。 */
  {
    id: RES.DM_IMAGE,
    projectId: I.P_ZS,
    kind: 'attachment',
    title: '私信里的对账截图.png',
    mimeType: 'image/png',
    origin: { kind: 'dm', conversationId: 'dm_1', messageId: 'msg_dm_attach_1' },
    audience: { kind: 'dm', conversationId: 'dm_1', memberIds: [I.M_CLAUDE] },
    revisions: [
      {
        revision: 1,
        hash: FIXTURE_PNG_DATA_URL.slice(-64),
        sizeBytes: 11264,
        createdAt: NOW - min(50),
        content: {
          kind: 'image',
          mimeType: 'image/png',
          dataUrl: FIXTURE_PNG_DATA_URL,
          width: FIXTURE_PNG_WIDTH,
          height: FIXTURE_PNG_HEIGHT,
        },
      },
    ],
    createdAt: NOW - min(50),
    authorId: I.M_CLAUDE,
  },

  /* ---- 10. 未接通格式：PDF ----
      §8.1 要求"保存/预览/提取/交给 AI"四种能力分别如实显示；
      PDF 的真实转换服务未接通，因此明确显示 unsupported 而不是假正文。 */
  {
    id: RES.UNSUPPORTED_PDF,
    projectId: I.P_ZS,
    kind: 'attachment',
    title: '外部评审意见.pdf',
    mimeType: 'application/pdf',
    origin: { kind: 'task', taskId: I.TASK_14, threadId: I.T_14, roomId: I.R_DEV },
    audience: { kind: 'room', roomId: I.R_DEV },
    revisions: [
      {
        revision: 1,
        hash: 'fnv1a_pdf_placeholder',
        sizeBytes: 486_912,
        createdAt: NOW - min(140),
        content: {
          kind: 'unsupported',
          reason: 'not_connected',
          note: 'PDF 预览需要受控转换/内嵌渲染服务，当前原型未接通。可保存与下载，但不提供伪渲染。',
        },
      },
    ],
    createdAt: NOW - min(140),
    authorId: I.M_HUMAN,
  },
];

/* ============================================================
   消息 ↔ 资源关联
   ============================================================ */

export const messageAttachments: MessageAttachment[] = [
  // 主池普通消息的两个附件（无 taskId —— 本轮的核心修复）
  { id: 'ma_1', messageId: 'msg_pool_attach_1', resourceId: RES.POOL_MD, revision: 1, ordinal: 0 },
  { id: 'ma_2', messageId: 'msg_pool_attach_2', resourceId: RES.ROOM_IMAGE, revision: 1, ordinal: 0 },
  // 线程 #14 的两份成果
  { id: 'ma_3', messageId: 'msg_t14_artifacts', resourceId: RES.ART_DESIGN_MD, revision: 3, ordinal: 0 },
  { id: 'ma_4', messageId: 'msg_t14_artifacts', resourceId: RES.ART_RESOLVER_TS, revision: 1, ordinal: 1 },
  // 线程 #14 里挂一份未接通格式，验证"如实显示不支持"
  { id: 'ma_5', messageId: 'msg_t14_artifacts', resourceId: RES.UNSUPPORTED_PDF, revision: 1, ordinal: 2 },
  // DM 附件
  { id: 'ma_6', messageId: 'msg_dm_attach_1', resourceId: RES.DM_IMAGE, revision: 1, ordinal: 0 },
  // 讨论串的消息附件（无 taskId 的线程内附件，减负 §2 的讨论变体验收依据）
  { id: 'ma_7', messageId: 'msg_d1_attach', resourceId: RES.DISC_NOTE_MD, revision: 1, ordinal: 0 },
];
