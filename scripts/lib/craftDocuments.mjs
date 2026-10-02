/**
 * 文档样本工厂（第二十九轮三/四）——测试与页面验证器共用的合成样本：
 * - PDF：ASCII 文本层（第二十八轮既有形态）；**真实中文**（Identity-H+ToUnicode CMap——
 *   码位↔Unicode 映射真实成立，不靠 latin1 冒充）；**CMap 解码**（UniGB-UCS2-H+STSong
 *   预定义 CID 字体——需要随包 cmaps 才可提取，验证 CMap 资源链）；**扫描件**（FlateDecode
 *   RGB 图像页——零文本层，视觉渲染可见像素）；**加密**（Standard R2/RC4 40-bit——真实
 *   O/U/密钥计算，pdfjs 抛 PasswordException）。
 * - Office：最小合法 DOCX/XLSX/PPTX（zip+[Content_Types]+rels+主体 XML——mammoth/自研
 *   解析器可读）；恶意条目名/超条目数 zip（护栏反例）。
 * - 图片：PNG（真 CRC）、JPEG/GIF/WebP 头部样本（仅头/截断体——头部通过≠像素可解码）、
 *   WebP VP8/VP8L 头（宽高可解析）。
 * 纯 Node 依赖（zlib/fflate），零网络。
 */
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { zipSync } from 'fflate';

const NL = String.fromCharCode(10);

// ---------- PDF 骨架 ----------
function buildPdf(objects, extraTrailer = '') {
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, idx) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${extraTrailer}>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
function streamObj(dict, bytes) {
  return `<< ${dict} /Length ${bytes.length} >>\nstream\n` + bytes.toString('latin1') + '\nendstream';
}

/** ASCII 文本层 PDF（Helvetica——第二十八轮既有 makePdf 形态，非中文证明用）。 */
export function makeAsciiPdf(pages) {
  const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [4 6] /Count ${pages.length} >>`, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`];
  const pageIds = [];
  pages.forEach((lines, i) => {
    const contentId = objects.length + 2;
    pageIds.push(objects.length + 1);
    const stream = lines.map((l, li) => `BT /F1 12 Tf 72 ${720 - li * 20}Td (${l.replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(streamObj('', Buffer.from(stream, 'latin1')));
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  return buildPdf(objects);
}

/** 真实中文 PDF：Identity-H + ToUnicode CMap（每字符 2 字节码位↔Unicode 双射）。 */
export function makeCjkToUnicodePdf(pages) {
  const chars = [...new Set(pages.flat().join(''))];
  const codeOf = new Map(chars.map((ch, i) => [ch, 0x0100 + i]));
  const hex = (n) => n.toString(16).padStart(4, '0');
  const bfchar = chars.map((ch, i) => `<${hex(0x0100 + i)}> <${hex(ch.codePointAt(0))}>`).join('\n');
  const toUnicode = Buffer.from(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /ZS-Custom def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${bfchar}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`, 'latin1');
  // 对象：1 catalog 2 pages 3 Type0 4 CIDFont 5 ToUnicode 6 FontDescriptor 7.. 页+内容
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages >>`,
    `<< /Type /Font /Subtype /Type0 /BaseFont /ZS-Custom /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ZS-Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /CIDToGIDMap /Identity /FontDescriptor 6 0 R >>`,
    streamObj('', toUnicode),
    FONT_DESCRIPTOR,
  ];
  const pageIds = [];
  pages.forEach((lines) => {
    const contentId = objects.length + 2;
    pageIds.push(objects.length + 1);
    const stream = lines.map((l, li) => {
      const codes = [...l].map((ch) => hex(codeOf.get(ch) ?? 0x003f)).join('');
      return `BT /F1 12 Tf 72 ${720 - li * 20}Td <${codes}> Tj ET`;
    }).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(streamObj('', Buffer.from(stream, 'latin1')));
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  return buildPdf(objects);
}

/** 无嵌入字体程序的占位 FontDescriptor（pdfjs 字体构造所需——提取走 ToUnicode/CMap）。 */
const FONT_DESCRIPTOR = `<< /Type /FontDescriptor /FontName /ZS-Custom /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>`;

/** CMap 解码 PDF：UniGB-UCS2-H 预定义 CMap（码位=字符 UTF-16BE——**需要随包 cmaps** 才能
 * 按码宽切分/建字体；无该资源=字体构建失败、提取降级）+ ToUnicode（pdfjs 对预定义 CID
 * 字体无内建 CID→Unicode 表——文本还原靠 ToUnicode）。对象：1 catalog 2 pages 3 Type0
 * 4 CIDFont 5 FontDescriptor 6 ToUnicode 7.. 页+内容。 */
export function makeCmapPdf(pages) {
  const chars = [...new Set(pages.flat().join(''))];
  const hex = (n) => n.toString(16).padStart(4, '0');
  const bfchar = chars.map((ch) => `<${hex(ch.codePointAt(0))}> <${hex(ch.codePointAt(0))}>`).join('\n');
  const toUnicode = Buffer.from(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /ZS-ToUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${bfchar}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`, 'latin1');
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages >>`,
    `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>`,
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 /FontDescriptor 5 0 R >>`,
    FONT_DESCRIPTOR,
    streamObj('', toUnicode),
  ];
  const pageIds = [];
  pages.forEach((lines) => {
    const contentId = objects.length + 2;
    pageIds.push(objects.length + 1);
    const stream = lines.map((l, li) => {
      const be = Buffer.from(l, 'utf16le').swap16();
      return `BT /F1 12 Tf 72 ${720 - li * 20}Td <${be.toString('hex')}> Tj ET`;
    }).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(streamObj('', Buffer.from(stream, 'latin1')));
  });
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  return buildPdf(objects);
}

