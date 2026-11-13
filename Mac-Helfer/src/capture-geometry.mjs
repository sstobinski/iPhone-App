const dimension = value => Number.isSafeInteger(value) && value >= 16 && value <= 4096;

/** Analysis JPEGs can be smaller than capture pixels. Both cover the same
 * window; an unannounced size/aspect change must invalidate the crop. */
export function readCaptureDimensions(header) {
  const { width, height } = header ?? {};
  if (!dimension(width) || !dimension(height) || width * height > 8_000_000) return null;
  const captureWidth = header.captureWidth === undefined ? width : header.captureWidth;
  const captureHeight = header.captureHeight === undefined ? height : header.captureHeight;
  if ((header.captureWidth === undefined) !== (header.captureHeight === undefined)
    || !dimension(captureWidth) || !dimension(captureHeight) || captureWidth * captureHeight > 8_000_000
    || captureWidth < width || captureHeight < height
    || Math.abs(captureWidth * height - captureHeight * width) > Math.max(captureWidth, captureHeight)) return null;
  return { captureWidth, captureHeight };
}
