import {describe, expect, it} from 'vitest';
import {spawnSync} from 'node:child_process';

function parseVersions(versions: string[]) {
  const script=`import {releaseVersion} from './scripts/make-windows-installer.mjs';
    const inputs=${JSON.stringify(versions)};
    console.log(JSON.stringify(inputs.map(version=>{try{return releaseVersion(version);}catch{return {rejected:true};}})));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true,timeout:15000});
  expect(result.status,result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Array<{version?:string;numericVersion?:string;rejected?:boolean}>;
}
describe('R148/R150 Windows stable release versions',()=>{
  it('orders stable 0.1.2 above older releases and its betas without changing public SemVer',()=>{
    const [beta0,beta3,lastBeta,previousStable,stable,next]=parseVersions(['0.1.2-beta.0','0.1.2-beta.3','0.1.2-beta.65534','0.1.1','0.1.2','0.1.3-beta.0']);
    expect(beta0).toEqual({version:'0.1.2-beta.0',numericVersion:'0.1.2.0'});
    expect(beta3?.numericVersion).toBe('0.1.2.3');
    expect(previousStable).toEqual({version:'0.1.1',numericVersion:'0.1.1.65535'});
    expect(stable).toEqual({version:'0.1.2',numericVersion:'0.1.2.65535'});
    const ordered=[beta3,lastBeta,stable,next].map(item=>BigInt('0x'+item!.numericVersion!.split('.').map(part=>Number(part).toString(16).padStart(4,'0')).join('')));
    for(let i=1;i<ordered.length;i++)expect(ordered[i]!>ordered[i-1]!).toBe(true);
  });
  it('uses the current core version for beta shorthand',()=>{
    expect(parseVersions(['beta.1'])[0]).toEqual({version:'1.0.0-beta.1',numericVersion:'1.0.0.1'});
  });
  it('rejects invalid or ambiguous versions instead of creating misleading installer metadata',()=>{
    const versions=['0.1','v0.1.0','00.1.0','0.1.0-beta.-1','0.1.0-beta.65535','65536.0.0','0.1.0-rc.1','0.1.0.4','0.1.0-beta.01'];
    expect(parseVersions(versions).every(item=>item.rejected)).toBe(true);
  });
});
