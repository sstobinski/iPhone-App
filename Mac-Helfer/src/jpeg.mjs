export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2]);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Inspect JPEG framing and its actual SOF dimensions. The browser remains
 * responsible for decoding pixels; no filesystem path or image library is used. */
export function inspectWindowJpeg(bytes) {
  const invalid = () => { throw failure('WINDOW_JPEG_INVALID'); };
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > MAX_FRAME_BYTES
    || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return invalid();
  let offset = 2;
  let dimensions = null;
  let scanSeen = false;
  let segments = 0;
  while (offset < bytes.length) {
    if (++segments > 4096 || bytes[offset] !== 0xff) return invalid();
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return invalid();
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!dimensions || !scanSeen || offset !== bytes.length) return invalid();
      return dimensions;
    }
    if (marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) return invalid();
    if (marker === 1) continue; // Standalone TEM marker.
    if (offset + 2 > bytes.length) return invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return invalid();
    if (SOF_MARKERS.has(marker)) {
      if (dimensions || length < 11 || bytes[offset + 2] !== 8) return invalid();
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7];
      if (components < 1 || components > 4 || length !== 8 + components * 3
        || width < 16 || height < 16 || width > 4096 || height > 4096
        || width * height > 8_000_000) return invalid();
      dimensions = { width, height };
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return invalid(); // Only browser baseline/sequential/progressive 8-bit JPEG.
    }
    if (marker === 0xda) {
      const components = bytes[offset + 2];
      if (components < 1 || components > 4 || length !== 6 + components * 2) return invalid();
    }
    offset += length;
    if (marker !== 0xda) continue;
    if (!dimensions) return invalid();
    scanSeen = true;
    // Skip entropy-coded data, including byte stuffing and restart markers.
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      let next = offset + 1;
      while (bytes[next] === 0xff) next++;
      if (next >= bytes.length) return invalid();
      if (bytes[next] === 0 || bytes[next] >= 0xd0 && bytes[next] <= 0xd7) {
        offset = next + 1;
        continue;
      }
      break;
    }
  }
  return invalid();
}

