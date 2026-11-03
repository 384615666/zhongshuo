import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {buildLineDiff,compactDiff,diffLines} from '../../src/ui/hifi/lib/textDiff';
import {DiffText} from '../../src/ui/hifi/preview/DiffText';
const render=(left:string|null,right:string|null)=>renderToStaticMarkup(createElement(DiffText,{left,right,leftLabel:'修改前',rightLabel:'修改后'}));

describe('R172 bounded, empty-aware file diffs',()=>{
  it.each([['','新增正文\n','add'],['删除正文\n','','del']] as const)('renders known empty versions as complete coloured differences (%s)',(left,right,kind)=>{
    const html=render(left,right);expect(html).not.toContain('不具备完整比较内容');
    expect(html).toContain(`preview-diff-row ${kind}`);expect(html).toContain((left||right).trim());
    expect(diffLines(left,right)).toHaveLength(1);
  });
  it('does not invent a blank line for an empty file',()=>{
    expect(diffLines('','')).toEqual([]);expect(render('','')).toContain('两个版本均为空');
  });
  it('retains available text when the other snapshot is unknown',()=>{
    const html=render(null,'已知正文');expect(html).toContain('不具备完整比较内容');expect(html).toContain('已知正文');
  });
  it('preserves line numbers and exact results for an ordinary modification',()=>{
    expect(diffLines('same\nold\nend','same\nnew\nend')).toEqual([
      {type:'same',text:'same',leftNo:1,rightNo:1},{type:'del',text:'old',leftNo:2},
      {type:'add',text:'new',rightNo:2},{type:'same',text:'end',leftNo:3,rightNo:3}]);
  });
  it('handles a change after 20000 unchanged lines without quadratic storage or hiding the change',()=>{
    const text=Array.from({length:20000},(_,i)=>'line '+i).join('\n');
    const diff=buildLineDiff(text,text+'\nchanged');expect(diff.mode).toBe('exact');
    expect(diff.added).toBe(1);expect(diff.removed).toBe(0);
    expect(compactDiff(diff.lines).length).toBeLessThan(12);
    const html=render(text,text+'\nchanged');expect(html).toContain('changed');expect(html).toContain('省略');
  });
  it('uses an explicit block fallback for unrelated long files, preserving both source texts',()=>{
    const left=Array.from({length:6000},(_,i)=>'old '+i).join('\n'),right=left.replaceAll('old','new');
    const diff=buildLineDiff(left,right);expect(diff.mode).toBe('blocks');expect(diff.added).toBe(6000);expect(diff.removed).toBe(6000);
    expect(diff.lines.filter(line=>line.type!=='add').map(line=>line.text).join('\n')).toBe(left);
    expect(diff.lines.filter(line=>line.type!=='del').map(line=>line.text).join('\n')).toBe(right);
    const html=render(left,right);expect(html).toContain('按整段');expect(html).toContain('显示更多');
    expect((html.match(/class="preview-diff-row /g)??[])).toHaveLength(500);
  });
  it('does not compute a diff or render unbounded content above the file limit',()=>{
    const huge='x'.repeat(1_100_000);expect(buildLineDiff(huge,'old').mode).toBe('large');
    const html=render(huge,'old');expect(html).toContain('文件较大');expect(html.length).toBeLessThan(130000);expect(html).toContain('old');
  });
  it('reconstructs both original versions from the exact edit script',()=>{
    const samples=['a','b','a\nb','b\na','a\na\nb','b\nb\na',''];
    for(const left of samples)for(const right of samples){
      const lines=diffLines(left,right);
      expect(lines.filter(line=>line.type!=='add').map(line=>line.text).join('\n')).toBe(left);
      expect(lines.filter(line=>line.type!=='del').map(line=>line.text).join('\n')).toBe(right);
    }
  });
});
