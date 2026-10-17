import {afterEach,describe,expect,it,vi} from 'vitest';
import * as configuration from '../../src/adapter/claude/configuration.ts';
import {claudeModelCatalog} from '../../src/daemon/runtimeCatalog.ts';
function configured(reason:string|null=null){
  vi.spyOn(configuration,'resolveClaudeConfiguration').mockReturnValue({env:{},restrictedEnv:{ANTHROPIC_BASE_URL:'https://fixture.invalid/v1',ANTHROPIC_AUTH_TOKEN:'fixture-secret-never-return',ANTHROPIC_MODEL:'configured-model'},configuredModel:'settings-model',configDir:'isolated',cwd:'isolated',endpointHash:'isolated',channel:'https://fixture.invalid/v1',endpointSource:'isolated',sources:[],reason,configurationKey:'isolated'});
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('R87 actual channel model metadata, zero inference',()=>{
  it('uses only the configured endpoint and exact reported IDs, without returning credentials or confusing configuration with support',async()=>{
    configured();const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{id:'deepseek-flash',display_name:'DeepSeek Flash'},{id:'sk-do-not-return'},{id:'bad model'}]})));
    vi.stubGlobal('fetch',fetcher);const result=await claudeModelCatalog('isolated');
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://fixture.invalid/v1/models');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({method:'GET',redirect:'error',headers:{Authorization:'Bearer fixture-secret-never-return'}});
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty('body');
    expect(result.models).toEqual([{id:'configured-model',label:'configured-model',source:'configured'},{id:'settings-model',label:'settings-model',source:'configured'},{id:'deepseek-flash',label:'DeepSeek Flash',source:'reported'}]);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');expect(JSON.stringify(result)).not.toContain('sk-do-not-return');
  });
  it('does not contact an uncertain effective provider, or pretend configured model hints are a discovered catalog',async()=>{
    configured('项目覆盖尚不能核实');const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const result=await claudeModelCatalog('isolated');expect(fetcher).not.toHaveBeenCalled();expect(result.warning).toContain('有效渠道尚不能确定');expect(result.models.every(m=>m.source==='configured')).toBe(true);
  });
  it.each([401,429,500])('preserves configured choices after metadata HTTP %s, without returning upstream error bodies',async status=>{
    configured();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('fixture-secret-never-return',{status})));
    const result=await claudeModelCatalog('isolated');expect(result.warning).toContain(`HTTP ${status}`);expect(result.models).toHaveLength(2);expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
  it('rejects oversized metadata and marks a bounded page as partial',async()=>{
    configured();const fetcher=vi.fn().mockResolvedValueOnce(new Response('x',{headers:{'content-length':'524289'}})).mockResolvedValueOnce(new Response(JSON.stringify({data:[{id:'actual-model'}],has_more:true})));
    vi.stubGlobal('fetch',fetcher);expect((await claudeModelCatalog('isolated')).warning).toContain('上限');
    expect(await claudeModelCatalog('isolated')).toMatchObject({truncated:true,models:expect.arrayContaining([{id:'actual-model',label:'actual-model',source:'reported'}])});
  });
});
