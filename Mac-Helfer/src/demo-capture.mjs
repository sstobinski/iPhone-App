import { EventEmitter } from 'node:events';
import jpeg from '../vendor/jpeg-js/index.js';

const palette = [[210, 50, 35], [220, 150, 45], [60, 180, 80], [70, 130, 210], [190, 65, 170]];
function rect(image, x, y, width, height, color) {
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(image.height, Math.ceil(y + height)); py++) {
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(image.width, Math.ceil(x + width)); px++) {
      const offset = (py * image.width + px) * 4;
      image.data[offset] = color[0]; image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2]; image.data[offset + 3] = 255;
    }
  }
}
/** Deliberately synthetic geometry. It never reads Serato or any screen. */
export function createDemoSource(phase = 0) {
  const width = 960, height = 675, data = new Uint8Array(width * height * 4);
  const image = { width, height, data };
  rect(image, 0, 0, width, height, [28, 29, 31]);
  const wave = box => {
    rect(image, box.x, box.y, box.width, box.height, [4, 5, 7]);
    for (let y = 0; y < box.height; y++) {
      const pulse = Math.exp(-(((y / (box.height / 13)) + phase) % 1) * 4.4);
      const half = box.width * .45 * (.12 + .77 * pulse + .04 * Math.sin(y * .27) ** 2);
      const color = palette[Math.floor(y / (box.height / palette.length)) % palette.length];
      rect(image, box.x + box.width / 2 - half, box.y + y, half * 2, 1, color);
    }
  };
  for (const x of [.40, .497]) wave({ x: width * x, y: height * .17, width: width * .09, height: height * .48 });
  wave({ x: width * .615, y: height * .17, width: width * .012, height: height * .48 });
  for (let row = 0; row < 9; row++) {
    const y = height * .69 + row * height * .029;
    if (row === 3) rect(image, 0, y - 3, width, height * .025, [8, 91, 140]);
    for (let column = 0; column < 4; column++) for (let glyph = 0; glyph < 11; glyph++) {
      rect(image, width * (.08 + column * .23) + glyph * width * .008,
        y, width * .004, height * .010, [20, 145, 190]);
    }
  }
  return image;
}
function cutImage(image, crop) {
  const x = Math.floor(crop.x * image.width), y = Math.floor(crop.y * image.height);
  const width = Math.max(1, Math.min(image.width - x, Math.ceil(crop.width * image.width)));
  const height = Math.max(1, Math.min(image.height - y, Math.ceil(crop.height * image.height)));
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) data.set(image.data.subarray(((y + row) * image.width + x) * 4,
    ((y + row) * image.width + x + width) * 4), row * width * 4);
  return { width, height, data };
}
export class DemoCapture extends EventEmitter {
  #timer = null; #sequence = 0; #crop = null; #cropRevision = 0; #frame = null; #closed = false;
  #packet(type, image, more = {}) {
    const began = performance.now();
    const bytes = jpeg.encode(image, 82).data;
    this.emit('packet', { header: { type, width: image.width, height: image.height,
      sequence: ++this.#sequence, geometryRevision: 1, cropRevision: this.#cropRevision,
      requestId: this.#crop?.requestId ?? 0, sourceAgeMs: 0, encodeMs: performance.now() - began, ...more }, jpeg: bytes });
  }
  #tick() {
    if (this.#closed) return;
    this.#frame = createDemoSource(this.#sequence * .07);
    this.#packet('analysis', this.#frame);
    if (this.#crop) this.#packet('frame', cutImage(this.#frame, this.#crop.crop));
  }
  async start() {
    if (this.#closed) throw new Error('CAPTURE_DEMO_CLOSED');
    this.emit('packet', { header: { type: 'status', status: 'capture-ready', geometryRevision: 1, cropRevision: 0 }, jpeg: Buffer.alloc(0) });
    this.#tick(); this.#timer = setInterval(() => this.#tick(), 500);
  }
  sendCrop(value) {
    if (this.#closed || value.geometryRevision !== 1) return false;
    this.#crop = structuredClone(value); this.#cropRevision++;
    this.emit('packet', { header: { type: 'status', status: 'crop-applied',
      geometryRevision: 1, cropRevision: this.#cropRevision, requestId: value.requestId }, jpeg: Buffer.alloc(0) });
    if (this.#frame) this.#packet('frame', cutImage(this.#frame, value.crop));
    return true;
  }
  clearCrop() { this.#crop = null; this.#cropRevision++; return !this.#closed; }
  getStats() { return { demo: true, packets: this.#sequence, running: Number(this.#timer !== null) }; }
  async stop() { this.#closed = true; clearInterval(this.#timer); this.#timer = null; this.#frame = null; this.#crop = null; }
}
