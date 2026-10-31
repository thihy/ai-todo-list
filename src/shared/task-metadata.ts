/** Task custom fields are a flat string-to-string map, never task instructions. */
export function validateTaskMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('元数据必须是 KV 对象');
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('元数据最多 100 项');
  const result: Record<string, string> = {};
  for (const [key, text] of entries) {
    if (!key.trim() || key.length > 100 || key.includes('\0')) throw new Error('元数据键不能为空，且最多 100 字符');
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('元数据键不可使用保留名称');
    if (typeof text !== 'string' || text.length > 10000 || text.includes('\0')) throw new Error('元数据值必须是字符串，且最多 10000 字符');
    result[key] = text;
  }
  if (JSON.stringify(result).length > 65536) throw new Error('元数据总长度最多 64K 字符');
  return result;
}
