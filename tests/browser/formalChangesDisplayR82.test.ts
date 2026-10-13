import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ChangeSnapshot} from '../../src/contracts/changeSnapshot';
const state=vi.hoisted(()=>({values:[] as unknown[]}));
vi.mock('react',async()=>({...await vi.importActual<typeof import('react')>('react'),useState:()=>[state.values.shift(),vi.fn()]}));
import {FormalChangeDetail} from '../../src/ui/hifi/components/FormalChanges';
const entry={changeSetId:'cs',taskId:'t',taskTitle:'正式任务',applicationStatus:'applied',beforeRef:'b',afterRef:'a',locate:'#task=t'};
const snapshot:ChangeSnapshot={projectId:'p',taskId:'t',changeSetId:'cs',applicationStatus:'applied',files:[{path:'说明.md',change:'modified',beforeHash:'before',afterHash:'after'}],truncated:false};
beforeEach(()=>{state.values=[];});
describe('formal change snapshot reading states',()=>{
  it('metadata is safely readable before any file is selected or content provided',()=>{state.values=[snapshot,null,undefined,0];const html=renderToStaticMarkup(createElement(FormalChangeDetail,{projectId:'p',entry}));expect(html).toContain('说明.md');expect(html).toContain('before');expect(html).not.toContain('data-zs-change-content');});
  it('confirmed before/after text is rendered only for the selected path',()=>{const content={path:'说明.md',before:{text:'REAL V1',reason:null},after:{text:'REAL V2',reason:null}};state.values=[{...snapshot,content},null,'说明.md',0];const html=renderToStaticMarkup(createElement(FormalChangeDetail,{projectId:'p',entry}));expect(html).toContain('REAL V1');expect(html).toContain('REAL V2');state.values=[{...snapshot,content},'读取失败','另一文件.md',0];const other=renderToStaticMarkup(createElement(FormalChangeDetail,{projectId:'p',entry}));expect(other).not.toContain('REAL V1');expect(other).toContain('读取失败');});
});
