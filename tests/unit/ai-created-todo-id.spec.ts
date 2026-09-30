// AI 建任务后回传新任务 id 的解析 —— 回归测试。
//
// 函数本身在 src/shared/ai-created-todo.ts（纯函数，不碰 Electron；
// 放在 main/ipc/ 下会因为连带 import 'electron' 而在 Vitest 里直接崩）。
//
// 这里锁的是两个易错点：
//
// 1. 工具名是**下划线** `todo_create`，不是点号 `todo.create`。
//    main/ipc/ai-handlers.ts 的 mutatingScope 注释记着同一类事故：早期用
//    点号，所有 mutating 工具都因 case miss 退化成"不广播"，左栏不刷新。
//    这里再错一次，AI 建完任务同样不会跳转。
//
// 2. result 的包装层数不固定。跳错详情比不跳转更糟（会打开不相干的
//    任务），所以只接受"确实像 ULID"的字符串，其余一律 null。

import { describe, expect, it } from 'vitest';

import { extractCreatedTodoId } from '../../src/shared/ai-created-todo';

const ULID = '01M3S5DX40SGT74QD9Q6VK5FEW';

describe('extractCreatedTodoId', () => {
  it('直接 { id } 形状', () => {
    expect(extractCreatedTodoId({ id: ULID })).toBe(ULID);
  });

  it('{ data: { id } } 包装层', () => {
    expect(extractCreatedTodoId({ data: { id: ULID } })).toBe(ULID);
  });

  it('{ result: { id } } 包装层', () => {
    expect(extractCreatedTodoId({ result: { id: ULID } })).toBe(ULID);
  });

  it('{ id, todo } 形状（IPC 返回值）', () => {
    expect(extractCreatedTodoId({ id: ULID, todo: { id: ULID, title: 'x' } })).toBe(ULID);
  });

  it('整体被序列化成 JSON 字符串', () => {
    expect(extractCreatedTodoId(JSON.stringify({ id: ULID }))).toBe(ULID);
  });

  it('camelCase 的 todoId 也能认', () => {
    expect(extractCreatedTodoId({ todoId: ULID })).toBe(ULID);
  });

  it('非 ULID 形状的 id 拒绝返回（宁可空跳也不跳错）', () => {
    // 26 位但含 I/L/O/U 这些 ULID 禁用字符，不是合法 id。
    expect(extractCreatedTodoId({ id: 'I' + '0'.repeat(25) })).toBeNull();
    expect(extractCreatedTodoId({ id: 'not-an-id' })).toBeNull();
    expect(extractCreatedTodoId({ id: 12345 })).toBeNull();
  });

  it('结构不认识时返回 null', () => {
    expect(extractCreatedTodoId(null)).toBeNull();
    expect(extractCreatedTodoId(undefined)).toBeNull();
    expect(extractCreatedTodoId({})).toBeNull();
    expect(extractCreatedTodoId({ title: '只有标题没有 id' })).toBeNull();
    expect(extractCreatedTodoId('not json at all')).toBeNull();
  });

  it('循环引用不会无限递归', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => extractCreatedTodoId(cyclic)).not.toThrow();
    expect(extractCreatedTodoId(cyclic)).toBeNull();
  });

  it('不会误取嵌套里的 parentId（那是别人的 id）', () => {
    // 顶层没有 id，只有 input.parentId —— 拿它跳转会打开父任务而非新建的。
    const parentId = '01M2SCXPPRBEGAK40K3KC490Y0';
    expect(extractCreatedTodoId({ input: { parentId } })).toBeNull();
  });
});
