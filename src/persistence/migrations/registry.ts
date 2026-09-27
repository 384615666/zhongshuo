import type { Migration } from '../db.ts';
import { initialMigration } from './001-initial.ts';
import { stopGenerationMigration } from './002-stop-generation.ts';

/** 迁移注册表：按 id 升序；已发布迁移不可改写（checksum 留档）。 */
export const MIGRATIONS: readonly Migration[] = [initialMigration, stopGenerationMigration];
