/**
 * 公共标量与工具约定（主设计 §12.2：所有 ID 为稳定随机 ID；时间为 UTC 毫秒）。
 *
 * 实施决策（见 docs/implementation/implementation-decisions.md ADR-I02）：
 * DTO 层 ID 使用 string 别名而非 brand，保证跨 IPC/SQLite/JSON 序列化零转换；
 * 数据库侧唯一性与引用完整性由 DEV-02 的迁移约束承担。
 */

/** UTC 毫秒时间戳。 */
export type TimestampMs = number;

/** 乐观并发控制修订号（CAS；不匹配返回 STALE_REVISION，§12.3）。 */
export type Revision = number;

/** 不透明分页游标：绑定主体、过滤条件与授权版本（开工契约 §3.3）。 */
export type OpaqueCursor = string;

/** 能力/验证三态：unverified 不得按 supported 处理（§9.3）。 */
export type Support = 'supported' | 'unsupported' | 'unverified';
