export function compactProgressBounds(anchor: { x: number; y: number; width: number; height: number }, area: { x: number; y: number; width: number; height: number }) {
  const width = Math.min(420, area.width), height = Math.min(360, area.height);
  const right = anchor.x + anchor.width + 12;
  const x = right + width <= area.x + area.width ? right : anchor.x - width - 12;
  return { x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(anchor.y, area.y + area.height - height)), width, height };
}
