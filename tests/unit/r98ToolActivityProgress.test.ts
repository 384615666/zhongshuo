import {describe,expect,it} from 'vitest';
import {
  runtimeToolAction,
  runtimeToolResultSummary,
  runtimeToolSummary,
  safeRuntimeToolTarget,
} from '../../src/contracts/runtimeProgress.ts';

describe('R98 normalized tool activity',()=>{
  it.each([
    ['Read','read'],
    ['read_file','read'],
    ['WebFetch','read'],
    ['Grep','search'],
    ['Glob','search'],
    ['web_search','search'],
    ['Bash','command'],
    ['commandExecution','command'],
    ['Write','edit'],
    ['MultiEdit','edit'],
    ['fileChange','edit'],
    ['StructuredOutput','other'],
  ] as const)('classifies %s as %s',(name,action)=>{
    expect(runtimeToolAction(name)).toBe(action);
  });

  it('keeps Claude command parameters while redacting credentials and bounding output',()=>{
    const summary=runtimeToolSummary('Bash',{
      command:'curl "https://example.test/?token=query-secret" --password cli-secret Authorization: Bearer bearer-secret',
      cwd:'D:\\work\\repo',
      timeout:120000,
    },{cwd:'D:\\work\\repo'});
    const serialized=JSON.stringify(summary);
    expect(summary.action).toBe('command');
    expect(summary.target).toContain('curl');
    expect(summary.argumentsSummary).toContain('timeout');
    expect(serialized).not.toContain('query-secret');
    expect(serialized).not.toContain('cli-secret');
    expect(serialized).not.toContain('bearer-secret');
    expect(summary.argumentsSummary.length).toBeLessThanOrEqual(480);
  });

  it('extracts every fileChange target without persisting patch bodies',()=>{
    const summary=runtimeToolSummary('fileChange',{
      changes:[
        {path:'D:\\work\\repo\\docs\\需求.md',kind:'update',diff:'PRIVATE_DIFF_ONE'},
        {path:'D:\\work\\repo\\src\\work.ts',kind:'add',diff:'PRIVATE_DIFF_TWO'},
        {path:'D:\\outside\\notes.md',kind:'delete',diff:'PRIVATE_DIFF_THREE'},
      ],
    },{cwd:'D:\\work\\repo'});
    const serialized=JSON.stringify(summary);
    expect(summary.action).toBe('edit');
    expect(summary.target).toContain('docs/需求.md');
    expect(summary.target).toContain('src/work.ts');
    expect(summary.target).toContain('notes.md');
    expect(summary.argumentsSummary).toContain('docs/需求.md');
    expect(serialized).not.toContain('PRIVATE_DIFF');
  });

  it('drops edit bodies, retains count/path facts, and redacts failure detail',()=>{
    const edit=runtimeToolSummary('Edit',{
      file_path:'D:\\work\\repo\\src\\a.ts',
      old_string:'PRIVATE_OLD',
      new_string:'PRIVATE_NEW',
      replace_all:true,
    },{cwd:'D:\\work\\repo'});
    expect(edit.action).toBe('edit');
    expect(edit.target).toBe('src/a.ts');
    expect(edit.argumentsSummary).toContain('replace_all');
    expect(JSON.stringify(edit)).not.toContain('PRIVATE_');
    const failure=runtimeToolResultSummary({
      content:[{type:'text',text:'permission denied token=result-secret'}],
    });
    expect(failure).toContain('permission denied');
    expect(failure).not.toContain('result-secret');
  });

  it('does not expose absolute user-directory prefixes outside the workspace',()=>{
    expect(safeRuntimeToolTarget('/home/alice/private/report.md','/home/alice/private/work'))
      .toBe('report.md');
  });
});
