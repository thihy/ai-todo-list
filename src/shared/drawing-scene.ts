/** Validate before overwriting a file or passing untrusted scene data to the editor. */
export function assertDrawingScene(scene: unknown): void {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error('绘图场景必须是 JSON 对象。');
  const value = scene as Record<string, unknown>;
  if (value.elements !== undefined && !Array.isArray(value.elements)) {
    throw new Error('绘图 elements 必须是 JSON 数组，不能使用 { item: ... } 包装。请保留原图，使用正确的 JSON 数组重试。');
  }
  if (value.appState !== undefined && (!value.appState || typeof value.appState !== 'object' || Array.isArray(value.appState))) {
    throw new Error('绘图 appState 必须是 JSON 对象。');
  }
  for (const element of (value.elements ?? []) as unknown[]) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) throw new Error('绘图元素必须是 JSON 对象。');
    const entry = element as Record<string, unknown>;
    for (const key of ['x', 'y', 'width', 'height', 'angle', 'fontSize', 'strokeWidth', 'opacity', 'seed', 'version', 'versionNonce']) {
      if (entry[key] !== undefined && (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]))) {
        throw new Error(`绘图元素 ${String(entry.id)} 的 ${key} 必须是数字，不能是字符串。`);
      }
    }
    for (const key of ['isDeleted', 'locked', 'autoResize', 'elbowed']) {
      if (entry[key] !== undefined && typeof entry[key] !== 'boolean') throw new Error(`绘图元素 ${String(entry.id)} 的 ${key} 必须是布尔值。`);
    }
    for (const key of ['points', 'groupIds', 'boundElements']) {
      if (entry[key] != null && !Array.isArray(entry[key])) throw new Error(`绘图元素 ${String(entry.id)} 的 ${key} 必须是数组。`);
    }
    if (Array.isArray(entry.points) && entry.points.some((point) => !Array.isArray(point) || point.length !== 2 || point.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate)))) {
      throw new Error(`绘图元素 ${String(entry.id)} 的 points 必须是二维数字坐标数组。`);
    }
  }
}
