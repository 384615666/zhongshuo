import pathlib
p = pathlib.Path(r'D:\zhongshuo\scripts\_dbggate_r67.cjs')
t = p.read_text(encoding='utf-8')
t = t.replace("(async () => {\n  let ws = null;", "(async () => {\n  LOG('IIFE start');\n  let ws = null;")
t = t.replace("const repo = 'D:/zhongshuo';", "const repo = 'D:/zhongshuo';\ntry { require('node:fs').appendFileSync('D:/zhongshuo/dbg-gate.log', 'SCRIPT LOADED\\n'); } catch { /* */ }")
p.write_text(t, encoding='utf-8')
print('ok')
