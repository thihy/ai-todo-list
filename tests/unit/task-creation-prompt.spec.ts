import { describe, expect, it } from 'vitest';
import { buildAiTaskCreationPrompt } from '../../src/shared/task-creation';

describe('AI task creation prompt', () => {
  it('marks the request as task creation and preserves the user text', () => {
    const prompt = buildAiTaskCreationPrompt(
      '今天完成季度报告，挂到工作项目下面',
      new Date(2026, 8, 12, 9, 30),
    );
    expect(prompt).toContain('[应用操作模式：创建任务]');
    expect(prompt).toContain('调用 todo.create');
    expect(prompt).toContain('plannedFor');
    expect(prompt).toContain('2026-09-12');
    expect(prompt).toContain('今天完成季度报告，挂到工作项目下面');
    expect(prompt).toContain('不得根据标题猜测或编造');
  });
});
