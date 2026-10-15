import {createRequire} from 'node:module';
import {taskCompleteOutputSchema} from '../../src/contracts/prompts.ts';
import {deliberationOutputSchema} from '../../src/daemon/deliberationRunner.ts';
import { describe, expect, it } from 'vitest';
import { coordinationCallAvailable, validateCoordinationPlan } from '../../src/contracts/coordination.ts';

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
