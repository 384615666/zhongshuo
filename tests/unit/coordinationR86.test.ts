import {createRequire} from 'node:module';
import {DELIBERATE_OUTPUT_CONTRACTS,taskCompleteOutputSchema} from '../../src/contracts/prompts.ts';
import {deliberationOutputSchema} from '../../src/daemon/deliberationRunner.ts';
import {analysisDraftPayloadSchema,reviewPayloadSchema,issuePositionPayloadSchema,checkpointVerdictPayloadSchema,synthesisPayloadSchema,ratifyPayloadSchema} from '../../src/contracts/deliberation.ts';
import { describe, expect, it } from 'vitest';
import { coordinationCallAvailable, validateCoordinationPlan } from '../../src/contracts/coordination.ts';
import {chatAnswer} from '../../src/contracts/chatAnswer.ts';

const step = (key: string, memberId = 'a', dependsOn: string[] = []) => ({ key, memberId, dependsOn, title: key, objective: '真实工作', role: 'analysis' });
describe('R86 authoritative collaboration plan', () => {
  it('accepts independent identities and an explicit dependency chain', () => {
    const plan = { summary: '实现后独立评审', steps: [step('build'), step('review', 'b', ['build'])] };
    expect(validateCoordinationPlan(plan, ['a', 'b'])).toEqual(plan);
  });
  it('rejects unknown and cross-project member identities regardless of display names', () => {
    expect(() => validateCoordinationPlan({ summary: 'x', steps: [step('work', 'other-project')] }, ['a'])).toThrow('名单');
  });
  it('rejects duplicate nodes, missing dependencies, self loops and longer cycles', () => {
    for (const steps of [[step('a'), step('a')], [step('a', 'a', ['missing'])], [step('a', 'a', ['a'])], [step('a', 'a', ['b']), step('b', 'b', ['a'])]]) {
      expect(() => validateCoordinationPlan({ summary: 'x', steps }, ['a', 'b'])).toThrow();
    }
  });
  it('rejects empty work and unbounded plans', () => {
    for (const steps of [[], Array.from({ length: 9 }, (_, i) => step(`a${i}`))]) expect(() => validateCoordinationPlan({ summary: 'x', steps }, ['a'])).toThrow();
  });
  it('reserves integration calls and counts unknown/reserved calls conservatively', () => {
    expect(coordinationCallAvailable(21, 'work')).toBe(true);
    expect(coordinationCallAvailable(22, 'work')).toBe(false);
    expect(coordinationCallAvailable(22, 'integration')).toBe(true);
    expect(coordinationCallAvailable(24, 'integration')).toBe(false);
    expect(coordinationCallAvailable(-1, 'work')).toBe(false);
  });
});

 it('uses CLI-compatible draft-07 for every actual stage schema without dropping constraints',()=>{
  const schemas=[taskCompleteOutputSchema('key'),taskCompleteOutputSchema('key',true),...(['IND','CR','ISS','CHK','SYN','RAT'] as const).map(stage=>deliberationOutputSchema(stage))];
  for(const schema of schemas){expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');expect(schema.type).toBe('object');expect(schema.required?.length).toBeGreaterThan(0);expect(JSON.stringify(schema)).not.toContain('2020-12');}
  expect(taskCompleteOutputSchema('key',true).properties).toHaveProperty('coordinationPlan');
  // Same draft-07 validator family, entirely local: the original declaration must fail.
  const dependencyRequire=createRequire(createRequire(import.meta.url).resolve('eslint'));
  const Ajv=dependencyRequire('ajv') as new(options:unknown)=>{compile:(schema:unknown)=>((data:unknown)=>boolean)};
  for(const schema of schemas){const validator=new Ajv({strict:false,validateSchema:true});const validate=validator.compile(schema);expect(validate({})).toBe(false);expect(()=>new Ajv({strict:false}).compile({...schema,$schema:'https://json-schema.org/draft/2020-12/schema'})).toThrow(/no schema with key or ref/);}

 });

it('every Codex structured-output object requires all declared properties, including nested deliberation fields',()=>{
 const visit=(node:unknown)=>{if(!node||typeof node!=='object')return;const row=node as Record<string,unknown>;if(row.type==='object'&&row.properties){expect(row.additionalProperties).toBe(false);expect(new Set(row.required as string[])).toEqual(new Set(Object.keys(row.properties)));}for(const value of Object.values(row)){if(Array.isArray(value))value.forEach(visit);else visit(value);}};
 for(const schema of [taskCompleteOutputSchema('key'),taskCompleteOutputSchema('key',true),...(['IND','CR','ISS','CHK','SYN','RAT'] as const).map(stage=>deliberationOutputSchema(stage))])visit(schema);
});

it('strict transport accepts actual six-stage values without relaxing historical business validation',()=>{
 const req=createRequire(createRequire(import.meta.url).resolve('eslint')),Ajv=req('ajv') as new(options:unknown)=>{compile:(schema:unknown)=>((data:unknown)=>boolean)};
 const cases=[
  ['IND',analysisDraftPayloadSchema,{schemaVersion:'analysis-draft-v1',summary:'独立分析',document:null,claims:[{claimId:'c1',statement:'主要风险',kind:'proposal',evidenceIds:[],uncertainty:''}],recommendations:[],openQuestions:[]}],
  ['CR',reviewPayloadSchema,{schemaVersion:'cross-review-v1',summary:'互评总览',document:null,reviews:[{targetArtifactId:'real-upstream',targetRevision:1,targetClaimId:'c1',stance:'agree',reason:'已有验收例',evidenceIds:[],suggestedVerification:''}]}],
  ['ISS',issuePositionPayloadSchema,{schemaVersion:'issue-position-v1',summary:'争议讨论总览',document:null,positions:[{issueId:'i1',stance:'agree',reason:'范围明确',newEvidence:[]}]}],
  ['CHK',checkpointVerdictPayloadSchema,{schemaVersion:'checkpoint-verdict-v1',summary:'检查点总览',document:null,verdict:'stop',reason:'无新增证据',evidenceSummary:''}],
  ['SYN',synthesisPayloadSchema,{schemaVersion:'synthesis-v1',summary:'整合',document:null,issueResolutions:[],claims:[{statement:'结论',sourceRefs:['real-upstream:1:c1']}],disputedClaims:[],recommendations:[]}],
  ['RAT',ratifyPayloadSchema,{schemaVersion:'ratify-v1',summary:'确认总览',document:null,deliveryFeedback:{status:'ready',reason:'可交付',revisionRequest:'',question:'',owner:''},issueResponses:[],responses:[{claimId:'clm_1',stance:'confirm',conditions:[],reason:''}]}],
 ] as const;
  for(const [stage,business,value] of cases){const transport=deliberationOutputSchema(stage);const validate=new Ajv({strict:false}).compile(transport);expect(transport.properties,stage).toHaveProperty('summary');expect(transport.properties,stage).toHaveProperty('document');expect(transport.properties,stage).not.toHaveProperty('detailMarkdown');expect(validate(value),stage).toBe(true);expect(business.safeParse(value).success,stage).toBe(true);expect(validate({...value,schemaVersion:'wrong'})).toBe(false);const withoutView=[...Object.entries(value)].filter(([key])=>key!=='summary'&&key!=='document');expect(validate(Object.fromEntries(withoutView)),`${stage} missing model user view`).toBe(false);}
  for(const [key,contract] of Object.entries(DELIBERATE_OUTPUT_CONTRACTS)){const value=JSON.parse(contract) as Record<string,unknown>;expect(value,key).toHaveProperty('summary');expect(value,key).toHaveProperty('document');expect(value,key).not.toHaveProperty('detailMarkdown');}
 const historical={schemaVersion:'analysis-draft-v1',summary:'原件',claims:[{claimId:'c1',statement:'原结论',kind:'proposal',evidenceIds:[]}],recommendations:[],openQuestions:[]};expect(analysisDraftPayloadSchema.safeParse(historical).success).toBe(true);expect(new Ajv({strict:false}).compile(deliberationOutputSchema('IND'))(historical)).toBe(false);
  const legacyRatify={schemaVersion:'ratify-v1',summary:'旧确认',document:null,deliveryFeedback:{status:'ready',reason:'可交付',revisionRequest:'',question:'',owner:''},responses:[{claimId:'clm_1',stance:'confirm',conditions:[],reason:''}]};expect(ratifyPayloadSchema.safeParse(legacyRatify).success).toBe(true);expect(new Ajv({strict:false}).compile(deliberationOutputSchema('RAT'))(legacyRatify)).toBe(false);
});

const planningChat={schemaVersion:'task-complete-v1',resultKey:'original-result',answer:'已排好分工，开始执行。',responseKind:'work',changeSummary:'只读规划完成',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],coordinationPlan:{summary:'实际分工',steps:[{key:'implement',memberId:'selected-member',title:'实现',objective:'完成合成任务',role:'implementation',dependsOn:[]}]}};
it('projects the formally supported AUTO planning result in agent chat and leaves human JSON and original bytes exact',()=>{
 const raw=JSON.stringify(planningChat);expect(chatAnswer(raw,'agent')).toBe(planningChat.answer);expect(chatAnswer(raw,'human')).toBe(raw);expect(chatAnswer(raw,'third_party_app')).toBe(raw);expect(JSON.stringify(planningChat)).toBe(raw);
});
it('accepts a nullable official plan but never hides malformed or extra-field planning JSON',()=>{
 expect(chatAnswer(JSON.stringify({...planningChat,coordinationPlan:null}),'agent')).toBe(planningChat.answer);
 for(const bad of [{...planningChat,unexpected:'keep me'},{...planningChat,files:[{path:'not a string'}]},{...planningChat,responseKind:'administrative'},{...planningChat,unexecutedVerifications:[{item:'unknown',reason:1}]},{...planningChat,coordinationPlan:{summary:'bad',steps:[]}},{...planningChat,coordinationPlan:{summary:'bad',steps:[{...planningChat.coordinationPlan.steps[0],role:'full-computer-authority'}]}}]){const raw=JSON.stringify(bad);expect(chatAnswer(raw,'agent')).toBe(raw);}
});
