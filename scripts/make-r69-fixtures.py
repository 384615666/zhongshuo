# R69 验收夹具生成：多页 PDF（reportlab）、多页 Word（python-docx）、多工作表 Excel（openpyxl，
# 含蓝表头/黄色整行/合并单元格/列宽行高——对照 reference-excel.png）、MD/HTML 长文。
# 全部本地生成，不联网；不使用任何用户私有内容。
import os
import sys

out = sys.argv[1] if len(sys.argv) > 1 else 'dist/desktop/r69-fixtures'
os.makedirs(out, exist_ok=True)

# ---------- 多页 PDF（5 页：标题+正文+表格，中文） ----------
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

font = None
for cand in [
    r'C:\Windows\Fonts\msyh.ttc',
    r'C:\Windows\Fonts\simsun.ttc',
    r'C:\Windows\Fonts\simhei.ttf',
]:
    if os.path.exists(cand):
        try:
            pdfmetrics.registerFont(TTFont('ZHCn', cand, subfontIndex=0))
            font = 'ZHCn'
            break
        except Exception:
            continue
if font is None:
    font = 'Helvetica'

c = pdfcanvas.Canvas(os.path.join(out, 'r69-多页报告.pdf'), pagesize=A4)
W, H = A4
for i in range(1, 6):
    c.setFont(font, 22)
    c.drawCentredString(W / 2, H - 40 * mm, f'众说预览验收报告 第 {i} 页')
    c.setFont(font, 12)
    y = H - 60 * mm
    for line in range(14):
        c.drawString(25 * mm, y, f'{i}.{line + 1} 这是第 {i} 页的第 {line + 1} 行正文——用于核验 PDF 分页、页码与按面板宽度适应渲染。')
        y -= 8 * mm
    if i == 3:
        c.setFont(font, 11)
        ty = H - 190 * mm
        rows = [['列一', '列二', '列三'], ['甲', '42', '2026-10-07'], ['乙', '7', '通过']]
        colw = [40 * mm, 30 * mm, 40 * mm]
        for r, row in enumerate(rows):
            x = 25 * mm
            for cell, cw in zip(row, colw):
                c.rect(x, ty - 5 * mm, cw, 7 * mm)
                c.drawString(x + 2 * mm, ty - 3.4 * mm, cell)
                x += cw
            ty -= 7 * mm
    c.setFont(font, 9)
    c.drawCentredString(W / 2, 12 * mm, f'- {i} -')
    c.showPage()
c.save()

# ---------- 多页 Word（3 节/多页：标题、表格、红字填空、高亮） ----------
from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
h = doc.add_heading('众说预览验收合同（Word 样本）', level=0)
h.alignment = WD_ALIGN_PARAGRAPH.CENTER
p = doc.add_paragraph('甲方：＿＿＿＿＿＿＿＿    乙方：＿＿＿＿＿＿＿＿')
run = p.add_run('（示例填空值：广西通服）')
run.font.color.rgb = RGBColor(0xC0, 0x00, 0x00)
run.font.underline = True
doc.add_heading('第一条 验收范围', level=1)
for i in range(1, 41):
    doc.add_paragraph(f'（{i}）表格、标题、字体与分页如实呈现：这一段用于撑出多页排版，核验 docx-preview 的 breakPages 与页边距（第 {i} 条）。')
doc.add_page_break()
doc.add_heading('附表（第 3 页）', level=1)
tbl = doc.add_table(rows=4, cols=3)
tbl.style = 'Table Grid'
for r, row in enumerate([['字段', '类型', '必填'], ['名称', '文本(40)', '是'], ['数量', '整数', '否'], ['日期', '日期', '是']]):
    for ci, v in enumerate(row):
        tbl.cell(r, ci).text = v
