/** Only a bounded previous automatic crop can guide image-based tracking. */
export function readPreviousRegion(value) {
  if (!['vertical-two-deck', 'horizontal-two-deck'].includes(value?.layout)) return null;
  const horizontal = value.layout === 'horizontal-two-deck';
  const crop = value.crop;
  if (!crop || typeof crop !== 'object' || Array.isArray(crop) || Object.keys(crop).sort().join(',') !== 'height,width,x,y'
    || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    || crop.x < 0 || crop.y < 0 || crop.width < (horizontal ? .25 : .04) || crop.width > (horizontal ? 1 : .40)
    || crop.height < (horizontal ? .12 : .18) || crop.height > (horizontal ? .65 : .90) || horizontal && crop.width * crop.height > .60
    || crop.x + crop.width > 1 || crop.y + crop.height > 1) return null;
  return { layout: value.layout, crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height } };
}
