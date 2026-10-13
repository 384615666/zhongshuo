import { readFileSync, existsSync,statSync } from 'node:fs';
import {createHash} from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
/** Conservative invalidation of local source changes; not a capability certification. */
export function codexConfigurationIdentity(cwd:string) {
  const home=resolve(process.env.CODEX_HOME??join(homedir(),'.codex'));
  const paths=new Set([join(home,'config.toml')]);
  let folder=resolve(cwd);
  for(let n=0;n<64;n++) {paths.add(join(folder,'.codex','config.toml'));if(dirname(folder)===folder)break;folder=dirname(folder);if(n===63)throw Error('Codex 配置层级超出检查范围');}
  const facts=[...paths].map(p=>{try{const st=statSync(p);if(st.size>1048576)throw Error('配置超过有界读取范围');return [p,createHash('sha256').update(readFileSync(p)).digest('hex')];}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return[p,'absent'];throw e;}});
  const env=Object.entries(process.env).filter(([k])=>/^(CODEX_|OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/.test(k)).sort(([a],[b])=>a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify({home,cwd:resolve(cwd),facts,env})).digest('hex');
}

/** Display-only, conservative local TOML subset. Never infers vision/entitlement from configuration. */
export function codexChannelDescription(cwd: string) {
  try {
    const text = readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8');
    let section = ''; const scalars = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const table = line.match(/^\s*\[([\w.-]+)\]\s*(?:#.*)?$/);
      if (table) { section = table[1]!; continue; }
      const scalar = line.match(/^\s*([\w-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)'|(true|false))\s*(?:#.*)?$/);
      if (scalar) scalars.set(`${section}:${scalar[1]}`, scalar[2] ?? scalar[3] ?? scalar[4]!);
    }
    const provider = scalars.get(':model_provider');
    if (provider == null || scalars.has(':profile')) return '无法确定 Codex 有效 provider（默认或 profile 覆盖需 CLI 核实）';
    for (let folder = resolve(cwd); ; folder = dirname(folder)) {
      if (existsSync(join(folder, '.codex', 'config.toml'))) return `${provider}（存在项目配置覆盖，有效渠道需 CLI 核实）`;
      if (dirname(folder) === folder) break;
    }
    const base = scalars.get(`model_providers.${provider}:base_url`);
    let address = '默认地址由登录方式决定';
    if (base != null) { const u = new URL(base); address = u.origin + u.pathname; }
    return `${provider} · ${scalars.get(`model_providers.${provider}:wire_api`) ?? '协议需 CLI 核实'} · ${address}`;
  } catch { return 'Codex 配置不可读或有效渠道无法确定'; }
}
