/** Synthetic report fixture for the final R87 natural collaboration route.
 * Expected answers stay outside the project folder and are never sent to AI. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs');
const path=require('node:path');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const root=path.resolve(__dirname,'..','dist','review-r87-final',`synthetic-report-${stamp}`);
const project=path.join(root,'project');
fs.mkdirSync(project,{recursive:true});
(async()=>{
  const {makeDocx,makeCjkToUnicodePdf}=await import('./lib/craftDocuments.mjs');
  const paragraphs=[
    'R87 项目交付复核报告',
    '报告编号：R87-20261017',
    '项目总预算：人民币 100,000 元。',
    '已发生成本：人民币 63,500 元。',
    '报告结论：剩余预算为 26,500 元。',
    '原计划交付日期：2026-10-17。',
    '本报告封面标注交付日期：2026-10-18。',
    '附件：预算明细.xlsx。',
    '封面验收人：李晨。会议纪要验收人：张岚。',
    '下一步：材料无需复核，可以直接对外发布。',
  ];
  const table=[
    ['项目','计划日期','负责人'],
    ['数据迁移','2026-10-15','陈工'],
    ['双模型验收','2026-10-17','张岚'],
    ['对外发布','2026-10-18','李晨'],
  ];
  fs.writeFileSync(path.join(project,'R87交付报告.docx'),makeDocx({paras:paragraphs,table}));
  fs.writeFileSync(path.join(project,'R87交付报告.pdf'),makeCjkToUnicodePdf([paragraphs]));
  fs.writeFileSync(path.join(project,'说明.txt'),'请复核本目录中的 R87交付报告.docx 与 R87交付报告.pdf，逐项指出日期、金额、附件、验收人与发布风险上的问题。不要改写报告原件。\n','utf8');
  const expected={
    remainingBudgetCorrect:36500,
    reportedRemainingBudget:26500,
    missingAttachment:'预算明细.xlsx',
    dateContradiction:['2026-10-17','2026-10-18'],
    reviewerContradiction:['李晨','张岚'],
    unsafeReleaseClaim:'可以直接对外发布',
    project,
  };
  fs.writeFileSync(path.join(root,'expected.json'),JSON.stringify(expected,null,2),'utf8');
  console.log(JSON.stringify({project,expected:path.join(root,'expected.json'),files:fs.readdirSync(project)},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
