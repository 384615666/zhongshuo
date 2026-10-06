import pathlib, re
p = pathlib.Path(r'D:\zhongshuo\scripts\_dbggate_r67.cjs')
t = p.read_text(encoding='utf-8')
t = t.replace("const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
"const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nconst LOG = (m) => { try { require('node:fs').appendFileSync('D:/zhongshuo/dbg-gate.log', m + '\\n'); } catch { /* */ } };", 1)
t = re.sub(r'console\.log\(', 'LOG(', t)
t = re.sub(r'console\.error\(e\);', 'LOG(String(e));', t)
p.write_text(t, encoding='utf-8')
print('ok')
