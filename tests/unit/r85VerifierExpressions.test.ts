import {it,expect} from 'vitest';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
it('R85 release verifier browser expressions compile after string-literal decoding',()=>{
 const source=ts.createSourceFile('verifier.cjs',readFileSync(new URL('../../scripts/verify-r85-daily-extension.cjs',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let count=0;
 function visit(node:ts.Node){if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='eval'){
   const first=node.arguments[0];if(first&&(ts.isStringLiteral(first)||ts.isNoSubstitutionTemplateLiteral(first))){count++;expect(()=>new Function(first.text),`browser expression at ${source.getLineAndCharacterOfPosition(first.pos).line+1}`).not.toThrow();}
 }ts.forEachChild(node,visit);}visit(source);expect(count).toBeGreaterThan(30);
});