/** 扫描件 PDF：每页一张 FlateDecode RGB 图像（零文本层——视觉渲染有像素、文本提取如实空）。 */
export function makeImagePdf(pages) {
  const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages >>`];
  const pageIds = [];
  for (const p of pages) {
    const raw = Buffer.alloc(p.w * p.h * 3);
    for (let i = 0; i < p.w * p.h; i += 1) {
      raw[i * 3] = (i * 7 + p.color[0]) % 256;
      raw[i * 3 + 1] = (i * 13 + p.color[1]) % 256;
      raw[i * 3 + 2] = (i * 29 + p.color[2]) % 256;
    }
    const z = zlib.deflateSync(raw);
    const imgId = objects.length + 1;
    const contentId = objects.length + 3; // image=len+1，page=len+2，content=len+3
    objects.push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n` + z.toString('latin1') + '\nendstream');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(imgId + 1);
    objects.push(streamObj('', Buffer.from(`q ${p.w} 0 0 ${p.h} 0 0 cm /Im0 Do Q`, 'latin1')));
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  return buildPdf(objects);
}

// ---------- RC4 + Standard R2 加密 PDF（真实 O/U/对象密钥——pdfjs 抛 PasswordException） ----------
const RC4_PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d06868e00124682e2e0212b6d06868e00124682e2e00b6d06868e00124682e2e0212', 'hex');
function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0; j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) % 256];
  }
  return out;
}
function padPassword(pw) {
  const b = Buffer.from(pw, 'latin1').subarray(0, 32);
  return Buffer.concat([b, RC4_PAD]).subarray(0, 32);
}
/** 加密 PDF（用户密码 userPassword；R2/V1/RC4 40-bit——内容流按对象密钥加密）。 */
export function makeEncryptedPdf(lines, userPassword) {
  const id0 = crypto.randomBytes(16);
  const p = -1;
  const pLe = Buffer.alloc(4); pLe.writeInt32LE(p, 0);
  const paddedUser = padPassword(userPassword);
  const ownerKey = rc4(crypto.createHash('md5').update(padPassword(userPassword)).digest().subarray(0, 5), paddedUser);
  const encKey = crypto.createHash('md5').update(Buffer.concat([paddedUser, ownerKey, pLe, Buffer.from(id0)])).digest().subarray(0, 5);
  const userKey = rc4(encKey, RC4_PAD);
  const objKey = (objNum) => {
    const extra = Buffer.alloc(5);
    extra.writeUIntLE(objNum & 0xffffff, 0, 3);
    extra.writeUIntLE(0, 3, 2);
    return crypto.createHash('md5').update(Buffer.concat([encKey, extra])).digest().subarray(0, 10);
  };
  const content = Buffer.from(lines.map((l, li) => `BT /F1 12 Tf 72 ${720 - li * 20}Td (${l}) Tj ET`).join('\n'), 'latin1');
  // 对象：1 catalog 2 pages 3 font 4 page 5 content(加密) 6 encrypt dict
  const encryptedContent = rc4(objKey(5), content);
  const hexStr = (b) => `<${b.toString('hex')}>`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [4 0 R] /Count 1 >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`,
    `<< /Length ${encryptedContent.length} >>\nstream\n` + encryptedContent.toString('latin1') + '\nendstream',
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /O ${hexStr(ownerKey)} /U ${hexStr(userKey)} /P ${p} >>`,
  ];
  return buildPdf(objects, `/Encrypt 6 0 R /ID [${hexStr(id0)} ${hexStr(id0)}]`);
}

