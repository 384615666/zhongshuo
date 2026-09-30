import type { Migration } from '../db.ts';
import { initialMigration } from './001-initial.ts';
import { stopGenerationMigration } from './002-stop-generation.ts';
import { daemonStateMigration } from './003-daemon-state.ts';
import { ratifyPayloadHashMigration } from './004-ratify-payload-hash.ts';
import { runStageStartedAtMigration } from './005-run-stage-started-at.ts';
import { turnExecClockMigration } from './006-turn-exec-clock.ts';
import { changesetPreimageMigration } from './007-changeset-preimage.ts';
import { formatRepairWorkitemsMigration } from './008-format-repair-workitems.ts';
import { recoveryProcessEvidenceMigration } from './009-recovery-process-evidence.ts';
import { logicalOutputRepairMigration } from './010-logical-output-repair-identity.ts';
import { processTreeEvidenceMigration } from './011-process-tree-evidence.ts';
import { processTreeLateEventsMigration } from './012-process-tree-snapshots.ts';
import { lateEventReceiptsMigration } from './013-late-event-receipts.ts';
import { processTreeIdentitiesMigration } from './014-process-tree-identities.ts';
import { lateReceiptScopeMigration } from './015-late-receipt-scope.ts';
import { gitOperationsMigration } from './016-git-operations.ts';
import { gitOperationsIntentMigration } from './017-git-operations-intent.ts';
import { gitOperationsActionsMigration } from './018-git-operations-actions.ts';
import { managedJobIdentityMigration } from './019-managed-job-identity.ts';
import { managedJobIdColumnMigration } from './020-managed-job-id-column.ts';
import { projectCollabMigration } from './021-project-collab.ts';
import { realCallsMigration } from './022-real-calls.ts';
import { realCallsAttributionMigration } from './023-real-calls-attribution.ts';
import { collabSnapshotMigration } from './024-collab-snapshot.ts';
import { dmBoundaryMigration } from './025-dm-boundary.ts';

/** 迁移注册表：按 id 升序；已发布迁移不可改写（checksum 留档）。 */
export const MIGRATIONS: readonly Migration[] = [
  initialMigration,
  stopGenerationMigration,
  daemonStateMigration,
  ratifyPayloadHashMigration,
  runStageStartedAtMigration,
  turnExecClockMigration,
  changesetPreimageMigration,
  formatRepairWorkitemsMigration,
  recoveryProcessEvidenceMigration,
  logicalOutputRepairMigration,
  processTreeEvidenceMigration,
  processTreeLateEventsMigration,
  lateEventReceiptsMigration,
  processTreeIdentitiesMigration,
  lateReceiptScopeMigration,
  gitOperationsMigration,
  gitOperationsIntentMigration,
  gitOperationsActionsMigration,
  managedJobIdentityMigration,
  managedJobIdColumnMigration,
  projectCollabMigration,
  realCallsMigration,
  realCallsAttributionMigration,
  collabSnapshotMigration,
  dmBoundaryMigration,
];
