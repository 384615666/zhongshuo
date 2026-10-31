import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildDshRuntime(output = join(sourceRoot, 'dist/dsh-runtime')) {
  output = resolve(output);
  const source = join(sourceRoot, 'packages/dsh-runtime');
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const files = ['package.json', ...pkg.files];
  const parts = [];
  const hashes = {};
  for (const file of files) {
    const data = await readFile(join(source, file));
    hashes[file] = createHash('sha256').update(data).digest('hex');
    parts.push(tarHeader(`package/${file}`, data.length), data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(parts), { level: 9 });
  const tarball = `zhongshuo-dsh-runtime-${pkg.version}.tgz`;
  const manifest = {
    schemaVersion: 1, runtime: 'zhongshuo-dsh', protocol: 1, profile: 'zhongshuo',
    package: pkg.name, pluginVersion: pkg.version, dshVersion: pkg.engines.dsh,
    officialPackage: '@deepseek-ai/dsh',
    officialRelease: 'https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.1-rc.5',
    officialIntegrity: 'sha512-WkyJZv4zl9sCAxSzRctGm58m0rilGqwR6pniBiLOz5CPDfHfDuAUicg0AAazXI7oj/Cph6/cjNTncA/rpLTXpw==',
    tarball, sha256: createHash('sha256').update(archive).digest('hex'), files: hashes,
  };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, tarball), archive);
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const setupSource=await readFile(join(sourceRoot, 'scripts/setup-deepseek-harness.mjs'),'utf8');
  await writeFile(join(output, 'setup-deepseek-harness.mjs'),setupSource.replace("'../src/adapter/cli/executable.mjs'","'./executable.mjs'"));
  await writeFile(join(output, 'executable.mjs'),await readFile(join(sourceRoot,'src/adapter/cli/executable.mjs')));
  return { output, ...manifest };
}

// A standard npm-compatible USTAR package, built without invoking a package
// manager or touching the project's shared node_modules junction.
function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  const octal = (offset, length, value) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, size); octal(136, 12, 0);
  header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node scripts/build-dsh-runtime.mjs [--out DIRECTORY]');
  console.log(JSON.stringify(await buildDshRuntime(args[1]), null, 2));
}
