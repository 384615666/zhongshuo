import {describe,expect,it} from 'vitest';
import {runtimeModelDisplayName,runtimeModelPickerOptions,type RuntimeModelMetadata} from '../../src/ui/hifi/lib/format.ts';

describe('R90 runtime model display',()=>{
  it('shows the display name once while preserving each full model ID as the option value',()=>{
    const models:RuntimeModelMetadata[]=[
      {id:'gpt-6-luna',label:'GPT-6-Luna',source:'reported'},
      {id:'ccs-new/glm-5.3-flash',label:'glm-5.3-flash (new)',source:'reported'},
    ];
    const options=runtimeModelPickerOptions(models,{channelFallback:'codex'});
    expect(options).toEqual([
      {value:'gpt-6-luna',label:'GPT-6-Luna'},
      {value:'ccs-new/glm-5.3-flash',label:'glm-5.3-flash (new)'},
    ]);
    expect(options[0]!.label).not.toContain(options[0]!.value);
    expect(options[1]!.label).not.toContain(options[1]!.value);
    expect(options[1]!.value).toBe('ccs-new/glm-5.3-flash');
    expect(runtimeModelDisplayName({id:'gpt-6-luna',label:'GPT-6-Luna · gpt-6-luna'})).toBe('GPT-6-Luna');
  });

  it('uses a short channel only when readable names collide',()=>{
    const models:RuntimeModelMetadata[]=[
      {id:'ccs-new/luna-shared',label:'Luna',source:'reported'},
      {id:'luna-shared',label:'Luna',source:'reported'},
    ];
    expect(runtimeModelPickerOptions(models,{channelFallback:'codex'})).toEqual([
      {value:'ccs-new/luna-shared',label:'Luna · ccs-new'},
      {value:'luna-shared',label:'Luna · codex'},
    ]);
  });

  it('keeps an unrecognized saved ID intact without printing it in the normal label',()=>{
    expect(runtimeModelPickerOptions([],{currentValue:'ccs-new/deepseek-flash',channelFallback:'claude'})).toEqual([
      {value:'ccs-new/deepseek-flash',label:'deepseek-flash'},
    ]);
    expect(runtimeModelDisplayName({id:'ccs-new/deepseek-flash',label:'ccs-new/deepseek-flash'})).toBe('deepseek-flash');
    expect(runtimeModelDisplayName({id:'',label:''})).toBe('未命名模型');
  });
});
