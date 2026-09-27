/**
 * 001 初始迁移：主设计 §12.2 表结构目录全量 + 开工契约 §2.2 会话增量 + §12.3 关键约束。
 *
 * 约定：所有 ID 稳定随机字符串；时间 UTC 毫秒 INTEGER；JSON 字段后缀 _json。
 * 组合外键 (project_id, conversation_id) → conversations(project_id, id) 落在
 * conversation_threads/messages/tasks/conversation_members/dm_participants/
 * conversation_read_states/runtime_sessions/thread_agent_followers；
 * workflow_runs/agent_turns 经 task→tasks 的组合外键链绑定会话，run.conversation_id
 * 与 task.conversation_id 的一致性由服务层提交路径校验（ADR-I16）。
 * external_connections/external_grants 不在 §12.2 目录内，随 FULL-11 迁移（ADR-I13）。
 * workspace_leases 活跃租约数量约束随项目 writeConcurrencyPolicy 变化，服务层执行（ADR-I14）。
 * reminder_occurrences 承载开工契约 §7「occurrence 以 (reminderId,scheduledAt) 唯一」。
 */
import type { Migration } from '../db.ts';

export const initialMigration: Migration = {
  id: 1,
  name: 'initial-schema-v1.23',
  up: (db) => {
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        directory_identity TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','archived','directory_missing','removed')),
        revision INTEGER NOT NULL DEFAULT 0,
        task_review_enabled INTEGER NOT NULL DEFAULT 0,
        write_concurrency_policy TEXT NOT NULL DEFAULT 'single_writer'
          CHECK (write_concurrency_policy IN ('single_writer','parallel_writers')),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE navigation_preferences (
        viewer_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        visible_project_ids_json TEXT NOT NULL,
        active_project_id TEXT,
        expanded_project_ids_json TEXT NOT NULL,
        file_git_tabs_json TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (viewer_id, client_id)
      );

      CREATE TABLE runtime_installations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        executable TEXT NOT NULL,
        version TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        capabilities_json TEXT,
        detected_at INTEGER NOT NULL
      );

      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        runtime_installation_id TEXT NOT NULL REFERENCES runtime_installations(id),
        settings_json TEXT
      );

      CREATE TABLE project_members (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        profile_id TEXT REFERENCES agent_profiles(id),
        display_name TEXT NOT NULL,
        principal_type TEXT NOT NULL CHECK (principal_type IN ('human','agent')),
        enabled INTEGER NOT NULL DEFAULT 1,
        settings_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX project_members_by_project ON project_members(project_id);

      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        coordinator_member_id TEXT NOT NULL REFERENCES project_members(id),
        settings_json TEXT,
        archived_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX rooms_by_project ON rooms(project_id);

      CREATE TABLE room_members (
        room_id TEXT NOT NULL REFERENCES rooms(id),
        member_id TEXT NOT NULL REFERENCES project_members(id),
        PRIMARY KEY (room_id, member_id)
      );

      -- 会话（开工契约 §2.2）：每个 room 恰一个会话；dm 的 room_id 为 NULL。
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL CHECK (kind IN ('room','dm')),
        room_id TEXT REFERENCES rooms(id),
        title TEXT,
        archived_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 0,
        last_message_seq INTEGER NOT NULL DEFAULT 0,
        CHECK ((kind = 'room' AND room_id IS NOT NULL) OR (kind = 'dm' AND room_id IS NULL))
      );
      CREATE UNIQUE INDEX one_conversation_per_room
        ON conversations(project_id, room_id) WHERE room_id IS NOT NULL;
      CREATE UNIQUE INDEX conversations_project_scope ON conversations(project_id, id);

      CREATE TABLE conversation_members (
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        member_id TEXT NOT NULL REFERENCES project_members(id),
        PRIMARY KEY (conversation_id, member_id),
        FOREIGN KEY (project_id, conversation_id) REFERENCES conversations(project_id, id)
      );

      CREATE TABLE dm_participants (
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        principal_type TEXT NOT NULL CHECK (principal_type IN ('human','agent')),
        principal_id TEXT NOT NULL,
        PRIMARY KEY (conversation_id, principal_id),
        FOREIGN KEY (project_id, conversation_id) REFERENCES conversations(project_id, id)
      );
      -- 「恰两个不同主体、创建后不可追加/替换」由服务层创建事务保证（ADR-I15）。

      CREATE TABLE conversation_read_states (
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        viewer_id TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation_id, viewer_id),
        FOREIGN KEY (project_id, conversation_id) REFERENCES conversations(project_id, id)
      );

      CREATE TABLE conversation_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        room_id TEXT NOT NULL REFERENCES rooms(id),
        anchor_message_id TEXT NOT NULL,
        root_task_id TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
        last_message_seq INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (project_id, conversation_id) REFERENCES conversations(project_id, id)
      );
      CREATE UNIQUE INDEX one_thread_per_anchor ON conversation_threads(anchor_message_id);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        conversation_seq INTEGER NOT NULL,
        room_id TEXT REFERENCES rooms(id),
        thread_id TEXT REFERENCES conversation_threads(id),
        task_id TEXT,
        reply_to_message_id TEXT,
        thread_message_seq INTEGER,
        author_type TEXT NOT NULL
          CHECK (author_type IN ('human','agent','system','third_party_app')),
        author_id TEXT NOT NULL,
        via_connection_id TEXT,
        body_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'saved'
          CHECK (status IN ('saved','streaming','final','invalid')),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id, conversation_id) REFERENCES conversations(project_id, id),
        CHECK (
          (thread_id IS NULL AND thread_message_seq IS NULL) OR
          (thread_id IS NOT NULL AND thread_message_seq IS NOT NULL)
        ),
        CHECK (via_connection_id IS NULL OR author_type = 'human')
      );
      CREATE UNIQUE INDEX conversation_seq_unique ON messages(conversation_id, conversation_seq);
      CREATE UNIQUE INDEX thread_message_order
        ON messages(thread_id, thread_message_seq) WHERE thread_id IS NOT NULL;
      CREATE INDEX top_level_room_messages
        ON messages(room_id, created_at) WHERE thread_id IS NULL;
      CREATE INDEX thread_history ON messages(thread_id, thread_message_seq);
      CREATE INDEX messages_by_task_time ON messages(task_id, created_at);

      CREATE TABLE message_revisions (
        message_id TEXT NOT NULL REFERENCES messages(id),
        revision INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        PRIMARY KEY (message_id, revision)
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('room_task','dm_turn')),
        room_id TEXT REFERENCES rooms(id),
        conversation_thread_id TEXT REFERENCES conversation_threads(id),
        root_message_id TEXT REFERENCES messages(id),
        room_task_number INTEGER,
        owner_member_id TEXT REFERENCES project_members(id),
        parent_task_id TEXT REFERENCES tasks(id),
        source_connection_id TEXT,
        title TEXT NOT NULL,
        objective TEXT,
        status TEXT NOT NULL DEFAULT 'OPEN'
          CHECK (status IN ('OPEN','ACTIVE','WAITING_USER','BLOCKED','REVIEW','DONE','CANCELLED')),
        revision INTEGER NOT NULL DEFAULT 0,
        review_policy TEXT NOT NULL DEFAULT 'auto_deliver'
          CHECK (review_policy IN ('auto_deliver','user_review')),
        current_delivery_id TEXT,
        FOREIGN KEY (project_id, conversation_id) REFERENCES conversations(project_id, id),
        CHECK (
          kind = 'room_task' OR
          (room_id IS NULL AND conversation_thread_id IS NULL AND room_task_number IS NULL)
        )
      );
      CREATE UNIQUE INDEX one_root_task_per_message
        ON tasks(root_message_id) WHERE parent_task_id IS NULL;
      CREATE UNIQUE INDEX one_task_number_per_room
        ON tasks(room_id, room_task_number) WHERE room_task_number IS NOT NULL;
      CREATE INDEX tasks_by_conversation ON tasks(conversation_id);

      CREATE TABLE task_deliveries (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        run_id TEXT,
        revision INTEGER NOT NULL,
        manifest_hash TEXT NOT NULL,
        artifact_refs_json TEXT NOT NULL,
        change_set_refs_json TEXT NOT NULL,
        verification_refs_json TEXT NOT NULL,
        review_status TEXT NOT NULL
          CHECK (review_status IN ('not_required','pending','accepted','changes_requested','superseded')),
        reviewed_by TEXT,
        reviewed_at INTEGER,
        review_note TEXT,
        UNIQUE (task_id, revision),
        CHECK (
          (review_status = 'not_required' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
          (review_status != 'not_required')
        ),
        CHECK (review_status != 'accepted' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
      );
      CREATE UNIQUE INDEX one_pending_delivery
        ON task_deliveries(task_id) WHERE review_status = 'pending';

      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id),
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
        PRIMARY KEY (task_id, depends_on_task_id),
        CHECK (task_id != depends_on_task_id)
      );

      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        thread_id TEXT REFERENCES conversation_threads(id),
        mode TEXT NOT NULL CHECK (mode IN ('AUTO','DELIBERATE','DIRECT')),
        task_revision INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'QUEUED'
          CHECK (status IN ('QUEUED','RUNNING','WAITING','STOPPING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','INTERRUPTED')),
        stage TEXT,
        round_no INTEGER,
        roster_revision INTEGER,
        budget_json TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        CHECK (thread_id IS NOT NULL OR mode = 'DIRECT')
      );
      CREATE INDEX runs_by_task ON workflow_runs(task_id);

      CREATE TABLE run_participants (
        run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        member_id TEXT NOT NULL REFERENCES project_members(id),
        role TEXT NOT NULL,
        expected INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        PRIMARY KEY (run_id, member_id)
      );

      CREATE TABLE agent_turns (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        thread_id TEXT REFERENCES conversation_threads(id),
        member_id TEXT NOT NULL REFERENCES project_members(id),
        stage_key TEXT NOT NULL,
        turn_purpose TEXT NOT NULL DEFAULT 'stage_work'
          CHECK (turn_purpose IN ('stage_work','checkpoint','format_repair')),
        attempt INTEGER NOT NULL DEFAULT 1,
        epoch INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN')),
        dispatch_key TEXT,
        session_id TEXT,
        UNIQUE (run_id, member_id, stage_key, attempt)
      );
      CREATE UNIQUE INDEX one_dispatch_key
        ON agent_turns(dispatch_key) WHERE dispatch_key IS NOT NULL;

      CREATE TABLE runtime_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        conversation_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('task','dm')),
        thread_id TEXT REFERENCES conversation_threads(id),
        member_id TEXT NOT NULL REFERENCES project_members(id),
        task_id TEXT,
        session_generation INTEGER NOT NULL DEFAULT 0,
        provider_session_id TEXT,
        cwd TEXT NOT NULL,
        capabilities_json TEXT,
        FOREIGN KEY (project_id, conversation_id) REFERENCES conversations(project_id, id),
        CHECK ((scope_kind = 'dm' AND task_id IS NULL) OR (scope_kind = 'task' AND task_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX dm_session_reuse_key
        ON runtime_sessions(project_id, conversation_id, member_id, session_generation)
        WHERE scope_kind = 'dm';

      CREATE TABLE domain_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        conversation_id TEXT,
        thread_id TEXT,
        task_id TEXT,
        run_id TEXT,
        turn_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX events_by_project_seq ON domain_events(project_id, seq);
      CREATE INDEX events_by_thread ON domain_events(thread_id, seq);

      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_key TEXT NOT NULL UNIQUE,
        turn_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','leased','done','failed')),
        lease_owner TEXT,
        lease_until INTEGER,
        attempt_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX pending_dispatch ON outbox(status, lease_until);

      CREATE TABLE command_receipts (
        idempotency_scope TEXT NOT NULL,
        command_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        result_json TEXT,
        result_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (idempotency_scope, command_id)
      );

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        baseline_id TEXT,
        status TEXT NOT NULL
      );

      CREATE TABLE workspace_leases (
        lock_domain TEXT NOT NULL,
        owner_turn_id TEXT NOT NULL REFERENCES agent_turns(id),
        epoch INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','released','expired')),
        PRIMARY KEY (lock_domain, owner_turn_id)
      );

      CREATE TABLE baselines (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_revision INTEGER NOT NULL,
        manifest_hash TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE context_bundles (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES agent_turns(id),
        thread_id TEXT REFERENCES conversation_threads(id),
        task_revision INTEGER NOT NULL,
        baseline_id TEXT REFERENCES baselines(id),
        included_refs_json TEXT NOT NULL,
        scope_grants_json TEXT NOT NULL,
        hash TEXT NOT NULL
      );

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        conversation_id TEXT,
        thread_id TEXT,
        task_id TEXT,
        run_id TEXT,
        author_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        hash TEXT NOT NULL,
        blob_path TEXT NOT NULL
      );
      CREATE INDEX artifacts_by_task ON artifacts(task_id);

      CREATE TABLE change_sets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id TEXT REFERENCES tasks(id),
        workspace_id TEXT REFERENCES workspaces(id),
        before_ref TEXT NOT NULL,
        after_ref TEXT NOT NULL,
        application_status TEXT NOT NULL DEFAULT 'not_applied'
          CHECK (application_status IN ('applied','not_applied','reverted','partial')),
        manifest_json TEXT
      );

      CREATE TABLE issues (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        statement TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('open','resolved','needs_user','insufficient_evidence')),
        evidence_refs_json TEXT NOT NULL
      );

      CREATE TABLE positions (
        issue_id TEXT NOT NULL REFERENCES issues(id),
        issue_revision INTEGER NOT NULL,
        member_id TEXT NOT NULL,
        stance TEXT NOT NULL CHECK (stance IN ('agree','disagree','needs_evidence')),
        conditions_json TEXT,
        source_artifact_id TEXT,
        PRIMARY KEY (issue_id, issue_revision, member_id)
      );

      CREATE TABLE synthesis_claims (
        run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        synthesis_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        synthesis_revision INTEGER NOT NULL,
        claim_id TEXT NOT NULL,
        statement TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        PRIMARY KEY (run_id, synthesis_artifact_id, synthesis_revision, claim_id)
      );

      CREATE TABLE ratification_records (
        run_id TEXT NOT NULL,
        synthesis_artifact_id TEXT NOT NULL,
        synthesis_revision INTEGER NOT NULL,
        claim_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        roster_revision INTEGER NOT NULL,
        response_status TEXT NOT NULL CHECK (response_status IN ('pending','submitted','missing')),
        stance TEXT CHECK (stance IN ('confirm','conditional','object','unconfirmed')),
        conditions_json TEXT,
        reason TEXT,
        missing_reason TEXT,
        turn_id TEXT,
        response_artifact_id TEXT,
        result_key TEXT NOT NULL,
        accepted_at INTEGER,
        PRIMARY KEY (run_id, synthesis_artifact_id, synthesis_revision, claim_id, member_id),
        FOREIGN KEY (run_id, member_id) REFERENCES run_participants(run_id, member_id),
        FOREIGN KEY (run_id, synthesis_artifact_id, synthesis_revision, claim_id)
          REFERENCES synthesis_claims(run_id, synthesis_artifact_id, synthesis_revision, claim_id),
        CHECK (response_status != 'submitted' OR (stance IS NOT NULL AND turn_id IS NOT NULL))
      );

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES agent_turns(id),
        provider_request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','allowed','denied','expired','superseded')),
        scope_json TEXT,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE usage_records (
        turn_id TEXT NOT NULL REFERENCES agent_turns(id),
        provider_event_id TEXT NOT NULL,
        reported_json TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        cost_quality TEXT NOT NULL CHECK (cost_quality IN ('reported','estimated','unknown')),
        PRIMARY KEY (turn_id, provider_event_id)
      );

      CREATE TABLE context_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        revision INTEGER NOT NULL,
        source_refs_json TEXT NOT NULL,
        confirmed_by TEXT
      );

      CREATE TABLE thread_read_states (
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id),
        viewer_id TEXT NOT NULL,
        last_read_message_seq INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, viewer_id)
      );

      CREATE TABLE thread_subscriptions (
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id),
        viewer_id TEXT NOT NULL,
        followed INTEGER NOT NULL DEFAULT 0,
        muted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (thread_id, viewer_id)
      );

      CREATE TABLE thread_agent_followers (
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id),
        member_id TEXT NOT NULL REFERENCES project_members(id),
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        added_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, member_id),
        FOREIGN KEY (project_id, conversation_id) REFERENCES conversations(project_id, id)
      );

      CREATE TABLE saved_items (
        viewer_id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES messages(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (viewer_id, message_id)
      );

      CREATE TABLE attention_items (
        id TEXT PRIMARY KEY,
        viewer_id TEXT NOT NULL,
        thread_id TEXT REFERENCES conversation_threads(id),
        source_event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        read_at INTEGER,
        UNIQUE (viewer_id, source_event_id)
      );

      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id),
        thread_id TEXT REFERENCES conversation_threads(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        display_name TEXT NOT NULL,
        mime_type TEXT,
        source_hash TEXT NOT NULL
      );

      CREATE TABLE context_grants (
        id TEXT PRIMARY KEY,
        target_thread_id TEXT NOT NULL REFERENCES conversation_threads(id),
        source_ref_json TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        granted_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        owner_member_id TEXT NOT NULL REFERENCES project_members(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        thread_id TEXT REFERENCES conversation_threads(id),
        task_id TEXT REFERENCES tasks(id),
        source_ref TEXT,
        timezone TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        next_at INTEGER,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        budget_json TEXT,
        grant_scope_json TEXT
      );

      CREATE TABLE reminder_occurrences (
        reminder_id TEXT NOT NULL REFERENCES reminders(id),
        scheduled_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (reminder_id, scheduled_at)
      );

      CREATE TABLE file_comments (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version INTEGER NOT NULL,
        hash TEXT NOT NULL,
        anchor_type TEXT NOT NULL,
        anchor_json TEXT,
        author_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX file_comments_by_artifact ON file_comments(artifact_id, version);
    `);
  },
};
