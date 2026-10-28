/**
 * 项目、房间、成员与导航偏好契约。
 * 字段名以主设计 §12.2 表结构目录为唯一权威；§17.7 导航增量见 NavigationPreferences。
 */
import { z } from 'zod';
import type { Revision, TimestampMs } from './common.ts';

// ---------- 标量 ----------

export type ProjectId = string;
export type RoomId = string;
export type MemberId = string;
export type ProfileId = string;
export type RuntimeInstallationId = string;

/** 写入并发策略（§14.1）：single_writer 为默认；parallel_writers 由用户手动开启。 */
export type WriteConcurrencyPolicy = 'single_writer' | 'parallel_writers';

/** 项目状态：SPACE-06 的归档/恢复/移除应用记录；directory_missing 表示目录失效待重定位（RT-14）。 */
export type ProjectStatus = 'active' | 'archived' | 'directory_missing' | 'removed';

// ---------- 目录身份（§3.3） ----------

/**
 * 目录身份与锁域判定的输入：projectId 用随机稳定 ID，不用路径散列代替；
 * Windows junction/符号链接/盘符解析由 DEV-04 实现并写入 identityKey。
 * identityKey 是统一目录锁域（RT-09）的判定基础。
 */
export interface DirectoryIdentity {
  /** 用户原始路径。 */
  rootPath: string;
  /** 解析后的物理路径（junction/符号链接/盘符规范化后）。 */
  canonicalPath: string;
  /** 物理身份键：重叠项目（父子目录、junction）映射到同一锁域。 */
  identityKey: string;
  /** 可获取的卷/目录身份补充，DEV-04 填充。 */
  volumeIdentity?: string;
}

export const directoryIdentitySchema = z.strictObject({
  rootPath: z.string().min(1),
  canonicalPath: z.string().min(1),
  identityKey: z.string().min(1),
  volumeIdentity: z.string().optional(),
});

// ---------- 项目 ----------

export interface Project {
  id: ProjectId;
  displayName: string;
  /** R71（R64 登记）：注册表真实路径直出（此前仅 project.list 回——open 响应缺失）。
   *  rootPath=用户打开时的入口路径；canonicalPath=realpath 规范身份（身份键由此派生）。 */
  rootPath?: string;
  canonicalPath?: string;
  directoryIdentity: DirectoryIdentity;
  status: ProjectStatus;
  revision: Revision;
  /** 任务验收开关（§10.5）：新项目默认关闭；创建用户任务时快照为 Task.reviewPolicy。 */
  taskReviewEnabled: boolean;
  /** 写入并发策略：默认 single_writer（§14.1）；parallel_writers 属用户手动开启的可选增强。 */
  writeConcurrencyPolicy: WriteConcurrencyPolicy;
  createdAt: TimestampMs;
}

export const projectSchema = z.strictObject({
  id: z.string().min(1),
  displayName: z.string().min(1),
  rootPath: z.string().optional(),
  canonicalPath: z.string().optional(),
  directoryIdentity: directoryIdentitySchema,
  status: z.enum(['active', 'archived', 'directory_missing', 'removed']),
  revision: z.number().int().nonnegative(),
  taskReviewEnabled: z.boolean(),
  writeConcurrencyPolicy: z.enum(['single_writer', 'parallel_writers']),
  createdAt: z.number().int().nonnegative(),
});

// ---------- 房间 ----------

export interface Room {
  id: RoomId;
  projectId: ProjectId;
  name: string;
  /** 新房间 coordinator 沿用项目当前默认（E5）；AUTO 模式默认接单者。 */
  coordinatorMemberId: MemberId;
  settingsJson?: unknown;
  archivedAt?: TimestampMs | null;
  revision: Revision;
}

export const roomSchema = z.strictObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  coordinatorMemberId: z.string().min(1),
  settingsJson: z.unknown().optional(),
  archivedAt: z.number().int().nonnegative().nullable().optional(),
  revision: z.number().int().nonnegative(),
});

// ---------- 成员 ----------

/** dm_participants.principal_type：一对一恰两个不同主体（开工契约 §2.2）。 */
export type PrincipalType = 'human' | 'agent';

/** Profile 是成员模板；ProjectMember 是项目内身份；RuntimeInstallation 是执行程序（§3.2 三者不混用 ID）。 */
export interface AgentProfile {
  id: ProfileId;
  name: string;
  description?: string;
  runtimeInstallationId: RuntimeInstallationId;
  settingsJson?: unknown;
}

export interface ProjectMember {
  id: MemberId;
  projectId: ProjectId;
  profileId?: ProfileId | null;
  displayName: string;
  /** 人类成员（本机用户）也以 project_members 记录；enabled=false 不参与派发。 */
  principalType: PrincipalType;
  enabled: boolean;
  settingsRevision: Revision;
}

export const agentProfileSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  runtimeInstallationId: z.string().min(1),
  settingsJson: z.unknown().optional(),
});

export const projectMemberSchema = z.strictObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  profileId: z.string().min(1).nullable().optional(),
  displayName: z.string().min(1),
  principalType: z.enum(['human', 'agent']),
  enabled: z.boolean(),
  settingsRevision: z.number().int().nonnegative(),
});

// ---------- Runtime 安装 ----------

export interface RuntimeInstallation {
  id: RuntimeInstallationId;
  kind: string;
  executable: string;
  version: string;
  adapterVersion: string;
  capabilitiesJson?: unknown;
  detectedAt: TimestampMs;
}

export const runtimeInstallationSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  executable: z.string().min(1),
  version: z.string().min(1),
  adapterVersion: z.string().min(1),
  capabilitiesJson: z.unknown().optional(),
  detectedAt: z.number().int().nonnegative(),
});

// ---------- 导航偏好与查询范围（§17.7 第十五批） ----------

/**
 * 三个概念独立：activeProjectId 是单个当前项目；visibleProjectIds 是有序显示集合；
 * 页面查询 scope 是当前展示范围。看板/搜索选“可见项目”不把 activeProjectId 变成数组。
 */
export interface NavigationPreferences {
  viewerId: string;
  clientId: string;
  /** 有序且去重的侧栏可见项目。 */
  visibleProjectIds: readonly ProjectId[];
  /** 始终单个；当前项目必须可见（不可取消勾选）。 */
  activeProjectId: ProjectId | null;
  expandedProjectIds: readonly ProjectId[];
  /** 按 projectId 记忆文件/Git 标签页。 */
  fileGitTabsJson?: unknown;
  revision: Revision;
}

export const navigationPreferencesSchema = z.strictObject({
  viewerId: z.string().min(1),
  clientId: z.string().min(1),
  visibleProjectIds: z.array(z.string().min(1)),
  activeProjectId: z.string().min(1).nullable(),
  expandedProjectIds: z.array(z.string().min(1)),
  fileGitTabsJson: z.unknown().optional(),
  revision: z.number().int().nonnegative(),
}).refine(
  (p) => p.activeProjectId === null || p.visibleProjectIds.includes(p.activeProjectId),
  { message: '当前使用的项目不能隐藏' },
).refine(
  (p) => new Set(p.visibleProjectIds).size === p.visibleProjectIds.length,
  { message: 'visibleProjectIds 必须有序且去重' },
);

/** 页面查询范围：visible=侧栏可见项目；all=全部可访问项目（待我处理默认）。 */
export type ProjectQueryScope =
  | { kind: 'project'; projectId: ProjectId }
  | { kind: 'visible' }
  | { kind: 'all' };

export const projectQueryScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), projectId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('visible') }),
  z.strictObject({ kind: z.literal('all') }),
]);
