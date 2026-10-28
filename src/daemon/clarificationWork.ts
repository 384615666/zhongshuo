import type { ZhongshuoDatabase } from '../persistence/db.ts';

type FileVersion = { path: string; state: string; sha256: string | null };

/** Only unfinished, successful question turns from this task and stop generation
 * carry work forward. A later formal delivery closes the partial-work chain. */
export function pendingClarificationChangeSets(db: ZhongshuoDatabase, taskId: string, stopGeneration: number, excludeTurnId = ''): string[] {
  const questions = db.prepare(`SELECT e.payload_json,e.run_id,a.id turn_id FROM domain_events e
    JOIN agent_turns a ON a.id=e.turn_id JOIN workflow_runs r ON r.id=a.run_id
    WHERE e.task_id=? AND r.task_id=? AND e.kind='turn.workClarification'
      AND json_type(e.payload_json,'$.question')='text' AND a.status='SUCCEEDED' AND a.id!=?
      AND COALESCE(a.stop_generation_snapshot,0)=?
      AND a.rowid>COALESCE((SELECT MAX(done.rowid) FROM task_deliveries d
        JOIN agent_turns done ON done.run_id=d.run_id WHERE d.task_id=?),0)
    ORDER BY e.seq`).all(taskId, taskId, excludeTurnId, stopGeneration, taskId) as Array<{payload_json:string;run_id:string;turn_id:string}>;
  const refs = new Set<string>();
  for (const question of questions) {
    const payload = JSON.parse(question.payload_json) as { changeSetRefs?: unknown };
    if (Array.isArray(payload.changeSetRefs)) {
      for (const ref of payload.changeSetRefs) {
        if (typeof ref !== 'string') throw Error('待确认成果的改动集引用无效');
        refs.add(ref);
      }
    } else {
      // V59 questions already have immutable baselines, but did not record their
      // refs in the question. Recover those exact refs without reading new files.
      const turns:string[]=[];
      let sourceTurn:string|undefined=question.turn_id;
      while(sourceTurn){
        if(turns.includes(sourceTurn))throw Error('待确认成果的修复来源存在循环');
        turns.unshift(sourceTurn);
        const repair=db.prepare('SELECT source_turn_id FROM format_repair_workitems WHERE consumed_turn_id=? AND task_id=?')
          .get(sourceTurn,taskId) as {source_turn_id:string}|undefined;
        sourceTurn=repair?.source_turn_id;
      }
      for(const turnId of turns){
        const owner=db.prepare('SELECT r.id FROM workflow_runs r JOIN agent_turns a ON a.run_id=r.id WHERE a.id=? AND r.task_id=?')
          .get(turnId,taskId) as {id:string}|undefined;
        if(!owner)throw Error('待确认成果的修复来源不属于原任务');
        const baselines = db.prepare(`SELECT json_extract(payload_json,'$.changeSetId') id FROM domain_events
          WHERE run_id=? AND task_id=? AND kind='changeset.baselineCaptured' ORDER BY seq`)
          .all(owner.id, taskId) as Array<{id:string}>;
        for (const baseline of baselines) refs.add(baseline.id);
      }
    }
  }
  for (const ref of refs) {
    if (!db.prepare("SELECT 1 FROM change_sets WHERE id=? AND task_id=? AND after_ref!=''").get(ref, taskId)) {
      throw Error('待确认成果的改动集缺失或尚未定型');
    }
  }
  return [...refs];
}

/** Fold only the supplied delivery chain, in execution order. Later legitimate
 * edits replace the same path; an intervening version change is never adopted. */
export function changeSetFilesForDelivery(db: ZhongshuoDatabase, taskId: string, refs: readonly string[]): FileVersion[] {
  const latest = new Map<string, FileVersion>();
  for (const ref of new Set(refs)) {
    // Parent deliveries may also reference their child deliveries. Those files
    // are already checked through the parent's managed upstream handoffs.
    if (!db.prepare('SELECT 1 FROM change_sets WHERE id=? AND task_id=?').get(ref, taskId)) continue;
    const rows = db.prepare(`SELECT f.path,f.state,f.sha256,b.state before_state,b.sha256 before_sha256
      FROM change_set_files f LEFT JOIN change_set_files b
        ON b.change_set_id=f.change_set_id AND b.path=f.path AND b.role='before'
      WHERE f.change_set_id=? AND f.role='after' ORDER BY f.id`).all(ref) as Array<FileVersion & {before_state:string|null;before_sha256:string|null}>;
    for (const file of rows) {
      const prior = latest.get(file.path);
      if (prior && (file.before_state !== prior.state || file.before_sha256 !== prior.sha256)) {
        throw Error(`待确认成果的文件版本已变化：${file.path}；未覆盖原交付依据`);
      }
      if (prior || file.before_state !== file.state || file.before_sha256 !== file.sha256) {
        latest.set(file.path, {path:file.path,state:file.state,sha256:file.sha256});
      }
    }
  }
  return [...latest.values()];
}
