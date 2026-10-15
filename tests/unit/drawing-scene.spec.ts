import { describe, expect, it } from 'vitest';
import { assertDrawingScene } from '../../src/shared/drawing-scene';

describe('drawing scene validation', () => {
  it('接受标准数组、数字、布尔值与连线坐标', () => {
    expect(() => assertDrawingScene({ elements: [{ id: 'a', x: 1, isDeleted: false,
      points: [[0, 0], [10, 20]], groupIds: [], boundElements: null }], appState: {} })).not.toThrow();
  });
  it.each([
    [{ elements: { item: [{ id: 'a' }] } }, /elements.*数组/],
    [{ elements: [{ id: 'a', x: '1' }] }, /x.*数字/],
    [{ elements: [{ id: 'a', isDeleted: 'false' }] }, /isDeleted.*布尔/],
    [{ elements: [{ id: 'a', groupIds: '' }] }, /groupIds.*数组/],
    [{ elements: [{ id: 'a', points: { item: [0, 0] } }] }, /points.*数组/],
    [{ elements: [{ id: 'a', points: [[0], ['1', '2']] }] }, /points.*二维数字/],
  ])('拒绝会导致场景初始化失败的数据 %#', (scene, message) => {
    expect(() => assertDrawingScene(scene)).toThrow(message as RegExp);
  });
});
