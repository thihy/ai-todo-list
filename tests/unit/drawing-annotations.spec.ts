import { expect, it } from 'vitest';
import { annotationPosition, annotationPrompt, loadDrawingAnnotations } from '../../src/renderer/drawing/annotations';
import type { LiveDrawingContext } from '../../src/shared/drawing-engine';

const live: LiveDrawingContext = { drawingId: 'drawing', revision: 'current', elements: [{ id: 'real-a' }, { id: 'real-b' }], selectedElementIds: ['real-b'], viewport: { scrollX: 0, scrollY: 0, zoom: 1, width: 800, height: 600 } };
const drafts = [{ id: 'note-1', elementIds: ['real-a'], text: '修改颜色', versions: { 'real-a': 1 } }, { id: 'note-2', elementIds: ['real-b'], text: '移动到右侧', versions: { 'real-b': 2 } }];
it('keeps separate real targets and literal instructions in one ordinary-chat batch', () => {
  const prompt = annotationPrompt('drawing', drafts, live);
  expect(prompt).toContain('这 2 条绘图标注'); expect(prompt).toContain('1. 修改颜色\n   元素引用：real-a');
  expect(prompt).toContain('2. 移动到右侧\n   元素引用：real-b'); expect(prompt).toContain('不要创建待办任务');
  expect(() => annotationPrompt('drawing', [{ ...drafts[0]!, elementIds: ['deleted'] }], live)).toThrow('第 1 条标注的目标已被删除');
  expect(() => annotationPrompt('other', drafts, live)).toThrow('画布已切换');
});
it('restores valid local drafts and rejects corrupt persisted data', () => {
  expect(loadDrawingAnnotations(JSON.stringify(drafts))).toEqual(drafts);
  expect(loadDrawingAnnotations('broken')).toEqual([]);
  expect(loadDrawingAnnotations('[{"text":123}]')).toEqual([]);
});
it('keeps an annotation composer inside narrow and normal canvas viewports', () => {
  const position = annotationPosition([700, 570, 790, 600], { width: 800, height: 600 });
  expect(position.left + position.width).toBeLessThanOrEqual(788); expect(position.top).toBe(430);
  const narrow = annotationPosition([20, 100, 120, 200], { width: 220, height: 400 });
  expect(narrow.left).toBeGreaterThanOrEqual(12); expect(narrow.left + narrow.width).toBeLessThanOrEqual(208);
});
