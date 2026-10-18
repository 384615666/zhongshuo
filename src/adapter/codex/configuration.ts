import { readFileSync, existsSync,statSync } from 'node:fs';
import {createHash} from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

interface TomlFacts {
  scalars: Map<string, string>;
  unsupportedTable: boolean;
}

function parseTomlKeyPath(raw: string): string[] | null {
  const parts: string[] = [];
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index]!)) index++;
    if (index >= raw.length) return null;
    let part = '';
    const quote = raw[index] === '"' || raw[index] === "'" ? raw[index] : null;
    if (quote != null) {
      index++;
      let closed = false;
      while (index < raw.length) {
        let char = raw[index++]!;
        if (char === quote) { closed = true; break; }
        if (quote === '"' && char === '\\') {
          if (index >= raw.length) return null;
          char = raw[index++]!;
        }
        part += char;
      }
      if (!closed || part.length === 0) return null;
    } else {
      const start = index;
      while (index < raw.length && /[A-Za-z0-9_-]/.test(raw[index]!)) index++;
      if (index === start) return null;
      part = raw.slice(start, index);
    }
    parts.push(part);
    while (index < raw.length && /\s/.test(raw[index]!)) index++;
    if (index >= raw.length) return parts;
    if (raw[index] !== '.') return null;
    index++;
  }
  return null;
}

/** Conservative TOML subset for root scalars and table paths. Quoted table keys are supported;
 * unsupported syntax is surfaced instead of leaving a stale section that can select another profile. */
function parseTomlFacts(text: string): TomlFacts {
  const scalars = new Map<string, string>();
  let section = '';
  let unsupportedTable = false;
  for (const line of text.split(/\r?\n/)) {
    const arrayTable = /^\s*\[\[(.+?)\]\]\s*(?:#.*)?$/.exec(line);
    if (arrayTable) {
      const path = parseTomlKeyPath(arrayTable[1]!);
      if (path == null) {
        unsupportedTable = true;
        section = '';
      } else {
        section = path.join('.');
      }
      continue;
    }
    const table = /^\s*\[(.+?)\]\s*(?:#.*)?$/.exec(line);
    if (table) {
      const path = parseTomlKeyPath(table[1]!);
      if (path == null) {
        unsupportedTable = true;
        section = '';
      } else {
        section = path.join('.');
      }
      continue;
    }
    const scalar = /^\s*([\w-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)'|(true|false))\s*(?:#.*)?$/.exec(line);
    if (scalar) scalars.set(`${section}:${scalar[1]}`, scalar[2] ?? scalar[3] ?? scalar[4]!);
  }
  return { scalars, unsupportedTable };
}

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
    const { scalars, unsupportedTable } = parseTomlFacts(text);
    if (unsupportedTable) return 'Codex 配置含尚未核实的表头，有效渠道需 CLI 核实';
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

export interface CodexDefaultMetadata {
  model: string | null;
  effort: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max' | null;
  provider: string | null;
  reason: string | null;
}

/** Read the effective global model when no project-level Codex override can change it.
 * Only root/profile metadata is returned; credentials and provider environment stay private. */
export function resolveCodexDefaultMetadata(cwd: string): CodexDefaultMetadata {
  let text: string;
  try {
    const userHome = resolve(homedir());
    const home = resolve(process.env.CODEX_HOME ?? join(userHome, '.codex'));
    const globalPath = join(home, 'config.toml');
    const stat = statSync(globalPath);
    if (stat.size > 1024 * 1024) return { model: null, effort: null, provider: null, reason: 'Codex 全局配置超过有界读取范围' };
    text = readFileSync(globalPath, 'utf8');
    for (let folder = resolve(cwd); ; folder = dirname(folder)) {
      const candidate = join(folder, '.codex', 'config.toml');
      if (folder !== userHome && candidate !== globalPath && existsSync(candidate)) {
        return { model: null, effort: null, provider: null, reason: '项目 Codex 配置可能覆盖全局默认，需由 CLI 核实' };
      }
      if (dirname(folder) === folder) break;
    }
  } catch {
    return { model: null, effort: null, provider: null, reason: 'Codex 全局配置不可读' };
  }
  const { scalars, unsupportedTable } = parseTomlFacts(text);
  if (unsupportedTable) return { model: null, effort: null, provider: null, reason: 'Codex 全局配置含尚未核实的表头，需由 CLI 核实' };
  const profile = scalars.get(':profile');
  const profilePrefix = profile != null ? `profiles.${profile}:` : '';
  const model = scalars.get(`${profilePrefix}model`) ?? scalars.get(':model') ?? null;
  const effortValue = scalars.get(`${profilePrefix}model_reasoning_effort`) ?? scalars.get(':model_reasoning_effort') ?? null;
  const effort = effortValue != null && ['none','minimal','low','medium','high','xhigh','max'].includes(effortValue)
    ? effortValue as CodexDefaultMetadata['effort']
    : null;
  const provider = scalars.get(`${profilePrefix}model_provider`) ?? scalars.get(':model_provider') ?? null;
  return {
    model: model != null && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/.test(model) && !model.startsWith('sk-') ? model : null,
    effort,
    provider,
    reason: model == null ? 'Codex 全局配置未声明可识别的默认模型' : null,
  };
}
