import { describe, expect, it } from 'vitest';
import {
  decodeUserMessage,
  encodeTaskCreationEnvelope,
  TASK_CREATION_PREFIX,
  localDateKey,
} from '../../src/shared/task-creation';

describe('AI task creation envelope', () => {
  // 当前格式：固定前缀 + JSON {intent, localDate, text}。十条固定规则
  // 已迁到系统提示词，封套只携带操作标记 / 日期 / 用户描述。
  it('encodes the create-task envelope with prefix + JSON payload', () => {
    const wire = encodeTaskCreationEnvelope(
      '今天完成季度报告，挂到工作项目下面',
      new Date(2026, 8, 12, 9, 30),
    );
    expect(wire.startsWith(TASK_CREATION_PREFIX)).toBe(true);
    const json = wire.slice(TASK_CREATION_PREFIX.length).trim();
    const obj = JSON.parse(json) as { intent: string; localDate: string; text: string };
    expect(obj.intent).toBe('create-task');
    expect(obj.localDate).toBe(localDateKey(new Date(2026, 8, 12, 9, 30)));
    expect(obj.text).toBe('今天完成季度报告，挂到工作项目下面');
    // 规则正文不应再出现在封套里——只在系统提示词里。
    expect(wire).not.toContain('调用 todo.create');
    expect(wire).not.toContain('不得根据标题猜测或编造');
  });

  // 编码端按请求时本地日期生成，不能在 Agent 启动时固定。
  it('uses a fresh localDate per call', () => {
    const earlier = encodeTaskCreationEnvelope('a', new Date(2026, 0, 1, 0, 0));
    const later = encodeTaskCreationEnvelope('a', new Date(2026, 11, 31, 23, 59));
    expect(earlier).toContain('"localDate":"2026-01-01"');
    expect(later).toContain('"localDate":"2026-12-31"');
  });

  // 解码 → 编码的逆操作；普通聊天原样返回。
  it('decodes the new envelope into text + intent=create-task', () => {
    const wire = encodeTaskCreationEnvelope('建一个任务：周五交报告');
    const decoded = decodeUserMessage(wire);
    expect(decoded.text).toBe('建一个任务：周五交报告');
    expect(decoded.intent).toBe('create-task');
    expect(decoded.description).toBe('建一个任务：周五交报告');
  });

  it('returns plain chat untouched (no intent)', () => {
    const decoded = decodeUserMessage('这条消息不是创建任务');
    expect(decoded.text).toBe('这条消息不是创建任务');
    expect(decoded.intent).toBeUndefined();
    expect(decoded.description).toBeUndefined();
  });

  // 严格旧封套兼容：完整匹配旧固定开头 + 标记时才视为 create-task。
  // 用户文本里碰巧出现方括号标记不应被误判。
  it('strictly matches the legacy envelope markers for back-compat', () => {
    const legacy = '[应用操作模式：创建任务]\n十条规则…\n[用户的任务描述开始]\n旧封套里的描述\n[用户的任务描述结束]';
    const decoded = decodeUserMessage(legacy);
    expect(decoded.intent).toBe('create-task');
    // 描述剥离开关外的十条规则——这样 priorTurns 重投给模型时不会再
    // 次注入旧规则正文；规则已迁到系统提示词。
    expect(decoded.description).toBe('旧封套里的描述');
    expect(decoded.text).toBe('旧封套里的描述');
  });

  it('keeps attachment blocks appended after the legacy end marker', () => {
    const legacy =
      '[应用操作模式：创建任务]\n十条规则…\n[用户的任务描述开始]\n旧封套里的描述\n[用户的任务描述结束]\n\n---\n\n[attached: a.txt (... )]\n附件内容';
    const decoded = decodeUserMessage(legacy);
    expect(decoded.intent).toBe('create-task');
    expect(decoded.description).toBe('旧封套里的描述');
    // 完整文本保留尾部（附件块），用于回投模型。
    expect(decoded.text).toContain('[attached: a.txt');
    expect(decoded.text).not.toContain('十条规则');
  });

  it('does NOT mistake ordinary text containing the legacy markers for an envelope', () => {
    // 缺旧前缀，只有标记——必须走普通聊天路径。
    const tricky = '用户随便写的：[用户的任务描述开始]\n不是封套\n[用户的任务描述结束]';
    const decoded = decodeUserMessage(tricky);
    expect(decoded.intent).toBeUndefined();
    expect(decoded.text).toBe(tricky);
  });
});
