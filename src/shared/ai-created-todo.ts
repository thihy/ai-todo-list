// AI 建任务后回传新任务 id 的解析 —— 纯函数，无 Electron 依赖。
//
// 放在 shared 而不是 main/ipc/ai-handlers.ts：这个解析只需要知道
// result 的形状，不碰 BrowserWindow、不碰 logger。留在 main 里会连带
// 拉进 `import { app } from 'electron'`，Vitest 环境下 app.getPath 直接
// 抛错（src/main/logger.ts 的已知问题），纯函数因此无法单测。
//
// 两个易错点：
//   1. 工具名是**下划线** `todo_create`，不是点号 `todo.create`。
//      main/ipc/ai-handlers.ts 的 mutatingScope 注释记着同一类事故：早期
//      用点号，所有 mutating 工具都因 case miss 退化成"不广播"，左栏不刷新。
//   2. result 包装层数不固定。跳错详情比不跳转更糟（会打开不相干的任务），
//      所以只接受"确实像 ULID"的字符串，其余一律 null —— 宁可不跳。

/** ULID：26 位 Crockford Base32，剔除 I / L / O / U 四个易混字符。 */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * 从 `todo_create` 的 tool/result 载荷里挖出新任务的 id。
 * 认得的形状：`{ id }` / `{ todoId }` / `{ data: { id } }` /
 * `{ result: { id } }` / `{ todo: { id } }`，以及整体被序列化成 JSON 字符串
 * 的上述任一种。任何拿不准的形状返回 null。
 */
export function extractCreatedTodoId(result: unknown): string | null {
  const found: string[] = [];
  // 深度上限防止畸形/自引用结构把遍历拖死。
  const visit = (node: unknown, depth: number): void => {
    if (node == null || depth > 4 || found.length > 0) return;

    if (typeof node === 'string') {
      const trimmed = node.trim();
      if (trimmed.startsWith('{')) {
        try {
          visit(JSON.parse(trimmed), depth + 1);
        } catch {
          /* 不是 JSON，忽略 */
        }
      }
      return;
    }
    if (typeof node !== 'object') return;

    const obj = node as Record<string, unknown>;
    // 先按字段名收口，命中就不再往里挖 —— 避免误取到 todo.parentId
    // 这种"别人的 id"。
    for (const key of ['id', 'todoId', 'todo_id']) {
      const v = obj[key];
      if (typeof v === 'string' && ULID_RE.test(v)) {
        found.push(v);
        return;
      }
    }
    // 包装层逐个下钻。
    for (const key of ['data', 'result', 'todo', 'output']) {
      if (key in obj) {
        visit(obj[key], depth + 1);
        if (found.length > 0) return;
      }
    }
  };

  visit(result, 0);
  return found[0] ?? null;
}
