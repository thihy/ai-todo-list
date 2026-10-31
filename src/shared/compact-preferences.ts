export interface CompactPreferences {
  enabled: boolean;
  opacity: number;
  alwaysOnTop: boolean;
  manualSize: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

export function normaliseCompactPreferences(raw: unknown): CompactPreferences {
  const value = raw && typeof raw === 'object' ? raw as Partial<CompactPreferences> : {};
  const bounds = value.bounds;
  return {
    enabled: value.enabled !== false,
    opacity: typeof value.opacity === 'number' && Number.isFinite(value.opacity) ? Math.max(.4, Math.min(1, value.opacity)) : 1,
    alwaysOnTop: value.alwaysOnTop !== false,
    manualSize: value.manualSize === true,
    bounds: bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(200, Math.min(1600, Math.round(bounds.width))),
        height: Math.max(64, Math.min(1200, Math.round(bounds.height))) } : null,
  };
}