doc.add_page_break()
doc.add_heading('附则（第 2 页）', level=1)
doc.add_paragraph('高亮与颜色：')
ph = doc.add_paragraph()
hl = ph.add_run('这一句带黄色高亮')
hl.font.highlight_color = 7  # YELLOW
doc.save(os.path.join(out, 'r69-验收合同.docx'))

# ---------- 多工作表 Excel（蓝表头/黄行/合并/列宽——对照参考图） ----------
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

wb = openpyxl.Workbook()
ws = wb.active
ws.title = '补助模块'
ws['A1'] = '04_补助模块'
ws['A1'].font = Font(bold=True, size=14)
headers = ['字段名', 'Excel别名', '是否必填', '数据类型']
for ci, hv in enumerate(headers, start=1):
    cell = ws.cell(row=2, column=ci, value=hv)
    cell.font = Font(bold=True, color='FFFFFF')
    cell.fill = PatternFill('solid', fgColor='2E75B6')
    cell.alignment = Alignment(horizontal='center')
rows = [
    ('mutualPlanName', '互助保障计划名称', '是', '文本(40)'),
    ('subsidyType', '补助类型', '是', '文本(20)'),
    ('amount', '金额', '是', '数值(12,2)'),
    ('hospital', '住院机构', '否', '文本(60)'),
    ('applyDate', '申请日期', '是', '日期'),
]
for ri, row in enumerate(rows, start=3):
    for ci, v in enumerate(row, start=1):
        ws.cell(row=ri, column=ci, value=v)
ws.merge_cells('A9:D9')
ws['A9'] = '分组说明：以下为住院补助分组（整行黄色）'
for ci in range(1, 6):
    ws.cell(row=10, column=ci).fill = PatternFill('solid', fgColor='FFFF00')
ws['A10'] = '住院补助'
ws['B10'] = 'hospitalSubsidy'
ws['C10'] = '是'
ws['D10'] = '数值(10,2)'
ws.column_dimensions['A'].width = 24
ws.column_dimensions['B'].width = 26
ws.column_dimensions['C'].width = 10
ws.column_dimensions['D'].width = 14
ws2 = wb.create_sheet('数据录入')
ws2['A1'] = '第二张工作表（页签切换验收）'
ws2['A2'] = 123
ws2['B2'] = '数值格'
ws3 = wb.create_sheet('Sheet1')
ws3['A1'] = '第三张表'
wb.save(os.path.join(out, 'r69-补助信息.xlsx'))

# ---------- MD / HTML ----------
md = '''# 众说预览验收 · Markdown 样本

这是 **加粗** 与 *斜体*，以及行内代码 `previewPane`。

## 表格

| 格式 | 渲染器 | 参考图 |
| --- | --- | --- |
| PPT | pptx-renderer 1.3.0 | reference-ppt.png |
| PDF | pdfjs 4.10 | reference-pdf.png |
| Excel | react-xlsx 0.16.0 | reference-excel.png |

## 列表与引用

- 缩略图列懒渲染（IntersectionObserver）
- 底部条：‹ [页码] / 总数 ›｜− % ＋

> 引用块：文件预览不发送给 AI、不运行脚本。

```ts
const doc = await openPptxDocument(bytes);
doc.renderPage(0, mount);
```
'''
open(os.path.join(out, 'r69-说明.md'), 'w', encoding='utf-8').write(md)

html = '''<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>R69 HTML 样本</title>
<style>body{font-family:system-ui,sans-serif;margin:32px;line-height:1.8}h1{color:#1a73e8}.card{border:1px solid #dbe2ea;border-radius:8px;padding:12px 16px;max-width:520px}</style>
</head><body>
<h1>众说预览验收 · HTML 样本</h1>
<div class="card">静态页面预览：脚本已禁用、外部资源不加载（隔离渲染）。</div>
<ul><li>结构</li><li>样式</li><li>安全边界</li></ul>
</body></html>
'''
open(os.path.join(out, 'r69-页面.html'), 'w', encoding='utf-8').write(html)

print('fixtures ready:', out)
