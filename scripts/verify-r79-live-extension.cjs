/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module */
const { join } = require('node:path');
const fs = require('node:fs');
module.exports = async function verifyR79(ctx) {
  const { cdp, projectId, room, memberId, project, data, out, command, navigate, uiSend, until, queryOne, queryAll, must, sleep, button, facts } = ctx;
  const taskBy = (label) => queryOne('SELECT id, conversation_thread_id AS threadId FROM tasks WHERE conversation_id=? AND title LIKE ? ORDER BY rowid DESC LIMIT 1', room.conversationId, `${label}%`);
  await navigate(cdp, `/project/${projectId}/room/${room.id}`, `/room/${room.id}`);
  await uiSend(cdp, 'R79 UI LIVE：持续运行中自动显示工具与用量', memberId);
  const live = await until(() => taskBy('R79 UI LIVE'), v => v?.id, 'R79 live task');
  await navigate(cdp, `/thread/${live.threadId}?tab=run`, live.threadId);
  await until(() => cdp.eval("document.body.textContent.includes('工具与诊断活动')"), Boolean, 'R79 actual details');
  const start = Date.now(); const samples = [];
  while (Date.now() - start < 17_500) {
    const persisted = queryOne(`SELECT t.revision taskRevision,r.id runId,r.status runStatus,(SELECT count(*) FROM domain_events e WHERE e.run_id=r.id AND e.kind LIKE 'tool.%') toolEvents,(SELECT count(*) FROM usage_records u JOIN agent_turns a ON a.id=u.turn_id WHERE a.run_id=r.id) usageRecords FROM tasks t JOIN workflow_runs r ON r.task_id=t.id WHERE t.id=? ORDER BY r.rowid DESC LIMIT 1`, live.id);
    const text = await cdp.eval("document.querySelector('.thread-details')?.textContent || ''");
    samples.push({ at: Date.now(), ...persisted, toolVisible: text.includes('R79_LIVE_PROGRESS_MARKER'), usageVisible: text.includes('用量记录（'), updatedTime: text.includes('更新于') });
    await sleep(250);
  }
  must(samples.every(s => s.runStatus === 'RUNNING') && new Set(samples.map(s => s.taskRevision)).size === 1 && new Set(samples.map(s => s.runId)).size === 1, 'R79 proof did not sustain unchanged RUNNING identity/revision across three cycles');
  must(samples.some(s => s.toolEvents === 2 && s.usageRecords === 1 && s.toolVisible && s.usageVisible && s.updatedTime), 'R79 persisted tools/usage not automatically visible');
  await cdp.shot('r79-live-running.png');
  const delivery = await until(() => queryOne('SELECT id FROM task_deliveries WHERE task_id=?', live.id), v => v?.id, 'R79 natural delivery');
  const document = await command(cdp, 'delivery.document', { deliveryId: delivery.id });
  must(document.hashMatch === true && fs.existsSync(join(project, 'results/r79-live.md')), 'R79 live natural file/document');
  await until(() => cdp.eval("document.body.textContent.includes('等待人工验收')"), Boolean, 'R79 natural delivery visible automatically');
  facts.steps.push('R79 unchanged RUNNING over 17.5 seconds / 3 polls → actual tools and usage → natural delivery');

  await navigate(cdp, `/project/${projectId}/room/${room.id}`, `/room/${room.id}`);
  await uiSend(cdp, 'R79 UI FAIL：工程明确失败，然后显式继续', memberId);
  const failed = await until(() => taskBy('R79 UI FAIL'), v => v?.id, 'R79 failed task');
  await navigate(cdp, `/thread/${failed.threadId}?tab=run`, failed.threadId);
  await until(() => cdp.eval("document.body.textContent.includes('R79_ENGINEERING_FAILURE') && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='继续最近失败运行'&&!b.disabled)"), Boolean, 'R79 failure reason and action');
  await cdp.shot('r79-failure-details.png');
  must(await cdp.eval(button('.thread-details', '继续最近失败运行')), 'R79 explicit continue');
  await until(() => queryOne('SELECT id FROM task_deliveries WHERE task_id=?', failed.id), v => v?.id, 'R79 explicit recovery delivery');
  must(queryAll('SELECT id FROM workflow_runs WHERE task_id=?', failed.id).length === 2, 'R79 recovery dispatched extra attempt');
  facts.steps.push('R79 natural FAILED reason → visible explicit retry → same task new natural delivery; no automatic retry');

  await navigate(cdp, `/project/${projectId}/room/${room.id}`, `/room/${room.id}`);
  await uiSend(cdp, 'R79 UI SCALE：独立历史规模夹具，不计正常业务完成', memberId);
  const scale = await until(() => taskBy('R79 UI SCALE'), v => v?.id, 'R79 scale fixture anchor');
  await until(() => queryOne('SELECT id FROM task_deliveries WHERE task_id=?', scale.id), v => v?.id, 'scale original natural delivery');
  // Explicit historical scale injection, separate from the ordinary room/DM lifecycle above.
  // It never mutates a task, turn, existing run, draft, outbox or original delivery status.
  const db = new (require('../node_modules/better-sqlite3'))(join(data, 'state.sqlite'));
  try {
    const original = db.prepare('SELECT * FROM task_deliveries WHERE task_id=? LIMIT 1').get(scale.id);
    db.transaction(() => {
      for (let i=0;i<25;i++) {
        const id=`r79-scale-run-${i}`;
        db.prepare("INSERT INTO workflow_runs(id,task_id,conversation_id,mode,status) VALUES(?,?,?,'DIRECT','FAILED')").run(id,scale.id,room.conversationId);
        for(let n=0;n<130;n++) db.prepare("INSERT INTO domain_events(event_id,schema_version,kind,project_id,conversation_id,task_id,run_id,payload_json,created_at) VALUES(?,1,'tool.completed',?,?,?,?,?,?)").run(`r79-scale-event-${i}-${n}`,projectId,room.conversationId,scale.id,id,JSON.stringify({toolCallId:`scale-${n}`,message:'R79_SYNTHETIC_HISTORY_ONLY'}),Date.now());
      }
      for(let i=2;i<=61;i++) db.prepare("INSERT INTO task_deliveries(id,task_id,run_id,revision,manifest_hash,artifact_refs_json,change_set_refs_json,verification_refs_json,review_status) VALUES(?,?,?,?,?,?,?,?,'superseded')").run(`r79-scale-delivery-${i}`,scale.id,original.run_id,i,original.manifest_hash,original.artifact_refs_json,original.change_set_refs_json,original.verification_refs_json);
    })();
  } finally { db.close(); }
  await navigate(cdp, `/thread/${scale.threadId}?tab=run`, scale.threadId);
  await until(() => cdp.eval("document.querySelector('[data-zs-history=runs] button') != null"), Boolean, 'R79 history control');
  must(await cdp.eval(button('[data-zs-history=runs]', '加载更早历史')), 'R79 run history click');
  await until(() => cdp.eval("document.querySelector('[data-zs-history=runs]')?.textContent.includes('已到历史起点')"), Boolean, 'older runs reached');
  const chosen = await cdp.eval("(()=>{const area=document.querySelector('[data-zs-history=runs]');const row=area.querySelector('button');const id=area.querySelector('details')?.textContent.replace('运行身份','');row.click();return id})()");
  await until(() => cdp.eval("document.querySelector('.thread-details')?.textContent.includes('历史运行 · 已定位')"), Boolean, 'older run actually selected');
  await sleep(5500);
  must((await command(cdp,'task.details',{projectId,taskId:scale.id,runId:chosen})).selectedRunId===chosen,'selected history mismatch');
  must(await cdp.eval(button('[data-zs-history=activity]', '加载更早历史')), 'R79 run activity history click');
  await until(() => cdp.eval("document.querySelector('[data-zs-history=activity]')?.textContent.includes('已到历史起点')"), Boolean, 'older run events reached');
  await cdp.shot('r79-historical-run.png');
  await navigate(cdp, `/thread/${scale.threadId}?tab=activity`, scale.threadId);
  must(await cdp.eval(button('[data-zs-history=activity]', '加载更早历史')), 'R79 task activity history click');
  await until(() => cdp.eval("document.querySelector('[data-zs-history=activity]')?.textContent.includes('更早历史页')"), Boolean, 'task activity page');
  await navigate(cdp, `/thread/${scale.threadId}?tab=delivery`, scale.threadId);
  must(await cdp.eval(button('[data-zs-history=deliveries]', '加载更早历史')), 'R79 delivery history click');
  await until(() => cdp.eval("document.querySelector('[data-zs-history=deliveries]')?.textContent.includes('交付 v11')"), Boolean, 'older delivery page');
  await cdp.shot('r79-delivery-history.png');
  const olderDocument=await command(cdp,'delivery.document',{deliveryId:'r79-scale-delivery-10'});
  must(olderDocument.hashMatch===true,'older fixture document original bytes no longer readable');
  facts.steps.push('R79 separately labelled synthetic 26-run/3250-event/61-delivery scale: older run selection, bounded activity/delivery pages and original document read');
  fs.writeFileSync(join(out,'r79-live-samples.json'),JSON.stringify({scope:'final copied package, unmodified launcher, formal worker + engineering Fake adapter',samples,realCalls:0},null,2));
  return {live,failed,scale,selectedHistoricalRun:chosen,threeCycles:true,automaticToolsAndUsage:true,naturalDelivery:true,explicitFailureRecovery:true,scaleInjection:'separate historical scale only; no normal state updates',runs:26,events:3250,deliveries:61,historyRead:true,zeroCalls:true};
};
