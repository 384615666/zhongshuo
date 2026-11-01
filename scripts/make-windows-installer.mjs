/** Current-user Inno Setup delivery. Never installs/runs the app or edits deps. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageUserGuideAssets, renderUserGuide } from './package-user-guide.mjs';
import { brandIco, brandIconName } from './lib/brand-icon.mjs';
import { brandWindowsExecutable, windowsExecutableBrand } from './lib/brand-executable.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const configDir = join(repo, 'packaging/windows');
const release = JSON.parse(readFileSync(join(configDir, 'release.json'), 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
const json = (target, value) => writeFileSync(target, JSON.stringify(value, null, 2) + '\n', 'utf8');

export function releaseVersion(input = release.version) {
  // beta.N shorthand follows the current stable core (e.g. 0.1.1-beta.N after a 0.1.1 bump).
  const version = input.startsWith('beta.') ? `${release.version.split('-')[0]}-${input}` : input;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(version);
  if (!match || match.slice(1,4).some(part => Number(part) > 65535)
    || match[4] != null && Number(match[4]) >= 65535) throw Error('Version must be X.Y.Z or X.Y.Z-beta.N (or beta.N); core parts <= 65535, beta number < 65535');
  // A stable release must compare higher than every beta of the same core in
  // Windows' four-part file versions, while keeping its visible SemVer intact.
  return {version, numericVersion: [...match.slice(1,4),match[4]??'65535'].map(Number).join('.')};
}

function listFiles(root) {
  const output = [];
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name), info = lstatSync(full);
    if (info.isSymbolicLink()) throw Error(`Payload symlink/junction is not allowed: ${name}`);
    if (info.isDirectory()) output.push(...listFiles(full));
    else if (info.isFile()) output.push(full);
    else throw Error(`Unsupported payload entry: ${name}`);
  }
  return output;
}

export function inspectFuse(executable) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const bytes = readFileSync(executable), offset = bytes.indexOf(sentinel);
  if (offset < 0 || bytes.indexOf(sentinel, offset + 1) >= 0) throw Error('Expected exactly one Electron Windows fuse sentinel');
  const start = offset + sentinel.length;
  if (bytes[start] !== 1 || bytes[start + 1] < 1 || start + 2 + bytes[start + 1] > bytes.length) throw Error('Unsupported Electron fuse schema');
  const wire = bytes.subarray(start + 2, start + 2 + bytes[start + 1]);
  if (![...wire].every(value => [0x30, 0x31, 0x72].includes(value))) throw Error('Unsupported Electron fuse state');
  return {offset: start + 2, version: 1, wire: wire.toString('ascii'), runAsNode: wire[0] === 0x31};
}

export function disableRunAsNode(executable) {
  // Documented Electron fuse V1 wire: index 0 = RunAsNode, ASCII 0 = disabled.
  // Patch only this byte in the private installer copy, before manifest/signing.
  const before = inspectFuse(executable);
  if (!['0', '1'].includes(before.wire[0])) throw Error('RunAsNode fuse was removed; cannot enforce installed bootstrap');
  const fd = openSync(executable, 'r+');
  try {writeSync(fd, Buffer.from('0'), 0, 1, before.offset);} finally {closeSync(fd);}
  const after = inspectFuse(executable);
  assert.equal(after.runAsNode, false); assert.equal(after.wire.slice(1), before.wire.slice(1));
  return {schemaVersion: 1, runAsNode: false, otherFusesUnchanged: true};
}

export { brandIco } from './lib/brand-icon.mjs';

function verifyManifest(root) {
  const build=JSON.parse(readFileSync(join(root,'BUILD.json'),'utf8'));
  const manifest=JSON.parse(readFileSync(join(root,'MANIFEST-SHA256.json'),'utf8'));
  assert.equal(build.buildId,manifest.buildId,'BUILD/MANIFEST identity differs');
  const actual=listFiles(root).map(file=>relative(root,file).replaceAll('\\','/')).filter(file=>!['BUILD.json','MANIFEST-SHA256.json'].includes(file)).sort();
  const listed=manifest.files.map(file=>file.path).sort();assert.deepEqual(actual,listed,'Manifest must cover every payload file');
  for(const file of manifest.files){const full=resolve(root,file.path);assert.ok(full.startsWith(resolve(root)+sep));assert.equal(statSync(full).size,file.bytes);assert.equal(sha(readFileSync(full)),file.sha256,`Hash mismatch: ${file.path}`);}
  return build;
}

function privacyCheck(root) {
  const sensitiveName=/(^|\/)(?:server-data|\.git|\.codex|\.claude|\.pi|\.dsh|logs|data|sessions|skills)(\/|$)|(^|\/)(?:auth|credentials|secrets|data-location|pipe-name|daemon-pid)\.(?:json|txt)$|\.(?:sqlite(?:-wal|-shm)?|db|pem|key|log)$|(^|\/)\.env(?:\.|$)/i;
  const privatePath=/(?:[A-Z]:[\\/]+Users[\\/]+(?:LSJ|Administrator)(?:[\\/]|\b)|[A-Z]:\\\\Users\\\\(?:LSJ|Administrator)|D:[\\/]+zhongshuo(?:-public)?(?:[\\/]|\b))/i;
  for(const file of listFiles(root)){
    const name=relative(root,file).replaceAll('\\','/');if(sensitiveName.test(name))throw Error(`User/runtime data must not enter installer: ${name}`);
    if(/\.(?:json|[cm]?js|md|txt|html|cmd|vbs|ps1|css|svg)$/i.test(name)&&statSync(file).size<40*1024*1024){
      const content=readFileSync(file,'utf8');if(privatePath.test(content))throw Error(`Local developer path found in payload: ${name}`);
      if(/\bsk-[A-Za-z0-9_-]{24,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))throw Error(`Credential-like content in payload: ${name}`);
    }
  }
}

function stampImage(root, sourceBuild, metadata) {
  const files=listFiles(root).filter(file=>!['BUILD.json','MANIFEST-SHA256.json'].includes(relative(root,file).replaceAll('\\','/')))
    .map(file=>({path:relative(root,file).replaceAll('\\','/'),bytes:statSync(file).size,sha256:sha(readFileSync(file))}));
  const buildId=`bld_${sha(JSON.stringify({sourceBuildId:sourceBuild.buildId,metadata,files})).slice(0,16)}`;
  json(join(root,'BUILD.json'),{buildId,commit:sourceBuild.commit,dirty:sourceBuild.dirty,dirtyDiffHash:sourceBuild.dirtyDiffHash,
    sourceBuildId:sourceBuild.buildId,builtAt:new Date().toISOString(),distribution:'windows-installer',version:metadata.version,
    manifest:'MANIFEST-SHA256.json',manifestRoot:'Paths relative to this BUILD.json; SHA256'});
  json(join(root,'MANIFEST-SHA256.json'),{buildId,files});verifyManifest(root);return {buildId,files:files.length};
}

function parseArgs(argv) {
  const options={};
  const flags=new Set(['--skip-build','--prepare-only','--validate-template','--stage-only']);
  const values=new Set(['--version','--source-image','--image','--output-dir','--iscc','--app-mutex']);
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];if(flags.has(arg))options[arg]=true;
    else if(values.has(arg)){const value=argv[++i];if(!value||value.startsWith('--'))throw Error(`Missing ${arg} value`);options[arg]=value;}
    else if(arg==='--help')options.help=true;else throw Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function compilerPath(override) {
  if(override)return resolve(override);
  const candidates=[process.env.ISCC_EXE,process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,'Programs/Inno Setup 6/ISCC.exe'),
    process.env['ProgramFiles(x86)']&&join(process.env['ProgramFiles(x86)'],'Inno Setup 6/ISCC.exe'),process.env.ProgramFiles&&join(process.env.ProgramFiles,'Inno Setup 6/ISCC.exe')].filter(Boolean);
  const found=candidates.find(existsSync);if(!found)throw Error('Inno Setup 6 compiler not found; use --iscc <ISCC.exe>');return found;
}

export async function makeInstaller(argv=process.argv.slice(2)) {
  const options=parseArgs(argv);
  if(options.help){console.log('node scripts/make-windows-installer.mjs [--version X.Y.Z|X.Y.Z-beta.N|beta.N] [--skip-build] [--source-image DIR] [--output-dir DIR] [--prepare-only|--validate-template|--stage-only] [--iscc EXE] [--app-mutex NATIVE_NAME]');return;}
  const version=releaseVersion(options['--version']);
  const work=join(repo,'dist/windows-installer',version.version);mkdirSync(work,{recursive:true});
  const iconBytes=brandIco(),iconName=brandIconName(iconBytes);
  const icon=join(work,iconName);writeFileSync(icon,iconBytes);
  const output=resolve(options['--output-dir']??join(repo,'dist/installers'));mkdirSync(output,{recursive:true});
  const sourceImage=resolve(options['--source-image']??options['--image']??join(repo,'dist/desktop/众说-便携-win-x64'));
  const compiler=compilerPath(options['--iscc']);
  const appMutex=options['--app-mutex'];if(appMutex&&!/^(?:Local\\|Global\\)?[A-Za-z0-9._-]+$/.test(appMutex))throw Error('Invalid native app mutex name');
  const baseName=`Zhongshuo-Setup-${version.version}-x64`;
  const plan={schemaVersion:1,...release,...version,sourceImage,output:join(output,`${baseName}.exe`),appMutex:appMutex??null,
    installDirectory:'localAppData/Programs/Zhongshuo',dataDirectory:'localAppData/Zhongshuo/data',silentAutoRun:false,icon,
    compiler,buildScripts:['build-ui.mjs','pack-daemon.mjs','pack-desktop.mjs']};
  json(join(work,'build-plan.json'),plan);
  if(options['--prepare-only']){console.log(JSON.stringify(plan,null,2));return plan;}
  const validation=!!options['--validate-template'];
  let image,build;
  if(validation){
    image=mkdtempSync(join(work,'syntax-image-'));writeFileSync(join(image,'Zhongshuo.exe'),'NON-EXECUTABLE TEMPLATE COMPILE FIXTURE\n');
    cpSync(join(repo,'LICENSE'),join(image,'LICENSE'));writeFileSync(join(image,'安装说明.txt'),'模板编译夹具，请勿安装。','utf8');
  }else{
    if(!options['--skip-build']&&!options['--source-image']&&!options['--image'])for(const script of plan.buildScripts){
      const child=spawnSync(process.execPath,[join(repo,'scripts',script)],{cwd:repo,stdio:'inherit',windowsHide:true});if(child.status!==0)throw Error(`Build failed: ${script} (${child.status})`);
    }
    const original=verifyManifest(sourceImage);
    assert.ok(existsSync(join(sourceImage,'electron.exe')),'Expected a portable source image with electron.exe');
    privacyCheck(sourceImage);
    image=mkdtempSync(join(work,'image-'));cpSync(sourceImage,image,{recursive:true});
    renameSync(join(image,'electron.exe'),join(image,release.executable));
    const branded=brandWindowsExecutable(join(image,release.executable),icon,windowsExecutableBrand({...release,...version},release.executable));
    const {Version:nativeVersion,...nativeIcon}=branded;
    const fuses=disableRunAsNode(join(image,release.executable));
    const appDir=join(image,'resources/app');
    const metadata={...release,...version,executable:release.executable,icon:iconName,nativeIcon,nativeVersion,fuses};
    json(join(appDir,'installed-desktop.json'),metadata);
    const pkg=JSON.parse(readFileSync(join(appDir,'package.json'),'utf8'));
    json(join(appDir,'package.json'),{...pkg,version:version.version,productName:release.productName,description:'众说——本地多 Agent 协同工作台'});
    cpSync(icon,join(appDir,iconName));cpSync(join(repo,'logo.png'),join(appDir,'logo.png'));
    if(existsSync(join(image,'LICENSE')))renameSync(join(image,'LICENSE'),join(image,'LICENSE-electron.txt'));
    cpSync(join(repo,'LICENSE'),join(image,'LICENSE'));
    const nativeLicense=join(dirname(process.execPath),'LICENSE');
    const nodeLicense=existsSync(nativeLicense)?nativeLicense:join(configDir,'Node-LICENSE.txt');
    if(!existsSync(nativeLicense)&&process.version!=='v24.16.0')throw Error('Update packaged Node license to match build Node version');
    cpSync(nodeLicense,join(image,'LICENSE-node.txt'));
    const licenses=join(image,'licenses');mkdirSync(licenses,{recursive:true});
    for(const name of ['pptx-renderer','react-xlsx']){const target=join(licenses,name);mkdirSync(target,{recursive:true});for(const file of ['LICENSE','PROVENANCE.json'])cpSync(join(repo,'src/ui/vendor',name,file),join(target,file));}
    const notices=readFileSync(join(repo,'THIRD_PARTY_NOTICES.md'),'utf8').replaceAll('src/ui/vendor/','licenses/');
    writeFileSync(join(image,'THIRD_PARTY_NOTICES.md'),notices+'\n\n安装器使用 Inno Setup：https://jrsoftware.org/ 。程序图标由项目根目录 logo.png 转换。\n','utf8');
    const guide=join(image,'操作手册');mkdirSync(guide,{recursive:true});
    cpSync(join(repo,'docs/user-guide/README.md'),join(guide,'README.md'));if(existsSync(join(repo,'docs/user-guide/images')))cpSync(join(repo,'docs/user-guide/images'),join(guide,'images'),{recursive:true});
    writeFileSync(join(image,'众说操作手册.html'),renderUserGuide({assetPrefix:'操作手册/',markdownPath:'操作手册/README.md'}),'utf8');
    packageUserGuideAssets(join(appDir,'dist/ui/renderer/user-guide'));
    writeFileSync(join(image,'安装说明.txt'),`众说 ${version.version}\r\n\r\n安装范围：当前 Windows 用户，无需管理员权限。\r\n默认程序目录：%LOCALAPPDATA%\\Programs\\Zhongshuo\r\n默认数据目录：%LOCALAPPDATA%\\Zhongshuo\\data\r\n\r\n安装、升级和卸载均不删除用户数据。数据目录仅由应用启动后管理。\r\n安装不自动导入已有聊天；需要时在设置中选择导入已有数据。\r\n升级或卸载前，请先在众说中正常退出并等待后台任务结束。\r\n静默安装不会自动启动应用。\r\n随包提供操作手册、MIT LICENSE、第三方许可证说明。\r\n`,'utf8');
    privacyCheck(image);build=stampImage(image,original,metadata);
    json(join(work,'payload-audit.json'),{...version,...build,runAsNode:false,privacyScanPassed:true,dataFilesIncluded:false});
  }
  const compileOutput=validation?join(work,'syntax-output'):output;mkdirSync(compileOutput,{recursive:true});
  const defs={PayloadDir:image,ReleaseVersion:version.version,NumericVersion:version.numericVersion,BrandIcon:icon,BrandIconName:iconName,ReleaseOutputDir:compileOutput,...(appMutex?{NativeAppMutex:appMutex}:{})};
  const args=[...Object.entries(defs).map(([key,value])=>`/D${key}=${value}`),join(configDir,'zhongshuo.iss')];
  const result={...plan,image,...(build??{}),validationOnly:validation};json(join(work,validation?'syntax-plan.json':'build-result.json'),result);
  if(options['--stage-only']&&!validation){console.log(JSON.stringify(result,null,2));return result;}
  const compilation=spawnSync(compiler,args,{cwd:configDir,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  writeFileSync(join(work,validation?'syntax-compile.log':'compile.log'),(compilation.stdout??'')+(compilation.stderr??''),'utf8');
  if(compilation.status!==0)throw Error(`Inno compilation failed (${compilation.status}); see ${work}`);
  const artifact=join(compileOutput,`${baseName}.exe`);assert.ok(existsSync(artifact),'Compiler did not produce requested EXE');
  Object.assign(result,{output:artifact,bytes:statSync(artifact).size,sha256:sha(readFileSync(artifact)),signed:false});
  json(join(work,validation?'syntax-result.json':'build-result.json'),result);
  if(!validation){writeFileSync(`${artifact}.sha256`,`${result.sha256}  ${baseName}.exe\n`);json(join(output,`${baseName}.release.json`),{schemaVersion:1,appId:release.appId,...version,architecture:'x64',file:`${baseName}.exe`,bytes:result.bytes,sha256:result.sha256,buildId:build.buildId,signed:false});}
  console.log(JSON.stringify(result,null,2));return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{await makeInstaller();}catch(error){console.error(`[windows-installer] ${error.message}`);process.exitCode=1;}
}
