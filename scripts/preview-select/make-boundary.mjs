/**
 * 预览选型验证（2026-10-03）：边界输入样本。
 * corrupt.pptx=截断 40%；huge.pptx=office-deck + 120MB 未压缩 junk（合法 zip、超安全限额）；
 * macro-container.pptm=office-deck + 4KB 伪 vbaProject.bin（关系+ContentTypes 齐备，无真实宏代码）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require('./route-a/node_modules/jszip');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/desktop/preview-select');
const samples = join(root, 'samples');
const bad = join(samples, 'bad');
mkdirSync(bad, { recursive: true });

// 1) corrupted: first 40% of the real Office deck
const deck = readFileSync(join(samples, 'office-deck.pptx'));
writeFileSync(join(bad, 'corrupt.pptx'), deck.subarray(0, Math.floor(deck.length * 0.4)));

// 2) huge: same deck plus a 120MB stored junk entry (valid zip, blows zip budgets)
{
  const zip = await JSZip.loadAsync(deck);
  const junk = Buffer.alloc(120 * 1024 * 1024);
  for (let i = 0; i < junk.length; i += 4096) junk[i] = 65 + ((i / 4096) % 26); // sparse pattern
  zip.file('ppt/media/junk.bin', junk, { compression: 'STORE' });
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  writeFileSync(join(bad, 'huge.pptx'), buf);
}

// 3) macro container: stub vbaProject.bin + rels + content-types, saved as .pptm
{
  const zip = await JSZip.loadAsync(deck);
  zip.file('ppt/vbaProject.bin', Buffer.from([...Array(4096)].map((_, i) => (i * 7 + 13) % 256)));
  let ct = await zip.file('[Content_Types].xml').async('string');
  if (!/Extension="bin"/.test(ct)) {
    ct = ct.replace('<Default Extension="xml"', '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Default Extension="xml"');
  }
  zip.file('[Content_Types].xml', ct);
  let rels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  rels = rels.replace('</Relationships>', '<Relationship Id="rIdVba1" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>');
  zip.file('ppt/_rels/presentation.xml.rels', rels);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeFileSync(join(bad, 'macro-container.pptm'), buf);
}

console.log('[boundary] OK corrupt=%d huge=%d macro=%d',
  readFileSync(join(bad, 'corrupt.pptx')).length,
  readFileSync(join(bad, 'huge.pptx')).length,
  readFileSync(join(bad, 'macro-container.pptm')).length);