// ---------- Office zip 样本 ----------
const CT_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** DOCX：段落（含标题样式名）+ 表格（行列保序）。 */
export function makeDocx(input) {
  const paras = input.paras ?? [];
  const table = input.table ?? null;
  let body = '';
  for (const p of paras) body += `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`;
  if (table != null) {
    body += '<w:tbl>';
    for (const row of table) {
      body += '<w:tr>';
      for (const cell of row) body += `<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`;
      body += '</w:tr>';
    }
    body += '</w:tbl>';
  }
  const document = `${CT_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const files = {
    '[Content_Types].xml': `${CT_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': document,
  };
  return zipToBuffer(files);
}

/** XLSX：多 sheet+行/列+内联字符串+数字+公式（有无缓存值两态）+合并单元格。 */
export function makeXlsx(sheets) {
  const files = {
    '[Content_Types].xml': '',
    '_rels/.rels': '',
    'xl/workbook.xml': '',
    'xl/_rels/workbook.xml.rels': '',
    'xl/styles.xml': `${CT_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="14" formatCode="yyyy-mm-dd"/></numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  let sheetOverrides = '';
  let sheetRels = '';
  sheets.forEach((s, i) => {
    sheetOverrides += `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
    sheetRels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`;
    let rowsXml = '';
    s.rows.forEach((row, r) => {
      let cellsXml = '';
      row.forEach((cell, c) => {
        const ref = `${colName(c)}${r + 1}`;
        if (cell == null || cell === '') cellsXml += `<c r="${ref}"/>`;
        else if (typeof cell === 'object' && cell.date != null) cellsXml += `<c r="${ref}" s="1"><v>${cell.date}</v></c>`;
        else if (typeof cell === 'object' && cell.formula != null) {
          cellsXml += cell.cached != null
            ? `<c r="${ref}"><f>${escapeXml(cell.formula)}</f><v>${cell.cached}</v></c>`
            : `<c r="${ref}"><f>${escapeXml(cell.formula)}</f></c>`;
        } else if (typeof cell === 'number') cellsXml += `<c r="${ref}"><v>${cell}</v></c>`;
        else cellsXml += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell))}</t></is></c>`;
      });
      rowsXml += `<row r="${r + 1}">${cellsXml}</row>`;
    });
    const merges = (s.merges ?? []).length > 0
      ? `<mergeCells count="${s.merges.length}">${s.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      : '';
    files[`xl/worksheets/sheet${i + 1}.xml`] = `${CT_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData>${merges}</worksheet>`;
  });
  files['[Content_Types].xml'] = `${CT_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>`;
  files['_rels/.rels'] = `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  files['xl/workbook.xml'] = `${CT_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}</Relationships>`;
  return zipToBuffer(files);
}

/** PPTX 顺序样本（第三十轮三）：sldIdLst 按数组顺序引用（rIdN→slides/slide{no}.xml——
 * 支持编号不连续/重排）；备注经该页自己的关系表（slideN.xml.rels→notesSlide{notesNo}.xml
 * ——**编号与页号无假定对应**）；orphanSlides=存在文件但未被引用（应被排除）。
 * slides: [{ no: 5, texts: ['...'], notes: '...', notesNo: 3 }, ...] */
export function makePptxSlides({ slides, orphanSlides = [] }) {
  const files = {
    '[Content_Types].xml': '',
    '_rels/.rels': `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `${CT_HEADER}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
  };
  let overrides = '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>';
  let rels = '';
  const allSlideNos = [...slides.map((x) => x.no), ...orphanSlides];
  for (const no of allSlideNos) overrides += `<Override PartName="/ppt/slides/slide${no}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  slides.forEach((sl, i) => {
    rels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${sl.no}.xml"/>`;
    const texts = (sl.texts ?? []).map((t) => `<a:p><a:r><a:t>${escapeXml(t)}</a:t></a:r></a:p>`).join('');
    files[`ppt/slides/slide${sl.no}.xml`] = `${CT_HEADER}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${texts}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    if (sl.notes != null) {
      const notesNo = sl.notesNo ?? sl.no; // 缺省同号；样本可显式错开
      overrides += `<Override PartName="/ppt/notesSlides/notesSlide${notesNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`;
      files[`ppt/slides/_rels/slide${sl.no}.xml.rels`] = `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${notesNo}.xml"/></Relationships>`;
      files[`ppt/notesSlides/notesSlide${notesNo}.xml`] = `${CT_HEADER}<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(sl.notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
  });
  files['[Content_Types].xml'] = `${CT_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;
  files['ppt/_rels/presentation.xml.rels'] = `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  return zipToBuffer(files);
}


/** PPTX 静态页样本（第三十七轮四）：带形状坐标/文本框/图片引用+页关系 media——SVG 受控转换用。
 * slides:[{no, shapes:[{x,y,cx,cy,texts,kind:'sp'|'pic'}], image?:{name,mime,bytes}, notes?}] */
export function makePptxPagesSample({ slides }) {
  const files = {
    '[Content_Types].xml': '',
    '_rels/.rels': `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `${CT_HEADER}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
  };
  let overrides = '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>';
  let rels = '';
  slides.forEach((sl, i) => {
    rels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${sl.no}.xml"/>`;
    overrides += `<Override PartName="/ppt/slides/slide${sl.no}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
    const shapeXml = (sl.shapes ?? []).map((sh) => {
      const geom = `<a:xfrm><a:off x="${sh.x}" y="${sh.y}"/><a:ext cx="${sh.cx}" cy="${sh.cy}"/></a:xfrm>`;
      if (sh.kind === 'pic') {
        return `<p:pic><p:nvPicPr/><p:blipFill><a:blip r:embed="rIdImg1"/></p:blipFill><p:spPr>${geom}</p:spPr></p:pic>`;
      }
      const texts = (sh.texts ?? []).map((t) => `<a:p><a:r><a:t>${escapeXml(t)}</a:t></a:r></a:p>`).join('');
      return `<p:sp><p:spPr>${geom}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody>${texts}</p:txBody></p:sp>`;
    }).join('');
    files[`ppt/slides/slide${sl.no}.xml`] = `${CT_HEADER}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${shapeXml}</p:spTree></p:cSld></p:sld>`;
    if (sl.image != null) {
      overrides += `<Override PartName="/ppt/slides/slide${sl.no}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Default Extension="${sl.image.ext}" ContentType="${sl.image.mime}"/>`;
      files[`ppt/media/${sl.image.name}`] = sl.image.bytes;
      files[`ppt/slides/_rels/slide${sl.no}.xml.rels`] = `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${sl.image.name}"/></Relationships>`;
    }
    if (sl.notes != null) {
      const notesNo = sl.notesNo ?? sl.no;
      overrides += `<Override PartName="/ppt/notesSlides/notesSlide${notesNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`;
      const existingRels = files[`ppt/slides/_rels/slide${sl.no}.xml.rels`];
      const notesRel = `<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${notesNo}.xml"/>`;
      files[`ppt/slides/_rels/slide${sl.no}.xml.rels`] = existingRels != null
        ? existingRels.replace('</Relationships>', notesRel + '</Relationships>')
        : `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${notesRel}</Relationships>`;
      files[`ppt/notesSlides/notesSlide${notesNo}.xml`] = `${CT_HEADER}<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(sl.notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
  });
  files['[Content_Types].xml'] = `${CT_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;
  files['ppt/_rels/presentation.xml.rels'] = `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  return zipToBuffer(files);
}

/** PPTX 底层组装（孤立页等反例用）：presentationRids 定义 sldIdLst 顺序与目标；
 * slideFiles={no:[texts]} 生成页文件（未被引用=孤立）；notes={slideNo:{no, text}} 经页关系表。 */
export function makePptxZipEntries({ presentationRids, slideFiles, notes = {} }) {
  const files = {
    '[Content_Types].xml': '',
    '_rels/.rels': `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `${CT_HEADER}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${presentationRids.map((_, i) => `<p:sldId id="${256 + i}" r:id="${_.rid}"/>`).join('')}</p:sldIdLst></p:presentation>`,
  };
  let overrides = '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>';
  let rels = '';
  for (const r of presentationRids) rels += `<Relationship Id="${r.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${r.target}"/>`;
  for (const [noStr, texts] of Object.entries(slideFiles)) {
    const no = Number(noStr);
    overrides += `<Override PartName="/ppt/slides/slide${no}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
    const body = texts.map((t) => `<a:p><a:r><a:t>${escapeXml(t)}</a:t></a:r></a:p>`).join('');
    files[`ppt/slides/slide${no}.xml`] = `${CT_HEADER}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const note = notes[no];
    if (note != null) {
      overrides += `<Override PartName="/ppt/notesSlides/notesSlide${note.no}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`;
      files[`ppt/slides/_rels/slide${no}.xml.rels`] = `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${note.no}.xml"/></Relationships>`;
      files[`ppt/notesSlides/notesSlide${note.no}.xml`] = `${CT_HEADER}<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(note.text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
  }
  files['[Content_Types].xml'] = `${CT_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;
  files['ppt/_rels/presentation.xml.rels'] = `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  return files;
}

/** PPTX 兼容旧签名（slides: [{texts, notes}]——编号 1..n、备注缺省同号，经页关系表定位）。 */
export function makePptx(slides) {
  return makePptxSlides({ slides: slides.map((s, i) => ({ no: i + 1, texts: s.texts, notes: s.notes })) });
}

/** 宏文档样本（macroEnabled 内容类型——.docm/.xlsm 形态）。 */
export function makeMacroDocx() {
  return zipToBuffer({
    '[Content_Types].xml': `${CT_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>`,
    '_rels/.rels': `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    'word/document.xml': `${CT_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>宏文档</w:t></w:r></w:p></w:body></w:document>`,
  });
}

/** zip 护栏反例：路径穿越条目。 */
export function makeTraversalZip() {
  return zipToBuffer({ '[Content_Types].xml': Buffer.from('<Types/>'), 'word/../../evil.txt': Buffer.from('x') });
}
/** zip 护栏反例：超条目数（1501 条）。 */
export function makeManyEntryZip() {
  const files = { '[Content_Types].xml': Buffer.from('<Types/>') };
  for (let i = 0; i < 1501; i += 1) files[`f${i}.txt`] = Buffer.from('x');
  return zipToBuffer(files);
}

// ---------- 图片样本 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** 最小合法 PNG（IDAT=纯色行重复——浏览器可解码；像素真实）。 */
export function makePng(w, h, rgb = [60, 120, 220]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let i = 0; i < w; i += 1) { row[1 + i * 3] = rgb[0]; row[2 + i * 3] = rgb[1]; row[3 + i * 3] = rgb[2]; }
  const idat = zlib.deflateSync(Buffer.concat(Array(h).fill(row)));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** JPEG 头部样本（SOI+SOF0 声明高宽+SOS 截断——头部可解析、像素不可解码）。 */
export function makeJpegHeaderOnly(w, h) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
}
/** GIF 头部样本（声明屏幕高宽，数据截断）。 */
export function makeGifHeaderOnly(w, h) {
  const b = Buffer.from('GIF89a', 'latin1');
  const size = Buffer.alloc(10); // 16B 头部校验窗（LSD 7B+3B 截断数据）
  size.writeUInt16LE(w, 0); size.writeUInt16LE(h, 2); size[4] = 0x70; size[5] = 0; size[6] = 0;
  return Buffer.concat([b, size]);
}
/** WebP VP8 头部样本（帧头+同步码+宽高——无压缩数据体）。 */
export function makeWebpVp8HeaderOnly(w, h) {
  const payload = Buffer.alloc(10);
  payload[0] = 0x30; payload[1] = 0x00; payload[2] = 0x00; // keyframe tag
  payload[3] = 0x9d; payload[4] = 0x01; payload[5] = 0x2a; // 同步码
  payload.writeUInt16LE(w, 6); payload.writeUInt16LE(h, 8);
  return webpContainer('VP8 ', payload);
}
/** WebP VP8L 头部样本（签名+14bit 宽/高打包——无数据体）。 */
export function makeWebpVp8lHeaderOnly(w, h) {
  const payload = Buffer.alloc(9);
  payload[0] = 0x2f;
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  payload.writeUInt32LE(bits >>> 0, 1);
  return webpContainer('VP8L', payload);
}
function webpContainer(fourcc, payload) {
  const chunk = Buffer.alloc(8);
  chunk.write(fourcc, 0, 'latin1');
  chunk.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([chunk, payload]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + body.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, Buffer.from('WEBP', 'latin1'), body]);
}

// ---------- CSV ----------
export function makeCsvText(rows, delim = ',') {
  return Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replaceAll('"', '""')}"` : String(c))).join(delim)).join('\r\n'), 'utf8');
}

export function zipToBuffer(files) {
  const zipped = {};
  for (const [k, v] of Object.entries(files)) zipped[k] = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
  return Buffer.from(zipSync(zipped, { level: 6 })); // Buffer（.toString('base64') 语义正确）
}
function colName(c) {
  let s = '';
  let n = c;
  for (;;) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; if (n < 0) break; }
  return s;
}
function escapeXml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
void NL;
