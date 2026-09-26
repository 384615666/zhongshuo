/**
 * 原型种子数据的 ID 常量。
 * 集中定义以避免跨文件循环引用；命名贴近实体语义，便于对照 §12.2。
 */

/* ---------- 项目 ---------- */
export const P_ZS = 'proj_zs_01';
export const P_BACKFILL = 'proj_backfill_02';
export const P_MISSING = 'proj_docs_03';
/**
 * 第十五批：**非 Git 且目录正常**的项目。
 *
 * 为什么需要它：§9.4 要求"非 Git 文件树和预览可用，Git 标签给说明且无自动初始化"，
 * 但在它之前，唯一的非 Git 项目（legacy-docs）目录也是失效的 ——
 * 于是"非 Git 的文件树可用"这条**根本无法被演示或验证**（实测树恒为空）。
 * 这个项目专门补上该用例：目录正常、有文件树、不是 Git 仓库。
 */
export const P_NOTGIT = 'proj_notgit_04';

/* ---------- runtime 安装（决策 37：首版仅 Codex App Server + Claude Code headless） ---------- */
export const RT_CODEX = 'rt_codex_appserver';
export const RT_CLAUDE = 'rt_claude_headless';

/* ---------- 成员模板与项目成员 ---------- */
export const PROF_CODEX = 'prof_codex';
export const PROF_CLAUDE = 'prof_claude';
export const PROF_CODEX2 = 'prof_codex_checker';

export const M_CODEX = 'member_codex';
export const M_CLAUDE = 'member_claude';
export const M_CODEX2 = 'member_codex_2';
export const M_HUMAN = 'member_you';

/* data-backfill 项目的成员（第十五批多项目演示；profile 复用，成员身份独立） */
export const M_BF_CODEX = 'member_bf_codex';
export const M_BF_CLAUDE = 'member_bf_claude';

/* notes-vault 项目的成员（非 Git 项目同样有成员与房间） */
export const M_NG_CLAUDE = 'member_ng_claude';

/* ---------- 房间 ---------- */
export const R_DEV = 'room_dev_hall';
export const R_DESIGN = 'room_design';
export const R_DOCS = 'room_docs';
/** data-backfill 的房间：**故意**与 R_DEV 同名「开发大厅」，用于验证分组不串线 */
export const R_BF_DEV = 'room_bf_dev_hall';
/** notes-vault 的房间 */
export const R_NG_NOTES = 'room_ng_notes';

/* ---------- 线程 ---------- */
export const T_12 = 'thread_t12';
export const T_13 = 'thread_t13';
export const T_14 = 'thread_t14';
export const T_D1 = 'thread_d1';
export const T_11 = 'thread_t11';

/* ---------- 顶层原消息（anchor，messages.thread_id = NULL） ---------- */
export const AM_12 = 'msg_a12';
export const AM_13 = 'msg_a13';
export const AM_14 = 'msg_a14';
export const AM_D1 = 'msg_d1';
export const AM_11 = 'msg_a11';

/* ---------- 任务 ---------- */
export const TASK_12 = 'task_12';
export const TASK_13 = 'task_13';
export const TASK_14 = 'task_14';
export const TASK_11 = 'task_11';
export const SUB_12_ARCH = 'task_12_sub_arch';
export const SUB_12_DATA = 'task_12_sub_data';

/* ---------- 运行与 turn ---------- */
export const RUN_12 = 'run_12_deliberate';
export const RUN_13 = 'run_13_direct';
export const RUN_14 = 'run_14_auto';
export const RUN_11 = 'run_11_deliberate';

export const TURN_12_CODEX_IND = 'turn_12_codex_ind';
export const TURN_12_CLAUDE_IND = 'turn_12_claude_ind';
export const TURN_12_CODEX2_IND = 'turn_12_codex2_ind';
export const TURN_12_CLAUDE_REV = 'turn_12_claude_rev';
export const TURN_12_CODEX2_REV = 'turn_12_codex2_rev';
export const TURN_12_CODEX_HOST = 'turn_12_codex_host';
export const TURN_13_CLAUDE = 'turn_13_claude';
export const TURN_14_CODEX = 'turn_14_codex';

/* ---------- 成果 ---------- */
export const ART_12_TEAM_REPORT = 'artifact_12_team_report';
export const ART_12_CODEX_IND = 'artifact_12_codex_ind';
export const ART_12_CLAUDE_IND = 'artifact_12_claude_ind';
export const ART_12_CODEX2_IND = 'artifact_12_codex2_ind';
export const ART_11_REPORT = 'artifact_11_report';
export const ART_13_PATCH_NOTE = 'artifact_13_patch_note';

/* ---------- 改动集 ---------- */
export const CS_13 = 'changeset_13';
export const CS_11 = 'changeset_11';
/** 任务 #12 第二轮（2026-09-26 补数据）：未提交，与 Git 工作区逐条对应 */
export const CS_12_R2 = 'changeset_12_r2';
/** 子任务 #12（adapter 类型泄漏核对）的未提交改动集（2026-09-26 补数据） */
export const CS_12_ARCH = 'changeset_12_arch';
/** 任务 #14 周报（2026-09-26 补数据）：未提交 */
export const CS_14 = 'changeset_14';
/** notes-vault（非 Git）的改动集：前像是整目录快照而不是 git ref（E15） */
export const CS_NG1 = 'changeset_ng_1';

/* ---------- 第十五批：多项目演示数据 ----------
   编号**故意**与众说项目撞号（#12），房间也**故意**同名（开发大厅），
   用来验证"同号任务/同名房间不能混在一起"（§9.5）——
   看板分组、卡片来源与深链都必须靠 projectId 定位，不能靠编号或名字猜。 */
export const T_BF12 = 'thread_bf12';
export const AM_BF12 = 'msg_bf_a12';
export const TASK_BF12 = 'task_bf_12';
export const RUN_BF12 = 'run_bf12_direct';
export const TURN_BF12_CODEX = 'turn_bf12_codex';

/* notes-vault（非 Git 项目）：一个已完成任务，让"非 Git 也能有交付与文件树"可演示 */
export const T_NG1 = 'thread_ng1';
export const AM_NG1 = 'msg_ng_a1';
export const TASK_NG1 = 'task_ng_1';
export const RUN_NG1 = 'run_ng1_auto';
