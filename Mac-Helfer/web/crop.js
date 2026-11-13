const finite = value => typeof value === 'number' && Number.isFinite(value);
const unit = value => Math.max(0, Math.min(1, value));

/** A strict source-window rectangle. No screen-coordinate assumptions. */
export function normalizeCrop(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(name => finite(value[name]))
    || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0
    || value.x + value.width > 1 + 1e-10 || value.y + value.height > 1 + 1e-10) return null;
  const width = Math.min(value.width, 1 - value.x), height = Math.min(value.height, 1 - value.y);
  return width > 0 && height > 0 ? { x: value.x, y: value.y, width, height } : null;
}

/** CSS pointer coordinates stay independent of Retina/backing-store pixels. */
export function selectionCrop(start, end, bounds) {
  if (!start || !end || !bounds
    || ![start.x, start.y, end.x, end.y, bounds.left, bounds.top, bounds.width, bounds.height].every(finite)
    || bounds.width <= 0 || bounds.height <= 0) return null;
  const x1 = unit((start.x - bounds.left) / bounds.width), y1 = unit((start.y - bounds.top) / bounds.height);
  const x2 = unit((end.x - bounds.left) / bounds.width), y2 = unit((end.y - bounds.top) / bounds.height);
  return normalizeCrop({ x: Math.min(x1, x2), y: Math.min(y1, y2),
    width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) });
}

export function pixelCrop(crop, width, height) {
  const value = normalizeCrop(crop);
  if (!value || ![width, height].every(dimension => Number.isSafeInteger(dimension) && dimension > 0)) return null;
  const x = Math.min(width - 1, Math.floor(value.x * width));
  const y = Math.min(height - 1, Math.floor(value.y * height));
  const right = Math.min(width, Math.ceil((value.x + value.width) * width));
  const bottom = Math.min(height, Math.ceil((value.y + value.height) * height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}
