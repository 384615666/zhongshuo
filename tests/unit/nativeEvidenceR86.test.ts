import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
const require=createRequire(import.meta.url);
const {ownedEvidenceRoot,nativeDelegation,nodeTestCommand,tapPassed,fileRead,fileChangePaths}=require('../../scripts/lib/r86-native-evidence.cjs');
describe('R86 native evidence rejects unrelated or self-reported proof',()=>{
 it('keeps absolute repository evidence boundary',()=>{expect(ownedEvidenceRoot('D:\\repo\\dist\\review-r86-own','D:\\repo\\dist')).toBe(true);expect(ownedEvidenceRoot('D:\\else\\review-r86-own','D:\\repo\\dist')).toBe(false);});
 it('recognizes namespaced delegation',()=>{for(const name of ['Task','functions.spawn_agent','mcp__x.Task','mcp__x__Task','functions.send_input'])expect(nativeDelegation(name)).toBe(true);expect(nativeDelegation('Get-Content')).toBe(false);});
 it('requires actual Node test runner and corresponding test file',()=>{expect(nodeTestCommand('node --test greeting.test.mjs',['greeting.test.mjs'])).toBe(true);for(const c of ['node -e "console.log(\'greeting.test.mjs\')"','echo node --test greeting.test.mjs','node --test unrelated.mjs'])expect(nodeTestCommand(c,['greeting.test.mjs'])).toBe(false);});
 it('requires positive TAP tests/pass and zero failures',()=>{expect(tapPassed('# tests 3\n# pass 3\n# fail 0')).toBe(true);expect(tapPassed('ℹ tests 3\nℹ pass 3\nℹ fail 0')).toBe(true);for(const text of ['passed','tests 3 pass 3','# tests 0\n# pass 0\n# fail 0','# tests 2\n# pass 1\n# fail 1'])expect(tapPassed(text)).toBe(false);});
 it('binds source read to path and frozen file contents',()=>{const f=[{path:'greeting.mjs',content:'export const greet=1;',sha256:'h',deliveryId:'d',revision:1,manifestHash:'m'}];expect(fileRead('cat greeting.mjs','export const greet=1;',f)).toHaveLength(1);expect(fileRead('cat AGENTS.md','export const greet=1;',f)).toHaveLength(0);expect(fileRead('cat greeting.mjs','old version',f)).toHaveLength(0);});
});

it('reads native FileChange keyed-map and array without reporting outside paths or code bodies',()=>{expect(fileChangePaths({'D:\\own\\greeting.mjs':{diff:'private-body'},'D:\\else\\secret':{}},'D:\\own')).toEqual(['greeting.mjs']);expect(fileChangePaths([{path:'greeting.test.mjs'}],'D:\\own')).toEqual(['greeting.test.mjs']);});
