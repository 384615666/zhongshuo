export function greet(name) {
  const trimmed = name.trim();
  return trimmed === '' ? '你好，朋友' : `你好，${trimmed}`;
}
